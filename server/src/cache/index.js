// Process-wide singleton cache, shared by /suggest (reads), /search-flush
// (invalidation), and /cache/debug (inspection). Backed by 3 real Redis nodes,
// configured from environment variables (see redisClients.js).
import { DistributedCache } from './DistributedCache.js';
import { createRedisNodes } from './redisClients.js';

const cache = new DistributedCache(createRedisNodes());

// Re-export the key helpers so routes build cache keys the same way everywhere.
export { cacheKey, CACHE_NAMESPACES } from './DistributedCache.js';
export default cache;
