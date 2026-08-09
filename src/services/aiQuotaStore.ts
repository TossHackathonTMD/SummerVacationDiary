/**
 * Holds the most recent AI usage snapshot the server sent.
 *
 * This module deliberately imports nothing. `supabaseEdge.ts` writes into it on
 * every response, so an import back the other way would form a cycle — and a
 * cycle would leave that module's top-level constants (`isAiTestMode`,
 * `isSupabaseConfigured`) undefined while this file is being evaluated.
 *
 * The counters here are for display only. Enforcement is the server's atomic
 * consume; a client that ignores or edits these numbers changes nothing.
 */

export interface QuotaCounter {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Why a request would be refused for a reason that is not the device's own
 * per-action budget. Used for wording, not for gating: `device` and `service`
 * are per-action on the server, so treating them as a global block would wrongly
 * disable the other action.
 */
export type QuotaBlockedReason = "device" | "ip-burst" | "ip-daily" | "service";

export interface QuotaRegion {
  /** False when the server refuses this caller's country outright. */
  allowed: boolean;
  /** ISO-3166 alpha-2, or null when the country could not be determined. */
  country: string | null;
}

export interface QuotaSnapshot {
  all: QuotaCounter;
  /** ISO timestamp of the next daily reset (00:00 UTC = 09:00 KST). */
  resetAt: string;
  blocked: QuotaBlockedReason | null;
  region: QuotaRegion;
  /** True only when the Edge Function's private test-mode Secret is enabled. */
  testMode: boolean;
  /**
   * False once today's rewarded-ad bonus has been claimed. `all.limit` cannot
   * carry this on its own — a limit of 3 looks identical whether the bonus is
   * already spent or still on offer.
   */
  adRewardAvailable: boolean;
}

const BLOCKED_REASONS: readonly string[] = [
  "device",
  "ip-burst",
  "ip-daily",
  "service",
];

const QUOTA_SNAPSHOT_STORAGE_KEY = "summer-vacation-diary:quota:v1";

function readStoredSnapshot(): QuotaSnapshot | null {
  try {
    const raw = localStorage.getItem(QUOTA_SNAPSHOT_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    // Reuse the response parser so persisted data is held to exactly the same
    // shape as data arriving over the network.
    const parsed = parseQuotaSnapshot({ quota: JSON.parse(raw) });
    if (
      parsed === null ||
      parsed.testMode ||
      Date.parse(parsed.resetAt) <= Date.now()
    ) {
      localStorage.removeItem(QUOTA_SNAPSHOT_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persistSnapshot(value: QuotaSnapshot): void {
  try {
    if (value.testMode) {
      localStorage.removeItem(QUOTA_SNAPSHOT_STORAGE_KEY);
      return;
    }
    localStorage.setItem(QUOTA_SNAPSHOT_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage is only a display cache. Private browsing and a full quota must
    // never affect the actual server-backed request flow.
  }
}

let snapshot: QuotaSnapshot | null = readStoredSnapshot();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parseCounter(value: unknown): QuotaCounter | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { used, limit, remaining } = value as Record<string, unknown>;
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    typeof remaining !== "number"
  ) {
    return null;
  }
  return { used, limit, remaining };
}

/**
 * Deliberately lenient, and never a reason to reject the whole snapshot: a
 * function deployed before the region gate simply omits this field, and turning
 * that into "blocked" would lock everyone out of the AI features on a rollback.
 */
function parseRegion(value: unknown): QuotaRegion {
  if (typeof value !== "object" || value === null) {
    return { allowed: true, country: null };
  }
  const { allowed, country } = value as Record<string, unknown>;
  return {
    allowed: allowed !== false,
    country: typeof country === "string" && country !== "" ? country : null,
  };
}

/**
 * Pulls a snapshot out of any Edge Function response body. Returns null rather
 * than throwing, because this runs on the response path of every call —
 * including error responses — and must never turn a server error into a
 * different client error.
 */
export function parseQuotaSnapshot(body: unknown): QuotaSnapshot | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const quota = (body as { quota?: unknown }).quota;
  if (typeof quota !== "object" || quota === null) {
    return null;
  }

  const record = quota as Record<string, unknown>;
  const all = parseCounter(record.all);
  if (all === null) {
    return null;
  }
  if (
    typeof record.resetAt !== "string" ||
    Number.isNaN(Date.parse(record.resetAt))
  ) {
    return null;
  }

  const blocked = record.blocked ?? null;
  if (blocked !== null && !BLOCKED_REASONS.includes(blocked as string)) {
    return null;
  }

  return {
    all,
    resetAt: record.resetAt,
    blocked: blocked as QuotaBlockedReason | null,
    region: parseRegion(record.region),
    testMode: record.testMode === true,
    // Same leniency as parseRegion: a function deployed before the ad reward
    // omits this field, and defaulting to `true` there would offer a bonus the
    // server cannot grant. Absent therefore means "no bonus on offer".
    adRewardAvailable: record.adRewardAvailable === true,
  };
}

/**
 * Records the snapshot carried by a response, if there is one. Called for both
 * success and failure bodies so a rejected over-limit request still updates the
 * counter to zero instead of leaving a stale number on screen.
 */
export function recordQuotaSnapshot(body: unknown): void {
  const parsed = parseQuotaSnapshot(body);
  if (parsed === null) {
    return;
  }
  snapshot = parsed;
  persistSnapshot(parsed);
  emit();
}

/**
 * Returns the same object reference until a new snapshot arrives, which is what
 * `useSyncExternalStore` needs to avoid re-rendering on every check.
 */
export function getQuotaSnapshot(): QuotaSnapshot | null {
  return snapshot;
}

/** Drops the snapshot once its daily window has passed. */
export function expireQuotaSnapshot(now: number): void {
  if (snapshot !== null && now >= Date.parse(snapshot.resetAt)) {
    snapshot = null;
    try {
      localStorage.removeItem(QUOTA_SNAPSHOT_STORAGE_KEY);
    } catch {
      // Same best-effort rule as persistence above.
    }
    emit();
  }
}

export function subscribeQuota(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
