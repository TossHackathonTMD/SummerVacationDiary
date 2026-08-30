import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  expireQuotaSnapshot,
  getQuotaSnapshot,
  subscribeQuota,
  type QuotaBlockedReason,
  type QuotaCounter,
  type QuotaRegion,
} from "../services/aiQuotaStore";
import {
  getPendingSketchCount,
  getSketchLedgerVersion,
  subscribeSketchLedger,
} from "../services/sketchLedger";
import {
  invokeDiaryAi,
  isAiTestMode,
  isSupabaseConfigured,
} from "../services/supabaseEdge";

export interface QuotaCounterView extends QuotaCounter {
  available: boolean;
}

/**
 * Two independent axes collapsed into one value: whether a server-backed
 * counter exists at all (`hidden` / `unknown`), and how much of it is left
 * (`ready`).
 */
export type AiQuotaView =
  | { mode: "hidden" }
  | { mode: "unknown" }
  | {
      mode: "ready";
      /** One user-facing budget shared by drawing and diary analysis. */
      completion: QuotaCounterView;
      blocked: QuotaBlockedReason | null;
      region: QuotaRegion;
      nextRefillAt: string;
      /** Server-side test mode bypasses counters but remains visible in the UI. */
      testMode: boolean;
      /** False once today's one rewarded-ad bonus has already been claimed. */
      adRewardAvailable: boolean;
    };

const QUOTA_STATUS_TIMEOUT_MS = 10_000;

/**
 * Folds the requests this client has already sent into the server's numbers.
 * A drawing takes 30-60 seconds, so without this the counter would still read
 * the old value while requests are in flight.
 *
 * Clamped at the limit: between the response being recorded and its ticket
 * being settled a few microtasks later, one request is briefly counted twice,
 * and "4/3" would read as a bug rather than as the blink it is.
 */
function withPending(counter: QuotaCounter, pending: number): QuotaCounterView {
  const used = Math.min(counter.used + pending, counter.limit);
  const remaining = Math.max(counter.limit - used, 0);
  return { used, limit: counter.limit, remaining, available: remaining > 0 };
}

/**
 * Fetches the current usage snapshot. `invokeDiaryAi` records it into the store
 * on the way through, so there is nothing to return. Failures are swallowed on
 * purpose: a missing counter must never block the diary flow, and the server
 * remains the authority either way.
 */
export async function refreshAiQuota(): Promise<void> {
  // The Edge Function does not consume or expose counters when its matching
  // DIARY_AI_TEST_MODE Secret is enabled. Avoiding this request also prevents
  // an old production function from needlessly reading a real quota while the
  // local client is in test mode.
  if (!isSupabaseConfigured || isAiTestMode) {
    return;
  }
  try {
    await invokeDiaryAi({ action: "quota-status" }, QUOTA_STATUS_TIMEOUT_MS);
  } catch {
    // Leaves the view as "unknown"; counters stay hidden until a call succeeds.
  }
}

/**
 * Banks today's rewarded-ad bonus on the server.
 *
 * Nothing is returned because nothing needs to be: `invokeDiaryAi` records the
 * snapshot carried by the response, so the counter and every gate derived from
 * it re-render on their own. Resolves to whether the call reached the server,
 * which is only used to decide whether to apologise to the user.
 *
 * Safe to call more than once — the server caps the bonus at one per day and
 * treats repeats as a no-op that still returns the current numbers.
 */
export async function grantAiQuotaAdReward(): Promise<boolean> {
  if (!isSupabaseConfigured || isAiTestMode) {
    return false;
  }
  try {
    await invokeDiaryAi({ action: "grant-ad-reward" }, QUOTA_STATUS_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

export function useAiQuota(): AiQuotaView {
  const snapshot = useSyncExternalStore(subscribeQuota, getQuotaSnapshot);
  // Subscribed on the version rather than the count, so no ledger transition can
  // fail to re-render; the number this view actually needs is then read fresh
  // below, which is also what keeps it an honest `useMemo` dependency.
  useSyncExternalStore(subscribeSketchLedger, getSketchLedgerVersion);
  const pendingSketches = getPendingSketchCount();

  // A session left open across 09:00 KST would otherwise miss its one-credit
  // refill. Expire the display cache and ask the server to apply the refill;
  // never assume the balance became full.
  useEffect(() => {
    if (snapshot === null) {
      return;
    }
    const expire = () => {
      expireQuotaSnapshot(Date.now());
      void refreshAiQuota();
    };
    const msUntilRefill = Date.parse(snapshot.nextRefillAt) - Date.now();
    if (msUntilRefill <= 0) {
      expire();
      return;
    }
    const timer = setTimeout(expire, msUntilRefill);
    return () => clearTimeout(timer);
  }, [snapshot]);

  return useMemo<AiQuotaView>(() => {
    if (!isSupabaseConfigured || isAiTestMode) {
      // Mock mode is free. Test mode is paired with the server-side
      // DIARY_AI_TEST_MODE Secret when its quota bypass is needed; either way,
      // the client-side display and preflight gate are not useful here.
      return { mode: "hidden" };
    }
    if (snapshot === null) {
      return { mode: "unknown" };
    }
    return {
      mode: "ready",
      completion: withPending(snapshot.all, pendingSketches),
      blocked: snapshot.blocked,
      region: snapshot.region,
      nextRefillAt: snapshot.nextRefillAt,
      testMode: snapshot.testMode,
      adRewardAvailable: snapshot.adRewardAvailable,
    };
  }, [snapshot, pendingSketches]);
}

/**
 * True when watching a rewarded ad would actually change something: the budget
 * is known and spent, today's bonus is still unclaimed, and nothing global
 * (region, test mode) makes the counter moot. Every ad entry point — the popup
 * and the button that reopens it — is gated on this one predicate so they can
 * never disagree about whether an ad is worth offering.
 */
export function canWatchRewardedAd(view: AiQuotaView): boolean {
  return (
    view.mode === "ready" &&
    !view.testMode &&
    view.region.allowed &&
    view.adRewardAvailable &&
    !view.completion.available
  );
}

/**
 * True only when the shared inspection budget is known AND spent. Both drawing
 * and analysis use this same gate, so one action cannot continue after all
 * currently held credits are gone.
 */
export function isAiQuotaSpent(view: AiQuotaView): boolean {
  return view.mode === "ready" && !view.testMode && !view.completion.available;
}

/**
 * True when the server refuses this caller's country. Unlike the per-action
 * budgets this is global and does not refill, so both operations are gated on
 * it and the wording must not promise another credit at 09:00.
 */
export function isRegionBlocked(view: AiQuotaView): boolean {
  return view.mode === "ready" && !view.region.allowed;
}
