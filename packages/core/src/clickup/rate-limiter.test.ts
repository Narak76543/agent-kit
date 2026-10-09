import { describe, expect, it } from 'vitest';
import { RateLimiter, type RateLimiterOptions, type WaitInfo } from './rate-limiter.js';

const START = 1_700_000_000_000; // fixed epoch ms

/** A limiter on a fake clock: sleep() advances time instantly. */
function setup(options: RateLimiterOptions = {}) {
  let now = START;
  const sleeps: number[] = [];
  const waits: WaitInfo[] = [];
  const limiter = new RateLimiter({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0,
    onWait: (w) => waits.push(w),
    ...options,
  });
  return { limiter, sleeps, waits, now: () => now };
}

const res = (status: number, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify({ status }), { status, headers });

/** A request function that returns the given responses in order (Errors are thrown). */
function sequence(...items: (Response | Error)[]) {
  let calls = 0;
  const fn = async () => {
    const item = items[Math.min(calls++, items.length - 1)]!;
    if (item instanceof Error) throw item;
    return item;
  };
  return { fn, calls: () => calls };
}

describe('RateLimiter', () => {
  it('passes a successful response through and records the budget', async () => {
    const { limiter, sleeps } = setup();
    const r = await limiter.run(
      sequence(res(200, { 'x-ratelimit-remaining': '42', 'x-ratelimit-reset': '1700000060' })).fn,
    );
    expect(r.status).toBe(200);
    expect(sleeps).toEqual([]);
    expect(limiter.state.remaining).toBe(42);
    expect(limiter.state.resetAt).toBe(1_700_000_060_000);
  });

  it('on 429 waits until X-RateLimit-Reset (seconds) and retries', async () => {
    const { limiter, sleeps, waits, now } = setup();
    const resetSec = START / 1000 + 20; // 20 s from now
    const seq = sequence(
      res(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSec) }),
      res(200, { 'x-ratelimit-remaining': '99' }),
    );
    const r = await limiter.run(seq.fn);
    expect(r.status).toBe(200);
    expect(seq.calls()).toBe(2);
    expect(sleeps).toEqual([20_250]);
    expect(waits).toEqual([{ reason: 'retry', ms: 20_250, attempt: 1, status: 429 }]);
    expect(now()).toBeGreaterThanOrEqual(resetSec * 1000);
  });

  it('accepts X-RateLimit-Reset in milliseconds', async () => {
    const { limiter, sleeps } = setup();
    const seq = sequence(res(429, { 'x-ratelimit-reset': String(START + 5_000) }), res(200));
    await limiter.run(seq.fn);
    expect(sleeps).toEqual([5_250]);
  });

  it('on 429 without a reset header uses exponential backoff', async () => {
    const { limiter, sleeps } = setup();
    const seq = sequence(res(429), res(429), res(429), res(200));
    const r = await limiter.run(seq.fn);
    expect(r.status).toBe(200);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('uses the backoff when it is longer than the time to reset', async () => {
    const { limiter, sleeps } = setup();
    const seq = sequence(res(429), res(429), res(429, { 'x-ratelimit-reset': String(START / 1000 + 1) }), res(200));
    await limiter.run(seq.fn);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('adds jitter to the backoff', async () => {
    const { limiter, sleeps } = setup({ random: () => 0.5 });
    await limiter.run(sequence(res(503), res(200)).fn);
    expect(sleeps).toEqual([1_125]);
  });

  it('retries 5xx', async () => {
    const { limiter, waits } = setup();
    const seq = sequence(res(500), res(502), res(200));
    expect((await limiter.run(seq.fn)).status).toBe(200);
    expect(waits.map((w) => w.status)).toEqual([500, 502]);
  });

  it('does not retry other 4xx errors', async () => {
    const { limiter, sleeps } = setup();
    const seq = sequence(res(404), res(200));
    expect((await limiter.run(seq.fn)).status).toBe(404);
    expect(seq.calls()).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('returns the last 429 after maxRetries retries', async () => {
    const { limiter, sleeps } = setup({ maxRetries: 3 });
    const seq = sequence(res(429));
    const r = await limiter.run(seq.fn);
    expect(r.status).toBe(429);
    expect(seq.calls()).toBe(4);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps a backoff step at maxBackoffMs', async () => {
    const { limiter, sleeps } = setup({ maxRetries: 7 });
    await limiter.run(sequence(res(500)).fn);
    expect(sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('retries network errors, then rethrows the last one', async () => {
    const { limiter, waits } = setup({ maxRetries: 2 });
    const seq = sequence(new Error('ECONNRESET'), new Error('ETIMEDOUT'), new Error('ENOTFOUND'));
    await expect(limiter.run(seq.fn)).rejects.toThrow('ENOTFOUND');
    expect(seq.calls()).toBe(3);
    expect(waits).toEqual([
      { reason: 'retry', ms: 1_000, attempt: 1 },
      { reason: 'retry', ms: 2_000, attempt: 2 },
    ]);
  });

  it('recovers from a network error', async () => {
    const { limiter } = setup();
    expect((await limiter.run(sequence(new Error('ECONNRESET'), res(200)).fn)).status).toBe(200);
  });

  it('pauses before a request when the budget is nearly used', async () => {
    const { limiter, sleeps, waits } = setup();
    await limiter.run(
      sequence(res(200, { 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': String(START / 1000 + 30) })).fn,
    );
    expect(sleeps).toEqual([]);
    const seq = sequence(res(200, { 'x-ratelimit-remaining': '99' }));
    await limiter.run(seq.fn);
    expect(waits).toEqual([{ reason: 'budget', ms: 30_250 }]);
    expect(sleeps).toEqual([30_250]);
    expect(limiter.state.remaining).toBe(99);
  });

  it('does not pause when the reset time has already passed', async () => {
    const { limiter, sleeps } = setup();
    await limiter.run(
      sequence(res(200, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(START / 1000 - 5) })).fn,
    );
    await limiter.run(sequence(res(200)).fn);
    expect(sleeps).toEqual([]);
  });

  it('ignores missing or invalid rate limit headers', async () => {
    const { limiter } = setup();
    await limiter.run(sequence(res(200, { 'x-ratelimit-remaining': 'abc', 'x-ratelimit-reset': '' })).fn);
    expect(limiter.state).toMatchObject({ remaining: Infinity, resetAt: 0 });
  });

  it('limits how many requests run at the same time', async () => {
    const { limiter } = setup({ concurrency: 2 });
    let inFlight = 0;
    let maxInFlight = 0;
    const request = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return res(200);
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => limiter.run(request)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(limiter.state).toMatchObject({ active: 0, queued: 0 });
  });

  it('defaults to 4 concurrent requests and real timers', async () => {
    const limiter = new RateLimiter();
    let inFlight = 0;
    let maxInFlight = 0;
    const request = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return res(200);
    };
    await Promise.all(Array.from({ length: 10 }, () => limiter.run(request)));
    expect(maxInFlight).toBe(4);
  });
});
