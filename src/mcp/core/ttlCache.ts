// A small keyed cache for results that are slow to produce and change rarely,
// such as the boards `west boards` lists. Concurrent callers of one key share a
// single load, so ten agent calls in a row start west once, and a failed load
// is never stored, so the next call simply tries again.

export interface CacheResult<T> {
  value: T;
  /** True when the value came from the cache rather than a load this call waited on. */
  cached: boolean;
  /** When the value was produced, in milliseconds since the epoch. */
  storedAt: number;
}

interface Entry<T> {
  value: T;
  storedAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly loading = new Map<string, Promise<Entry<T>>>();
  private readonly now: () => number;

  constructor(private readonly options: { ttlMs: number; maxEntries: number; now?: () => number }) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The value for `key`: from the cache while it is younger than the TTL,
   * otherwise from `load`. A load already running is joined by every caller,
   * because it is fresh by definition: a refresh does not start a second one,
   * and a plain call made during a refresh gets the refreshed value, not the
   * one the refresh replaces. `refresh` drops the stored value as its load
   * starts, so if that load fails the next call loads again rather than
   * getting the old value back.
   */
  get(key: string, load: () => Promise<T>, refresh = false): Promise<CacheResult<T>> {
    let running = this.loading.get(key);
    if (!running) {
      const entry = this.entries.get(key);
      if (!refresh && entry && this.now() - entry.storedAt < this.options.ttlMs) {
        return Promise.resolve({ value: entry.value, cached: true, storedAt: entry.storedAt });
      }
      if (refresh) {
        this.entries.delete(key);
      }
      running = this.start(key, load);
    }
    return running.then(entry => ({ value: entry.value, cached: false, storedAt: entry.storedAt }));
  }

  private start(key: string, load: () => Promise<T>): Promise<Entry<T>> {
    // `load` runs on a later tick, so even one that throws synchronously is
    // registered first and then cleared, never left behind as a stuck load.
    const running = Promise.resolve()
      .then(load)
      .then(value => {
        const entry = { value, storedAt: this.now() };
        this.store(key, entry);
        return entry;
      })
      .finally(() => this.loading.delete(key));
    this.loading.set(key, running);
    return running;
  }

  private store(key: string, entry: Entry<T>): void {
    // Re-inserting moves the key to the end, so the first key is always the
    // least recently stored one and is what goes when the cache is full.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }
}
