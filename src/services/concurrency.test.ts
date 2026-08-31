import { describe, expect, it } from 'vitest';

import { createConcurrencyLimiter, mapWithConcurrency } from './concurrency';

describe('bounded concurrency helpers', () => {
  it('limits arbitrary asynchronous work and preserves every result', async () => {
    const limiter = createConcurrencyLimiter(3);
    let inFlight = 0;
    let peakInFlight = 0;
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => limiter.run(async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return index;
      })),
    );

    expect(peakInFlight).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index));
  });

  it('maps a large collection without starting more workers than requested', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const results = await mapWithConcurrency(
      Array.from({ length: 25 }, (_, index) => index),
      4,
      async (value) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return value * 2;
      },
    );

    expect(peakInFlight).toBe(4);
    expect(results).toEqual(Array.from({ length: 25 }, (_, index) => index * 2));
  });

  it('propagates failures instead of returning a partial result', async () => {
    await expect(mapWithConcurrency([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('read failed');
      return value;
    })).rejects.toThrow('read failed');
  });

  it('propagates an undefined rejection instead of returning partial results', async () => {
    await expect(mapWithConcurrency([1], 1, async () => {
      await Promise.reject(undefined);
      return 1;
    })).rejects.toBeUndefined();
  });

  it('releases queued slots after a synchronous task failure', async () => {
    const limiter = createConcurrencyLimiter(1);
    const first = limiter.run(async () => 1);
    const failed = limiter.run(() => {
      throw new Error('synchronous guard failure');
    });
    const last = limiter.run(async () => 3);

    await expect(first).resolves.toBe(1);
    await expect(failed).rejects.toThrow('synchronous guard failure');
    await expect(last).resolves.toBe(3);
  });
});
