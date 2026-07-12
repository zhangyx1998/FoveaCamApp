// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Latest-value write coalescer for high-rate control edits (slider drags).
// One instance per device serializes writes (GenICam handles concurrent
// writes badly): at most one `write` in flight; while it runs, newer values
// per key overwrite the queued one, so intermediates are dropped but the
// final value always lands. Accepted values are persisted on a trailing
// debounce — a rejected write never schedules a persist, so a dropped or
// refused intermediate can never be persisted over a newer accepted one.
// Pure: no camera/store imports; every effect is an injected hook.

export type CoalescedWriterHooks<V> = {
  /** Apply one value to the device. Throw/reject = the device refused it. */
  write: (key: string, value: V) => void | Promise<void>;
  /** Runs after every settled `write` (`error` undefined on success) — the
   *  targeted read-back/publish hook. Must not throw. */
  onResult?: (key: string, value: V, error?: unknown) => void;
  /** Persist an accepted value; called per key on the trailing debounce (and
   *  on `dispose`), serialized in acceptance order. */
  persist: (key: string, value: V) => void | Promise<void>;
  /** `persist` rejections land here (they never break the chain). */
  onPersistError?: (key: string, value: V, error: unknown) => void;
  /** Trailing debounce for `persist`, ms. */
  persistDelay?: number;
};

export class CoalescedWriter<V = unknown> {
  private pending = new Map<string, V>();
  private pumping = false;
  private disposed = false;
  private persists = new Map<string, { value: V; timer: ReturnType<typeof setTimeout> }>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private hooks: CoalescedWriterHooks<V>) {}

  /** Queue `value` for `key`, replacing any not-yet-written older value. */
  submit(key: string, value: V): void {
    if (this.disposed) return;
    this.pending.set(key, value);
    if (!this.pumping) void this.pump();
  }

  /** Drop queued writes AND pending persists without flushing (e.g. a device
   *  reset that supersedes everything in flight). */
  clear(): void {
    this.pending.clear();
    for (const { timer } of this.persists.values()) clearTimeout(timer);
    this.persists.clear();
  }

  /** Stop accepting writes, drop queued ones, flush pending persists. An
   *  in-flight write that still succeeds persists immediately (no trailing
   *  wait) — it landed on the device, so it must land in the store. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pending.clear();
    for (const key of [...this.persists.keys()]) this.flushPersist(key);
    await this.persistChain;
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    try {
      while (!this.disposed && this.pending.size > 0) {
        const [key, value] = this.pending.entries().next().value as [string, V];
        this.pending.delete(key);
        let error: unknown;
        let ok = true;
        try {
          await this.hooks.write(key, value);
        } catch (err) {
          ok = false;
          error = err;
        }
        if (ok) this.schedulePersist(key, value);
        this.hooks.onResult?.(key, value, error);
      }
    } finally {
      this.pumping = false;
    }
  }

  private schedulePersist(key: string, value: V): void {
    const prev = this.persists.get(key);
    if (prev) clearTimeout(prev.timer);
    if (this.disposed) {
      this.persists.delete(key);
      this.enqueuePersist(key, value);
      return;
    }
    const timer = setTimeout(() => this.flushPersist(key), this.hooks.persistDelay ?? 300);
    this.persists.set(key, { value, timer });
  }

  private flushPersist(key: string): void {
    const entry = this.persists.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.persists.delete(key);
    this.enqueuePersist(key, entry.value);
  }

  private enqueuePersist(key: string, value: V): void {
    this.persistChain = this.persistChain
      .then(() => this.hooks.persist(key, value))
      .catch((err) => this.hooks.onPersistError?.(key, value, err));
  }
}
