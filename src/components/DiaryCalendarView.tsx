import { Modal } from "@toss/tds-mobile";
import { useEffect, useRef, useState, type CSSProperties } from "react";

import { formatKoreanDate } from "../constants/diary";
import type { DiaryProgressView } from "../hooks/useDiaryProgress";
import {
  DiaryStoreError,
  deleteDiary,
  getDiary,
  listDiaries,
  type DiaryRecord,
  type DiarySummary,
} from "../services/diaryStore";
import {
  daysInMonth,
  diariesByDay,
  koreanMonth,
  monthKeyOf,
  moveMonth,
} from "../utils/diaryCalendar";
import { DiaryButton } from "./DiaryButton";
import { DiaryStreakCalendarCard } from "./DiaryStreakStatus";

const WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"] as const;
const DAILY_COMPLETE_STAMP_URL = "/stamps/daily-complete.png";

const REVEAL_VIEWER_DELAY_MS = 1500;
type PageDirection = "forward" | "backward";

export interface CalendarRevealRequest {
  date: string;
  diaryId: string;
}

export interface CalendarShareRequest {
  imageDataUrl: string;
  fileName: string;
}

interface DiaryCalendarViewProps {
  initialDate?: string;
  reveal?: CalendarRevealRequest | null;
  progress: DiaryProgressView;
  onRevealComplete?: () => void;
  onShareRequest: (request: CalendarShareRequest) => void;
}

function CalendarArrow({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      className="diary-calendar-arrow-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d={
          direction === "left"
            ? "M14.8 5.5 8.4 12l6.4 6.5"
            : "m9.2 5.5 6.4 6.5-6.4 6.5"
        }
      />
    </svg>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; summaries: DiarySummary[] };

/** Where the diary should appear to burst out of, relative to screen centre. */
interface PopOrigin {
  dx: number;
  dy: number;
}

/**
 * Rebuilt from the record rather than stored, so it always matches the diary
 * being looked at.
 */
