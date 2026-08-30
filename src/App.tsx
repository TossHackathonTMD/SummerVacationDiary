import { Top, useDialog, useToast } from "@toss/tds-mobile";
import {
  graniteEvent,
  SafeAreaInsets,
  Screen,
} from "@apps-in-toss/web-framework";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import "./App.css";
import { AiQuotaNotice, AiRecheckNotice } from "./components/AiQuotaNotice";
import { BannerAd } from "./components/BannerAd";
import { DiaryButton } from "./components/DiaryButton";
import { PhotoUploadStep } from "./components/PhotoUploadStep";
import { RewardedAdCallout } from "./components/RewardedAdCallout";
import { StreakMilestoneModal } from "./components/StreakMilestoneModal";
import {
  TODAY_DIARY_FULL_TITLE,
  todayDiaryFullDescription,
} from "./constants/diary";
import type {
  CalendarRevealRequest,
  CalendarShareRequest,
} from "./components/DiaryCalendarView";
import type { RenderedDiaryPreview } from "./components/PreviewStep";
import { WriteStep } from "./components/WriteStep";
import {
  isAiQuotaSpent,
  isRegionBlocked,
  refreshAiQuota,
  useAiQuota,
} from "./hooks/useAiQuota";
import { useDiaryAnalysis } from "./hooks/useDiaryAnalysis";
import { useDiaryDraft, type DiaryDraft } from "./hooks/useDiaryDraft";
import { useDiaryProgress } from "./hooks/useDiaryProgress";
import { useSketch } from "./hooks/useSketch";
import {
  createDiaryInspectionContext,
  type DiaryInspectionContext,
} from "./services/diaryInspection";
import type { DiaryImageInput } from "./utils/diaryImage";
import { createDiaryRevisionKey } from "./utils/diaryIdentity";
import { isAiConnected } from "./services/diaryAnalysis";
import {
  DiaryStoreError,
  MAX_DIARIES_PER_DATE,
  saveDiary,
} from "./services/diaryStore";
import { isSketchAiConnected } from "./services/styleTransfer";
import type { DiaryMilestone } from "./services/diaryProgress";

// Plain state instead of a router: the flow is a strict 3-step wizard. The
// calendar is the one externally addressable destination, so its deep-link
// path is mapped to the initial state below without adding a routing library.
type Step = "upload" | "write" | "preview" | "calendar";
type WizardStep = Exclude<Step, "calendar">;

const CALENDAR_PATH = "/calendar";
const HISTORY_STEP_KEY = "summerDiaryStep";

function historyStateFor(step: Step): Record<string, unknown> {
  const current = window.history.state;
  return {
    ...(typeof current === "object" && current !== null ? current : {}),
    [HISTORY_STEP_KEY]: step,
  };
}

function stepFromHistoryState(state: unknown): Step | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const value = (state as Record<string, unknown>)[HISTORY_STEP_KEY];
  return value === "upload" ||
    value === "write" ||
    value === "preview" ||
    value === "calendar"
    ? value
    : null;
}

const loadPreviewStep = () => import("./components/PreviewStep");
const loadDiaryCalendarView = () => import("./components/DiaryCalendarView");
const loadDiaryShareModal = () => import("./components/DiaryShareModal");
const PreviewStep = lazy(async () => {
  const module = await loadPreviewStep();
  return { default: module.PreviewStep };
});
const DiaryCalendarView = lazy(async () => {
  const module = await loadDiaryCalendarView();
  return { default: module.DiaryCalendarView };
});
const DiaryShareModal = lazy(async () => {
  const module = await loadDiaryShareModal();
  return { default: module.DiaryShareModal };
});

function isCalendarDeepLink(): boolean {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === CALENDAR_PATH;
}

interface DiaryConfirmOptions {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  // TDS defaults this to true. Opt out for dialogs that report a blocked
  // action: a stray dimmer tap there reads as "dismissed by accident", and
  // the user never learns why the save did not go through.
  closeOnDimmerClick?: boolean;
}

type PreviewDraftSnapshot = Pick<
  DiaryDraft,
  "photoDataUrl" | "title" | "content" | "weather" | "timeOfDay"
>;

function previewDraftSnapshot(draft: DiaryDraft): PreviewDraftSnapshot {
  return {
    photoDataUrl: draft.photoDataUrl,
    title: draft.title,
    content: draft.content,
    weather: draft.weather,
    timeOfDay: draft.timeOfDay,
  };
}

function sameDiaryImageInput(
  left: DiaryImageInput,
  right: DiaryImageInput,
): boolean {
  return (
    left.imageDataUrl === right.imageDataUrl &&
    left.title === right.title &&
    left.content === right.content &&
    left.date === right.date &&
    left.weather === right.weather &&
    left.analysis === right.analysis &&
    left.includesAiGeneratedContent === right.includesAiGeneratedContent
  );
}

const STEP_HEADERS: Record<Step, { title: string; subtitle: string }> = {
  upload: {
    title: "어떤 여름이었나요?",
    subtitle: "그림일기로 만들 사진 1장을 골라주세요.",
  },
  write: {
    title: "일기 쓰기",
    subtitle: "사진 속 이야기를 짧게 적어주세요.",
  },
  preview: {
    title: "그림일기 미리보기",
    subtitle: "선생님의 한마디와 함께 확인해 보세요.",
  },
  calendar: {
    title: "일기 달력",
    subtitle: "일기를 완성한 날짜에 도장을 모아 보세요.",
  },
};

