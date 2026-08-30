import { useCallback, useRef, useState } from "react";

import {
  analyzeDiary,
  analysisErrorCode,
  analysisErrorMessage,
  isAnalysisErrorRetryable,
} from "../services/diaryAnalysis";
import type { DiaryAnalysis } from "../services/diaryAnalysis";
import type { DiaryInspectionContext } from "../services/diaryInspection";
import { refreshAiQuota } from "./useAiQuota";
import type { DiaryDraft } from "./useDiaryDraft";

export type AnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; analysis: DiaryAnalysis }
  // `retryable` is false once no immediately usable credit remains, so the UI
  // must not offer a button that can only fail again.
  | { status: "error"; message: string; retryable: boolean };

// Internal state remembers which input produced it, so a result computed for
// an older draft is never shown against newer content.
type InternalState =
  | { status: "idle" }
  | { status: "loading"; signature: string }
  | { status: "success"; analysis: DiaryAnalysis; signature: string }
  | {
      status: "error";
      message: string;
      retryable: boolean;
      signature: string;
    };

interface PendingRequest {
  signature: string;
  promise: Promise<DiaryAnalysis>;
}

// Keep the last few results, not just one: reverting an edit (A -> B -> back
// to A) is common, and each entry is small next to the photo it already keyed.
const CACHE_MAX_ENTRIES = 3;

function toPublicState(
  internal: InternalState,
  signature: string,
  cached: DiaryAnalysis | undefined,
): AnalysisState {
  if (internal.status === "loading" && internal.signature === signature) {
    return { status: "loading" };
  }
  if (
    internal.status !== "idle" &&
    internal.status !== "loading" &&
    internal.signature === signature
  ) {
    return internal.status === "success"
      ? { status: "success", analysis: internal.analysis }
      : {
          status: "error",
          message: internal.message,
          retryable: internal.retryable,
        };
  }

  // Restore a result synchronously when the user returns to an input that was
  // already checked (A → B → A). No server request or quota is needed, and the
  // preview can skip the processing screen just like an unchanged diary.
  return cached === undefined
    ? { status: "idle" }
    : { status: "success", analysis: cached };
}

/**
 * Runs the diary analysis on demand: `run()` is wired to the 검사 받기 button.
 *
 * It used to fire automatically whenever the preview opened, which does not
 * fit a scarce credit budget — editing one character changes the input
 * signature, so a few typo fixes would spend every held credit. Results are
 * still cached by input signature and an in-flight request for the same input
 * is reused, so asking again without editing costs nothing.
 */
export function useDiaryAnalysis(draft: DiaryDraft) {
  const [internalState, setInternalState] = useState<InternalState>({
    status: "idle",
  });
  const cacheRef = useRef(new Map<string, DiaryAnalysis>());
  const pendingRef = useRef<PendingRequest | null>(null);
  const requestIdRef = useRef(0);

  // Display-only fields (title, date, weather) don't change the AI input, so
  // editing them must not invalidate a result the user already paid for.
  const { photoDataUrl, content } = draft;
  // JSON.stringify gives an unambiguous key without inventing a separator
  // that user text could theoretically contain.
  const signature = JSON.stringify([photoDataUrl, content]);

  const run = useCallback((inspection?: DiaryInspectionContext) => {
    const cached = cacheRef.current.get(signature);
    if (cached !== undefined) {
      // A cache hit never reaches the server, so it never spends a request.
      // Invalidate any in-flight call for abandoned input: without this bump,
      // its late result could overwrite the cached one on screen.
      requestIdRef.current += 1;
      setInternalState({ status: "success", analysis: cached, signature });
      return;
    }

    // Stale-response guard: only the newest run may commit state.
    const requestId = ++requestIdRef.current;
    setInternalState({ status: "loading", signature });

    // Reuse the in-flight request when the input hasn't changed (a double tap,
    // or navigating away and back mid-analysis) instead of paying twice.
    let pending = pendingRef.current;
    if (pending === null || pending.signature !== signature) {
      pending = {
        signature,
        promise: analyzeDiary({ photoDataUrl, content }, inspection),
      };
      pendingRef.current = pending;
    }
    const request = pending;

    request.promise
      .then((analysis) => {
        if (pendingRef.current === request) {
          pendingRef.current = null;
        }
        // The result is valid for the input that produced it, so cache it even
        // if a newer request superseded this one — the user may revert.
        cacheRef.current.set(request.signature, analysis);
        if (cacheRef.current.size > CACHE_MAX_ENTRIES) {
          const oldestKey = cacheRef.current.keys().next().value;
          if (oldestKey !== undefined) {
            cacheRef.current.delete(oldestKey);
          }
        }
        if (requestId !== requestIdRef.current) {
          return;
        }
        setInternalState({
          status: "success",
          analysis,
          signature: request.signature,
        });
      })
      .catch((error: unknown) => {
        if (pendingRef.current === request) {
          pendingRef.current = null;
        }
        // A client-side timeout does not cancel the Edge Function, so the call
        // may still have succeeded and stayed charged. Only a fresh read can
        // tell; every other failure already carried a snapshot back with it.
        if (analysisErrorCode(error) === "timeout") {
          void refreshAiQuota();
        }
        if (requestId !== requestIdRef.current) {
          return;
        }
        setInternalState({
          status: "error",
          message: analysisErrorMessage(error),
          retryable: isAnalysisErrorRetryable(error),
          signature: request.signature,
        });
      });
  }, [photoDataUrl, content, signature]);

  return {
    state: toPublicState(
      internalState,
      signature,
      cacheRef.current.get(signature),
    ),
    run,
  };
}