function diaryFileName(record: DiaryRecord): string {
  const saved = new Date(record.savedAt);
  const suffix = [saved.getHours(), saved.getMinutes(), saved.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  return `summer-diary-${record.date}-${suffix}.jpg`;
}

export function DiaryCalendarView({
  initialDate,
  reveal = null,
  progress,
  onRevealComplete,
  onShareRequest,
}: DiaryCalendarViewProps) {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  // One calendar month is on screen at a time, so it is view state rather than
  // something derived from the saved diaries.
  const [selectedMonth, setSelectedMonth] = useState(() =>
    reveal !== null
      ? reveal.date.slice(0, 7)
      : initialDate !== undefined
        ? initialDate.slice(0, 7)
        : monthKeyOf(new Date()),
  );
  // The viewer is a small album for one calendar date. It deliberately keeps
  // its own list so a swipe can never spill into the previous or next day.
  const [viewerEntries, setViewerEntries] = useState<DiarySummary[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [manageOnly, setManageOnly] = useState(false);
  const [pageDirection, setPageDirection] = useState<PageDirection>("forward");
  const [popOrigin, setPopOrigin] = useState<PopOrigin>({ dx: 0, dy: 0 });
  const [record, setRecord] = useState<DiaryRecord | null>(null);
  const [recordError, setRecordError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [revealingDiaryId, setRevealingDiaryId] = useState<string | null>(
    null,
  );
  const [revealViewerPending, setRevealViewerPending] = useState(false);
  const [revealViewerAnimationFinished, setRevealViewerAnimationFinished] =
    useState(false);
  const revealCellRef = useRef<HTMLButtonElement | null>(null);
  const handledRevealRef = useRef<string | null>(null);
  const initialDateOpenedRef = useRef(false);
  const onRevealCompleteRef = useRef(onRevealComplete);

  useEffect(() => {
    onRevealCompleteRef.current = onRevealComplete;
  }, [onRevealComplete]);

  useEffect(() => {
    const targetDate = reveal?.date ?? initialDate;
    if (targetDate !== undefined) {
      setSelectedMonth(targetDate.slice(0, 7));
    }
  }, [initialDate, reveal]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const summaries = await listDiaries();
        if (!cancelled) {
          setLoad({ status: "ready", summaries });
        }
      } catch (error) {
        if (!cancelled) {
          setLoad({
            status: "error",
            message:
              error instanceof DiaryStoreError
                ? error.userMessage
                : "저장된 일기를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const summaries = load.status === "ready" ? load.summaries : [];
  const current = viewerIndex === null ? null : viewerEntries[viewerIndex];

  useEffect(() => {
    if (
      reveal !== null ||
      initialDate === undefined ||
      initialDateOpenedRef.current ||
      load.status !== "ready"
    ) {
      return;
    }

    initialDateOpenedRef.current = true;
    const entries = load.summaries.filter(
      (summary) => summary.date === initialDate,
    );
    if (entries.length === 0) {
      return;
    }

    setPopOrigin({ dx: 0, dy: 0 });
    setViewerEntries(entries);
    setPageDirection("forward");
    setManageOnly(true);
    setViewerIndex(0);
  }, [initialDate, load, reveal]);

  useEffect(() => {
    if (reveal === null || load.status !== "ready") {
      return;
    }

    const revealKey = `${reveal.date}:${reveal.diaryId}`;
    if (
      handledRevealRef.current === revealKey ||
      selectedMonth !== reveal.date.slice(0, 7)
    ) {
      return;
    }

    const entries = load.summaries.filter(
      (summary) => summary.date === reveal.date,
    );
    const revealedIndex = entries.findIndex(
      (summary) => summary.id === reveal.diaryId,
    );
    const cell = revealCellRef.current;
    if (cell === null || revealedIndex < 0) {
      return;
    }

    handledRevealRef.current = revealKey;
    setRevealingDiaryId(reveal.diaryId);
    setRevealViewerPending(false);
    setRevealViewerAnimationFinished(false);
    setManageOnly(false);

    const rect = cell.getBoundingClientRect();
    setPopOrigin({
      dx: rect.left + rect.width / 2 - window.innerWidth / 2,
      dy: rect.top + rect.height / 2 - window.innerHeight / 2,
    });

    // AIDEV-NOTE: 순서 중요 — 도장 뒤 1.5초 대기는 저장 위치를 인지한 다음 상세를 열기 위한 것이다.
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const delay = reducedMotion ? 180 : REVEAL_VIEWER_DELAY_MS;
    const timer = window.setTimeout(() => {
      setViewerEntries(entries);
      setPageDirection("forward");
      setViewerIndex(revealedIndex);
      setRevealingDiaryId(null);
      setRevealViewerPending(true);
      setRevealViewerAnimationFinished(reducedMotion);
    }, delay);

    return () => window.clearTimeout(timer);
  }, [load, reveal, selectedMonth]);

  // The image lives in the entry, not the index, so it is fetched per page
  // instead of loading every diary's bytes up front.
  useEffect(() => {
    if (current === undefined || current === null) {
      return;
    }

    let cancelled = false;
    setRecordError(null);
    setDeleteError(null);

    void (async () => {
      try {
        const found = await getDiary(current.id);
        if (cancelled) {
          return;
        }
        if (found === null) {
          setRecordError("이 일기를 찾을 수 없어요.");
          return;
        }
        setRecord(found);
      } catch (error) {
        if (!cancelled) {
          setRecordError(
            error instanceof DiaryStoreError
              ? error.userMessage
              : "일기를 불러오지 못했어요.",
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [current]);

  useEffect(() => {
    if (
      !revealViewerPending ||
      !revealViewerAnimationFinished ||
      current === null ||
      current === undefined ||
      (record?.id !== current.id && recordError === null)
    ) {
      return;
    }

    setRevealViewerPending(false);
    setRevealViewerAnimationFinished(false);
    onRevealCompleteRef.current?.();
  }, [
    current,
    record,
    recordError,
    revealViewerAnimationFinished,
    revealViewerPending,
  ]);

  const [selectedYear, selectedMonthNumber] = selectedMonth
    .split("-")
    .map(Number);
  const firstDay = new Date(selectedYear, selectedMonthNumber - 1, 1).getDay();
  // JavaScript starts weeks on Sunday. The picture-diary calendar starts on
  // Monday, so Sunday moves from index 0 to the last column.
  const leadingBlankCount = (firstDay + 6) % 7;
  const dayCount = daysInMonth(selectedMonth);
  const calendarCells = [
    ...Array.from({ length: leadingBlankCount }, () => null),
    ...Array.from({ length: dayCount }, (_, index) => index + 1),
  ];
  while (calendarCells.length % 7 !== 0) {
    calendarCells.push(null);
  }
  const byDay = diariesByDay(summaries, selectedMonth);

  const step = (delta: number) => {
    setViewerIndex((index) => {
      if (index === null) {
        return null;
      }
      if (viewerEntries.length < 2) {
        return index;
      }
      setPageDirection(delta > 0 ? "forward" : "backward");
      return (index + delta + viewerEntries.length) % viewerEntries.length;
    });
  };

  const openDay = (entries: DiarySummary[], calendarCell: HTMLElement) => {
    if (entries.length === 0) {
      return;
    }

    // Measured at tap time so the diary grows out of the date cell the user
    // actually pressed, not from a fixed point on screen.
    const rect = calendarCell.getBoundingClientRect();
    setPopOrigin({
      dx: rect.left + rect.width / 2 - window.innerWidth / 2,
      dy: rect.top + rect.height / 2 - window.innerHeight / 2,
    });
    // listDiaries already orders entries on the same date newest first.
    setViewerEntries([...entries]);
    setPageDirection("forward");
    setManageOnly(false);
    setViewerIndex(0);
  };

  const removeCurrentDiary = async () => {
    if (current === null || deleting) {
      return;
    }

    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteDiary(current.id);
      const remaining = viewerEntries.filter(
        (entry) => entry.id !== current.id,
      );
      setLoad((state) =>
        state.status === "ready"
          ? {
              status: "ready",
              summaries: state.summaries.filter(
                (summary) => summary.id !== current.id,
              ),
            }
          : state,
      );
      setViewerEntries(remaining);

      if (remaining.length === 0) {
        setRecord(null);
        setViewerIndex(null);
      } else {
        setViewerIndex((index) =>
          index === null ? null : Math.min(index, remaining.length - 1),
        );
      }
    } catch (error) {
      setDeleteError(
        error instanceof DiaryStoreError
          ? error.userMessage
          : "일기를 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    } finally {
      setDeleting(false);
    }
  };

  const popStyle = {
    "--diary-pop-dx": `${popOrigin.dx}px`,
    "--diary-pop-dy": `${popOrigin.dy}px`,
  } as CSSProperties;
  const shareUnavailable =
    deleting || record === null || record.id !== current?.id;

  return (
    // The viewer is a sibling of the step body, not a child of it. .step-body
    // is z-index 1, so anything inside it is stuck below the bottom bar at
    // z-index 50 no matter how high its own z-index goes — the 돌아가기 button
    // would sit on top of the diary, bright and still tappable. Out here the
    // viewer shares .app-shell's stacking context and its z-index counts.
    <>
      <div className="step-body diary-calendar-view">
        <DiaryStreakCalendarCard progress={progress} />
        <section className="diary-calendar-paper" aria-labelledby="diary-month">
          <div className="diary-calendar-month-picker">
            <DiaryButton
              tone="secondary"
              stable
              aria-label="이전 달"
              onClick={() =>
                setSelectedMonth((current) => moveMonth(current, -1))
              }
            >
              <CalendarArrow direction="left" />
            </DiaryButton>
            <h2 id="diary-month">{koreanMonth(selectedMonth)}</h2>
            <DiaryButton
              tone="secondary"
              stable
              aria-label="다음 달"
              onClick={() =>
                setSelectedMonth((current) => moveMonth(current, 1))
              }
            >
              <CalendarArrow direction="right" />
            </DiaryButton>
          </div>

          <div className="diary-calendar-grid" role="grid">
            <div className="diary-calendar-weekdays" role="row">
              {WEEKDAYS.map((weekday, index) => (
                <div
                  key={weekday}
                  className={`diary-calendar-weekday weekday-${index}`}
                  role="columnheader"
                >
                  {weekday}
                </div>
              ))}
            </div>

            <div className="diary-calendar-days">
              {calendarCells.map((day, index) => {
                if (day === null) {
                  return (
                    <span
                      className="diary-calendar-cell is-empty"
                      key={`empty-${index}`}
                      aria-hidden="true"
                    />
                  );
                }

                const saved = byDay[day] ?? [];
                const first = saved[0];
                const hasDiaries = first !== undefined;
                const weekdayIndex = index % 7;
                const isRevealTarget =
                  reveal !== null &&
                  reveal.date.startsWith(`${selectedMonth}-`) &&
                  Number(reveal.date.slice(8, 10)) === day;
                const isRevealing =
                  isRevealTarget && revealingDiaryId === reveal?.diaryId;

                return (
                  <button
                    key={day}
                    ref={isRevealTarget ? revealCellRef : undefined}
                    type="button"
                    role="gridcell"
                    className={`diary-calendar-cell weekday-${weekdayIndex}${hasDiaries ? " has-diaries" : ""}${isRevealTarget ? " is-reveal-target" : ""}${isRevealing ? " is-revealing" : ""}`}
                    disabled={!hasDiaries}
                    aria-label={
                      hasDiaries
                        ? `${day}일, 저장된 일기 ${saved.length}개 보기`
                        : `${day}일, 완성한 일기 없음`
                    }
                    onClick={(event) => {
                      if (saved.length > 0) {
                        openDay(saved, event.currentTarget);
                      }
                    }}
                  >
                    <span className="diary-calendar-day">{day}</span>
                    {hasDiaries && (
                      <img
                        className={`diary-calendar-stamp${isRevealing ? " is-revealing" : ""}`}
                        src={DAILY_COMPLETE_STAMP_URL}
                        alt=""
                        aria-hidden="true"
                        draggable={false}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {load.status === "loading" && (
            <p className="diary-calendar-message" role="status">
              일기 달력을 불러오는 중…
            </p>
          )}

          {load.status === "error" && (
            <p
              className="diary-calendar-message diary-calendar-message-error"
              role="alert"
            >
              {load.message}
            </p>
          )}

        </section>
      </div>

      {current !== null && current !== undefined && (
        // Covers the whole screen, header and bottom bar included, so the only
        // sharp and bright thing left is the diary itself.
        <div
          className="diary-viewer-layer"
          style={popStyle}
          role="dialog"
          aria-modal="true"
          aria-label={`${formatKoreanDate(current.date)}에 저장된 일기 ${viewerEntries.length}편`}
        >
          {/* Mounts once per open, so the pop animation plays on opening and
              not again on every swipe. */}
          <div
            className="diary-viewer-card"
            onAnimationEnd={(event) => {
              if (
                event.target === event.currentTarget &&
                event.animationName === "diary-viewer-pop" &&
                revealViewerPending
              ) {
                setRevealViewerAnimationFinished(true);
              }
            }}
          >
            <div className="diary-viewer-nav">
              <DiaryButton
                tone="secondary"
                stable
                disabled={viewerEntries.length < 2}
                onClick={() => step(-1)}
                aria-label="이 날의 이전 일기"
              >
                <CalendarArrow direction="left" />
              </DiaryButton>

              <span className="diary-viewer-count">
                {(viewerIndex ?? 0) + 1} / {viewerEntries.length}
              </span>

              <DiaryButton
                tone="secondary"
                stable
                disabled={viewerEntries.length < 2}
                onClick={() => step(1)}
                aria-label="이 날의 다음 일기"
              >
                <CalendarArrow direction="right" />
              </DiaryButton>
            </div>

            <div
              className={`diary-viewer-stage stack-${Math.min(viewerEntries.length, 3)}`}
            >
              {recordError !== null ? (
                <p className="diary-viewer-note" role="alert">
                  {recordError}
                </p>
              ) : record === null ? (
                <p className="diary-viewer-note">일기를 펴는 중이에요…</p>
              ) : (
                <img
                  key={record.id}
                  className={`diary-viewer-image diary-page-${pageDirection}`}
                  src={record.imageDataUrl}
                  alt={`${formatKoreanDate(record.date)}에 쓴 그림일기`}
                />
              )}
            </div>

            {deleteError !== null && (
              <p className="diary-viewer-error" role="alert">
                {deleteError}
              </p>
            )}

            <div className="diary-viewer-actions" aria-busy={deleting}>
              <DiaryButton
                tone="danger"
                stable
                fullWidth
                disabled={deleting}
                aria-busy={deleting}
                onClick={() => setDeleteConfirmOpen(true)}
              >
                일기 삭제
              </DiaryButton>

              {!manageOnly && (
                <DiaryButton
                  stable
                  fullWidth
                  data-interaction-disabled={shareUnavailable || undefined}
                  tabIndex={shareUnavailable ? -1 : undefined}
                  onClick={() => {
                    if (!shareUnavailable && record !== null) {
                      onShareRequest({
                        imageDataUrl: record.imageDataUrl,
                        fileName: diaryFileName(record),
                      });
                    }
                  }}
                >
                  저장 및 공유
                </DiaryButton>
              )}

              <DiaryButton
                tone="secondary"
                stable
                fullWidth
                data-interaction-disabled={deleting || undefined}
                tabIndex={deleting ? -1 : undefined}
                onClick={() => {
                  if (deleting) {
                    return;
                  }
                  setManageOnly(false);
                  setViewerIndex(null);
                }}
              >
                뒤로가기
              </DiaryButton>
            </div>
          </div>
        </div>
      )}

      <Modal open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <Modal.Overlay />
        <Modal.Content
          className="app-modal-panel diary-delete-modal"
          aria-labelledby="diary-delete-title"
          aria-describedby="diary-delete-description"
        >
          <div className="app-modal-layout diary-delete-modal-layout">
            <div className="diary-delete-modal-body">
              <h2 id="diary-delete-title" className="app-modal-title">
                이 일기를 삭제할까요?
              </h2>
              <p id="diary-delete-description">
                삭제한 일기는 다시 복원할 수 없어요.
              </p>
            </div>
            <div className="app-modal-footer diary-delete-modal-actions">
              <DiaryButton
                tone="secondary"
                stable
                fullWidth
                disabled={deleting}
                onClick={() => setDeleteConfirmOpen(false)}
              >
                취소
              </DiaryButton>
              <DiaryButton
                tone="danger"
                stable
                fullWidth
                disabled={deleting}
                aria-busy={deleting}
                onClick={() => {
                  setDeleteConfirmOpen(false);
                  void removeCurrentDiary();
                }}
              >
                삭제하기
              </DiaryButton>
            </div>
          </div>
        </Modal.Content>
      </Modal>
    </>
  );
}
