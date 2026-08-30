import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { refreshAiQuota } from "./useAiQuota";
import type { DiaryInspectionContext } from "../services/diaryInspection";
import { putCachedSketch, removeCachedSketch } from "../services/sketchCache";
import {
  forgetSettledSketchTicket,
  getSketchLedgerVersion,
  hasSketchTicket,
  isSketchTicketSettled,
  subscribeSketchLedger,
} from "../services/sketchLedger";
import {
  isSketchAiConnected,
  isSketchErrorRetryable,
  isSketchOutcomeUnverified,
  sketchCauseMessage,
  sketchErrorMessage,
  transferPhotoToSketch,
} from "../services/styleTransfer";
import type { DiaryDraft, DiaryDraftPatch } from "./useDiaryDraft";

// Shown when no user credit remains, so no request is ever made.
const QUOTA_SPENT_MESSAGE = sketchCauseMessage("daily-limit-exceeded");

export type SketchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; sketchDataUrl: string }
  | {
      status: "error";
      message: string;
      /** false when retrying the same photo can never succeed (moderation). */
      retryable: boolean;
    };

// Sketches are ~200-400KB each, so the in-memory cache stays small. It only
// covers "picked photo A, tried B, went back to A" within one session —
// across sessions the draft's persisted sketchDataUrl is the cache.
const CACHE_MAX_ENTRIES = 2;

/**
 * Runs the photo → drawing conversion while `active` is true.
 *
 * App activates it only after the user presses 검사 받기, so selecting a photo
 * or beginning a diary never spends a limited conversion opportunity. The
 * finished sketch is written INTO the draft, which both persists it and makes
 * "photo changed → sketch cleared" a single-source-of-truth rule that App.tsx
 * enforces at the moment the photo changes.
 */