const STEP_PROGRESS: Record<WizardStep, { current: number; label: string }> = {
  upload: { current: 1, label: "사진 고르기" },
  write: { current: 2, label: "일기 쓰기" },
  preview: { current: 3, label: "미리보기" },
};

const STEP_LABELS = ["사진 고르기", "일기 쓰기", "미리보기"] as const;

const ONBOARDING_DECORATIONS = [
  { name: "sun", file: "sun.png" },
  { name: "cloud-big", file: "big_cloud.png" },
  { name: "cloud-small", file: "small_cloud2.png" },
  { name: "seagull", file: "seagull.png" },
  { name: "seagull-two", file: "seagull.png" },
  { name: "sailboat", file: "sailboat.png" },
  { name: "dolphin", file: "dolphin.png" },
  { name: "palm-tree", file: "palm_tree.png" },
  { name: "girl", file: "LittleGirlAndCat.png" },
  { name: "sandcastle", file: "sancastle.png" },
  { name: "beach-ball", file: "beach_ball.png" },
  { name: "crab", file: "crab.png" },
] as const;

const ONBOARDING_TITLE_LINES = [
  [
    { name: "na", file: "title-na.png" },
    { name: "ui", file: "title-ui.png" },
  ],
  [
    { name: "yeo", file: "title-yeo.png" },
    { name: "reum", file: "title-reum.png" },
    { name: "bang", file: "title-bang.png" },
    { name: "hak", file: "title-hak.png" },
  ],
  [
    { name: "il", file: "title-il.png" },
    { name: "gi", file: "title-gi.png" },
  ],
] as const;

function AppBottomBar({
  children,
  double = false,
}: {
  children: ReactNode;
  double?: boolean;
}) {
  const layout = double ? " app-bottom-bar-content-double" : "";

  return (
    <div className="app-bottom-bar">
      <div className={`app-bottom-bar-content${layout}`}>{children}</div>
    </div>
  );
}

