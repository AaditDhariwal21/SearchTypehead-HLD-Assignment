// Batched write pipeline for /search submissions.
//
// /search no longer writes to SQLite inline. It appends to this in-memory buffer
// and returns immediately. A background flusher aggregates the buffer and writes
// it in ONE transaction, triggered every 5s OR when the buffer hits 50 items —
// whichever comes first.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ CRASH / DURABILITY TRADE-OFF                                              │
// │                                                                           │
// │ The buffer lives ONLY in process memory. It is not persisted anywhere     │
// │ until a flush commits to SQLite. So if the process dies hard (kill -9,    │
// │ power loss, unhandled crash) BEFORE the next flush, every buffered-but-   │
// │ unflushed { term, timestamp } is LOST — at most ~5 seconds' worth of      │
// │ search submissions, or up to 50 items, whichever bound was hit first.     │
// │                                                                           │
// │ WHY this is an acceptable trade-off here:                                 │
// │  - These are POPULARITY COUNTERS, not transactional/financial data.       │
// │    Losing a handful of increments is harmless and self-corrects as users  │
// │    keep searching — the ranking barely moves.                             │
// │  - Batching is the whole point: collapsing N synchronous writes into one  │
// │    aggregated transaction slashes write volume and fsync pressure, which  │
// │    is exactly the win /metrics is there to demonstrate.                   │
// │  - The durable alternative (a write-ahead log / persistent queue of       │
// │    pending increments) buys correctness we don't need for approximate     │
// │    counts, at real complexity cost.                                       │
// │                                                                           │
// │ We DO flush on graceful shutdown (SIGINT/SIGTERM, see index.js), so a     │
// │ normal restart loses nothing — only a hard crash does.                    │
// └─────────────────────────────────────────────────────────────────────────┘
import db from '../db.js';
import cache from '../cache/index.js';
import { counters } from '../metrics.js';
import { log } from '../logger.js';

const FLUSH_INTERVAL_MS = 5000; // flush at least every 5s
const BATCH_SIZE = 50; // ...or sooner if the buffer reaches this many items

// buffer entries: { term, displayTerm, timestamp }
let buffer = [];
let timer = null;

// Same insert-or-increment shape as before, but @count is the AGGREGATED count
// for the term within this flush (not always 1), so repeated terms collapse into
// a single row write.
const upsert = db.prepare(`
  INSERT INTO queries (term, display_term, count, last_searched_at)
  VALUES (@term, @displayTerm, @count, @ts)
  ON CONFLICT(term) DO UPDATE SET
    count = count + excluded.count,
    last_searched_at = excluded.last_searched_at
`);

// One transaction per flush: all aggregated upserts commit together (or not at
// all). This is where the write-volume reduction physically happens.
const flushTxn = db.transaction((aggregated) => {
  for (const row of aggregated) upsert.run(row);
});

export function enqueue({ term, displayTerm, timestamp }) {
  buffer.push({ term, displayTerm, timestamp });
  counters.searchCalls += 1; // one logical write requested per /search
  // Size trigger: flush as soon as we hit the batch size, don't wait for the timer.
  // flush() is async now (Redis invalidation); we don't await here, but we attach
  // a .catch so a flush failure can never become an unhandled rejection.
  if (buffer.length >= BATCH_SIZE) flush('size').catch(() => {});
}

// async because cache invalidation is now a set of Redis DELs. The DB write
// itself is still synchronous (better-sqlite3); only the post-write cache
// invalidation is awaited, so shutdown can wait for it to settle.
export async function flush(reason = 'interval') {
  if (buffer.length === 0) return;

  // Drain by swapping the buffer out. The synchronous DB section below cannot be
  // interleaved (better-sqlite3 is sync, Node is single-threaded), but we swap
  // before the first `await` so submissions arriving during invalidation land in
  // the fresh buffer.
  const batch = buffer;
  buffer = [];

  // Aggregate repeated terms: sum occurrences, keep the latest timestamp, and
  // remember a display casing for the new-term insert path.
  const agg = new Map();
  for (const e of batch) {
    const cur = agg.get(e.term);
    if (cur) {
      cur.count += 1;
      if (e.timestamp > cur.ts) cur.ts = e.timestamp;
    } else {
      agg.set(e.term, { term: e.term, displayTerm: e.displayTerm, count: 1, ts: e.timestamp });
    }
  }

  const aggregated = [...agg.values()];
  flushTxn(aggregated); // synchronous transaction — the durable part

  counters.sqlWrites += aggregated.length; // actual row-writes executed
  counters.flushes += 1; // transactions committed

  log(
    'batch-write',
    `flush(${reason}): ${batch.length} buffered -> ${aggregated.length} upsert(s) in 1 txn`,
  );

  // Invalidate AFTER the DB write, not at enqueue time. WHY: if we invalidated
  // when the search was buffered, a /suggest miss in the gap before the flush
  // would re-query the DB (still holding the OLD count) and re-cache that stale
  // value. Invalidating post-flush means the next /suggest re-reads the freshly
  // written counts. Each affected term's prefixes are routed to their owning
  // node(s) by invalidateTerm() (each issuing Redis DELs).
  await Promise.all(aggregated.map(({ term }) => cache.invalidateTerm(term)));
}

export function size() {
  return buffer.length;
}

export function startFlusher() {
  if (timer) return;
  // .catch so an interval flush rejecting can never become an unhandled rejection.
  timer = setInterval(() => flush('interval').catch(() => {}), FLUSH_INTERVAL_MS);
  // unref so the interval alone never keeps the process alive; the HTTP server
  // is what holds it open.
  if (timer.unref) timer.unref();
}

export function stopFlusher() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
