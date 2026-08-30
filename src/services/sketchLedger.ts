/**
 * Counts a drawing the moment it is requested, not when the server answers.
 *
 * A sketch takes 30-60 seconds, and until the response lands the server-sourced
 * counter still reads the old number. Without this, someone who picks a photo,
 * goes back, picks another and repeats can spend the whole day's budget while
 * the screen still says none of it is used. One ticket per photo closes that
 * window: the count moves at dispatch, and it moves back only when the server
 * tells us it did not charge.
 *
 * Like `aiQuotaStore.ts` this module deliberately imports nothing, so it can be
 * read from both a service and a hook without forming a cycle.
 *
 * These numbers steer a normal user; they do not enforce anything. A modified
 * client that ignores this file changes nothing, because the Edge Function's
 * atomic consume is still what decides whether a request is allowed.
 */

/**
 * `pending` — dispatched, no answer yet, so it adds +1 on top of the server's
 * count. `settled` — the server charged for it, so the charge now lives in the
 * server snapshot and the ticket only remembers "this photo is spent".
 */
type SketchTicketStatus = "pending" | "settled";

// The keys are cropped photo data URLs, 150-400 KB each, and the ledger may be
// their last remaining holder once the draft moves on. A two-credit capacity
// makes anything past a handful unreachable in practice.
const MAX_TICKETS = 5;

const tickets = new Map<string, SketchTicketStatus>();
const listeners = new Set<() => void>();
let pendingCount = 0;
let version = 0;

function emit(): void {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
}

function evictOldestSettled(): void {
  if (tickets.size <= MAX_TICKETS) {
    return;
  }
  // Map iterates in insertion order, and re-setting an existing key keeps its
  // place, so the first settled entry found is the oldest one.
  for (const [key, status] of tickets) {
    if (status === "settled") {
      tickets.delete(key);
      return;
    }
  }
  // Everything is still in flight — unreachable with a two-credit capacity, and
  // keeping them all is the safe answer anyway: dropping a pending ticket would
  // hand back a count that is genuinely spent.
}

/**
 * Claims this photo's one request. Doing nothing when the photo already holds a
 * ticket is the whole point — it is what makes "one photo, one count" true even
 * when the effect that dispatches re-runs.
 */
export function reserveSketchTicket(key: string): void {
  if (tickets.has(key)) {
    return;
  }
  tickets.set(key, "pending");
  pendingCount += 1;
  evictOldestSettled();
  emit();
}

/** The server charged for this request; stop adding a local delta for it. */
export function settleSketchTicket(key: string): void {
  if (tickets.get(key) !== "pending") {
    return;
  }
  tickets.set(key, "settled");
  pendingCount -= 1;
  emit();
}

/**
 * The server did not charge. Drops the count back AND frees the photo to be
 * requested again, which is what makes a retry after a transient failure cost
 * the user nothing.
 */
export function releaseSketchTicket(key: string): void {
  const status = tickets.get(key);
  if (status === undefined) {
    return;
  }
  tickets.delete(key);
  if (status === "pending") {
    pendingCount -= 1;
  }
  emit();
}

/**
 * The user knowingly bought a second drawing for this photo ("다시 그리기"), so
 * the photo stops counting as already paid for and may dispatch again.
 *
 * Only a SETTLED ticket is dropped. A still-pending one is the new drawing
 * already on its way — the hook reuses that in-flight request rather than
 * paying twice — and dropping it would hand back a count that is genuinely
 * spent. Settled tickets add nothing to `pendingCount`, so forgetting one
 * leaves the server-sourced number (which already includes that charge) alone.
 */
export function forgetSettledSketchTicket(key: string): void {
  if (tickets.get(key) !== "settled") {
    return;
  }
  tickets.delete(key);
  emit();
}

/** True once this photo has spent its request, whether or not it finished. */
export function hasSketchTicket(key: string | null): boolean {
  return key !== null && tickets.has(key);
}

/**
 * True when this photo's request was made and charged for. Nothing may dispatch
 * again for it — a second request would pay twice for one photo.
 */
export function isSketchTicketSettled(key: string | null): boolean {
  return key !== null && tickets.get(key) === "settled";
}

/** How much to add to the server's `used` while requests are still in flight. */
export function getPendingSketchCount(): number {
  return pendingCount;
}

/**
 * The `useSyncExternalStore` snapshot. A version rather than the pending count,
 * because a pending → settled flip has to re-render (a photo's entitlement
 * changes with it) while leaving the count untouched.
 */
export function getSketchLedgerVersion(): number {
  return version;
}

export function subscribeSketchLedger(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