export function useSketch(
  draft: Pick<DiaryDraft, "photoDataUrl" | "sketchDataUrl">,
  updateDraft: (patch: DiaryDraftPatch) => void,
  active: boolean,
  /**
   * False only when the budget is known to be spent — counting the requests
   * this client has already dispatched, not just the ones the server has
   * answered. It is a courtesy gate that saves a round trip, never the
   * enforcement point: the server's atomic consume decides, and it must stay
   * true while the budget is unknown so a slow first quota fetch cannot lock a
   * user out of their own diary.
   */
  allowed: boolean,
  /** SHA-256 of the file the photo came from; keys the cross-session cache. */
  sourceHash: string | null,
  inspection?: DiaryInspectionContext,
) {
  const { photoDataUrl, sketchDataUrl } = draft;

  // Errors remember which photo they belong to, so an error for an abandoned
  // photo is never shown against a newly picked one.
  const [error, setError] = useState<{
    source: string;
    message: string;
    retryable: boolean;
  } | null>(null);
  // Bumping this re-runs the effect for the same inputs (explicit retry).
  const [attempt, setAttempt] = useState(0);
  const cacheRef = useRef(new Map<string, string>());
  // One in-flight request PER PHOTO. A single slot used to mean that leaving
  // photo A for B and coming back to A started a second paid request for A
  // while the first was still running.
  const pendingRef = useRef(new Map<string, Promise<string>>());
  // Which source file each in-flight request came from. The request itself is
  // keyed by the CROPPED image, which does not exist yet while the user is
  // picking a file — so this is what lets the upload step say "this photo is
  // already being drawn" at pick time.
  const pendingSourceRef = useRef(new Map<string, string>());

  // Any ledger change can flip this photo's entitlement or the budget it is
  // measured against, so the hook has to re-render on it.
  useSyncExternalStore(subscribeSketchLedger, getSketchLedgerVersion);
  // A photo that already holds a ticket stays allowed even once the budget hits
  // zero: otherwise the third drawing would flip to "횟수를 다 써서" while its
  // own request is still running.
  const canRequest = allowed || hasSketchTicket(photoDataUrl);

  // The resolve handlers below need the CURRENT photo and the CURRENT committed
  // sketch, not the ones captured when the request started — refs avoid
  // re-subscribing them on each edit.
  const photoRef = useRef(photoDataUrl);
  useEffect(() => {
    photoRef.current = photoDataUrl;
  }, [photoDataUrl]);
  const sketchRef = useRef(sketchDataUrl);
  useEffect(() => {
    sketchRef.current = sketchDataUrl;
  }, [sketchDataUrl]);

  // Synchronous mirror update: a resolution landing in the same tick as this
  // commit must already see the sketch and stand down.
  const commitSketch = useCallback(
    (sketch: string) => {
      sketchRef.current = sketch;
      updateDraft({ sketchDataUrl: sketch });
    },
    [updateDraft],
  );

  useEffect(() => {
    if (
      !active ||
      !canRequest ||
      photoDataUrl === null ||
      sketchDataUrl !== null
    ) {
      return;
    }
    // A failed conversion must NOT auto-retry on step navigation — each
    // attempt costs an API call, so only the explicit retry button (which
    // clears `error` and bumps `attempt`) may fire again.
    if (error !== null && error.source === photoDataUrl) {
      return;
    }

    // Serve this session's cache first. This must run BEFORE the settled
    // backstop: a settled photo whose drawing only ever reached the cache (its
    // commit was superseded at resolution time) heals here on the next run
    // instead of deadlocking behind "already handled".
    const cached = cacheRef.current.get(photoDataUrl);
    if (cached !== undefined) {
      commitSketch(cached);
      return;
    }

    // Backstop for "one photo, one paid request": a settled photo with nothing
    // in the cache has genuinely lost its result, and dispatching again would
    // pay a second time for it. Cache eviction cannot strand the current photo,
    // but this keeps duplicate dispatch impossible if that invariant changes.
    if (isSketchTicketSettled(photoDataUrl)) {
      return;
    }

    // Reuse the in-flight request for this exact photo (the user navigated back
    // and forth mid-conversion, or swapped away and returned) instead of paying
    // twice. `transferPhotoToSketch` is what claims the ledger ticket, so not
    // calling it again is also what keeps the count honest.
    const source = photoDataUrl;
    let pending = pendingRef.current.get(source);
    if (pending === undefined) {
      pending = transferPhotoToSketch(source, inspection);
      pendingRef.current.set(source, pending);
      if (sourceHash !== null) {
        pendingSourceRef.current.set(source, sourceHash);
      }
    }
    const request = pending;

    request
      .then((sketch) => {
        if (pendingRef.current.get(source) === request) {
          pendingRef.current.delete(source);
          pendingSourceRef.current.delete(source);
        }
        // The sketch is valid for the photo that produced it, so cache it
        // even if superseded — the user may revert to that photo.
        cacheRef.current.set(source, sketch);
        // Persist only real conversions. In test mode this "sketch" is the
        // untouched photo, and offering to reuse that later would promise a
        // drawing that was never made.
        if (isSketchAiConnected) {
          putCachedSketch(sourceHash, sketch);
        }
        if (cacheRef.current.size > CACHE_MAX_ENTRIES) {
          const oldestKey = cacheRef.current.keys().next().value;
          if (oldestKey !== undefined) {
            cacheRef.current.delete(oldestKey);
          }
        }
        // Commit iff this drawing still belongs to the CURRENT photo and
        // nothing has been committed for it yet — keyed the same way as the
        // in-flight map, so a dispatch for a DIFFERENT photo can no longer
        // strand this one's result.
        if (photoRef.current !== source) {
          return;
        }
        if (sketchRef.current !== null) {
          return;
        }
        commitSketch(sketch);
      })
      .catch((cause: unknown) => {
        if (pendingRef.current.get(source) === request) {
          pendingRef.current.delete(source);
          pendingSourceRef.current.delete(source);
        }
        // These failures carried no response body, so the ticket was released
        // on a guess and the on-screen counter may be wrong REGARDLESS of which
        // photo is currently showing — refresh before deciding whether this
        // error is displayable.
        if (isSketchOutcomeUnverified(cause)) {
          void refreshAiQuota();
        }
        if (photoRef.current !== source) {
          return;
        }
        if (sketchRef.current !== null) {
          return;
        }
        setError({
          source,
          message: sketchErrorMessage(cause),
          retryable: isSketchErrorRetryable(cause),
        });
      });
  }, [
    active,
    attempt,
    canRequest,
    commitSketch,
    error,
    photoDataUrl,
    sketchDataUrl,
    sourceHash,
    inspection,
  ]);

  const retry = useCallback(() => {
    setError(null);
    setAttempt((count) => count + 1);
  }, []);

  /**
   * Whether a drawing is already on its way for the file this hash came from.
   * Answered per source FILE, not per cropped image: the upload step asks the
   * moment a file is picked, when the crop that keys the request has not been
   * made yet. A photo with no hash (Web Crypto unavailable) is never matched.
   */
  const isDrawingInProgress = useCallback((hash: string | null): boolean => {
    if (hash === null) {
      return false;
    }
    for (const pendingHash of pendingSourceRef.current.values()) {
      if (pendingHash === hash) {
        return true;
      }
    }
    return false;
  }, []);

  /**
   * Forgets everything that could hand this photo's previous drawing back: both
   * caches and the ledger's "already paid for" mark. Called when the user picks
   * 다시 그리기, whose whole point is a genuinely new drawing — without this the
   * cache path would re-commit the old one and the settled backstop would block
   * the new request.
   *
   * The photo and hash are arguments because this runs from the event handler
   * that changes them, one render before the hook's own props catch up.
   */
  const discardSketch = useCallback((photo: string, hash: string | null) => {
    cacheRef.current.delete(photo);
    removeCachedSketch(hash);
    forgetSettledSketchTicket(photo);
    // A remembered failure for this exact photo would short-circuit the effect,
    // so the redraw would never dispatch.
    setError((current) =>
      current !== null && current.source === photo ? null : current,
    );
  }, []);

  let state: SketchState;
  if (photoDataUrl === null) {
    state = { status: "idle" };
  } else if (sketchDataUrl !== null) {
    state = { status: "success", sketchDataUrl };
  } else if (!canRequest) {
    // Derived rather than stored: when the budget comes back the state heals on
    // its own, and a stale "no budget" error can never outlive the reset. It
    // also outranks any remembered error, so no retry button is offered for
    // something that cannot succeed.
    state = { status: "error", message: QUOTA_SPENT_MESSAGE, retryable: false };
  } else if (error !== null && error.source === photoDataUrl) {
    state = {
      status: "error",
      message: error.message,
      retryable: error.retryable,
    };
  } else if (isSketchTicketSettled(photoDataUrl)) {
    // The ledger settles inside the request before this hook's resolution
    // handler can cache and commit the returned drawing. A render can land in
    // that gap, so an in-flight promise must remain loading just like a cached
    // result waiting to be committed. Only a settled photo with neither is a
    // genuine lost-result failure.
    state =
      pendingRef.current.has(photoDataUrl) ||
      cacheRef.current.has(photoDataUrl)
      ? { status: "loading" }
      : {
          status: "error",
          message: sketchCauseMessage("invalid-response"),
          retryable: false,
        };
  } else if (active) {
    state = { status: "loading" };
  } else {
    state = { status: "idle" };
  }

  return { state, retry, discardSketch, isDrawingInProgress };
}
