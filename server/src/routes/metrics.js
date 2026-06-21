// GET /metrics
//
// One place to read the system's health/evidence:
//   - suggestLatencyMs : p50/p95/p99 over the last 1000 /suggest requests
//   - cache            : hit rate per node and overall
//   - writes           : /search calls vs actual SQL writes (batch reduction)
import { Router } from 'express';
import { snapshot } from '../metrics.js';
import { size } from '../batch/searchBuffer.js';

const router = Router();

router.get('/metrics', (req, res) => {
  const snap = snapshot();

  // Augment the writes section with the live buffer depth and the reduction %
  // vs the naive "one SQL write per /search" baseline. (Done here rather than in
  // metrics.js so that module stays free of a searchBuffer import / cycle.)
  const { searchCalls, sqlWrites } = snap.writes;
  snap.writes.bufferedPending = size();
  snap.writes.writeReductionPct =
    searchCalls > 0 ? +(100 * (1 - sqlWrites / searchCalls)).toFixed(1) : 0;

  res.json(snap);
});

export default router;
