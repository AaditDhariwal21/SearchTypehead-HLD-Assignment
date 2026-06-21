// Consistent-hash ring with virtual nodes.
//
// WHY consistent hashing (vs. `hash(key) % N`):
//   Plain modulo remaps almost EVERY key when the node count changes
//   (add/remove a cache node -> nearly the whole cache is invalidated). A hash
//   ring only remaps the keys in the arc owned by the node that joined/left —
//   O(keys / nodes) churn instead of O(keys). For a cache that's the whole point.
//
// WHY virtual nodes (vnodes):
//   With only one ring point per physical node, 3 nodes land at 3 random spots
//   and the arcs between them are wildly uneven — one node can own 60% of the
//   keyspace. Giving each physical node MANY points (here 100) averages those
//   arcs out, so load is distributed evenly. More vnodes -> smoother distribution.
export class ConsistentHashRing {
  constructor(nodeIds, vnodesPerNode = 100) {
    this.vnodesPerNode = vnodesPerNode;
    this.nodeIds = [];
    // ring: array of { hash, nodeId }, kept sorted by hash ascending so we can
    // binary-search the owner of any key.
    this.ring = [];
    for (const id of nodeIds) this.addNode(id);
  }

  addNode(nodeId) {
    this.nodeIds.push(nodeId);
    for (let v = 0; v < this.vnodesPerNode; v++) {
      // Each vnode is a distinct point on the ring derived from "<node>#<v>".
      this.ring.push({ hash: this._hash(`${nodeId}#${v}`), nodeId });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  // Owner of `key` = the first vnode walking clockwise from hash(key),
  // wrapping around the end of the ring back to the start.
  getNode(key) {
    if (this.ring.length === 0) return null;
    const h = this._hash(key);

    // Past the last point on the ring -> wrap to the first (the ring is circular).
    if (h > this.ring[this.ring.length - 1].hash) return this.ring[0].nodeId;

    // Binary search: lowest index whose vnode hash >= h.
    let lo = 0;
    let hi = this.ring.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ring[mid].hash >= h) hi = mid;
      else lo = mid + 1;
    }
    return this.ring[lo].nodeId;
  }

  // Public accessor for a key's hash — used only for logging the routing
  // decision (the ring class itself stays logging-free / easy to unit-test).
  hash(key) {
    return this._hash(key);
  }

  // FNV-1a (32-bit) followed by an avalanche finalizer.
  //
  // WHY the finalizer: plain FNV-1a over short, near-identical strings
  // ("node-0#0", "node-0#1", ...) barely changes the low bits, so the vnode
  // positions CLUSTER and the ring arcs come out lopsided (one node ending up
  // with ~50% of the keyspace in testing). The finalizer is a well-known
  // bit-mixing step (xor-shift + multiply) that scrambles those bits so similar
  // inputs land far apart on the ring — turning ~50/27/22 into a tight ~33/33/33.
  // We don't need cryptographic strength, just good spread. Math.imul does the
  // 32-bit multiply; >>> 0 keeps everything an unsigned 32-bit integer.
  _hash(str) {
    let h = 0x811c9dc5; // FNV offset basis
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193); // FNV prime
    }
    // Avalanche finalizer (from the integer-hash "prospector" family).
    h ^= h >>> 16;
    h = Math.imul(h, 0x21f0aaad);
    h ^= h >>> 15;
    h = Math.imul(h, 0x735a2d97);
    h ^= h >>> 15;
    return h >>> 0;
  }
}
