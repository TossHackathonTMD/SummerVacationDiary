import { Modal, Paragraph } from "@toss/tds-mobile";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import {
  AI_CONTENT_WATERMARK,
  weatherIconUrl,
  weatherLabel,
} from "../constants/diary";
import { DiaryFrameBackground } from "./DiaryFrameBackground";
import { StarMark } from "./StarMark";
import type { AnalysisState } from "../hooks/useDiaryAnalysis";
import type { DiaryDraft } from "../hooks/useDiaryDraft";
import type { SketchState } from "../hooks/useSketch";
import { isAiConnected } from "../services/diaryAnalysis";
import { isSketchAiConnected } from "../services/styleTransfer";
import type { DiaryAnalysis } from "../services/diaryAnalysis";
import { isAiTestMode } from "../services/supabaseEdge";
import {
  composeDiaryImage,
  type ComposedDiaryImage,
  type DiaryImageInput,
} from "../utils/diaryImage";
import {
  DIARY_FRAME,
  getDiaryFrameLayout,
  type DiaryFrameLayout,
  type DiaryFrameRegion,
} from "../utils/diaryFrameLayout";
import { diaryDateParts } from "../utils/diaryDate";
import { pickCorrectionMarkAsset } from "../utils/correctionMarks";
import {
  buildAnnotationTimeline,
  buildDiaryCells,
  correctionMarkBox,
  profanityMarkBox,
  starMarkBox,
  type AnnotationTimeline,
} from "../utils/diaryAnnotations";
import {
  handwritingVariation,
  TITLE_HANDWRITING_STRENGTH,
} from "../utils/handwriting";
import { pickProfanityMarkAsset } from "../utils/profanityMarks";
import { STAMP_ALT_TEXT, STAMP_IMAGE_URLS } from "../constants/stamp";
import { DiaryButton } from "./DiaryButton";

interface PreviewStepProps {
  draft: DiaryDraft;
  analysisState: AnalysisState;
  onRetry: () => void;
  sketchState: SketchState;
  onSketchRetry: () => void;
  processingEnabled: boolean;
  onProcessingVisibilityChange: (visible: boolean) => void;
  onRenderedImageChange: (preview: RenderedDiaryPreview | null) => void;
}

export interface RenderedDiaryPreview {
  dataUrl: string;
  input: DiaryImageInput;
}

const PREVIEW_PROCESSING_STEPS = [
  "사진과 일기를 한 장에 담고 있어요",
  "선생님이 일기를 꼼꼼히 읽고 있어요",
  "그림과 첨삭을 마무리하고 있어요",
] as const;
// Move through the first two narrative steps quickly, then wait for the real
// request in step 3. Even a fast response shows the finishing animation once.
const PROCESSING_READ_STEP_DELAY_MS = 2_500;
const PROCESSING_FINISH_STEP_DELAY_MS = 5_500;
const PROCESSING_FINISH_MIN_VISIBLE_MS = 1_200;
const PROCESSING_MASCOT_URL = "/mascot/stamp-friend-faceplant-stable.png";
const PROCESSING_MASCOT_REPLAY_MS = 1_300;

function DiaryProcessingStage({ currentStep }: { currentStep: number }) {
  const [mascotLoop, setMascotLoop] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(
      () => setMascotLoop((current) => current + 1),
      PROCESSING_MASCOT_REPLAY_MS,
    );
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section
      className="diary-processing-stage"
      aria-labelledby="diary-processing-title"
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {PREVIEW_PROCESSING_STEPS[currentStep]}
      </p>

      <div className="diary-processing-visual" aria-hidden="true">
        <span className="diary-processing-orbit" />
        <span className="diary-processing-badge">
          <picture>
            <source
              media="(prefers-reduced-motion: reduce)"
              srcSet="/mascot/stamp-friend-idle.png"
            />
            <img
              key={mascotLoop}
              className="diary-processing-mascot"
              src={`${PROCESSING_MASCOT_URL}?loop=${mascotLoop}`}
              alt=""
              draggable={false}
            />
          </picture>
        </span>
        <span className="diary-processing-spark diary-processing-spark-one" />
        <span className="diary-processing-spark diary-processing-spark-two" />
        <span className="diary-processing-spark diary-processing-spark-three" />
      </div>

      <div className="diary-processing-copy">
        <span>선생님 검사 중</span>
        <h2 id="diary-processing-title">그림일기를 만들고 있어요</h2>
        <p>완성되면 그림과 첨삭을 함께 보여드릴게요.</p>
      </div>

      <ol className="diary-processing-steps">
        {PREVIEW_PROCESSING_STEPS.map((message, index) => (
          <li
            key={message}
            className={
              index === currentStep
                ? "is-current"
                : index < currentStep
                  ? "is-complete"
                  : ""
            }
            aria-current={index === currentStep ? "step" : undefined}
          >
            <span aria-hidden="true">
              {index < currentStep ? "✓" : index + 1}
            </span>
            <strong>{message}</strong>
          </li>
        ))}
      </ol>
    </section>
  );
}

