import { Paragraph } from "@toss/tds-mobile";
import { useEffect, useRef } from "react";

import type { DiaryProgressView } from "../hooks/useDiaryProgress";
import { isRegionBlocked, useAiQuota } from "../hooks/useAiQuota";
import { useRewardedAdOffer } from "../hooks/useRewardedAdOffer";
import { isAiTestMode } from "../services/supabaseEdge";
import { DiaryButton } from "./DiaryButton";
import { DiaryStreakLead } from "./DiaryStreakStatus";

function NoticeBox({
  lines,
  tone = "neutral",
}: {
  lines: string[];
  tone?: "neutral" | "warning";
}) {
  return (
    <div
      className={`ai-quota-notice ai-quota-notice-${tone}`}
      aria-live="polite"
    >
      <span className="ai-quota-notice-symbol" aria-hidden="true">
        i
      </span>
      <div className="ai-quota-notice-copy">
        {lines.map((line) => (
          <Paragraph key={line} as="span" typography="t7" color="#5A442C">
            {line}
          </Paragraph>
        ))}
      </div>
    </div>
  );
}

const REGION_BLOCKED_LINES = [
  "해외에서는 AI 그림일기 검사를 이용할 수 없어요.",
  "AI 결과 없이도 그림일기를 완성할 수 있어요.",
];

/**
 * The photo step's status card.
 *
 * The daily AI counter used to live here and has been removed on purpose: with
 * a rewarded ad able to extend the budget, a number on screen would need to
 * explain itself ("2 free, or 3 if you watch something") to stay honest, and
 * the remaining count is not what this screen is for. What survives is the
 * streak lead — the mascot and its one-line greeting — which is about the
 * user's own record rather than about quota.
 *
 * The one thing that does replace the counter is the ad offer, and only in the
 * state where it means something: the budget is spent and today's bonus is
 * still unclaimed. In every other state this card is just the mascot.
 */
export function AiQuotaNotice({ progress }: { progress: DiaryProgressView }) {
  const quota = useAiQuota();
  const { canOffer, openOffer, busy } = useRewardedAdOffer();

  // This component is mounted only while the photo step is showing, so its
  // mount *is* "the user came back to the photo view" — which is the moment the
  // offer is supposed to appear on its own.
  //
  // The latch is per mount rather than per session: declining should stop the
  // dialog reappearing while they stay here (the button below is how they get
  // it back), but leaving and returning is a fresh arrival and offers again.
  // It cannot fire on mount directly — the quota arrives from the server a beat
  // later, so this waits for `canOffer` to actually become true.
  const autoOfferedRef = useRef(false);
  useEffect(() => {
    if (!canOffer || autoOfferedRef.current) {
      return;
    }
    autoOfferedRef.current = true;
    void openOffer();
  }, [canOffer, openOffer]);

  // Region blocking is not a counter — it says the AI features cannot run here
  // at all — so hiding it with the count would leave overseas users tapping a
  // button that silently does nothing.
  const regionBlocked = !isAiTestMode && isRegionBlocked(quota);

  return (
    <div
      className="ai-quota-notice daily-status-card daily-status-plain"
      aria-live="polite"
    >
      <DiaryStreakLead progress={progress} />

      {regionBlocked && (
        <>
          <div className="daily-status-divider" aria-hidden="true" />
          <div className="daily-status-ai-message">
            <span className="ai-quota-notice-symbol" aria-hidden="true">
              i
            </span>
            <div className="ai-quota-notice-copy">
              {REGION_BLOCKED_LINES.map((line) => (
                <Paragraph key={line} as="span" typography="t7" color="#5A442C">
                  {line}
                </Paragraph>
              ))}
            </div>
          </div>
        </>
      )}

      {canOffer && (
        <>
          <div className="daily-status-divider" aria-hidden="true" />
          <DiaryButton
            tone="secondary"
            stable
            fullWidth
            disabled={busy}
            onClick={() => {
              void openOffer();
            }}
          >
            AI 일기 횟수 추가하기
          </DiaryButton>
        </>
      )}
    </div>
  );
}

export function AiRecheckNotice() {
  const quota = useAiQuota();

  if (
    isAiTestMode ||
    isRegionBlocked(quota) ||
    quota.mode !== "ready" ||
    quota.testMode ||
    quota.completion.used >= quota.completion.limit
  ) {
    return null;
  }

  return (
    <NoticeBox
      lines={["다시 검사하면 오늘의 AI 검사 기회 1회를 사용해요."]}
      tone="warning"
    />
  );
}
