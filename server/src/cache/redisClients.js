// Builds one ioredis client per simulated cache node.
//
// Node host/port come from ENVIRONMENT VARIABLES with sensible localhost
// defaults, so the SAME code works in three situations:
//   - via Docker Compose: env points at service names (redis-node-0:6379, ...)
//   - via `npm run dev` with 3 local Redis on 6379/6380/6381
//   - via `npm run dev` with NO Redis at all: connections fail, every request
//     falls back to SQLite (see DistributedCache) — degraded but not broken.
import Redis from 'ioredis';
import { log } from '../logger.js';

// id -> the env var names + default host/port for that node.
const NODE_DEFS = [
  { id: 'node-0', hostEnv: 'REDIS_NODE_0_HOST', portEnv: 'REDIS_NODE_0_PORT', defaultPort: 6379 },
  { id: 'node-1', hostEnv: 'REDIS_NODE_1_HOST', portEnv: 'REDIS_NODE_1_PORT', defaultPort: 6380 },
  { id: 'node-2', hostEnv: 'REDIS_NODE_2_HOST', portEnv: 'REDIS_NODE_2_PORT', defaultPort: 6381 },
];

export function createRedisNodes() {
  return NODE_DEFS.map(({ id, hostEnv, portEnv, defaultPort }) => {
    const host = process.env[hostEnv] || '127.0.0.1';
    const port = Number(process.env[portEnv] || defaultPort);

    const client = new Redis({
      host,
      port,
      // enableOfflineQueue:false is the key to clean fallback — when the node is
      // down, commands REJECT immediately instead of queueing forever, so the
      // request handler can fall back to SQLite without hanging.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1000,
      // Keep trying to reconnect in the background with a capped backoff, so the
      // node automatically rejoins once its Redis comes back.
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });

    // Log connection state changes ONCE per transition (not per failed retry),
    // so a down node produces one clear line, not a flood.
    let down = false;
    client.on('ready', () => {
      down = false;
      log('cache', `redis ${id} connected (${host}:${port})`);
    });
    client.on('error', (err) => {
      if (!down) {
        down = true;
        log('cache', `redis ${id} UNREACHABLE (${host}:${port}) — falling back to SQLite: ${err.message}`);
      }
    });

    return { id, host, port, client };
  });
}
