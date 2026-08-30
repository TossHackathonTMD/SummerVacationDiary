import { User } from "@apps-in-toss/web-framework";

import { recordQuotaSnapshot } from "./aiQuotaStore";

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL ?? "")
  .trim()
  .replace(/\/$/, "");
const publishableKey = (
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? ""
).trim();

// Cost-safe by default: test mode keeps the inexpensive analysis path but
// skips image generation. Setting false explicitly enables both operations.
const aiTestModeValue = (import.meta.env.VITE_AI_TEST_MODE ?? "false")
  .trim()
  .toLowerCase();

const DIARY_AI_FUNCTION_URL = `${supabaseUrl}/functions/v1/diary-ai`;
const CLIENT_ID_STORAGE_KEY = "summer-vacation-diary:client-id:v1";
let sessionClientId: string | null = null;

export const isAiTestMode = !["false", "0", "off"].includes(aiTestModeValue);
export const isSupabaseConfigured = supabaseUrl !== "" && publishableKey !== "";

export type EdgeFunctionErrorKind =
  "timeout" | "network" | "http" | "invalid-response";

export class EdgeFunctionError extends Error {
  constructor(
    public readonly kind: EdgeFunctionErrorKind,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(code ?? kind);
    this.name = "EdgeFunctionError";
  }
}

export type CommonDiaryAiErrorCode =
  | "timeout"
  | "network"
  | "invalid-key"
  | "rate-limited"
  | "api-error"
  | "invalid-response";

export function isKnownErrorCode<T extends string>(
  messages: Record<T, unknown>,
  value: string | undefined,
): value is T {
  // Do not use `in`: it walks the prototype chain, so a malicious server code
  // such as "toString" could be treated as one of our own error keys.
  return (
    value !== undefined && Object.prototype.hasOwnProperty.call(messages, value)
  );
}

/**
 * Converts transport failures into the error vocabulary shared by analysis
 * and sketch generation, while preserving each action's recognised server
 * codes (quota, region and content-policy failures).
 */
export function mapEdgeFunctionErrorCode<T extends string>(
  error: EdgeFunctionError,
  isActionCode: (value: string | undefined) => value is T,
): CommonDiaryAiErrorCode | T {
  if (
    error.kind === "timeout" ||
    error.kind === "network" ||
    error.kind === "invalid-response"
  ) {
    return error.kind;
  }
  if (isActionCode(error.code)) {
    return error.code;
  }
  if (error.status === 401 || error.status === 403) {
    return "invalid-key";
  }
  if (error.status === 429) {
    return "rate-limited";
  }
  return "api-error";
}

interface EdgeErrorBody {
  code?: unknown;
}

function createClientId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Uses Toss's anonymous mini-app key when available. Plain-browser
 * development gets a random, persisted installation ID instead. This is only
 * a rate-limit hint: the server hashes it with a secret salt before storage.
 */
async function getRateLimitClientId(): Promise<string> {
  try {
    const { hash } = await User.getAnonymousKey();
    if (hash.trim() !== "") {
      return `toss:${hash}`;
    }
  } catch {
    // Expected in a normal browser outside the Toss bridge.
  }

  try {
    const stored = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored !== null && stored !== "") {
      return `web:${stored}`;
    }
    const created = createClientId();
    localStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
    return `web:${created}`;
  } catch {
    // Private browsing can deny localStorage; keep a stable ID for this tab.
    sessionClientId ??= createClientId();
    return `session:${sessionClientId}`;
  }
}

/** Calls the shared `diary-ai` Supabase Edge Function. */
export async function invokeDiaryAi(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  if (!isSupabaseConfigured) {
    throw new EdgeFunctionError("network");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let phase: "request" | "body" = "request";

  try {
    const clientId = await getRateLimitClientId();
    const response = await fetch(DIARY_AI_FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // New sb_publishable_* keys belong in apikey, not Authorization.
        apikey: publishableKey,
        "x-diary-client-id": clientId,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    phase = "body";
    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new EdgeFunctionError("invalid-response", response.status);
    }

    // Every response carries the post-request usage snapshot, rejections
    // included. Recording before the error branch is what lets an
    // over-the-limit refusal drop the on-screen counter to zero in the same
    // round trip, with no follow-up quota-status call.
    recordQuotaSnapshot(responseBody);

    if (!response.ok) {
      const errorBody = responseBody as EdgeErrorBody;
      throw new EdgeFunctionError(
        "http",
        response.status,
        typeof errorBody.code === "string" ? errorBody.code : undefined,
      );
    }

    return responseBody;
  } catch (error) {
    if (error instanceof EdgeFunctionError) {
      throw error;
    }
    if (controller.signal.aborted) {
      throw new EdgeFunctionError("timeout");
    }
    throw new EdgeFunctionError(
      phase === "request" ? "network" : "invalid-response",
    );
  } finally {
    clearTimeout(timer);
  }
}
