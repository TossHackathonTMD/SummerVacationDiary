import { recompressDataUrl } from "../utils/image";
import { applyPencilFilter } from "../utils/sketchFilter";
import {
  requestInspectionSketch,
  type DiaryInspectionContext,
} from "./diaryInspection";
import {
  releaseSketchTicket,
  reserveSketchTicket,
  settleSketchTicket,
} from "./sketchLedger";
import {
  EdgeFunctionError,
  isAiTestMode,
  isKnownErrorCode,
  isSupabaseConfigured,
  mapEdgeFunctionErrorCode,
} from "./supabaseEdge";

export type SketchErrorCode =
  | "timeout"
  | "network"
  | "invalid-key"
  | "invalid-image"
  | "model-unavailable"
  | "rate-limited"
  | "region-blocked"
  | "ip-burst-limit-exceeded"
  | "ip-daily-limit-exceeded"
  | "service-daily-limit-exceeded"
  | "daily-limit-exceeded"
  | "quota-exceeded"
  | "content-blocked"
  | "api-error"
  | "invalid-response";

/**
 * The preview shows one short line, "{cause} 그림을 못그렸어요.", so these are
 * sentence fragments rather than full messages. Naming the cause matters: it is
 * what tells a child whether picking a different photo would help or whether
 * there is simply nothing to do right now.
 */
export const SKETCH_ERROR_CAUSES: Record<SketchErrorCode, string> = {
  "content-blocked": "부적절한 이미지때문에",
  "invalid-image": "깨진 이미지때문에",
  "region-blocked": "해외 IP라서",
  "ip-daily-limit-exceeded": "같은 인터넷의 이용 한도를 다 써서",
  "service-daily-limit-exceeded": "오늘 준비한 AI 이용량을 다 써서",
  "daily-limit-exceeded": "AI 검사 기회를 다 써서",
  // Everything transient reads the same way on purpose — the distinction
  // between a timeout, a busy model and a dead tunnel is ours to debug from the
  // logs, not the child's to interpret.
  timeout: "친구가 쉬러가서",
  network: "친구가 쉬러가서",
  "api-error": "친구가 쉬러가서",
  "model-unavailable": "친구가 쉬러가서",
  "rate-limited": "친구가 쉬러가서",
  "ip-burst-limit-exceeded": "친구가 쉬러가서",
  "quota-exceeded": "친구가 쉬러가서",
  "invalid-key": "친구가 쉬러가서",
  "invalid-response": "알 수 없는 이유로",
};

// Retrying these cannot succeed immediately: no user credit is available, a
// daily safety window is exhausted, the photo is rejected, or billing failed.
const NON_RETRYABLE_SKETCH_CODES: readonly SketchErrorCode[] = [
  "content-blocked",
  "invalid-image",
  "region-blocked",
  "ip-daily-limit-exceeded",
  "service-daily-limit-exceeded",
  "daily-limit-exceeded",
  "quota-exceeded",
];

// Mirrors the Edge Function's NON_REFUNDABLE denylist (index.ts). These are the
// only failures the server keeps the money for, so they are the only ones whose
// ticket stays claimed; everything else gives the count back. Both quota (429)
// and region (403) rejections happen before the server reserves anything, so
// they release too.
const CHARGED_SKETCH_CODES: readonly SketchErrorCode[] = [
  "content-blocked",
  "invalid-image",
];

export class SketchError extends Error {
  constructor(public readonly code: SketchErrorCode) {
    super(code);
    this.name = "SketchError";
  }
}

/** Builds the preview line for a code, including causes never thrown as an
 *  error — the quota gate blocks before a request is even attempted. */
export function sketchCauseMessage(code: SketchErrorCode): string {
  return `${SKETCH_ERROR_CAUSES[code]} 그림을 못그렸어요.`;
}

export function sketchErrorMessage(error: unknown): string {
  return sketchCauseMessage(sketchErrorCode(error));
}

export function sketchErrorCode(error: unknown): SketchErrorCode {
  return error instanceof SketchError ? error.code : "api-error";
}

export function isSketchErrorRetryable(error: unknown): boolean {
  return !NON_RETRYABLE_SKETCH_CODES.includes(sketchErrorCode(error));
}

// No response body reached us, so no usage snapshot rode back with it and the
// counter on screen is now a guess. Everything else already carries the
// server's own numbers.
const UNVERIFIED_SKETCH_CODES: readonly SketchErrorCode[] = [
  "timeout",
  "network",
  "invalid-response",
];

/** True when the counter has to be re-read rather than inferred. */
export function isSketchOutcomeUnverified(error: unknown): boolean {
  return UNVERIFIED_SKETCH_CODES.includes(sketchErrorCode(error));
}

export const isSketchAiConnected = isSupabaseConfigured && !isAiTestMode;

/** Converts a photo through Supabase, or uses the local filter in mock mode. */
export function transferPhotoToSketch(
  photoDataUrl: string,
  inspection?: DiaryInspectionContext,
): Promise<string> {
  // Test mode deliberately uses the original photo unchanged. It avoids both
  // the paid image model and the local pencil filter while analysis continues.
  if (isAiTestMode) {
    return Promise.resolve(photoDataUrl);
  }
  return isSketchAiConnected
    ? sketchWithEdgeFunction(photoDataUrl, inspection)
    : sketchWithLocalFilter(photoDataUrl);
}

function isSketchErrorCode(
  value: string | undefined,
): value is SketchErrorCode {
  return isKnownErrorCode(SKETCH_ERROR_CAUSES, value);
}

/**
 * Owns the photo's ledger ticket. This is the one function that is 1:1 with a
 * paid server request — test and mock mode short-circuit above it in
 * `transferPhotoToSketch` — so a mode that never spends can never leave a
 * ticket behind, and no caller has to remember to count.
 */
async function sketchWithEdgeFunction(
  photoDataUrl: string,
  inspection?: DiaryInspectionContext,
): Promise<string> {
  reserveSketchTicket(photoDataUrl);
  try {
    const sketch = await requestSketch(photoDataUrl, inspection);
    settleSketchTicket(photoDataUrl);
    return sketch;
  } catch (error) {
    if (CHARGED_SKETCH_CODES.includes(sketchErrorCode(error))) {
      settleSketchTicket(photoDataUrl);
    } else {
      releaseSketchTicket(photoDataUrl);
    }
    throw error;
  }
}

async function requestSketch(
  photoDataUrl: string,
  inspection?: DiaryInspectionContext,
): Promise<string> {
  try {
    if (inspection === undefined) {
      throw new SketchError("invalid-response");
    }
    const imageBase64 = await requestInspectionSketch(
      inspection,
      photoDataUrl,
    );

    try {
      return await recompressDataUrl(`data:image/jpeg;base64,${imageBase64}`);
    } catch {
      throw new SketchError("invalid-response");
    }
  } catch (error) {
    if (error instanceof SketchError) {
      throw error;
    }
    if (error instanceof EdgeFunctionError) {
      throw new SketchError(mapEdgeFunctionErrorCode(error, isSketchErrorCode));
    }
    throw new SketchError("api-error");
  }
}

const MOCK_DELAY_MS = 1500;

async function sketchWithLocalFilter(photoDataUrl: string): Promise<string> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));
  try {
    return await applyPencilFilter(photoDataUrl);
  } catch {
    throw new SketchError("invalid-response");
  }
}
