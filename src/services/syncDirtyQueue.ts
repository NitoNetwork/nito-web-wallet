export type DirtySyncOptions = {
  silent?: boolean;
  onlyAddresses?: readonly string[];
  rescanGap?: boolean;
};

type RequestSync = (options: DirtySyncOptions) => void;

const mergeOptions = (
  current: DirtySyncOptions,
  incoming: DirtySyncOptions,
): DirtySyncOptions => ({
  silent: Boolean(current.silent && incoming.silent),
  rescanGap: Boolean(current.rescanGap || incoming.rescanGap),
  onlyAddresses:
    current.onlyAddresses && incoming.onlyAddresses
      ? [...new Set([...current.onlyAddresses, ...incoming.onlyAddresses])]
      : undefined,
});

export class DirtySyncQueue {
  private pending: DirtySyncOptions | null = null;

  request(
    options: DirtySyncOptions,
    syncInFlight: boolean,
    requestSync: RequestSync,
  ): 'requested' | 'deferred' {
    if (!syncInFlight) {
      requestSync(options);
      return 'requested';
    }

    this.pending = this.pending ? mergeOptions(this.pending, options) : { ...options };
    return 'deferred';
  }

  flush(syncInFlight: boolean, requestSync: RequestSync): boolean {
    if (syncInFlight || !this.pending) return false;
    const pending = this.pending;
    this.pending = null;
    requestSync(pending);
    return true;
  }

  clear(): void {
    this.pending = null;
  }
}
