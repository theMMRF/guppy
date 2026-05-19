const DEFAULT_NOW = () => Date.now();

export const stableStringify = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const buildQueryCacheKey = ({ esIndex, esType, queryBody }) => (
  stableStringify({ esIndex, esType, queryBody })
);

export class QueryCache {
  constructor({
    ttlMs = 60000,
    maxSize = 256,
    now = DEFAULT_NOW,
    logger = null,
  } = {}) {
    this.ttlMs = Number(ttlMs) || 0;
    this.maxSize = Number(maxSize) || 0;
    this.now = now;
    this.logger = logger;
    this.inFlight = new Map();
    this.cache = new Map();
  }

  isEnabled() {
    return this.ttlMs > 0 && this.maxSize > 0;
  }

  clear() {
    this.inFlight.clear();
    this.cache.clear();
  }

  getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      this.log('evict', key, 'expired');
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);
    this.log('hit', key);
    return entry.value;
  }

  setCached(key, value) {
    this.cache.set(key, {
      value,
      expiresAt: this.now() + this.ttlMs,
    });

    while (this.cache.size > this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.log('evict', oldestKey, 'max_size');
    }
  }

  async run({ esIndex, esType, queryBody }, fetcher) {
    if (!this.isEnabled()) {
      return fetcher();
    }

    const key = buildQueryCacheKey({ esIndex, esType, queryBody });
    const cached = this.getCached(key);
    if (typeof cached !== 'undefined') {
      return cached;
    }

    if (this.inFlight.has(key)) {
      this.log('dedupe', key);
      return this.inFlight.get(key);
    }

    this.log('miss', key);
    const promise = Promise.resolve()
      .then(fetcher)
      .then((value) => {
        this.setCached(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  log(event, key, reason) {
    if (!this.logger || typeof this.logger.debug !== 'function') {
      return;
    }
    const suffix = reason ? ` reason:${reason}` : '';
    this.logger.debug(`[ES.queryCache] ${event}${suffix}. key:${key}`);
  }
}

export default QueryCache;
