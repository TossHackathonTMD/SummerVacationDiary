import { useRewardedAdOffer } from "../hooks/useRewardedAdOffer";
import { DiaryButton } from "./DiaryButton";

/** Compact top-up action kept visually separate from the quota meter. */
export function RewardedAdCallout() {
  const { canOffer, openOffer, busy } = useRewardedAdOffer();

  if (!canOffer) {
    return null;
  }

  return (
    <div className="rewarded-ad-callout" aria-live="polite">
      <span>기회를 채워둘까요?</span>
      <DiaryButton
        tone="secondary"
        stable
        disabled={busy}
        onClick={() => {
          void openOffer();
        }}
      >
        광고 보고 +1
      </DiaryButton>
    </div>
  );
}
