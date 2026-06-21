// Seed script — loads the ORCAS search-query dataset into the `queries` table.
//
// Run with:  npm run seed   (or: docker compose exec backend npm run seed)
//
// DATASET: ORCAS (Open Resource for Click Analysis in Search), from MS MARCO.
//   Download: https://msmarco.z22.web.core.windows.net/msmarcoranking/orcas.tsv.gz
//   Place it at server/data/orcas.tsv.gz (gzip is read directly — no unzip needed).
//   Format: tab-separated, columns = qid, query, did, url. We only use `query`.
//
// COUNT semantics: ORCAS has no explicit per-query count — each row is one clicked
// query->document pair. We aggregate by query and use the NUMBER OF CLICK-
// CONNECTIONS as the popularity `count` (more clicked docs => more popular query).
//
// SAMPLING (important): the full file is 18.8M rows / ~10M distinct queries. We
// must stream the WHOLE file (so counts are accurate and the sample spans the
// entire alphabet), but we keep only a uniform SAMPLE of queries to bound the DB
// size. The sample is chosen by a deterministic hash of the query, so:
//   - it's uniform across all queries (NOT a biased contiguous slice — an earlier
//     "first N rows" approach loaded only queries near the start of the file, so
//     common queries like "what is ..." were missing entirely);
//   - every kept query's count is exact (all its rows are counted).
// SAMPLE_MOD (env, default 10) keeps ~1/10 of queries -> ~1M distinct, ~150 MB DB.
// Set SAMPLE_MOD=1 to load EVERYTHING (~10M queries, ~1.5 GB DB, slower).
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Keep 1 in SAMPLE_MOD distinct queries (uniform). 1 = keep all.
const SAMPLE_MOD = Math.max(1, Number(process.env.SAMPLE_MOD ?? 10));
const CHUNK = 50_000; // rows per write transaction

// Deterministic FNV-1a hash, used only to decide sampling — same query always
// gets the same keep/skip verdict, so all of a kept query's rows are counted.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const candidates = [
  process.env.ORCAS_FILE,
  join(DATA_DIR, 'orcas.tsv.gz'),
  join(DATA_DIR, 'orcas.tsv'),
].filter(Boolean);
const inputPath = candidates.find((p) => existsSync(p));

if (!inputPath) {
  console.error('[seed] ORCAS file not found. Expected one of:');
  console.error(`         ${join(DATA_DIR, 'orcas.tsv.gz')}`);
  console.error(`         ${join(DATA_DIR, 'orcas.tsv')}`);
  console.error('[seed] Download it from:');
  console.error('         https://msmarco.z22.web.core.windows.net/msmarcoranking/orcas.tsv.gz');
  console.error('[seed] place it at server/data/orcas.tsv.gz and re-run `npm run seed`.');
  process.exit(1);
}

// Insert-or-increment: each click-connection for a query bumps its count by 1.
const upsert = db.prepare(`
  INSERT INTO queries (term, display_term, count, last_searched_at)
  VALUES (?, ?, 1, NULL)
  ON CONFLICT(term) DO UPDATE SET count = count + 1
`);
const writeChunk = db.transaction((rows) => {
  for (const [term, displayTerm] of rows) upsert.run(term, displayTerm);
});

async function run() {
  const start = Date.now();
  console.log(`[seed] reading ${inputPath}`);
  console.log(`[seed] keeping ~1/${SAMPLE_MOD} of queries (set SAMPLE_MOD=1 to load all)`);

  // Fresh start so re-seeding never double-counts.
  db.exec('DELETE FROM queries');
  try {
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'queries'");
  } catch {
    // sqlite_sequence only exists after the first AUTOINCREMENT insert; ignore.
  }

  let input = createReadStream(inputPath);
  if (inputPath.endsWith('.gz')) input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });

  let lines = 0;
  let kept = 0;
  let skipped = 0;
  let chunk = [];

  for await (const line of rl) {
    lines++;
    if (lines % 2_000_000 === 0) console.log(`[seed]   ...${(lines / 1e6).toFixed(0)}M rows read`);

    // `query` is column index 1: between the 1st and 2nd tab.
    const tab1 = line.indexOf('\t');
    if (tab1 === -1) {
      skipped++;
      continue;
    }
    const tab2 = line.indexOf('\t', tab1 + 1);
    const query = (tab2 === -1 ? line.slice(tab1 + 1) : line.slice(tab1 + 1, tab2)).trim();
    if (!query) {
      skipped++;
      continue;
    }

    const term = query.toLowerCase();
    // Uniform sample by query hash (same query -> same verdict every time).
    if (SAMPLE_MOD > 1 && hash(term) % SAMPLE_MOD !== 0) continue;

    chunk.push([term, query]);
    kept++;
    if (chunk.length >= CHUNK) {
      writeChunk(chunk);
      chunk = [];
    }
  }
  if (chunk.length) writeChunk(chunk);
  rl.close();
  input.destroy();

  const distinct = db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
  const range = db.prepare('SELECT MIN(count) AS lo, MAX(count) AS hi FROM queries').get();
  const ms = Date.now() - start;
  console.log('[seed] done:');
  console.log(`         rows read           : ${lines.toLocaleString()}`);
  console.log(`         rows skipped (bad)  : ${skipped}`);
  console.log(`         click-rows kept     : ${kept.toLocaleString()}`);
  console.log(`         distinct queries    : ${distinct.toLocaleString()}`);
  console.log(`         count range         : ${range.lo} .. ${range.hi}`);
  console.log(`         elapsed             : ${(ms / 1000).toFixed(1)} s`);
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
