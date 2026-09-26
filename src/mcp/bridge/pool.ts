// One upstream connection per VS Code window.
//
// A single agent session can drive apps open in different windows, so the
// bridge keeps a connection per window rather than one global one, and a
// failure in one window never tears down another. Calls hold a lease: a
// connection that failed for one call is replaced for new calls, but closed
// only once the calls still running on it have finished.

import { WindowRecord } from '../core/registry';

export interface Closable {
  close(): Promise<void>;
}

interface Entry<C> {
  /** Port and token: a window that restarted gets a new entry. */
  key: string;
  promise: Promise<C>;
  client?: C;
  leases: number;
  retired: boolean;
}

export interface Lease<C> {
  client: C;
  release(): void;
}

const keyOf = (record: WindowRecord) => `${record.port}:${record.token}`;

export class ConnectionPool<C extends Closable> {
  private readonly entries = new Map<string, Entry<C>>();
  private readonly retiring = new Set<Entry<C>>();

  constructor(private readonly connect: (record: WindowRecord) => Promise<C>) {}

  /** True when a connection to exactly this record is up, so no probe is needed. */
  isKnownGood(record: WindowRecord): boolean {
    const entry = this.entries.get(record.windowId);
    return !!entry?.client && entry.key === keyOf(record);
  }

  /** The connection for this window, created once even under concurrent calls. */
  get(record: WindowRecord): Promise<C> {
    return this.entryFor(record).promise;
  }

  /** The connection plus a lease that keeps it open until released. */
  async acquire(record: WindowRecord): Promise<Lease<C>> {
    const entry = this.entryFor(record);
    entry.leases++;
    try {
      const client = await entry.promise;
      let released = false;
      return {
        client,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          entry.leases--;
          this.closeIfIdle(entry);
        },
      };
    } catch (error) {
      entry.leases--;
      throw error;
    }
  }

  private entryFor(record: WindowRecord): Entry<C> {
    const key = keyOf(record);
    const existing = this.entries.get(record.windowId);
    if (existing?.key === key) {
      return existing;
    }
    if (existing) {
      // The window restarted on a new port or token.
      this.retire(record.windowId, existing);
    }
    const entry: Entry<C> = { key, promise: this.connect(record), leases: 0, retired: false };
    this.entries.set(record.windowId, entry);
    entry.promise.then(
      client => {
        entry.client = client;
        this.closeIfIdle(entry);
      },
      () => {
        if (this.entries.get(record.windowId) === entry) {
          this.entries.delete(record.windowId);
        }
      },
    );
    return entry;
  }

  /**
   * Stop handing out a window's connection. With `failed`, only when it is
   * still the connection that failed: a concurrent call may have replaced it.
   * Calls already running on it finish first.
   */
  drop(windowId: string, failed?: C): void {
    const entry = this.entries.get(windowId);
    if (!entry || (failed && entry.client !== failed)) {
      return;
    }
    this.retire(windowId, entry);
  }

  private retire(windowId: string, entry: Entry<C>): void {
    if (this.entries.get(windowId) === entry) {
      this.entries.delete(windowId);
    }
    entry.retired = true;
    this.retiring.add(entry);
    this.closeIfIdle(entry);
  }

  private closeIfIdle(entry: Entry<C>): void {
    if (!entry.retired || entry.leases > 0 || !this.retiring.has(entry)) {
      return;
    }
    this.retiring.delete(entry);
    void entry.promise.then(client => client.close()).catch(() => undefined);
  }

  get size(): number {
    return this.entries.size;
  }

  async closeAll(): Promise<void> {
    const entries = [...this.entries.values(), ...this.retiring];
    this.entries.clear();
    this.retiring.clear();
    await Promise.all(entries.map(entry => entry.promise.then(client => client.close()).catch(() => undefined)));
  }
}
