/**
 * Simple in-memory TTL cache.
 */
export class TTLCache {
  #store = new Map();

  set(key, value, ttlMs = 60_000) {
    this.#store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  get(key) {
    const entry = this.#store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.#store.delete(key);
      return null;
    }
    return entry.value;
  }

  has(key) { return this.get(key) !== null; }
  delete(key) { this.#store.delete(key); }

  cleanup() {
    const now = Date.now();
    for (const [k, v] of this.#store) {
      if (now > v.expiresAt) this.#store.delete(k);
    }
  }

  get size() { return this.#store.size; }
}
