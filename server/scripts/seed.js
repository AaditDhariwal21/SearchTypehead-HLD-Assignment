// Seed script — loads server/data/queries.csv into the `queries` table.
//
// Run with:  npm run seed
//
// This is intentionally a SEPARATE script, not part of the request path: seeding
// 150k rows is a one-time bulk operation and has no business happening while the
// server is serving traffic.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import db from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSV_PATH = join(__dirname, '..', 'data', 'queries.csv');

if (!existsSync(CSV_PATH)) {
  console.error(`[seed] CSV not found at ${CSV_PATH}`);
  console.error('[seed] Place your {query,count} CSV there and re-run `npm run seed`.');
  process.exit(1);
}

// --- CSV parsing -----------------------------------------------------------
// We avoid a CSV-parser dependency. The only structural assumption we rely on is
// that `count` is ALWAYS the final column and is a plain integer. That lets us
// split on the LAST comma, so unquoted commas inside Wikipedia titles
// (e.g. "Boston, Massachusetts") are handled correctly without quoting — the
// title is "everything before the last comma", the count is "everything after".
// If a title field happens to be quoted, we strip the surrounding quotes and
// un-double any escaped quotes ("" -> ").
function parseLine(line) {
  const idx = line.lastIndexOf(',');
  if (idx === -1) return null;

  let displayTerm = line.slice(0, idx).trim();
  const rawCount = line.slice(idx + 1).trim();

  if (displayTerm.startsWith('"') && displayTerm.endsWith('"')) {
    displayTerm = displayTerm.slice(1, -1).replace(/""/g, '"');
  }

  const count = parseInt(rawCount, 10);
  if (!displayTerm || !Number.isInteger(count)) return null;

  // term = normalized (lowercased + trimmed) match key; displayTerm keeps casing.
  return { term: displayTerm.toLowerCase(), displayTerm, count };
}

// --- upsert with case-collision merge --------------------------------------
// Two source rows can differ only by casing (the dataset is case-sensitively
// unique but NOT case-insensitively unique). After lowercasing they collide on
// the same `term`. ON CONFLICT(term) sums their counts rather than overwriting,
// so no views are lost. For display_term we keep the casing of the LARGER
// contributor (more views == more "canonical" surface form); this only needs to
// be consistent, not globally deterministic.
const upsert = db.prepare(`
  INSERT INTO queries (term, display_term, count, last_searched_at)
  VALUES (@term, @displayTerm, @count, NULL)
  ON CONFLICT(term) DO UPDATE SET
    count = queries.count + excluded.count,
    display_term = CASE
      WHEN excluded.count > queries.count THEN excluded.display_term
      ELSE queries.display_term
    END
`);

function run() {
  const start = Date.now();
  console.log(`[seed] reading ${CSV_PATH}`);

  const raw = readFileSync(CSV_PATH, 'utf8');
  // Handle both \n and \r\n line endings; drop a trailing empty line.
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);

  // Skip the header row if present (spec says header is exactly "query,count").
  let startIdx = 0;
  if (lines.length && lines[0].trim().toLowerCase() === 'query,count') {
    startIdx = 1;
  }

  let rowsRead = 0;
  let skipped = 0;

  // Make seeding idempotent: a clean slate every run so re-seeding never
  // double-counts. Wrapped with the inserts in one transaction below.
  const seedAll = db.transaction(() => {
    db.exec('DELETE FROM queries');
    try {
      db.exec("DELETE FROM sqlite_sequence WHERE name = 'queries'");
    } catch {
      // sqlite_sequence only exists once an AUTOINCREMENT row has been written;
      // safe to ignore on a fresh DB.
    }

    for (let i = startIdx; i < lines.length; i++) {
      const parsed = parseLine(lines[i]);
      if (!parsed) {
        skipped++;
        continue;
      }
      rowsRead++;
      upsert.run(parsed);
    }
  });

  seedAll();

  // Merged-collision count = data rows we inserted minus distinct terms left.
  // (Reported so it can be cited in a viva.)
  const uniqueTerms = db.prepare('SELECT COUNT(*) AS n FROM queries').get().n;
  const merged = rowsRead - uniqueTerms;
  const range = db
    .prepare('SELECT MIN(count) AS lo, MAX(count) AS hi FROM queries')
    .get();

  const ms = Date.now() - start;
  console.log('[seed] done:');
  console.log(`         data rows read     : ${rowsRead}`);
  console.log(`         rows skipped (bad) : ${skipped}`);
  console.log(`         distinct terms     : ${uniqueTerms}`);
  console.log(`         case-collisions    : ${merged} merged (counts summed)`);
  console.log(`         count range        : ${range.lo} .. ${range.hi}`);
  console.log(`         elapsed            : ${ms} ms`);
}

run();
