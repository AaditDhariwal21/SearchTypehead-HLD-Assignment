// POST /search   body: { "query": "<term>" }
//
// Records a search submission and returns a dummy { message: "Searched" }.
//
// Step 6: this no longer writes to SQLite inline. It appends the submission to
// the in-memory batch buffer and returns IMMEDIATELY — the actual count update
// happens later in an aggregated batch flush (see batch/searchBuffer.js). This
// is the optimized counterpart to step 4's naive per-request write; /metrics
// exposes the resulting write-volume reduction.
import { Router } from 'express';
import { enqueue } from '../batch/searchBuffer.js';

const router = Router();

router.post('/search', (req, res) => {
  const raw = req.body?.query;

  // A submission must carry a non-empty string query (rejected before it ever
  // reaches the buffer, so bad requests don't pollute the write metrics).
  if (typeof raw !== 'string' || raw.trim() === '') {
    return res.status(400).json({ message: 'query is required' });
  }

  // Same normalization as seed/suggest: lowercased+trimmed match key, original
  // casing preserved for the new-term insert path.
  const displayTerm = raw.trim();
  const term = displayTerm.toLowerCase();

  enqueue({ term, displayTerm, timestamp: new Date().toISOString() });

  // Return immediately — the count update is deferred to the batch flusher.
  res.json({ message: 'Searched' });
});

export default router;
