// Runs async work one at a time per key.
//
// Every workbench settings writer rewrites a whole array (all build
// configurations, or all applications of a west workspace), so two agent calls
// writing the same settings file at once would silently drop one change. Work
// under one key waits for the previous work under that key to settle, whether
// it succeeded or not. Free of `vscode` so it is unit tested.

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const done = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => done);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      // Forget the key once nothing is queued behind this work.
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** True while work holds or waits for the key. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
