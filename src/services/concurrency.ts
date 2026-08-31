export type ConcurrencyLimiter = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

type QueuedTask = {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const normalizeConcurrency = (concurrency: number) => {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('Concurrency must be a positive integer.');
  }

  return concurrency;
};

export const createConcurrencyLimiter = (concurrency: number): ConcurrencyLimiter => {
  const limit = normalizeConcurrency(concurrency);
  const queue: QueuedTask[] = [];
  let active = 0;

  const drain = () => {
    while (active < limit && queue.length > 0) {
      const queued = queue.shift();
      if (!queued) return;
      active += 1;
      // Queue callbacks can fail synchronously (for example when a sibling scan
      // has already failed and the shared scan guard rejects pending work).
      // Enter through a resolved promise so both sync throws and async
      // rejections settle the caller promise and always release the slot.
      void Promise.resolve()
        .then(queued.run)
        .then(queued.resolve, queued.reject)
        .then(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          run: task,
          resolve: (value) => resolve(value as T),
          reject,
        });
        drain();
      });
    },
  };
};

export const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const limit = normalizeConcurrency(concurrency);
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;
  let failure: unknown;
  let hasFailure = false;

  const runWorker = async () => {
    while (!hasFailure) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        failure = error;
        hasFailure = true;
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => runWorker(),
  );
  await Promise.all(workers);

  if (hasFailure) {
    throw failure;
  }

  return results;
};
