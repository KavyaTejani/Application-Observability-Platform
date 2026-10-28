import type { Logger } from 'pino';
import type { AlertEvaluator } from './alert-evaluator.js';
import type { Notifier } from './notifier.js';

/**
 * Background loop for alert evaluation and notification delivery. It runs inside the API process
 * by default (simple deployment); it can be disabled there and run as `npm run worker` instead.
 * Ticks never overlap, and every unit of work is claimed with a lease, so several instances can
 * run safely.
 */
export interface AlertWorkerStatus {
  running: boolean;
  lastTickAt: string | null;
  lastTickDurationMs: number | null;
  lastTickFailed: boolean;
}

export class AlertWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private lastTick: { at: Date; durationMs: number; failed: boolean } | null = null;

  constructor(
    private readonly evaluator: AlertEvaluator,
    private readonly notifier: Notifier,
    private readonly logger: Logger,
    private readonly tickMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    this.logger.info({ tickMs: this.tickMs }, 'Alert worker started');
  }

  /** One pass: evaluate due rules, then send due notifications. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const started = Date.now();
      let failed = false;
      try {
        await this.evaluator.runDue();
        await this.notifier.runDue();
      } catch (error) {
        failed = true;
        this.logger.error({ err: error }, 'Alert worker tick failed');
      } finally {
        this.lastTick = { at: new Date(), durationMs: Date.now() - started, failed };
        this.running = null;
      }
    })();
    return this.running;
  }

  /** For the operator view: whether the loop runs here and how its last pass went. */
  status(): AlertWorkerStatus {
    return {
      running: this.timer !== undefined,
      lastTickAt: this.lastTick?.at.toISOString() ?? null,
      lastTickDurationMs: this.lastTick?.durationMs ?? null,
      lastTickFailed: this.lastTick?.failed ?? false,
    };
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
