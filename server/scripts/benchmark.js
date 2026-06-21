// Performance driver: generates a realistic load against a RUNNING backend, then
// prints the /metrics report (latency percentiles, cache hit rate, write
// reduction). Use it to produce numbers for the performance report.
//
//   docker compose exec backend node scripts/benchmark.js
//   # or, from your laptop against the published port:
//   cd server && node scripts/benchmark.js
//
// Env knobs: BASE_URL (default http://localhost:3001),
//            SUGGEST_REQUESTS (default 300), SEARCHES (default 500).
//
// NOTE: /metrics counters are CUMULATIVE since the server started. For a clean
// run, restart the backend first (`docker compose restart backend`) so the
// numbers reflect only this benchmark.
const BASE = process.env.BASE_URL || 'http://localhost:3001';
const SUGGEST_REQUESTS = Number(process.env.SUGGEST_REQUESTS || 300);
const SEARCHES = Number(process.env.SEARCHES || 500);

// A spread of prefixes; reused round-robin so repeats become cache hits.
const PREFIXES = [
  'a', 'ab', 'an', 'am', 'ap', 'you', 'yo', 'goo', 'app', 'and',
  'na', 'ca', 'de', 'in', 'st', 'ba', 'co', 'fa', 'ma', 're',
];
// A few "hot" terms so /search submissions aggregate heavily within a flush.
const HOT_TERMS = ['youtube', 'google', 'apple', 'nasa', 'android'];

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  return res.json();
}

async function main() {
  console.log(`benchmark -> ${BASE}`);

  // Health check first, with a friendly message if the backend isn't up.
  try {
    await fetch(`${BASE}/metrics`);
  } catch {
    console.error(`\nCannot reach ${BASE}. Is the backend running? (docker compose up)`);
    process.exit(1);
  }

  // Phase 1 — read traffic. Repeated prefixes warm the cache (miss -> hit).
  console.log(`\n[1/3] firing ${SUGGEST_REQUESTS} /suggest requests (mixed Popular/Trending)...`);
  for (let i = 0; i < SUGGEST_REQUESTS; i++) {
    const prefix = PREFIXES[i % PREFIXES.length];
    const mode = i % 4 === 0 ? 'trending' : 'basic'; // ~25% trending
    await getJson(`${BASE}/suggest?q=${encodeURIComponent(prefix)}&mode=${mode}`);
  }

  // Phase 2 — write traffic. Many submissions over few hot terms => big aggregation.
  console.log(`[2/3] firing ${SEARCHES} /search submissions over ${HOT_TERMS.length} hot terms...`);
  for (let i = 0; i < SEARCHES; i++) {
    const query = HOT_TERMS[i % HOT_TERMS.length];
    await fetch(`${BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
  }

  // Phase 3 — let the time-based flush drain the buffer, then read the report.
  console.log('[3/3] waiting 6s for the batch flush, then reading /metrics...');
  await new Promise((r) => setTimeout(r, 6000));
  const m = await getJson(`${BASE}/metrics`);

  const lat = m.suggestLatencyMs;
  const c = m.cache.overall;
  const w = m.writes;

  console.log('\n===== /metrics =====');
  console.log(JSON.stringify(m, null, 2));

  console.log('\n===== summary (cumulative since server start) =====');
  console.log(`suggest latency   p50=${lat.p50}ms  p95=${lat.p95}ms  p99=${lat.p99}ms  (n=${lat.samples})`);
  console.log(`cache hit rate    ${(c.hitRate * 100).toFixed(1)}%  (${c.hits}/${c.lookups} lookups, errors=${c.errors})`);
  console.log(`write reduction   ${w.writeReductionPct}%  (${w.searchCalls} /search -> ${w.sqlWrites} SQL row-writes in ${w.flushes} flushes)`);
}

main();
