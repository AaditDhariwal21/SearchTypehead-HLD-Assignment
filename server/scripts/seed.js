// Seed script — loads the ORCAS search-query dataset into the `queries` table.
//
// Run with:  npm run seed   (or: docker compose exec backend npm run seed)
//
// DATASET: ORCAS (Open Resource for Click Analysis in Search), from MS MARCO.
//   Download: https://msmarco.z22.web.core.windows.net/msmarcoranking/orcas.tsv.gz
//   Place it at server/data/orcas.tsv.gz (gzip is read directly — no need to
//   unzip the ~2 GB file). A plain orcas.tsv also works.
//   Format: tab-separated, columns = qid, query, did, url. We only use `query`.
//
// COUNT semantics: ORCAS has no explicit per-query count — each row is one
// clicked query->document pair. We aggregate by query and use the NUMBER OF
// CLICK-CONNECTIONS as the popularity `count` (more clicked docs => more popular
// query). It's a proxy: counts are lower/flatter than Wikipedia page-views, but
// it's a real search-query signal, which is the point of switching to ORCAS.
//
// SIZE: the full file is 18.8M rows / ~10M distinct queries — too big to hold in
// memory. We STREAM it and process only the first MAX_LINES rows (env, default
// 1,000,000 -> ~550k distinct queries, comfortably over the 100k requirement).
// Raise MAX_LINES if you have the RAM and want popular queries to accrue higher
// counts. This is a SEPARATE script, never run in the request path.
import { createReadStream, existsSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

// Process at most this many input rows (0 = no cap — only if you have the RAM).
const MAX_LINES = Number(process.env.MAX_LINES ?? 1_000_000);

// Pick the input file: explicit env override, else gzip, else plain TSV.
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
  console.error('[seed] Download it with:');
  console.error('         https://msmarco.z22.web.core.windows.net/msmarcoranking/orcas.tsv.gz');
  console.error('[seed] then place it at server/data/orcas.tsv.gz and re-run `npm run seed`.');
  process.exit(1);
}

const insert = db.prepare(`
  INSERT INTO queries (term, display_term, count, last_searched_at)
  VALUES (@term, @displayTerm, @count, NULL)
`);

// All inserts in one transaction (fast bulk load). Wipe first so re-seeding is
// idempotent and never double-counts.
const seedAll = db.transaction((rows) => {
  db.exec('DELETE FROM queries');
  try {
    db.exec("DELETE FROM sqlite_sequence WHERE name = 'queries'");
  } catch {
    // sqlite_sequence only exists after the first AUTOINCREMENT insert; ignore.
  }
  for (const row of rows) insert.run(row);
});

async function run() {
  const start = Date.now();
  console.log(`[seed] reading ${inputPath}`);
  if (MAX_LINES > 0) console.log(`[seed] processing first ${MAX_LINES.toLocaleString()} rows (set MAX_LINES to change)`);

  // Stream the file; gunzip on the fly if it's a .gz so we never materialize the
  // full ~2 GB uncompressed file on disk or in memory.
  let input = createReadStream(inputPath);
  if (inputPath.endsWith('.gz')) input = input.pipe(createGunzip());
  const rl = createInterface({ input, crlfDelay: Infinity });

  // Aggregate query -> { displayTerm, count }. Key is the normalized term;
  // queries that differ only by casing collapse here and their counts SUM (the
  // same case-collision merge we always had — now it's just natural aggregation).
  const agg = new Map();
  let lines = 0;
  let skipped = 0;

  for await (const line of rl) {
    if (MAX_LINES > 0 && lines >= MAX_LINES) break;
    lines++;

    // Extract column index 1 (`query`) cheaply: it's between the 1st and 2nd tab.
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
    const cur = agg.get(term);
    if (cur) {
      cur.count += 1;
    } else {
      agg.set(term, { displayTerm: query, count: 1 });
    }
  }
  rl.close();
  input.destroy();

  const capped = MAX_LINES > 0 && lines >= MAX_LINES;

  const rows = [];
  for (const [term, { displayTerm, count }] of agg) {
    rows.push({ term, displayTerm, count });
  }

  seedAll(rows);

  const range = db.prepare('SELECT MIN(count) AS lo, MAX(count) AS hi FROM queries').get();
  const ms = Date.now() - start;
  console.log('[seed] done:');
  console.log(`         rows read          : ${lines.toLocaleString()}${capped ? ' (capped by MAX_LINES)' : ' (whole file)'}`);
  console.log(`         rows skipped (bad) : ${skipped}`);
  console.log(`         distinct queries   : ${rows.length.toLocaleString()}`);
  console.log(`         count range        : ${range.lo} .. ${range.hi}`);
  console.log(`         elapsed            : ${ms} ms`);
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
