/**
 * Thin wrapper around the Apps in Toss full-screen rewarded ad.
 *
 * The SDK is callback-based and emits a small event stream per showing
 * (`requested → show → impression → [userEarnedReward] → dismissed`). Callers
 * only ever care about one question — "did this person actually earn the
 * reward?" — so this module collapses that stream into a single promise and
 * keeps the event names from leaking into UI code.
 *
 * The one rule worth stating out loud, because getting it wrong is how reward
 * fraud happens: the bonus is granted for `userEarnedReward` and nothing else.
 * `dismissed` fires whether the ad was watched to the end or skipped a second
 * in, so treating it as success would hand out a free request to anyone who
 * opens and closes the ad.
 */

import { loadFullScreenAd, showFullScreenAd } from "@apps-in-toss/web-framework";

import { REWARDED_AD_GROUP_ID } from "../constants/ads";

export type RewardedAdOutcome =
  /** Watched far enough that the SDK reported a reward. */
  | "rewarded"
  /** Closed without earning anything. Not an error — just no bonus. */
  | "dismissed"
  /** Ads are unavailable here (local browser, unsupported Toss version). */
  | "unsupported"
  /** The SDK refused to show or errored out. */
  | "failed";

/**
 * Ads only exist inside the Toss WebView. In a plain browser — which is where
 * most of this app's development happens — the SDK reports no support, and
 * every entry point has to hide itself rather than show a button that throws.
 */
export function isRewardedAdSupported(): boolean {
  try {
    return loadFullScreenAd.isSupported() && showFullScreenAd.isSupported();
  } catch {
    return false;
  }
}

/**
 * Warms up an ad so the eventual tap opens something already in memory.
 *
 * Returns an unregister function for the caller's effect cleanup. Failures are
 * intentionally silent: a missed preload only means the ad loads late, and
 * there is no user-visible action to take.
 */
export function preloadRewardedAd(onLoaded?: () => void): () => void {
  if (!isRewardedAdSupported()) {
    return () => {};
  }
  try {
    return loadFullScreenAd({
      options: { adGroupId: REWARDED_AD_GROUP_ID },
      onEvent: (event) => {
        if (event.type === "loaded") {
          onLoaded?.();
        }
      },
      onError: () => {},
    });
  } catch {
    return () => {};
  }
}

/**
 * Shows the ad and resolves once it closes.
 *
 * Never rejects — every failure mode is an outcome the caller has to render
 * anyway, and a throw here would have to be caught at every call site to say
 * the same thing. Settling is latched so a late `dismissed` after a
 * `failedToShow` cannot resolve the same promise twice.
 */
export function showRewardedAd(): Promise<RewardedAdOutcome> {
  if (!isRewardedAdSupported()) {
    return Promise.resolve("unsupported");
  }

  return new Promise<RewardedAdOutcome>((resolve) => {
    let earned = false;
    let settled = false;
    let unregister: (() => void) | null = null;

    const settle = (outcome: RewardedAdOutcome) => {
      if (settled) {
        return;
      }
      settled = true;
      // Detaching before resolving keeps a closed ad from delivering further
      // events into a promise nobody is listening to any more.
      try {
        unregister?.();
      } catch {
        // Cleanup is best effort; the outcome still stands.
      }
      resolve(outcome);
    };

    try {
      unregister = showFullScreenAd({
        options: { adGroupId: REWARDED_AD_GROUP_ID },
        onEvent: (event) => {
          switch (event.type) {
            case "userEarnedReward":
              // Recorded, not resolved: the ad is still on screen here, and the
              // UI should not start changing behind it.
              earned = true;
              break;
            case "dismissed":
              settle(earned ? "rewarded" : "dismissed");
              break;
            case "failedToShow":
              settle("failed");
              break;
            default:
              break;
          }
        },
        onError: () => settle("failed"),
      });
    } catch {
      settle("failed");
    }
  });
}
