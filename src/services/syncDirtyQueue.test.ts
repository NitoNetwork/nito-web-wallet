import { describe, expect, it, vi } from 'vitest';

import { DirtySyncQueue } from './syncDirtyQueue';

describe('dirty synchronization queue', () => {
  it('guarantees one trailing sync for events received while a sync is active', () => {
    const queue = new DirtySyncQueue();
    const requestSync = vi.fn();
    expect(
      queue.request(
        {
          silent: true,
          onlyAddresses: ['address-a'],
        },
        true,
        requestSync,
      ),
    ).toBe('deferred');
    expect(requestSync).not.toHaveBeenCalled();
    expect(queue.flush(false, requestSync)).toBe(true);
    expect(requestSync).toHaveBeenCalledOnce();
  });

  it('merges dirty events without narrowing a required full rescan', () => {
    const queue = new DirtySyncQueue();
    const requestSync = vi.fn();
    queue.request(
      { silent: true, onlyAddresses: ['address-a'] },
      true,
      requestSync,
    );
    queue.request({ silent: true, rescanGap: true }, true, requestSync);
    queue.flush(false, requestSync);
    expect(requestSync).toHaveBeenCalledWith({
      silent: true,
      rescanGap: true,
      onlyAddresses: undefined,
    });
  });
});
