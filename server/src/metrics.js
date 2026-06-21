// Process-wide metrics, surfaced via GET /metrics.
//   - write counters       (step 6): /search calls vs actual SQL writes
//   - /suggest latency      (step 8): last 1000 samples -> p50/p95/p99
//   - cache hit rate        (step 8): per node + overall
//
// Plain in-memory counters: cheap, and exactly the kind of thing a real system
// would ship to a metrics backend (Prometheus etc.). Resets on restart.

// ---------------------------------------------------------------------------
// Write counters — mutated directly by the batch flusher (searchBuffer.js).
// ---------------------------------------------------------------------------
export const counters = {
  searchCalls: 0, // total /search submissions accepted (one logical write each)
  sqlWrites: 0, //   total SQL upsert row-writes executed by the batch flusher
  flushes: 0, //     total flush transactions committed
};

// ---------------------------------------------------------------------------
// /suggest latency — fixed-size ring buffer of the last N request times (ms).
// Bounded memory: we keep only the most recent samples, overwriting oldest.
// ---------------------------------------------------------------------------
const LATENCY_CAP = 1000;
const latencies = [];
let latWrite = 0; // next slot to overwrite once the buffer is full

export function recordSuggestLatency(ms) {
  if (latencies.length < LATENCY_CAP) {
    latencies.push(ms);
  } else {
    latencies[latWrite] = ms;
    latWrite = (latWrite + 1) % LATENCY_CAP;
  }
}

// Nearest-rank percentile: sort, then take the ceil((p/100)*N)-th sample.
// Simple, dependency-free, and good enough for a demo's p50/p95/p99.
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1];
}

// ---------------------------------------------------------------------------
// Cache hit rate — per node and overall. Nodes register at construction so all
// nodes show up in /metrics even before they've served a lookup.
// ---------------------------------------------------------------------------
const cacheStats = new Map(); // nodeId -> { hits, lookups, errors }

function statsFor(nodeId) {
  let s = cacheStats.get(nodeId);
  if (!s) {
    s = { hits: 0, lookups: 0, errors: 0 };
    cacheStats.set(nodeId, s);
  }
  return s;
}

export function registerCacheNode(nodeId) {
  statsFor(nodeId);
}

export function recordCacheLookup(nodeId, hit) {
  const s = statsFor(nodeId);
  s.lookups += 1;
  if (hit) s.hits += 1;
}

// A Redis op failed (node unreachable). Tracked separately so it does NOT
// distort the hit rate (which stays a measure of clean cache outcomes); a spike
// here is the signal that fallback-to-SQLite is happening.
export function recordCacheError(nodeId) {
  statsFor(nodeId).errors += 1;
}

// ---------------------------------------------------------------------------
const round2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
const rate = (hits, lookups) => (lookups > 0 ? Math.round((hits / lookups) * 1000) / 1000 : 0);

// Build the read-side snapshot (latency + cache). The /metrics route adds the
// write-derived fields (it owns the searchBuffer dependency, keeping this module
// free of it and thus free of an import cycle).
export function snapshot() {
  const sorted = latencies.slice().sort((a, b) => a - b);

  let totalHits = 0;
  let totalLookups = 0;
  let totalErrors = 0;
  const perNode = {};
  for (const [node, s] of cacheStats) {
    totalHits += s.hits;
    totalLookups += s.lookups;
    totalErrors += s.errors;
    perNode[node] = {
      hits: s.hits,
      lookups: s.lookups,
      errors: s.errors,
      hitRate: rate(s.hits, s.lookups),
    };
  }

  return {
    suggestLatencyMs: {
      samples: sorted.length,
      p50: round2(percentile(sorted, 50)),
      p95: round2(percentile(sorted, 95)),
      p99: round2(percentile(sorted, 99)),
    },
    cache: {
      overall: {
        hits: totalHits,
        lookups: totalLookups,
        errors: totalErrors,
        hitRate: rate(totalHits, totalLookups),
      },
      perNode,
    },
    writes: { ...counters },
  };
}