function frameRegionStyle(
  region: DiaryFrameRegion,
  layout: DiaryFrameLayout,
): CSSProperties {
  return {
    left: `${(region.x / layout.width) * 100}%`,
    top: `${(region.y / layout.height) * 100}%`,
    width: `${(region.width / layout.width) * 100}%`,
    height: `${(region.height / layout.height) * 100}%`,
  };
}

function handwritingCharacterStyle(
  variation: ReturnType<typeof handwritingVariation>,
  varyScale = true,
): CSSProperties {
  return {
    fontSize: `${varyScale ? variation.scale : 1}em`,
    fontWeight: variation.fontWeight,
    opacity: variation.opacity,
    transform: `translate(${variation.offsetXEm}em, ${variation.offsetYEm}em) rotate(${variation.rotationDeg}deg)`,
  };
}

function contentRegionStyle(
  region: DiaryFrameRegion,
  layout: DiaryFrameLayout,
): CSSProperties {
  return {
    left: `${((region.x - layout.content.x) / layout.content.width) * 100}%`,
    top: `${((region.y - layout.content.y) / layout.content.height) * 100}%`,
    width: `${(region.width / layout.content.width) * 100}%`,
    height: `${(region.height / layout.content.height) * 100}%`,
  };
}

// 날짜/날씨/제목처럼 한 요소 안에 있는 문자열도 한 글자씩 나눠서
// 본문과 같은 고정된 손글씨 흔들림을 적용합니다.
function HandwrittenText({
  text,
  seedOffset = 0,
  strength = 1,
  varyScale = true,
}: {
  text: string;
  seedOffset?: number;
  strength?: number;
  varyScale?: boolean;
}) {
  return Array.from(text).map((character, index) => {
    const variation = handwritingVariation(
      character,
      index + seedOffset,
      strength,
    );
    return (
      <span
        key={`${index}-${character}`}
        className="handwritten-character"
        style={handwritingCharacterStyle(variation, varyScale)}
      >
        {character === " " ? "\u00a0" : character}
      </span>
    );
  });
}

// Renders the diary text onto a 13x5 manuscript grid, one character per cell.
// Correction marks (circle/underline) are drawn as an absolutely-positioned
// visual overlay. The overlay is aria-hidden, so these marks are NOT exposed
// to screen readers (visual-only for now).
function HighlightedContent({
  content,
  analysis,
  timeline,
}: {
  content: string;
  analysis: DiaryAnalysis | null;
  timeline: AnnotationTimeline;
}) {
  const columnCount = DIARY_FRAME.columns;
  const layout = getDiaryFrameLayout(content);
  const rowCount = layout.contentRows;
  const visibleCells = buildDiaryCells(
    content,
    analysis,
    columnCount,
    rowCount,
  );

  return (
    <>
      {visibleCells.map((cell, index) => {
        // 본문도 날짜·날씨·제목과 동일한 기본 강도 1을 사용합니다.
        const variation = handwritingVariation(cell.text, index, 1);
        return (
          <span key={index} className="diary-grid-cell">
            <span
              className="diary-grid-character"
              style={handwritingCharacterStyle(variation)}
            >
              {cell.text === " " ? "\u00a0" : cell.text}
            </span>
          </span>
        );
      })}
      <span className="diary-correction-layer" aria-hidden>
        {timeline.events.map((event, index) => {
          const timingStyle = {
            "--mark-delay": `${event.delayMs}ms`,
            "--mark-duration": `${event.durationMs}ms`,
          } as CSSProperties;

          if (event.kind === "star") {
            return (
              <StarMark
                key={`star-${index}`}
                placement={event.placement}
                style={{
                  ...contentRegionStyle(
                    starMarkBox(layout, event.placement),
                    layout,
                  ),
                  ...timingStyle,
                }}
              />
            );
          }

          if (event.kind === "profanity") {
            return (
              <span
                key={`profanity-${index}`}
                className="diary-profanity-check"
                style={{
                  ...contentRegionStyle(
                    profanityMarkBox(layout, event.run),
                    layout,
                  ),
                  ...timingStyle,
                  backgroundImage: `url("${pickProfanityMarkAsset(
                    event.run.row,
                    event.run.startColumn,
                    event.run.length,
                  )}")`,
                }}
              />
            );
          }

          const box = correctionMarkBox(layout, event.run);
          if (event.kind === "circle") {
            return (
              <span
                key={`circle-${index}`}
                className="diary-correction diary-correction-circle"
                style={{
                  ...contentRegionStyle(box, layout),
                  ...timingStyle,
                  backgroundImage: `url("${pickCorrectionMarkAsset(
                    "circle",
                    event.run.row,
                    event.run.startColumn,
                    event.run.length,
                  )}")`,
                }}
              />
            );
          }

          const originalBox = correctionMarkBox(layout, event.originalRun);
          const segmentOffset = box.x - originalBox.x;
          return (
            <span
              key={`underline-${index}`}
              className="diary-correction diary-correction-underline"
              style={{
                ...contentRegionStyle(box, layout),
                ...timingStyle,
              }}
            >
              <span
                className="diary-underline-segment-image"
                style={{
                  left: `${(-segmentOffset / box.width) * 100}%`,
                  width: `${(originalBox.width / box.width) * 100}%`,
                  backgroundImage: `url("${pickCorrectionMarkAsset(
                    "underline",
                    event.originalRun.row,
                    event.originalRun.startColumn,
                    event.originalRun.length,
                  )}")`,
                }}
              />
            </span>
          );
        })}
      </span>
    </>
  );
}

