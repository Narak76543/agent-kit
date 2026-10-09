/**
 * Rate limiting for the ClickUp API (100 requests/minute per token on most plans).
 * Ported from EKMONG_MOBILE scripts/clickup.ts:
 * - reads X-RateLimit-Remaining / X-RateLimit-Reset and pauses when the budget is nearly gone;
 * - retries 429 and 5xx (and network errors) with exponential backoff + jitter;
 * - on 429 waits at least until X-RateLimit-Reset.
 * New: a concurrency limit, and an injectable clock so tests never really wait.
 */

export interface WaitInfo {
  reason: 'budget' | 'retry';
  ms: number;
  /** 1-based retry number (retry only). */
  attempt?: number;
  /** HTTP status that caused the retry; undefined for network errors. */
  status?: number;
}

export interface RateLimiterOptions {
  /** Retries after the first attempt. Default 5. */
  maxRetries?: number;
  /** Requests in flight at the same time. Default 4. */
  concurrency?: number;
  /** Pause before a request when this many or fewer requests remain. Default 2. */
  lowWater?: number;
  /** Cap for one backoff step. Default 30 s. */
  maxBackoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0, 1); used for jitter. */
  random?: () => number;
  onWait?: (info: WaitInfo) => void;
}

const RESET_MARGIN_MS = 250;
const JITTER_MS = 250;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private remaining = Infinity;
  private resetAt = 0; // epoch ms
  private active = 0;
  private readonly queue: (() => void)[] = [];

  private readonly maxRetries: number;
  private readonly concurrency: number;
  private readonly lowWater: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onWait: (info: WaitInfo) => void;

  constructor(options: RateLimiterOptions = {}) {
    this.maxRetries = options.maxRetries ?? 5;
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.lowWater = options.lowWater ?? 2;
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onWait = options.onWait ?? (() => {});
  }

  /** Current view of the budget, for diagnostics and tests. */
  get state(): { remaining: number; resetAt: number; active: number; queued: number } {
    return { remaining: this.remaining, resetAt: this.resetAt, active: this.active, queued: this.queue.length };
  }

  /**
   * Runs `request` with budget checks and retries. Resolves with the final Response, which may
   * still be a 429/5xx when retries ran out. Rejects with the last network error after retries.
   */
  async run(request: () => Promise<Response>): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForBudget();

      let res: Response;
      await this.acquire();
      try {
        res = await request();
      } catch (error) {
        if (attempt >= this.maxRetries) throw error;
        const ms = this.backoff(attempt);
        this.onWait({ reason: 'retry', ms, attempt: attempt + 1 });
        await this.sleep(ms);
        continue;
      } finally {
        this.release();
      }

      this.readHeaders(res.headers);

      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        await discardBody(res);
        const untilReset =
          res.status === 429 && this.resetAt > this.now() ? this.resetAt - this.now() + RESET_MARGIN_MS : 0;
        const ms = Math.max(untilReset, this.backoff(attempt));
        this.onWait({ reason: 'retry', ms, attempt: attempt + 1, status: res.status });
        await this.sleep(ms);
        continue;
      }
      return res;
    }
  }

  backoff(attempt: number): number {
    return Math.min(1000 * 2 ** attempt, this.maxBackoffMs) + Math.floor(this.random() * JITTER_MS);
  }

  private async waitForBudget(): Promise<void> {
    if (this.remaining <= this.lowWater && this.resetAt > this.now()) {
      const ms = this.resetAt - this.now() + RESET_MARGIN_MS;
      this.onWait({ reason: 'budget', ms });
      await this.sleep(ms);
      // A new window has started; trust the next response's headers again.
      this.remaining = Infinity;
    }
  }

  private readHeaders(headers: Headers): void {
    const remaining = headers.get('x-ratelimit-remaining');
    if (remaining !== null && remaining.trim() !== '' && Number.isFinite(Number(remaining))) {
      this.remaining = Number(remaining);
    }
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      // ClickUp documents a "Unix timestamp" without a unit; it is seconds in practice,
      // but accept milliseconds too.
      this.resetAt = reset > 1e12 ? reset : reset * 1000;
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active++;
      return;
    }
    // The slot is handed over directly by release(), so `active` stays the same.
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

/** Frees the connection of a response we are not going to read. */
async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // ignore: the body may already be consumed or closed
  }
}
