import { Paragraph } from "@toss/tds-mobile";

import {
  AI_CREDIT_POLICY_NOTICE,
  AI_CREDIT_REFILL_NOTICE,
} from "../constants/diary";
import type { DiaryProgressView } from "../hooks/useDiaryProgress";
import { isRegionBlocked, useAiQuota } from "../hooks/useAiQuota";
import { isAiTestMode } from "../services/supabaseEdge";
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

function QuotaCounterNotice({
  progress,
  label,
  used,
  limit,
  exhaustedMessage,
}: {
  progress: DiaryProgressView;
  label: string;
  used: number;
  limit: number;
  exhaustedMessage: string;
}) {
  const remaining = Math.max(limit - used, 0);
  const available = remaining > 0;
  const safeLimit = Math.max(limit, 1);

  return (
    <div
      className={`ai-quota-notice ai-quota-counter daily-status-card${
        available ? "" : " is-exhausted"
      }`}
      aria-live="polite"
    >
      <DiaryStreakLead progress={progress} />

      <div className="daily-status-divider" aria-hidden="true" />

      <div className="ai-quota-counter-header">
        <div className="ai-quota-counter-heading">
          <span className="ai-quota-counter-kicker">
            {label} · 최대 {limit}회
          </span>
          <strong>
            {available ? `${remaining}회 남았어요` : exhaustedMessage}
          </strong>
        </div>

        <span
          className="ai-quota-counter-value"
          aria-label={`${limit}회 중 ${remaining}회 남음`}
        >
          <strong>{remaining}</strong>
          <span>/{limit}</span>
        </span>
      </div>

      <div
        className="ai-quota-meter"
        role="progressbar"
        aria-label={`${label} 남은 횟수`}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={remaining}
      >
        {Array.from({ length: safeLimit }, (_, index) => (
          <span
            key={index}
            className={index < remaining ? "is-remaining" : ""}
            aria-hidden="true"
          />
        ))}
      </div>

      <div className="ai-quota-counter-footer">
        <span>
          {available ? AI_CREDIT_POLICY_NOTICE : AI_CREDIT_REFILL_NOTICE}
        </span>
      </div>
    </div>
  );
}

function QuotaStatusMessage({
  progress,
  lines,
  tone = "neutral",
}: {
  progress: DiaryProgressView;
  lines: string[];
  tone?: "neutral" | "warning";
}) {
  return (
    <div
      className={`ai-quota-notice daily-status-card daily-status-message is-${tone}`}
      aria-live="polite"
    >
      <DiaryStreakLead progress={progress} />
      <div className="daily-status-divider" aria-hidden="true" />
      <div className="daily-status-ai-message">
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
    </div>
  );
}

interface QuotaNoticeCopy {
  label: string;
  localMode: string[];
  localTest: string[];
  serverTest: string[];
  regionBlocked: string[];
  checking: string;
  exhausted: string;
}

const QUOTA_NOTICE_COPY: QuotaNoticeCopy = {
  label: "AI 검사",
  localMode: ["기기 안에서 그림일기를 만들고 검사해요."],
  localTest: ["테스트 모드 · AI 검사를 제한 없이 이용할 수 있어요."],
  serverTest: ["테스트 모드 · AI 검사를 제한 없이 이용할 수 있어요."],
  regionBlocked: [
    "해외에서는 AI 그림일기 검사를 이용할 수 없어요.",
    "AI 결과 없이도 그림일기를 완성할 수 있어요.",
  ],
  checking: "AI 검사 기회를 확인하고 있어요.",
  exhausted: "기회를 모두 사용했어요",
};

function QuotaNotice({ progress }: { progress: DiaryProgressView }) {
  const quota = useAiQuota();
  const copy = QUOTA_NOTICE_COPY;

  if (isAiTestMode) {
    return <QuotaStatusMessage progress={progress} lines={copy.localTest} />;
  }
  if (isRegionBlocked(quota)) {
    return (
      <QuotaStatusMessage
        progress={progress}
        lines={copy.regionBlocked}
        tone="warning"
      />
    );
  }
  if (quota.mode === "ready" && quota.testMode) {
    return <QuotaStatusMessage progress={progress} lines={copy.serverTest} />;
  }
  if (quota.mode !== "ready") {
    return (
      <QuotaStatusMessage
        progress={progress}
        lines={quota.mode === "unknown" ? [copy.checking] : copy.localMode}
      />
    );
  }

  const { used, limit } = quota.completion;

  return (
    <QuotaCounterNotice
      progress={progress}
      label={copy.label}
      used={used}
      limit={limit}
      exhaustedMessage={copy.exhausted}
    />
  );
}

export function AiQuotaNotice({ progress }: { progress: DiaryProgressView }) {
  return <QuotaNotice progress={progress} />;
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
      lines={["다시 검사하면 AI 검사 기회 1회를 사용해요."]}
      tone="warning"
    />
  );
}