/**
 * Step 3: the diary card laid out per the spec's 기본 구성
 * (date/weather → photo → title → content → one-line comment).
 * Stage 2 fills the comment area with the real analysis result (comment +
 * tags + highlight marks); stage 3 swaps the photo for the pencil drawing,
 * with the original photo as the fallback while converting / on failure
 * (spec: "원본 사진으로 그림일기를 만들거나 다시 시도할 수 있습니다").
 */
export function PreviewStep({
  draft,
  analysisState,
  onRetry,
  sketchState,
  onSketchRetry,
  processingEnabled,
  onProcessingVisibilityChange,
  onRenderedImageChange,
}: PreviewStepProps) {
  const analysis =
    analysisState.status === "success" ? analysisState.analysis : null;
  const modeNotice = isAiTestMode
    ? {
        title: "테스트 모드 안내",
        description: isAiConnected
          ? "원본 사진으로 분석만 진행해요. 그림 변환 모델은 호출하지 않아요."
          : "원본 사진과 예시 분석을 보여드려요.",
      }
    : !isAiConnected
      ? {
          title: "체험 모드 안내",
          description: "예시 분석과 간단한 그림 효과를 보여드려요.",
        }
      : null;

  const sketchUrl =
    sketchState.status === "success" && !isAiTestMode
      ? sketchState.sketchDataUrl
      : null;
  const showsSketch = sketchUrl !== null;
  const includesAiGeneratedContent =
    (isSketchAiConnected && sketchState.status === "success") ||
    (isAiConnected && analysisState.status === "success");
  const isAiRequestLoading =
    processingEnabled &&
    (analysisState.status === "loading" || sketchState.status === "loading");
  const analysisRetryable =
    analysisState.status === "error" && analysisState.retryable;
  const sketchRetryable =
    sketchState.status === "error" && sketchState.retryable;
  const hasRetryableError = analysisRetryable || sketchRetryable;
  const errorMessages = [
    analysisState.status === "error" ? analysisState.message : null,
    sketchState.status === "error" ? sketchState.message : null,
  ].filter((message): message is string => message !== null);
  const errorMessageText = errorMessages.join("\n\n");
  const errorDialogKey = `${analysisState.status === "error" ? analysisState.message : ""}|${sketchState.status === "error" ? sketchState.message : ""}`;
  const errorDialogKeyRef = useRef<string | null>(null);
  const [errorModalOpen, setErrorModalOpen] = useState(false);
  const [modeModalOpen, setModeModalOpen] = useState(() => modeNotice !== null);
  const retryFailedRequests = useCallback(() => {
    if (analysisRetryable) onRetry();
    if (sketchRetryable) onSketchRetry();
  }, [analysisRetryable, onRetry, onSketchRetry, sketchRetryable]);
  const [renderedPreview, setRenderedPreview] =
    useState<ComposedDiaryImage | null>(null);
  const [processingStep, setProcessingStep] = useState(0);
  const [isProcessingVisible, setIsProcessingVisible] =
    useState(isAiRequestLoading);
  const processingStartedAtRef = useRef<number | null>(null);
  const readTimerRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const animatedAnalysis = renderedPreview === null ? null : analysis;
  const annotationTimeline = useMemo(
    () =>
      buildAnnotationTimeline(
        draft.content,
        animatedAnalysis,
        DIARY_FRAME.columns,
        DIARY_FRAME.baseRows,
      ),
    [animatedAnalysis, draft.content],
  );
  const commentWriteDurationMs =
    Math.max(animatedAnalysis?.comment.length ?? 0, 1) * 50;
  const commentDelayMs = annotationTimeline.totalDurationMs + 350;
  const stampDelayMs = commentDelayMs + commentWriteDurationMs + 1_000;

  useEffect(() => {
    if (errorMessages.length === 0) {
      errorDialogKeyRef.current = null;
      setErrorModalOpen(false);
      return;
    }

    if (errorDialogKeyRef.current === errorDialogKey) {
      return;
    }
    errorDialogKeyRef.current = errorDialogKey;

    setErrorModalOpen(true);
  }, [
    errorDialogKey,
    errorMessageText,
    errorMessages.length,
    hasRetryableError,
  ]);

  useEffect(() => {
    const imageDataUrl = draft.sketchDataUrl ?? draft.photoDataUrl;
    if (imageDataUrl === null) {
      setRenderedPreview(null);
      return;
    }

    let cancelled = false;
    setRenderedPreview(null);
    onRenderedImageChange(null);
    const input: DiaryImageInput = {
      imageDataUrl,
      title: draft.title.trim() || "제목 없는 일기",
      content: draft.content,
      date: draft.date,
      weather: draft.weather,
      analysis,
      includesAiGeneratedContent,
    };
    void composeDiaryImage(input)
      .then((result) => {
        if (!cancelled) {
          setRenderedPreview(result);
          onRenderedImageChange({ dataUrl: result.dataUrl, input });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRenderedPreview(null);
          onRenderedImageChange(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analysis, draft, includesAiGeneratedContent, onRenderedImageChange]);

  useEffect(() => {
    if (isAiRequestLoading) {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
      if (processingStartedAtRef.current !== null) {
        return;
      }

      processingStartedAtRef.current = Date.now();
      setIsProcessingVisible(true);
      setProcessingStep(0);
      readTimerRef.current = window.setTimeout(
        () => setProcessingStep(1),
        PROCESSING_READ_STEP_DELAY_MS,
      );
      finishTimerRef.current = window.setTimeout(
        () => setProcessingStep(2),
        PROCESSING_FINISH_STEP_DELAY_MS,
      );
      return;
    }

    const startedAt = processingStartedAtRef.current;
    if (startedAt === null) {
      return;
    }

    const hideAt =
      startedAt +
      PROCESSING_FINISH_STEP_DELAY_MS +
      PROCESSING_FINISH_MIN_VISIBLE_MS;
    hideTimerRef.current = window.setTimeout(
      () => {
        setIsProcessingVisible(false);
        setProcessingStep(0);
        processingStartedAtRef.current = null;
        hideTimerRef.current = null;
      },
      Math.max(0, hideAt - Date.now()),
    );
  }, [isAiRequestLoading]);

  useEffect(
    () => () => {
      if (readTimerRef.current !== null) {
        window.clearTimeout(readTimerRef.current);
      }
      if (finishTimerRef.current !== null) {
        window.clearTimeout(finishTimerRef.current);
      }
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
      processingStartedAtRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (isProcessingVisible) {
      onProcessingVisibilityChange(true);
    } else if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onProcessingVisibilityChange(false);
    }
  }, [isProcessingVisible, onProcessingVisibilityChange]);

  useEffect(
    () => () => {
      onProcessingVisibilityChange(false);
    },
    [onProcessingVisibilityChange],
  );

  // Announced through the always-mounted live region below. A region that
  // mounts together with its text is often not read at all — only TEXT
  // CHANGES inside an existing region are reliably announced, which is
  // exactly what happens when loading flips to success mid-visit.
  const sketchAnnouncement =
    sketchState.status === "loading"
      ? "사진을 크레파스 그림으로 바꾸고 있어요"
      : sketchState.status === "success"
        ? isAiTestMode
          ? "원본 사진으로 미리보기를 준비했어요"
          : "크레파스 그림이 완성됐어요"
        : sketchState.status === "error"
          ? "그림 변환에 실패해서 원본 사진이 보여요"
          : "";
  const { year, month, day, weekday } = diaryDateParts(draft.date);
  const frameLayout =
    renderedPreview?.frameLayout ?? getDiaryFrameLayout(draft.content);

  return (
    <div
      className={`step-body preview-step${isProcessingVisible ? " is-processing" : ""}`}
    >
      <p className="visually-hidden" role="status">
        {sketchAnnouncement}
      </p>

      {isProcessingVisible ? (
        <DiaryProcessingStage currentStep={processingStep} />
      ) : (
        <>
          <div className="preview-save-notice" role="note">
            <span className="preview-save-notice-symbol" aria-hidden="true">
              ✓
            </span>
            <span>
              아래 <strong>일기 완성하기</strong>를 눌러야 달력에 저장돼요.
            </span>
          </div>

          <div
            className="diary-card diary-card-reveal"
            onAnimationEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                analysis === null
              ) {
                onProcessingVisibilityChange(false);
              }
            }}
          >
            <div
              className="diary-template"
              style={
                {
                  aspectRatio: `${frameLayout.width} / ${frameLayout.height}`,
                  "--stamp-delay": `${stampDelayMs}ms`,
                } as CSSProperties
              }
            >
              <DiaryFrameBackground layout={frameLayout} />

              {includesAiGeneratedContent && (
                <span className="ai-content-watermark">
                  {AI_CONTENT_WATERMARK}
                </span>
              )}

              <div
                className="diary-card-header"
                style={frameRegionStyle(DIARY_FRAME.header, frameLayout)}
              >
                <span>
                  <strong>
                    <HandwrittenText text={year} strength={0.45} />
                  </strong>
                </span>
                <span>
                  <strong>
                    <HandwrittenText
                      text={month}
                      seedOffset={10}
                      strength={0.45}
                    />
                  </strong>
                </span>
                <span>
                  <strong>
                    <HandwrittenText
                      text={day}
                      seedOffset={20}
                      strength={0.45}
                    />
                  </strong>
                </span>
                <span>
                  <strong>
                    <HandwrittenText
                      text={weekday}
                      seedOffset={30}
                      strength={0.45}
                    />
                  </strong>
                </span>
                <span className="diary-weather">
                  <img
                    className="diary-weather-icon"
                    src={weatherIconUrl(draft.weather)}
                    alt=""
                    aria-hidden="true"
                  />
                  <strong>
                    <HandwrittenText
                      text={weatherLabel(draft.weather)}
                      seedOffset={40}
                      strength={0.45}
                    />
                  </strong>
                </span>
              </div>

              <div
                className="diary-title-row"
                style={frameRegionStyle(DIARY_FRAME.title, frameLayout)}
              >
                <strong>
                  <HandwrittenText
                    text={draft.title !== "" ? draft.title : "제목 없는 일기"}
                    seedOffset={50}
                    strength={TITLE_HANDWRITING_STRENGTH}
                  />
                </strong>
              </div>

              <div
                className="diary-card-photo"
                style={frameRegionStyle(DIARY_FRAME.photo, frameLayout)}
              >
                {draft.photoDataUrl !== null ? (
                  <>
                    <img
                      src={showsSketch ? sketchUrl : draft.photoDataUrl}
                      alt={
                        showsSketch
                          ? "크레파스 그림으로 바뀐 일기 사진"
                          : "일기 사진"
                      }
                    />
                  </>
                ) : (
                  <div className="diary-card-photo-empty">사진이 없어요</div>
                )}
              </div>

              <div
                className="diary-card-content"
                style={{
                  ...frameRegionStyle(frameLayout.content, frameLayout),
                  gridTemplateRows: `repeat(${frameLayout.contentRows}, minmax(0, 1fr))`,
                }}
              >
                <HighlightedContent
                  content={draft.content}
                  analysis={animatedAnalysis}
                  timeline={annotationTimeline}
                />
              </div>

              {/* Fixed colors throughout the card: it sits on a fixed paper
            background (#fffdf5), and the AIT provider is light-only today. */}
              <div
                className="diary-card-comment"
                style={frameRegionStyle(frameLayout.comment, frameLayout)}
              >
                {animatedAnalysis === null && (
                  <div className="diary-comment-label">선생님 한마디</div>
                )}

                {analysisState.status === "error" && (
                  <div className="comment-error">
                    <Paragraph
                      as="span"
                      className="diary-comment-text"
                      typography="t5"
                      color="#8a7d55"
                    >
                      한마디를 불러오지 못했어요
                    </Paragraph>
                  </div>
                )}

                {analysisState.status === "idle" && (
                  <div className="comment-error">
                    <Paragraph
                      as="span"
                      className="diary-comment-text"
                      typography="t5"
                      color="#8a7d55"
                    >
                      아직 검사받지 않았어요
                    </Paragraph>
                  </div>
                )}
              </div>

              {animatedAnalysis !== null && renderedPreview !== null && (
                <div
                  className="diary-rendered-comment"
                  style={
                    {
                      ...frameRegionStyle(frameLayout.comment, frameLayout),
                      "--comment-write-duration": `${commentWriteDurationMs}ms`,
                      "--comment-delay": `${commentDelayMs}ms`,
                      "--comment-write-steps": Math.max(
                        animatedAnalysis.comment.length,
                        1,
                      ),
                    } as CSSProperties
                  }
                  aria-hidden="true"
                >
                  <img
                    src={renderedPreview.dataUrl}
                    alt=""
                    style={{
                      left: `${(-frameLayout.comment.x / frameLayout.comment.width) * 100}%`,
                      top: `${(-frameLayout.comment.y / frameLayout.comment.height) * 100}%`,
                      width: `${(frameLayout.width / frameLayout.comment.width) * 100}%`,
                      height: `${(frameLayout.height / frameLayout.comment.height) * 100}%`,
                    }}
                  />
                </div>
              )}

              {animatedAnalysis !== null && (
                <img
                  className="diary-stamp"
                  src={STAMP_IMAGE_URLS[animatedAnalysis.stamp]}
                  alt={STAMP_ALT_TEXT[animatedAnalysis.stamp]}
                  onAnimationEnd={() => onProcessingVisibilityChange(false)}
                />
              )}
            </div>
          </div>
        </>
      )}

      <Modal open={errorModalOpen} onOpenChange={setErrorModalOpen}>
        <Modal.Overlay />
        <Modal.Content
          className="app-modal-panel preview-error-modal"
          aria-label="오류 안내"
          aria-describedby="preview-error-description"
        >
          <div className="app-modal-layout preview-error-modal-layout">
            <div className="preview-error-modal-body">
              <p
                id="preview-error-description"
                className="preview-error-message"
              >
                {errorMessageText}
              </p>
            </div>
            <div
              className={`app-modal-footer preview-error-modal-actions${hasRetryableError ? "" : " is-single"}`}
            >
              {hasRetryableError ? (
                <>
                  <DiaryButton
                    tone="secondary"
                    stable
                    fullWidth
                    onClick={() => setErrorModalOpen(false)}
                  >
                    닫기
                  </DiaryButton>
                  <DiaryButton
                    stable
                    fullWidth
                    onClick={() => {
                      setErrorModalOpen(false);
                      retryFailedRequests();
                    }}
                  >
                    다시 시도
                  </DiaryButton>
                </>
              ) : (
                <DiaryButton
                  stable
                  fullWidth
                  onClick={() => setErrorModalOpen(false)}
                >
                  확인
                </DiaryButton>
              )}
            </div>
          </div>
        </Modal.Content>
      </Modal>

      {modeNotice !== null && (
        <Modal open={modeModalOpen} onOpenChange={setModeModalOpen}>
          <Modal.Overlay />
          <Modal.Content
            className="app-modal-panel preview-error-modal"
            aria-labelledby="preview-mode-title"
            aria-describedby="preview-mode-description"
          >
            <div className="app-modal-layout preview-error-modal-layout">
              <div className="preview-error-modal-body">
                <h2 id="preview-mode-title" className="app-modal-title">
                  {modeNotice.title}
                </h2>
                <p id="preview-mode-description">{modeNotice.description}</p>
              </div>
              <div className="app-modal-footer preview-error-modal-actions is-single">
                <DiaryButton
                  stable
                  fullWidth
                  onClick={() => setModeModalOpen(false)}
                >
                  확인
                </DiaryButton>
              </div>
            </div>
          </Modal.Content>
        </Modal>
      )}
    </div>
  );
}
