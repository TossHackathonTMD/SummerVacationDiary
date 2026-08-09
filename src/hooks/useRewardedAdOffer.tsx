import { useCallback, useEffect, useState } from "react";
import { useDialog, useToast } from "@toss/tds-mobile";

import {
  canWatchRewardedAd,
  grantAiQuotaAdReward,
  useAiQuota,
} from "./useAiQuota";
import {
  isRewardedAdSupported,
  preloadRewardedAd,
  showRewardedAd,
} from "../services/rewardedAd";
import { DiaryButton } from "../components/DiaryButton";

/**
 * The whole "watch an ad for one more diary" flow behind a single hook.
 *
 * Both entry points — the popup that appears on returning to the photo step and
 * the button that reopens it — run this same code, so they cannot drift on when
 * the offer is valid or what happens after the ad. `canOffer` is the one
 * predicate they share.
 *
 * The offer disappears on its own once the bonus is spent: `useAiQuota`
 * re-renders from the snapshot `grantAiQuotaAdReward` brings back, so this hook
 * keeps no state about whether the reward was already taken.
 */
export function useRewardedAdOffer(): {
  /** True only when watching an ad would actually add a request right now. */
  canOffer: boolean;
  /** Opens the confirm dialog, then the ad, then banks the reward. */
  openOffer: () => Promise<void>;
  /** True from the moment the ad is requested until the reward is settled. */
  busy: boolean;
} {
  const quota = useAiQuota();
  const { openConfirm } = useDialog();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // Support is checked alongside the quota rather than inside it: the server
  // knows nothing about whether this device can render an ad, and offering one
  // in a plain browser would be a button that can only fail.
  const canOffer = canWatchRewardedAd(quota) && isRewardedAdSupported();

  // Warmed only once the offer is live, so a user who never runs out never
  // fetches an ad. The SDK wants load → show, and the unregister returned here
  // detaches the pending load if they navigate away first.
  useEffect(() => {
    if (!canOffer) {
      return;
    }
    return preloadRewardedAd();
  }, [canOffer]);

  const openOffer = useCallback(async () => {
    // Re-checked rather than trusted from render: the dialog is async, and the
    // daily reset or a parallel grant can invalidate the offer mid-flight.
    if (busy || !canWatchRewardedAd(quota) || !isRewardedAdSupported()) {
      return;
    }

    const accepted = await openConfirm({
      title: "광고보고 AI 일기를 한 번 더 써봐요!",
      description: "광고를 끝까지 보면 오늘 AI 일기 1회가 추가돼요.",
      // '써볼래요' takes the confirm slot because it is the action this dialog
      // exists to offer; declining costs nothing and stays secondary.
      // No `placement="dialog"` on either: that variant stretches a single
      // alert button edge to edge, which breaks a two-button row.
      confirmButton: <DiaryButton>써볼래요</DiaryButton>,
      cancelButton: <DiaryButton tone="secondary">괜찮아요</DiaryButton>,
    });

    if (!accepted) {
      return;
    }

    setBusy(true);
    try {
      const outcome = await showRewardedAd();

      if (outcome === "rewarded") {
        const stored = await grantAiQuotaAdReward();
        toast.openToast(
          stored
            ? "AI 일기 1회가 추가됐어요."
            : "보상을 저장하지 못했어요. 잠시 후 다시 시도해 주세요.",
        );
        return;
      }

      // Closing early is a choice, not a fault — say what would have happened
      // without implying something broke.
      toast.openToast(
        outcome === "dismissed"
          ? "광고를 끝까지 봐야 횟수가 추가돼요."
          : "지금은 광고를 볼 수 없어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, quota, openConfirm, toast]);

  return { canOffer, openOffer, busy };
}
