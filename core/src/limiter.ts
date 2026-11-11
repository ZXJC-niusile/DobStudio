/**
 * A process-wide concurrency limiter.
 *
 * The translation layer reads `provider.concurrency` per call, so three queued
 * jobs each open four requests: twelve in flight against a provider that was
 * configured for four. Most providers rate-limit per key, not per job, so the
 * symptom is HTTP 429s on exactly the runs the user was waiting for.
 *
 * This is a counting semaphore keyed by provider id. The first caller sets the
 * ceiling from its own config; later callers with a *smaller* ceiling lower it,
 * because honouring a lower limit is always safe, while raising it would
 * violate whichever job asked for less.
 *
 * The counter is deliberately process-global rather than passed down: the whole
 * point is to bound what the process does in total, and a limit that each
 * caller can opt out of is not a limit.
 */

/** Ceilings currently in force, by provider id. */
const limits = new Map<string, number>();

/** In-flight requests, by provider id. */
const inFlight = new Map<string, number>();

/** Waiters, by provider id. */
const waiters = new Map<string, (() => void)[]>();

/** How many requests may be in flight for this provider right now. */
export function currentLimit(providerId: string): number {
  return limits.get(providerId) ?? Number.POSITIVE_INFINITY;
}

/**
 * Register the ceiling a caller wants.
 *
 * Only ever lowers the effective limit: if one job asks for 8 and another for
 * 2, the process runs at 2 until the stricter job finishes. Raising it back up
 * when the strict job ends is intentionally not done — the safer default is to
 * stay low until every caller has been heard from again.
 */
export function requestLimit(providerId: string, wanted: number): void {
  const existing = limits.get(providerId);
  if (existing === undefined || wanted < existing) {
    limits.set(providerId, Math.max(1, wanted));
  }
}

/** Drop a caller's claim, so the limit can rise again. */
export function releaseLimit(providerId: string): void {
  limits.delete(providerId);
  drain(providerId);
}

/** How many requests are in flight for this provider. */
export function activeCount(providerId: string): number {
  return inFlight.get(providerId) ?? 0;
}

/**
 * Run `task` once a slot is free.
 *
 * The returned promise settles with whatever `task` does, including rejecting;
 * the slot is always released, so a throwing request cannot wedge the limiter.
 */
export async function withSlot<T>(providerId: string, task: () => Promise<T>): Promise<T> {
  /*
   * Wait for a slot, then take it.
   *
   * `drain` reserves the slot on this caller's behalf when it wakes it, so the
   * count is already correct by the time this line runs — incrementing again
   * would double-count and starve everyone behind us.
   */
  let reserved = false;
  while (!reserved) {
    if (activeCount(providerId) < currentLimit(providerId)) {
      inFlight.set(providerId, activeCount(providerId) + 1);
      reserved = true;
      break;
    }
    await new Promise<void>((resolve) => {
      const queue = waiters.get(providerId) ?? [];
      queue.push(resolve);
      waiters.set(providerId, queue);
    });
    // Woken by drain, which already incremented on our behalf.
    reserved = true;
  }
  try {
    return await task();
  } finally {
    inFlight.set(providerId, Math.max(0, activeCount(providerId) - 1));
    drain(providerId);
  }
}

/**
 * Wake as many waiters as the current limit allows.
 *
 * Reserving the slot here, rather than letting the woken caller claim it when
 * it resumes, is what makes the accounting exact: otherwise a wakee that has
 * not run yet is invisible to the next `drain`, and the same free slot gets
 * handed out more than once — or, with the opposite mistake, only one waiter
 * is ever woken per release and throughput collapses.
 */
function drain(providerId: string): void {
  const queue = waiters.get(providerId);
  if (queue === undefined || queue.length === 0) return;

  let free = currentLimit(providerId) - activeCount(providerId);
  while (free > 0 && queue.length > 0) {
    queue.shift()?.();
    // Count the slot as taken immediately; the woken caller will not re-check.
    inFlight.set(providerId, activeCount(providerId) + 1);
    free -= 1;
  }
  if (queue.length === 0) waiters.delete(providerId);
}

/** Test seam: forget every limit and in-flight count. */
export function resetLimiter(): void {
  limits.clear();
  inFlight.clear();
  waiters.clear();
}
