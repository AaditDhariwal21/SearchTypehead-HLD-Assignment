// Server entry point.
//
// Wires up the routes and starts the batch-write flusher. Routes by step:
//   step 2 -> GET  /suggest
//   step 4 -> POST /search
//   step 5 -> GET  /cache/debug
//   step 6 -> GET  /metrics  + batch flusher
//   step 8 -> /metrics (latency, hit rate) + structured logging
import express from 'express';
import './db.js'; // side-effect import: opens the connection + applies schema
import cache from './cache/index.js';
import suggestRouter from './routes/suggest.js';
import searchRouter from './routes/search.js';
import cacheDebugRouter from './routes/cacheDebug.js';
import metricsRouter from './routes/metrics.js';
import { startFlusher, flush, stopFlusher } from './batch/searchBuffer.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Parse JSON request bodies (needed by POST /search).
app.use(express.json());

// --- routes ---
app.use(suggestRouter); //    GET  /suggest      (step 2)
app.use(searchRouter); //     POST /search       (step 4, batched in step 6)
app.use(cacheDebugRouter); // GET  /cache/debug  (step 5)
app.use(metricsRouter); //    GET  /metrics      (step 6)

// Start the background batch-write flusher.
startFlusher();

const server = app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

// Graceful shutdown: on a clean signal, flush whatever is still buffered so a
// normal restart loses nothing, then close Redis connections cleanly. (A hard
// crash still loses the buffer — the documented trade-off in searchBuffer.js.)
// Now async: the final flush awaits its Redis invalidations so we don't leave
// stale entries behind that would survive into the next run.
async function shutdown(signal) {
  console.log(`[server] ${signal} received — flushing buffer and shutting down`);
  stopFlusher();
  try {
    await flush('shutdown');
    await cache.close();
  } catch (err) {
    console.error('[server] error during shutdown flush:', err.message);
  }
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
