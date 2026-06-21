// GET /suggest?q=<prefix>[&mode=basic|trending]
//
// Returns up to 10 suggestions whose (normalized) term starts with the prefix.
//   - mode=basic   (default): rank by all-time popularity (count DESC).
//   - mode=trending:          rank by a recency-aware score (see trendingScore).
//
// Fronted by the distributed cache (cache-aside). The two modes use SEPARATE
// cache namespaces ("basic:<prefix>" / "trending:<prefix>") so they never share
// a cached result set, while a single invalidateTerm() clears both.
import { Router } from 'express';
import db from '../db.js';
import cache, { cacheKey } from '../cache/index.js';
import { recordSuggestLatency } from '../metrics.js';

const router = Router();

// --- basic mode: indexed top-10 by count -----------------------------------
// Prepared ONCE at module load and reused for every request.
//
// WHY a range scan instead of `LIKE 'prefix%'`:
//   `term` is stored lowercased with SQLite's default BINARY collation, and its
//   UNIQUE index is therefore BINARY. SQLite only rewrites `LIKE` into an index
//   range when the column is COLLATE NOCASE (or case_sensitive_like is ON);
//   otherwise the default case-insensitive LIKE degrades to a full table scan.
//   A half-open range [prefix, prefixUpper) always rides the BINARY B-tree index
//   directly. It's both faster and the cleaner viva answer.
const basicStmt = db.prepare(`
  SELECT display_term AS term, count
  FROM queries
  WHERE term >= ? AND term < ?
  ORDER BY count DESC
  LIMIT 10
`);
const basicStmtOpen = db.prepare(`
  SELECT display_term AS term, count
  FROM queries
  WHERE term >= ?
  ORDER BY count DESC
  LIMIT 10
`);

// --- trending mode: fetch all prefix matches + score in JS ------------------
// Unlike basic mode, trending CANNOT push its ranking into an indexed
// `ORDER BY ... LIMIT 10`: the score depends on last_searched_at (recency), and
// there's no index on the score. So a trending miss fetches every prefix match
// and scores it in application code. Cost is O(matches) per miss — bounded by
// how many terms share the prefix and fully absorbed by the cache (a hot
// trending prefix is computed once per TTL). Basic mode stays cheap and indexed.
const trendingCandidates = db.prepare(`
  SELECT display_term AS term, count, last_searched_at
  FROM queries
  WHERE term >= ? AND term < ?
`);
const trendingCandidatesOpen = db.prepare(`
  SELECT display_term AS term, count, last_searched_at
  FROM queries
  WHERE term >= ?
`);

// Decay parameters.
//
// LAMBDA gives a 24-hour half-life: a term's recency multiplier halves every
// 24h since it was last searched. WHY 24h: "trending" is a day-scale notion, so
// something searched today should clearly outrank something searched last week,
// but yesterday's hits shouldn't be erased. (lambda = ln2 / half-life.)
//
// MAX_AGE_HOURS caps the age used in the formula at 7 days. WHY: it puts a FLOOR
// on the decay multiplier (exp(-lambda*168) ~= 0.008) so an old-but-hugely-
// popular term keeps a small fraction of its weight instead of decaying to ~0
// and disappearing entirely. It also defines the recency of NEVER-searched rows
// (last_searched_at IS NULL): they're treated as "at least a week stale" rather
// than infinitely old, so a high-count seeded term still surfaces in trending.
const LAMBDA = Math.LN2 / 24;
const MAX_AGE_HOURS = 168;

function trendingScore(count, lastSearchedAt, nowMs) {
  let hours;
  if (!lastSearchedAt) {
    hours = MAX_AGE_HOURS; // never searched -> treat as maximally stale (floored)
  } else {
    hours = (nowMs - Date.parse(lastSearchedAt)) / 3_600_000;
    if (hours < 0) hours = 0; // guard against clock skew / future timestamps
    if (hours > MAX_AGE_HOURS) hours = MAX_AGE_HOURS; // floor the decay
  }
  return count * Math.exp(-LAMBDA * hours);
}

// Half-open upper bound for the prefix range: increment the last character so
// [prefix, upper) captures exactly the terms beginning with `prefix`.
// Guard: if the last char is the max code unit (extremely unlikely for typed
// prefixes), we can't increment it; fall back to the open-ended statement.
function prefixUpperBound(prefix) {
  const lastCode = prefix.charCodeAt(prefix.length - 1);
  if (lastCode >= 0xffff) return null;
  return prefix.slice(0, -1) + String.fromCharCode(lastCode + 1);
}

// Compute results for a (normalized) prefix + mode. Only called on a cache miss.
function computeSuggestions(prefix, mode) {
  const upper = prefixUpperBound(prefix);

  if (mode === 'trending') {
    const rows =
      upper === null ? trendingCandidatesOpen.all(prefix) : trendingCandidates.all(prefix, upper);

    const now = Date.now();
    return rows
      .map((r) => ({ term: r.term, count: r.count, score: trendingScore(r.count, r.last_searched_at, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(({ term, count }) => ({ term, count })); // keep the response shape identical to basic
  }

  // basic
  return upper === null ? basicStmtOpen.all(prefix) : basicStmt.all(prefix, upper);
}

router.get('/suggest', async (req, res) => {
  // Per-request latency clock. hrtime.bigint is a monotonic nanosecond counter
  // (immune to wall-clock adjustments), the right tool for measuring durations.
  const start = process.hrtime.bigint();

  const raw = req.query.q;

  // Empty / missing / non-string q -> [] immediately, 200. Never an error.
  // Not a real lookup, so we don't record it as a latency sample (it would
  // skew the percentiles toward ~0).
  if (typeof raw !== 'string' || raw.trim() === '') {
    return res.json([]);
  }

  // Only "trending" enables the recency mode; anything else (incl. absent) is basic.
  const mode = req.query.mode === 'trending' ? 'trending' : 'basic';

  // Normalize to match how `term` is stored: trim + lowercase. This is the exact
  // prefix used to build the namespaced cache key + hash-ring routing key.
  const prefix = raw.trim().toLowerCase();
  const key = cacheKey(mode, prefix);

  // Cache-aside: check the owning node first (logs routing + hit/miss). Use
  // `!== null` so a negatively-cached empty array still counts as a hit.
  // cache.get is now async (Redis) and returns null on a miss OR a node error —
  // either way we transparently fall back to SQLite below.
  const cached = await cache.get(key);
  const results = cached !== null ? cached : computeSuggestions(prefix, mode);
  if (cached === null) {
    // Populate the cache, INCLUDING empty results (negative caching).
    // Best-effort + fire-and-forget: don't make the user wait on the cache write,
    // and a failed write (node down) is already handled inside cache.set.
    cache.set(key, results);
  }

  // Record the end-to-end /suggest latency (covers both cache hits and misses —
  // what the end user actually experiences).
  recordSuggestLatency(Number(process.hrtime.bigint() - start) / 1e6);

  // No-match is simply an empty array -> still 200 + []. Not an error.
  res.json(results);
});

export default router;
