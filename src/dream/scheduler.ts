// In-process scheduler: per-conversation idle timers (consolidate shortly
// after activity stops) plus an hourly sweep over all namespaces. All jobs
// run through one serial queue — no concurrent writers.
import type { DreamConfig } from '../config.js';
import type { Store } from '../store/store.js';
import { consolidate, type ConsolidateDeps, type ConsolidationResult } from './consolidate.js';

export class Scheduler {
  private idleTimers = new Map<string, NodeJS.Timeout>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  readonly runs: Array<{ ts: number; ns: string; mode: string; extracted: number; actions: Record<string, number> }> = [];

  constructor(
    private deps: ConsolidateDeps,
    private cfg: DreamConfig,
    private store: Store,
  ) {}

  /** Arm/reset the idle timer for a conversation (called per proxied request). */
  onActivity(ns: string): void {
    const existing = this.idleTimers.get(ns);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.idleTimers.delete(ns);
      void this.enqueue(ns);
    }, this.cfg.idleConsolidateMs);
    t.unref?.();
    this.idleTimers.set(ns, t);
  }

  enqueue(ns: string): Promise<ConsolidationResult> {
    const job = this.queue.then(async () => {
      const result = await consolidate(this.deps, ns).catch((err): ConsolidationResult => {
        return { ns, mode: 'noop', extracted: 0, actions: { error: 1, message: String(err).length } };
      });
      this.runs.push({ ts: Date.now(), ns: result.ns, mode: result.mode, extracted: result.extracted, actions: result.actions });
      if (this.runs.length > 100) this.runs.shift();
      return result;
    });
    this.queue = job;
    return job;
  }

  start(): void {
    this.sweepTimer = setInterval(() => {
      for (const ns of this.store.listNamespaces()) void this.enqueue(ns);
    }, this.cfg.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    for (const t of this.idleTimers.values()) clearTimeout(t);
    this.idleTimers.clear();
  }
}
