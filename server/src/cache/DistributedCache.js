// Distributed cache over 3 real Redis instances (one per "node"), with cache
// KEYS routed to a node by the consistent-hash ring. The ring is UNCHANGED — it
// still decides which node id owns a key. What changed vs the old Map-based
// version: a node is now a Redis client, so get/set/peek/invalidate are async
// Redis GET/SET/DEL calls, and TTL is Redis-native (PX) instead of a manual
// cachedAt timestamp.
import { ConsistentHashRing } from './ConsistentHashRing.js';
import { log } from '../logger.js';
import { registerCacheNode, recordCacheLookup, recordCacheError } from '../metrics.js';

// Ranking modes share the cache-node structure but live in SEPARATE key
// namespaces: "basic:<prefix>" vs "trending:<prefix>" — unchanged from before.
export const CACHE_NAMESPACES = ['basic', 'trending'];
export const cacheKey = (mode, prefix) => `${mode}:${prefix}`;

// TTL = 60s. Rationale unchanged: popularity drifts slowly, so a short TTL keeps
// results fresh while absorbing repeated prefixes, and self-heals any missed
// invalidation within 60s. Now enforced by Redis itself via SET ... PX.
const DEFAULT_TTL_MS = 60_000;

export class DistributedCache {
  // nodes: [{ id, client }, ...] — `client` is an ioredis instance.
  constructor(nodes, ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.ring = new ConsistentHashRing(nodes.map((n) => n.id));
    // nodeId -> ioredis client
    this.clients = new Map();
    for (const { id, client } of nodes) {
      this.clients.set(id, client);
      registerCacheNode(id); // so every node shows in /metrics even at 0 traffic
    }
  }

  ownerOf(key) {
    return this.ring.getNode(key);
  }

  // Real lookup path (used by /suggest). Returns the cached results on a hit, or
  // null on a miss OR a Redis error — in BOTH null cases the caller falls back to
  // SQLite. The two are logged/counted differently so a down node is visible.
  async get(key) {
    const nodeId = this.ownerOf(key);
    // Routing decision under 'hash-ring' — greppable proof the ring maps this key
    // (deterministically) to this node. (Same as before; ring is unchanged.)
    log('hash-ring', `route key="${key}" hash=${this.ring.hash(key)} -> ${nodeId}`);

    const client = this.clients.get(nodeId);
    let raw;
    try {
      raw = await client.get(key);
    } catch (err) {
      // Node unreachable: don't count as a hit/miss; surface it and fall back.
      recordCacheError(nodeId);
      log('cache', `lookup key="${key}" node=${nodeId} ERROR -> SQLite fallback (${err.message})`);
      return null;
    }

    const hit = raw !== null; // a Redis GET returning null IS the miss
    recordCacheLookup(nodeId, hit);
    log('cache', `lookup key="${key}" node=${nodeId} ${hit ? 'HIT' : 'MISS'}`);
    return hit ? JSON.parse(raw) : null;
  }

  // Store results under the key's owning node with Redis-native TTL (PX = ms).
  // Errors are swallowed (best-effort): if the node is down we simply don't
  // cache — the request already has its result from SQLite.
  async set(key, results) {
    const nodeId = this.ownerOf(key);
    try {
      await this.clients.get(nodeId).set(key, JSON.stringify(results), 'PX', this.ttlMs);
    } catch (err) {
      recordCacheError(nodeId);
    }
  }

  // Pure inspection for /cache/debug. A Redis GET does not mutate state, so this
  // stays non-destructive. We report remaining TTL (PTTL) instead of the old
  // cachedAt, since Redis owns expiry now. Does NOT record hit-rate metrics —
  // debug must not perturb the numbers it reports on.
  async peek(key) {
    const nodeId = this.ownerOf(key);
    const client = this.clients.get(nodeId);
    try {
      const raw = await client.get(key);
      const hit = raw !== null;
      const ttlMs = hit ? await client.pttl(key) : null;
      return { node: nodeId, status: hit ? 'hit' : 'miss', ttlMs };
    } catch (err) {
      return { node: nodeId, status: 'error', ttlMs: null };
    }
  }

  // Invalidate every cached prefix of `term`, in BOTH namespaces, each on its
  // owning node — now via Redis DEL. Logic for WHICH keys to clear is identical
  // to before; only the storage call changed (Map.delete -> client.del).
  // DEL returns the number of keys removed, so we log only keys that existed.
  async invalidateTerm(term) {
    const ops = [];
    for (let len = 1; len <= term.length; len++) {
      const prefix = term.slice(0, len);
      for (const ns of CACHE_NAMESPACES) {
        const key = cacheKey(ns, prefix);
        const nodeId = this.ownerOf(key);
        const client = this.clients.get(nodeId);
        ops.push(
          client
            .del(key)
            .then((removed) => (removed > 0 ? `${key}@${nodeId}` : null))
            .catch(() => {
              recordCacheError(nodeId);
              return null;
            }),
        );
      }
    }

    const invalidated = (await Promise.all(ops)).filter(Boolean);
    if (invalidated.length) {
      log('cache', `invalidate term="${term}" -> ${invalidated.join(', ')}`);
    }
    return invalidated;
  }

  // Close all node connections (called on graceful shutdown).
  async close() {
    await Promise.all([...this.clients.values()].map((c) => c.quit().catch(() => {})));
  }
}
