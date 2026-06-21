// Minimal structured logger — no dependency, just a tagged + timestamped line.
//
// Format:  <ISO-timestamp> [<category>] <message>
// e.g.     2026-06-21T16:40:04.932Z [hash-ring] route key="basic:you" -> node-0
//
// WHY categories: every log line is tagged with a category so the server output
// can be grepped for one kind of evidence at a time, e.g.
//   node src/index.js | grep '\[hash-ring\]'   # consistent-hash routing
//   ... | grep '\[cache\]'                      # hit/miss behavior
//   ... | grep '\[batch-write\]'                # flush activity
// Categories in use: 'cache', 'hash-ring', 'batch-write'.
export function log(category, message) {
  console.log(`${new Date().toISOString()} [${category}] ${message}`);
}
