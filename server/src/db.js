// Single shared SQLite connection for the whole process.
//
// better-sqlite3 is synchronous by design. For a local, read-heavy demo at this
// scale (a few hundred thousand rows, single process) that is a feature, not a
// limitation: no callback/promise plumbing, queries are simple function calls, and the logic
// stays linear and easy to read in a viva. There is no separate DB server to run.
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB path is configurable via DB_PATH. WHY: under Docker Desktop on Windows/Mac,
// a SQLite file on a BIND MOUNT gets unreliable file locking (the gRPC-FUSE /
// virtiofs layer doesn't fully support the POSIX locks SQLite needs), causing
// intermittent SQLITE_CANTOPEN / IOERR. So in Docker we set DB_PATH to a NAMED
// VOLUME (a real Linux filesystem); locally it defaults to server/data/app.db.
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'app.db');

// better-sqlite3 will NOT create missing parent directories — if the target dir
// doesn't exist it fails with SQLITE_CANTOPEN. Ensure it exists first (idempotent).
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// PRAGMAs — chosen for a read-heavy workload and explainable in a viva:
//   WAL: readers don't block the writer and vice-versa. /suggest is almost all
//        reads, so this keeps suggestion lookups fast even while /search writes.
//   synchronous = NORMAL: the standard, safe-with-WAL durability/speed trade-off
//        (a crash can lose the last transaction but never corrupts the DB).
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Apply the schema on every startup. CREATE TABLE IF NOT EXISTS is idempotent,
// so both the server and the seed script can safely call into this module and be
// guaranteed the table exists before they touch it.
const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

export default db;