function App() {
  const isAndroid = /Android/i.test(navigator.userAgent);
  const isIos =
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const usesMobileKeyboard = isAndroid || isIos;
  const [isKeyboardClosing, setIsKeyboardClosing] = useState(false);
  const contentKeyboardSessionRef = useRef(false);
  const writeFormEndRef = useRef<HTMLDivElement>(null);
  const [showOnboarding, setShowOnboarding] = useState(
    () => !isCalendarDeepLink(),
  );
  const [step, setStep] = useState<Step>(() =>
    isCalendarDeepLink() ? "calendar" : "upload",
  );
  const stepRef = useRef(step);
  const navigateToStep = (nextStep: Step, replace = false) => {
    stepRef.current = nextStep;
    window.history[replace ? "replaceState" : "pushState"](
      historyStateFor(nextStep),
      "",
    );
    setStep(nextStep);
  };
  const [calendarReturnStep, setCalendarReturnStep] = useState<
    "upload" | "write" | "preview" | "new"
  >("upload");
  const [calendarInitialDate, setCalendarInitialDate] = useState<string>();
  const [writeEntryId, setWriteEntryId] = useState(0);
  // Always open on a fresh diary. Draft persistence remains available in the
  // hook, but this flow must not restore a previous visit's photo or text.
  const { draft, updateDraft, clearDraft } = useDiaryDraft({
    restoreOnStart: false,
  });
  // Not part of the draft: it is only a cache key, and persisting it would mean
  // versioning the draft shape for something that dies with the session anyway.
  const [photoSourceHash, setPhotoSourceHash] = useState<string | null>(null);
  const [weatherEffectKey, setWeatherEffectKey] = useState(0);
  const [inspectionContext, setInspectionContext] =
    useState<DiaryInspectionContext>();
  const quota = useAiQuota();
  const { state: diaryProgress, completeToday: completeDiaryProgress } =
    useDiaryProgress();
  // Refused outright by country, which unlike a user credit refill never comes
  // back — so it gates both operations rather than one.
  const regionBlocked = isRegionBlocked(quota);
  const aiQuotaSpent = isAiQuotaSpent(quota);
  // Gate on "would this actually reach the server". Mock and test mode never
  // do, so they must never be blocked by a counter they don't spend.
  const sketchAllowed =
    !isSketchAiConnected || (!regionBlocked && !aiQuotaSpent);
  const analyzeAllowed = !isAiConnected || (!regionBlocked && !aiQuotaSpent);

  // Analysis is triggered explicitly by 검사 받기, not by opening the preview:
  // with scarce bundled credits, re-running on every edit would spend the
  // budget on typo fixes. Results are cached by input inside the hook, so
  // asking again without editing is free.
  const { state: analysisState, run: runAnalysis } = useDiaryAnalysis(draft);
  // Photo conversion and diary analysis both start only after 검사 받기. This
  // preserves the user's limited drawing opportunities when they leave midway
  // through writing or return to replace the photo.
  const {
    state: sketchState,
    retry: retrySketch,
    discardSketch,
    isDrawingInProgress,
  } = useSketch(
    draft,
    updateDraft,
    step === "preview",
    sketchAllowed,
    photoSourceHash,
    inspectionContext,
  );
  const { openAlert, openConfirm } = useDialog();
  const openDiaryConfirm = ({
    title,
    description,
    confirmLabel,
    cancelLabel,
    closeOnDimmerClick,
  }: DiaryConfirmOptions) =>
    openConfirm({
      title,
      description,
      confirmButton: <DiaryButton>{confirmLabel}</DiaryButton>,
      cancelButton: <DiaryButton tone="secondary">{cancelLabel}</DiaryButton>,
      closeOnDimmerClick,
    });
  const regionNoticeShownRef = useRef(false);
  const toast = useToast();
  const exitConfirmPendingRef = useRef(false);
  const requestAppExit = useCallback(async () => {
    if (exitConfirmPendingRef.current) {
      return;
    }

    exitConfirmPendingRef.current = true;
    try {
      const shouldExit = await openConfirm({
        title: "앱을 종료할까요?",
        description: "작성 중인 내용은 다음 실행에서 이어지지 않을 수 있어요.",
        confirmButton: <DiaryButton tone="danger">종료하기</DiaryButton>,
        cancelButton: <DiaryButton tone="secondary">계속하기</DiaryButton>,
        closeOnDimmerClick: false,
      });

      if (shouldExit) {
        await Screen.close();
      }
    } catch {
      toast.openToast("앱을 종료하지 못했어요. 잠시 후 다시 시도해 주세요.");
    } finally {
      exitConfirmPendingRef.current = false;
    }
  }, [openConfirm, toast]);
  const [saving, setSaving] = useState(false);
  const [renderedDiaryPreview, setRenderedDiaryPreview] =
    useState<RenderedDiaryPreview | null>(null);
  const [previewAnimationRunning, setPreviewAnimationRunning] = useState(false);
  const [previewProcessingEnabled, setPreviewProcessingEnabled] =
    useState(false);
  const [previewModuleLoading, setPreviewModuleLoading] = useState(false);
  const [calendarReveal, setCalendarReveal] =
    useState<CalendarRevealRequest | null>(null);
  const [calendarShareRequest, setCalendarShareRequest] =
    useState<CalendarShareRequest | null>(null);
  const [pendingMilestone, setPendingMilestone] =
    useState<DiaryMilestone | null>(null);
  const [milestoneVisible, setMilestoneVisible] = useState(false);
  // Consent is intentionally memory-only: it survives new-diary navigation
  // inside this execution, but a fresh mini-app launch asks again.
  const [hasPhotoSessionConsent, setHasPhotoSessionConsent] = useState(false);

  const [hasVisitedWrite, setHasVisitedWrite] = useState(false);
  const [hasVisitedPreview, setHasVisitedPreview] = useState(false);
  const lastPreviewDraftRef = useRef<PreviewDraftSnapshot | null>(null);
  const [analyzeRecheckNoticeVisible, setAnalyzeRecheckNoticeVisible] =
    useState(false);

  useEffect(() => {
    if (!usesMobileKeyboard) {
      return;
    }

    const viewport = window.visualViewport;
    let largestViewportHeight = viewport?.height ?? window.innerHeight;
    let keyboardOpen = false;
    let contentClosePending = false;
    let firstScrollFrame = 0;
    let secondScrollFrame = 0;

    const isWriteFieldFocused = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLElement &&
        activeElement.matches(
          ".write-form textarea, .write-form input[type='text'], .write-form input:not([type])",
        )
      );
    };

    const rememberFocusedField = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }

      if (target.matches(".diary-content-section textarea")) {
        contentKeyboardSessionRef.current = true;
      } else if (target.matches(".diary-title-section input")) {
        contentKeyboardSessionRef.current = false;
      }

      updateKeyboardState();
    };

    const updateKeyboardState = () => {
      const currentHeight = viewport?.height ?? window.innerHeight;
      largestViewportHeight = Math.max(largestViewportHeight, currentHeight);

      // Browser chrome can change the viewport by a few pixels. A software
      // keyboard reduces it much more, so keep a conservative opening
      // threshold. Once open, keep that state until the viewport is fully
      // restored instead of treating the keyboard's closing animation as
      // already closed.
      const keyboardHeight = largestViewportHeight - currentHeight;
      const nextKeyboardOpen = keyboardOpen
        ? keyboardHeight > 8
        : isWriteFieldFocused() && keyboardHeight > 120;

      if (
        keyboardOpen &&
        !nextKeyboardOpen &&
        contentKeyboardSessionRef.current
      ) {
        keyboardOpen = false;
        contentClosePending = true;
        contentKeyboardSessionRef.current = false;
        setIsKeyboardClosing(true);

        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLTextAreaElement &&
          activeElement.matches(".diary-content-section textarea")
        ) {
          activeElement.blur();
        }

        // Keep the fixed actions hidden until the mobile WebView has applied
        // the blur and its restored viewport layout. Then jump to the form's
        // real bottom marker and reveal the actions on the following render.
        firstScrollFrame = window.requestAnimationFrame(() => {
          secondScrollFrame = window.requestAnimationFrame(() => {
            writeFormEndRef.current?.scrollIntoView({
              behavior: "auto",
              block: "end",
              inline: "nearest",
            });

            // iOS WebViews can align the anchor inside the visual viewport
            // without moving the root document to its true maximum scroll.
            // Confirm the root position explicitly before revealing actions.
            const scrollingElement = document.scrollingElement;
            if (scrollingElement !== null) {
              scrollingElement.scrollTo({
                top: scrollingElement.scrollHeight,
                behavior: "auto",
              });
            } else {
              window.scrollTo(0, document.documentElement.scrollHeight);
            }

            contentClosePending = false;
            setIsKeyboardClosing(false);
          });
        });
        return;
      }

      if (contentClosePending) {
        return;
      }

      keyboardOpen = nextKeyboardOpen;
    };

    const handleFocusOut = () => {
      window.setTimeout(updateKeyboardState, 0);
    };

    viewport?.addEventListener("resize", updateKeyboardState);
    window.addEventListener("resize", updateKeyboardState);
    document.addEventListener("focusin", rememberFocusedField);
    document.addEventListener("focusout", handleFocusOut);

    return () => {
      viewport?.removeEventListener("resize", updateKeyboardState);
      window.removeEventListener("resize", updateKeyboardState);
      document.removeEventListener("focusin", rememberFocusedField);
      document.removeEventListener("focusout", handleFocusOut);
      window.cancelAnimationFrame(firstScrollFrame);
      window.cancelAnimationFrame(secondScrollFrame);
    };
  }, [usesMobileKeyboard]);

  useEffect(() => {
    window.history.replaceState(historyStateFor(stepRef.current), "");

    const handleHistoryNavigation = (event: PopStateEvent) => {
      const nextStep = stepFromHistoryState(event.state);
      if (nextStep === null || event.state?.diaryOverlayReturn === "crop") {
        return;
      }

      const previousStep = stepRef.current;
      if (previousStep === "upload") {
        window.history.back();
        return;
      }
      if (previousStep === "preview" && nextStep === "write") {
        setAnalyzeRecheckNoticeVisible(true);
        setWriteEntryId((entryId) => entryId + 1);
      }
      if (previousStep === "calendar") {
        setCalendarInitialDate(undefined);
        setCalendarReveal(null);
        if (nextStep === "write") {
          setWriteEntryId((entryId) => entryId + 1);
        }
      }

      stepRef.current = nextStep;
      setStep(nextStep);
    };

    window.addEventListener("popstate", handleHistoryNavigation);
    return () =>
      window.removeEventListener("popstate", handleHistoryNavigation);
  }, []);

  useEffect(() => {
    if (!showOnboarding || !("ReactNativeWebView" in window)) {
      return;
    }

    return graniteEvent.addEventListener("backEvent", {
      onEvent: () => {
        void requestAppExit();
      },
    });
  }, [requestAppExit, showOnboarding]);

  useEffect(() => {
    if (step === "upload" || !("ReactNativeWebView" in window)) {
      return;
    }

    return graniteEvent.addEventListener("backEvent", {
      onEvent: () => {
        if (step !== "preview") {
          window.history.back();
        }
      },
    });
  }, [step]);

  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-onboarding-open", showOnboarding);

    return () => {
      root.removeAttribute("data-onboarding-open");
    };
  }, [showOnboarding]);

  useEffect(() => {
    if (!showOnboarding) return;

    // The two locally bundled handwriting faces are otherwise fetched only
    // when their first screen appears.
    void Promise.all([
      document.fonts.load("400 19px NanumCoDingHeuiMang"),
      document.fonts.load("400 19px NanumDdarEGeEomMaGa"),
    ]);
  }, [showOnboarding]);

  // quota-status never consumes a request. Start it while the onboarding is
  // visible so the upload step can show the real remaining count immediately
  // in the usual case, instead of beginning the network round trip on tap.
  useEffect(() => {
    void refreshAiQuota();
  }, []);

  useEffect(() => {
    const applyInsets = (insets: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    }) => {
      const root = document.documentElement;
      root.style.setProperty("--toss-safe-area-top", `${insets.top}px`);
      root.style.setProperty("--toss-safe-area-right", `${insets.right}px`);
      root.style.setProperty("--toss-safe-area-bottom", `${insets.bottom}px`);
      root.style.setProperty("--toss-safe-area-left", `${insets.left}px`);
    };

    try {
      applyInsets(SafeAreaInsets.get());
      return SafeAreaInsets.subscribe({ onEvent: applyInsets });
    } catch {
      // Plain browsers do not have the Toss bridge. CSS env() remains the
      // fallback there, so the local development flow needs no mock values.
      return undefined;
    }
  }, []);

  // Once per session, and only after onboarding: the quota fetch that reveals
  // this is fired by 시작하기, so before that there is nothing to say. The ref
  // guard is also what makes openAlert's reference stability irrelevant. The
  // dialog portals, so the onboarding early return below does not hide it.
  useEffect(() => {
    if (showOnboarding || !regionBlocked || regionNoticeShownRef.current) {
      return;
    }
    regionNoticeShownRef.current = true;
    void openAlert({
      title: "해외 IP는 AI 기능을 사용할 수 없어요",
      description:
        "그림 그리기와 일기 검사는 한국에서만 이용할 수 있어요. 사진 그대로 그림일기를 만드는 건 그대로 할 수 있어요.",
      alertButton: <DiaryButton placement="dialog">확인</DiaryButton>,
      closeOnDimmerClick: false,
    });
  }, [openAlert, regionBlocked, showOnboarding]);

  const header = STEP_HEADERS[step];
  // The upload screen already has the streak/quota card and photo picker, so a
  // step counter adds more density than guidance there. Keep it only after the
  // user has entered the actual writing flow.
  const progress =
    step === "calendar" || step === "upload" ? null : STEP_PROGRESS[step];
  const canWrite = draft.photoDataUrl !== null;
  // trim() on both fields so whitespace-only input can't pass validation.
  const canPreview = draft.title.trim() !== "" && draft.content.trim() !== "";
  const lastPreviewDraft = lastPreviewDraftRef.current;
  const previewAiInputChanged =
    lastPreviewDraft !== null &&
    (draft.photoDataUrl !== lastPreviewDraft.photoDataUrl ||
      draft.content !== lastPreviewDraft.content);
  const previewDisplayChanged =
    lastPreviewDraft !== null &&
    (draft.title !== lastPreviewDraft.title ||
      draft.weather !== lastPreviewDraft.weather ||
      draft.timeOfDay !== lastPreviewDraft.timeOfDay);
  const writePrimaryLabel =
    !hasVisitedPreview || lastPreviewDraft === null
      ? "검사 받기"
      : previewAiInputChanged
        ? "다시 검사 받기"
        : previewDisplayChanged
          ? "수정 내용 확인하기"
          : "미리보기로 돌아가기";
  const previewPreparing =
    sketchState.status === "loading" ||
    analysisState.status === "loading" ||
    previewAnimationRunning ||
    previewModuleLoading;
  const includesAiGeneratedContent =
    (isSketchAiConnected && sketchState.status === "success") ||
    (isAiConnected && analysisState.status === "success");

  if (showOnboarding) {
    return (
      <main className="onboarding" aria-label="나의 여름방학 일기 시작 화면">
        <div className="onboarding-scene">
          {ONBOARDING_DECORATIONS.map(({ name, file }) => (
            <img
              key={name}
              className={`onboarding-decoration onboarding-decoration-${name}`}
              src={`/onboarding_images/${file}`}
              alt=""
              draggable={false}
            />
          ))}
          <h1 className="onboarding-title" aria-label="나의 여름방학 일기">
            {ONBOARDING_TITLE_LINES.map((line, lineIndex) => (
              <span
                key={lineIndex}
                className={`onboarding-title-line onboarding-title-line-${lineIndex + 1}`}
                aria-hidden="true"
              >
                {line.map(({ name, file }) => (
                  <img
                    key={file}
                    className={`onboarding-title-letter onboarding-title-letter-${name}`}
                    src={`/onboarding_images/${file}`}
                    alt=""
                    draggable={false}
                  />
                ))}
              </span>
            ))}
          </h1>
        </div>
        <div className="onboarding-action-area">
          <button
            className="summer-diary-button summer-diary-button-primary summer-diary-button-onboarding"
            type="button"
            onClick={() => {
              setShowOnboarding(false);
            }}
          >
            시작하기
          </button>
        </div>
      </main>
    );
  }

  const startNewDiary = () => {
    clearDraft();
    setPhotoSourceHash(null);
    setInspectionContext(undefined);
    setRenderedDiaryPreview(null);
    setPreviewAnimationRunning(false);
    setPreviewProcessingEnabled(false);
    setPreviewModuleLoading(false);
    setHasVisitedWrite(false);
    setHasVisitedPreview(false);
    lastPreviewDraftRef.current = null;
    setAnalyzeRecheckNoticeVisible(false);
    setCalendarReturnStep("upload");
    setCalendarInitialDate(undefined);
    setCalendarReveal(null);
    setCalendarShareRequest(null);
    setPendingMilestone(null);
    setMilestoneVisible(false);
    navigateToStep("upload", true);
  };

  const handleStartWriting = () => {
    if (!canWrite) {
      toast.openToast("먼저 사진을 올려주세요.", {
        gap: 15,
      });
      return;
    }

    setHasVisitedWrite(true);

    // PhotoUploadStep already collects the required processing consent before
    // a photo can enter the draft, so another confirmation here would repeat
    // the same notice and interrupt the user a second time.
    setWriteEntryId((entryId) => entryId + 1);
    navigateToStep("write");
  };

  const handlePreview = () => {
    const titleMissing = draft.title.trim() === "";
    const contentMissing = draft.content.trim() === "";

    if (titleMissing && contentMissing) {
      toast.openToast("제목과 일기 내용을 입력해 주세요.");
      return;
    }
    if (titleMissing) {
      toast.openToast("제목을 입력해 주세요.");
      return;
    }
    if (contentMissing) {
      toast.openToast("일기 내용을 입력해 주세요.");
      return;
    }

    setHasVisitedPreview(true);
    lastPreviewDraftRef.current = previewDraftSnapshot(draft);
    setPreviewModuleLoading(true);
    void loadPreviewStep().finally(() => setPreviewModuleLoading(false));

    const needsSketch = draft.sketchDataUrl === null;
    const needsAnalysis = analysisState.status !== "success";
    const willProcessSketch = needsSketch && sketchAllowed;
    const willProcessAnalysis = needsAnalysis && analyzeAllowed;
    const runSketchAi = isSketchAiConnected && willProcessSketch;
    const runAnalyzeAi = isAiConnected && willProcessAnalysis;
    const inspection =
      runSketchAi || runAnalyzeAi
        ? createDiaryInspectionContext(runSketchAi, runAnalyzeAi)
        : undefined;
    setInspectionContext(inspection);
    // Decide at entry time whether this visit has real work to wait for.
    // When the shared AI budget is spent, both `willProcess*` values are false,
    // so PreviewStep skips its three-stage animation and shows the fallback
    // preview immediately.
    setPreviewProcessingEnabled(willProcessSketch || willProcessAnalysis);
    setPreviewAnimationRunning(willProcessSketch || willProcessAnalysis);

    // Navigation is never gated on the budget: unavailable AI results fall
    // back to the original photo or an uncommented diary, and 완성하기 still
    // works from there.
    // A success state belongs to the CURRENT AI input signature. Only the
    // photo and body are part of it, so title/date/weather-only edits return
    // to the completed preview without spending another opportunity.
    if (analyzeAllowed && analysisState.status !== "success") {
      runAnalysis(inspection);
    }

    const needsAiWork = needsSketch || needsAnalysis;
    if (aiQuotaSpent && needsAiWork) {
      toast.openToast("오늘 AI 검사 기회를 모두 사용했어요.");
    }

    navigateToStep("preview");
  };

  const retryAnalysis = () => {
    const inspection = isAiConnected
      ? createDiaryInspectionContext(false, true)
      : undefined;
    setInspectionContext(inspection);
    runAnalysis(inspection);
  };

  const retryDrawing = () => {
    const inspection = isSketchAiConnected
      ? createDiaryInspectionContext(true, false)
      : undefined;
    setInspectionContext(inspection);
    retrySketch();
  };

  // Stage 4: compose the finished diary once, archive it, then reveal that
  // exact entry from its calendar date.
  const handleFinish = async () => {
    if (draft.photoDataUrl === null || saving) {
      return;
    }
    // Saving with a missing piece is allowed, but never silently: the AI
    // comment / 첨삭 (MVP-required) and the drawing are the whole point, so an
    // incomplete keepsake must be a knowing choice. A sketch *error* is the
    // one exception — it falls back to the original photo, which the spec
    // explicitly endorses and the preview already communicates.
    const drawingLoading = sketchState.status === "loading";
    const commentLoading = analysisState.status === "loading";

    if (drawingLoading || commentLoading) {
      // Name only what is actually still generating (not a fixed "both"),
      // so the dialog never claims a piece that is already done.
      const pending = [
        drawingLoading ? "크레파스 그림" : null,
        commentLoading ? "선생님 한마디" : null,
      ].filter((part): part is string => part !== null);
      const proceed = await openDiaryConfirm({
        title: "아직 그림일기가 만들어지고 있어요",
        description: `조금 기다리면 ${pending.join("과 ")}까지 담아 저장할 수 있어요. 지금 이대로 저장할까요?`,
        confirmLabel: "이대로 저장",
        cancelLabel: "기다릴게요",
      });
      if (!proceed) {
        return;
      }
    } else if (analysisState.status === "error" && analysisState.retryable) {
      // Nothing will finish on its own — waiting wouldn't help, so offer a
      // retry (the analysis hook only re-runs on an explicit trigger) or a save
      // without the comment. A non-retryable failure cannot succeed on an
      // immediate retry, so it falls through and saves instead of offering an
      // action that is guaranteed to fail.
      const retry = await openDiaryConfirm({
        title: "선생님의 한마디를 불러오지 못했어요",
        description:
          "다시 시도해서 한마디와 첨삭까지 담거나, 지금 이대로 저장할 수 있어요.",
        confirmLabel: "다시 시도",
        cancelLabel: "이대로 저장",
      });
      if (retry) {
        retryAnalysis();
        return;
      }
    } else if (analysisState.status === "idle" && analyzeAllowed) {
      // Never asked for a check at all. The comment and 첨삭 are the point of
      // the app, so leaving them out has to be a knowing choice — but only ask
      // when a check is actually still possible.
      const check = await openDiaryConfirm({
        title: "아직 선생님께 검사받지 않았어요",
        description:
          "지금 검사받으면 선생님 한마디와 첨삭까지 담을 수 있어요. 오늘 남은 검사 횟수가 한 번 줄어들어요.",
        confirmLabel: "검사 받기",
        cancelLabel: "이대로 저장",
      });
      if (check) {
        retryAnalysis();
        return;
      }
    }

    setSaving(true);
    try {
      const imageInput: DiaryImageInput = {
        imageDataUrl: draft.sketchDataUrl ?? draft.photoDataUrl,
        title: draft.title.trim() || "제목 없는 일기",
        content: draft.content,
        date: draft.date,
        weather: draft.weather,
        analysis:
          analysisState.status === "success" ? analysisState.analysis : null,
        includesAiGeneratedContent,
      };
      const imageDataUrl =
        renderedDiaryPreview !== null &&
        sameDiaryImageInput(renderedDiaryPreview.input, imageInput)
          ? renderedDiaryPreview.dataUrl
          : (
              await (
                await import("./utils/diaryImage")
              ).composeDiaryImage(imageInput)
            ).dataUrl;
      const revisionKey = await createDiaryRevisionKey(
        draft.photoDataUrl,
        draft.content,
      );
      const saveResult = await saveDiary({
        draftId: draft.draftId,
        revisionKey,
        date: draft.date,
        // Stored as typed. The empty-title fallback is a display choice, and
        // baking it in here would make it impossible to tell apart from a
        // diary the user actually named 제목 없는 일기.
        title: draft.title,
        content: draft.content,
        weather: draft.weather,
        imageDataUrl,
        includesAiGeneratedContent,
      });
      let progressRecorded = true;
      try {
        const progress = await completeDiaryProgress();
        const specialMilestone =
          progress.milestones.find(
            (milestone) =>
              milestone.metric === "streak" && milestone.tier === "special",
          ) ??
          progress.milestones.find(
            (milestone) => milestone.tier === "special",
          ) ??
          null;
        setPendingMilestone(specialMilestone);
        setMilestoneVisible(false);
      } catch {
        progressRecorded = false;
        setPendingMilestone(null);
        setMilestoneVisible(false);
      }
      toast.openToast(
        progressRecorded
          ? `일기와 오늘의 도장을 저장했어요! (${saveResult.diariesOnDate}/${saveResult.limit})`
          : "일기는 저장했지만 오늘의 도장을 확인하지 못했어요.",
      );

      void loadDiaryCalendarView();
      setCalendarReturnStep("new");
      setCalendarInitialDate(undefined);
      setCalendarReveal({ date: draft.date, diaryId: saveResult.record.id });
      navigateToStep("calendar");
    } catch (error) {
      // The daily limit is the one save failure that retrying cannot clear —
      // the user has to delete something first. A toast with 다시 시도 would
      // loop them straight back into the same error, so mirror the 작성 화면
      // dialog and hand them the calendar instead.
      if (error instanceof DiaryStoreError && error.code === "daily-limit") {
        // The save is already over, and the dimmer does not cover the bottom
        // bar — leaving it on 완성 중… until `finally` would show a spinner
        // label behind a dialog that says nothing is being saved.
        setSaving(false);
        const openRecords = await openDiaryConfirm({
          title: TODAY_DIARY_FULL_TITLE,
          description: todayDiaryFullDescription(MAX_DIARIES_PER_DATE),
          confirmLabel: "일기장 보기",
          cancelLabel: "닫기",
          closeOnDimmerClick: false,
        });
        if (openRecords) {
          void loadDiaryCalendarView();
          // "preview", not "write": the completed diary is still sitting in the
          // preview, and that is where deleting an old entry has to return the
          // user so they can finish saving it.
          setCalendarReturnStep("preview");
          setCalendarInitialDate(draft.date);
          setCalendarReveal(null);
          navigateToStep("calendar");
        }
        return;
      }

      const message =
        error instanceof DiaryStoreError
          ? error.userMessage
          : "그림일기를 저장하지 못했어요. 다시 시도해 주세요.";
      // Retry button keeps the failure recoverable in place instead of
      // vanishing with the 3s toast.
      toast.openToast(message, {
        button: {
          text: "다시 시도",
          onClick: () => void handleFinish(),
        },
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      className={`app-shell app-shell-${step} weather-${draft.weather} time-${draft.timeOfDay}${isAndroid ? " app-shell-android" : ""}${isKeyboardClosing ? " app-keyboard-closing" : ""}`}
    >
      <div
        key={`${draft.weather}-${draft.timeOfDay}-${weatherEffectKey}`}
        className="summer-sky-accent"
        aria-hidden="true"
      >
        <span className="summer-sun" />
        <span className="summer-moon" />
        <span className="summer-cloud summer-cloud-one" />
        <span className="summer-cloud summer-cloud-two" />
        <span className="summer-cloud summer-cloud-extra summer-cloud-three" />
        <span className="summer-cloud summer-cloud-extra summer-cloud-four" />
        <span className="summer-cloud summer-cloud-extra summer-cloud-five" />
        <span className="summer-cloud summer-cloud-extra summer-cloud-six" />
        <span className="summer-weather-rain" />
        <span className="summer-weather-lightning summer-weather-lightning-one" />
        <span className="summer-weather-lightning summer-weather-lightning-two" />
        <span className="summer-weather-lightning summer-weather-lightning-three" />
        <span className="summer-weather-stars" />
      </div>
      <Top
        className="app-top"
        title={
          <Top.TitleParagraph size={22}>{header.title}</Top.TitleParagraph>
        }
        subtitleBottom={
          <Top.SubtitleParagraph size={15}>
            {header.subtitle}
          </Top.SubtitleParagraph>
        }
      />

      {/* The banner lives here, not inside each view, so it lands in the same
          place on every screen that carries one: directly under the header.
          Inside .step-body it could not — on the preview step the step
          indicator is a sibling of .step-body, so no ordering within the body
          could lift the banner above it. Keeping one instance also means
          moving between the preview and the calendar reuses the attached slot
          instead of tearing it down and asking the SDK for a new ad. */}
      {(step === "preview" || step === "calendar") && <BannerAd />}

      {progress !== null && (
        <div
          className="summer-step-progress"
          aria-label={`그림일기 만들기 ${progress.current}단계, ${progress.label}`}
        >
          <ol className="summer-step-list">
            {STEP_LABELS.map((label, index) => {
              const item = index + 1;

              return (
                <li
                  key={label}
                  aria-current={item === progress.current ? "step" : undefined}
                  className={
                    item === progress.current
                      ? "is-current"
                      : item < progress.current
                        ? "is-complete"
                        : ""
                  }
                >
                  <span className="summer-step-marker" aria-hidden="true" />
                  <span className="summer-step-name">{label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {step === "calendar" && (
        <Suspense
          fallback={
            <div className="step-body" role="status">
              일기장을 불러오고 있어요.
            </div>
          }
        >
          <DiaryCalendarView
            initialDate={calendarInitialDate}
            reveal={calendarReveal}
            progress={diaryProgress}
            onRevealComplete={() => {
              setCalendarReveal(null);
              if (pendingMilestone !== null) {
                setMilestoneVisible(true);
              }
            }}
            onShareRequest={(request) => {
              void loadDiaryShareModal();
              setCalendarShareRequest(request);
            }}
          />
        </Suspense>
      )}

      {step === "upload" && (
        <>
          <AiQuotaNotice progress={diaryProgress} />
          <RewardedAdCallout />
          <PhotoUploadStep
            photoDataUrl={draft.photoDataUrl}
            onRequestExit={requestAppExit}
            hasSessionConsent={hasPhotoSessionConsent}
            onSessionConsent={() => setHasPhotoSessionConsent(true)}
            canRedraw={sketchAllowed}
            isDrawingInProgress={isDrawingInProgress}
            onPhotoChange={({
              dataUrl,
              sourceHash,
              reusedSketchDataUrl,
              redraw,
            }) => {
              setPhotoSourceHash(sourceHash);
              // 다시 그리기 means the previous drawing is gone for good. Clearing
              // the draft below is not enough: the caches would hand it straight
              // back and the ledger would still count this photo as paid for, so
              // the new request could never go out.
              if (redraw === true) {
                discardSketch(dataUrl, sourceHash);
              }
              // A sketch belongs to exactly one photo — replacing the photo
              // must drop the old drawing in the same state update, or the
              // preview could pair the new photo with the previous sketch. The
              // one exception is a drawing the user explicitly asked to reuse,
              // which also keeps the sketch hook from spending a request.
              updateDraft({
                photoDataUrl: dataUrl,
                sketchDataUrl: reusedSketchDataUrl ?? null,
              });
            }}
          />
        </>
      )}
      {step === "write" && (
        <>
          {analyzeRecheckNoticeVisible &&
            analysisState.status !== "success" && <AiRecheckNotice />}
          <WriteStep
            draft={draft}
            entryId={writeEntryId}
            endAnchorRef={writeFormEndRef}
            onOpenCalendar={() => {
              void loadDiaryCalendarView();
              setCalendarReturnStep("write");
              setCalendarInitialDate(draft.date);
              setCalendarReveal(null);
              navigateToStep("calendar");
            }}
            onChange={(patch) => {
              if (
                patch.weather !== undefined ||
                patch.timeOfDay !== undefined
              ) {
                setWeatherEffectKey((key) => key + 1);
              }
              updateDraft(patch);
            }}
          />
        </>
      )}
      {step === "preview" && (
        <Suspense
          fallback={
            <div className="step-body" role="status">
              미리보기를 준비하고 있어요.
            </div>
          }
        >
          <PreviewStep
            draft={draft}
            analysisState={analysisState}
            onRetry={retryAnalysis}
            sketchState={sketchState}
            onSketchRetry={retryDrawing}
            processingEnabled={previewProcessingEnabled}
            onProcessingVisibilityChange={setPreviewAnimationRunning}
            onRenderedImageChange={setRenderedDiaryPreview}
          />
        </Suspense>
      )}

      {calendarShareRequest !== null && (
        <Suspense fallback={null}>
          <DiaryShareModal
            open
            imageDataUrl={calendarShareRequest.imageDataUrl}
            fileName={calendarShareRequest.fileName}
            onClose={() => setCalendarShareRequest(null)}
          />
        </Suspense>
      )}

      {milestoneVisible && pendingMilestone !== null && (
        <StreakMilestoneModal
          milestone={pendingMilestone}
          onClose={() => {
            setMilestoneVisible(false);
            setPendingMilestone(null);
          }}
        />
      )}

      {step === "upload" && (
        <AppBottomBar double>
          <DiaryButton
            tone="secondary"
            stable
            fullWidth
            onClick={() => {
              void loadDiaryCalendarView();
              setCalendarReturnStep("upload");
              setCalendarInitialDate(undefined);
              setCalendarReveal(null);
              navigateToStep("calendar");
            }}
          >
            일기장 보기
          </DiaryButton>

          <DiaryButton
            stable
            feedbackDisabled
            fullWidth
            aria-disabled={!canWrite}
            onClick={handleStartWriting}
          >
            {hasVisitedWrite ? "다시 일기 쓰러 가기" : "일기 쓰러 가기"}
          </DiaryButton>
        </AppBottomBar>
      )}
      {step === "calendar" && (
        <AppBottomBar>
          <DiaryButton
            tone={calendarReturnStep === "new" ? "primary" : "secondary"}
            stable
            fullWidth
            onClick={() => {
              setCalendarInitialDate(undefined);
              setCalendarReveal(null);
              if (calendarReturnStep === "write") {
                window.history.back();
              } else if (calendarReturnStep === "new") {
                startNewDiary();
              } else {
                window.history.back();
              }
            }}
          >
            {calendarReturnStep === "write"
              ? "일기 쓰기로 돌아가기"
              : calendarReturnStep === "preview"
                ? "미리보기로 돌아가기"
                : calendarReturnStep === "new"
                  ? "새 일기 쓰기"
                  : "돌아가기"}
          </DiaryButton>
        </AppBottomBar>
      )}
      {step === "write" && (
        <AppBottomBar double>
          <DiaryButton
            tone="secondary"
            stable
            fullWidth
            onClick={() => {
              window.history.back();
            }}
          >
            사진 변경
          </DiaryButton>

          <DiaryButton
            stable
            feedbackDisabled
            fullWidth
            aria-disabled={!canPreview}
            onClick={handlePreview}
          >
            {writePrimaryLabel}
          </DiaryButton>
        </AppBottomBar>
      )}
      {step === "preview" && (
        <AppBottomBar double>
          <DiaryButton
            tone="secondary"
            stable
            fullWidth
            disabled={saving || previewPreparing}
            onClick={() => {
              window.history.back();
            }}
          >
            일기 수정
          </DiaryButton>

          <DiaryButton
            stable
            fullWidth
            disabled={saving || previewPreparing}
            aria-busy={saving || previewPreparing}
            onClick={handleFinish}
          >
            {saving
              ? "완성 중…"
              : previewPreparing
                ? "선생님 검사 중…"
                : "일기 완성하기"}
          </DiaryButton>
        </AppBottomBar>
      )}
    </main>
  );
}

export default App;
