/**
 * One git write at a time, app-wide.
 *
 * Two writes racing in the same repo collide on `index.lock`; two in different
 * repos make the busy indicator lie (the first to finish clears it). Every
 * write — toolbar, context menu, badge, prune — goes through here.
 *
 * The background fetch is not a write the user asked for, so it yields: it is
 * skipped while a write holds the lock, and a write started during a fetch
 * waits for it to finish instead of being refused.
 */
export class GitLock {
  private holder: string | null = null;
  private background: Promise<unknown> | null = null;

  /** Label of the write holding the lock, or null. */
  get busy(): string | null {
    return this.holder;
  }

  get backgroundRunning(): boolean {
    return this.background !== null;
  }

  /**
   * Run a write under the lock. Returns null, without running it, when another
   * write already holds the lock.
   */
  async run<T>(label: string, fn: () => Promise<T>): Promise<{ value: T } | null> {
    if (this.holder !== null) return null;
    this.holder = label;
    try {
      // Let a fetch in flight land first: fetch and pull both write refs.
      if (this.background) await this.background.catch(() => undefined);
      return { value: await fn() };
    } finally {
      this.holder = null;
    }
  }

  /**
   * Run a background task unless a write or another background task is
   * running. Returns false when skipped.
   */
  async runBackground(fn: () => Promise<unknown>): Promise<boolean> {
    if (this.holder !== null || this.background !== null) return false;
    const task = fn();
    this.background = task;
    try {
      await task;
    } finally {
      this.background = null;
    }
    return true;
  }
}
