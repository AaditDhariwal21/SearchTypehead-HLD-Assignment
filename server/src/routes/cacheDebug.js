// GET /cache/debug?prefix=<prefix>[&mode=basic|trending]
//
// Inspection endpoint: reports which cache node owns the (namespaced) key and
// whether it's currently a hit or miss — WITHOUT consuming or mutating cache
// state. It uses cache.peek(), a plain Redis GET (non-mutating) plus PTTL for
// the remaining time-to-live, so you can poll it freely without perturbing what
// you're observing. status is 'hit' | 'miss' | 'error' (node unreachable).
//
// `mode` selects the namespace to inspect (default basic), since basic and
// trending results for the same prefix are cached as separate keys that may even
// live on different nodes.
import { Router } from 'express';
import cache, { cacheKey } from '../cache/index.js';

const router = Router();

router.get('/cache/debug', async (req, res) => {
  const raw = req.query.prefix;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return res.status(400).json({ message: 'prefix is required' });
  }

  const mode = req.query.mode === 'trending' ? 'trending' : 'basic';

  // Normalize identically to /suggest so we inspect the SAME key that /suggest
  // would actually cache and route.
  const prefix = raw.trim().toLowerCase();
  const key = cacheKey(mode, prefix);

  const { node, status, ttlMs } = await cache.peek(key);
  res.json({ prefix, mode, cacheKey: key, node, status, ttlMs });
});

export default router;
