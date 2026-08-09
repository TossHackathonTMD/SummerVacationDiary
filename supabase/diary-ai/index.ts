import { createClient } from "npm:@supabase/supabase-js@2";
import { ANALYSIS_PROMPT } from "./prompt_analysis.ts";
import { SKETCH_PROMPT } from "./prompt_sketch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type, x-diary-client-id",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json; charset=utf-8",
};

// Change limits here without touching the database function. One inspection
// consumes one request from the device and shared IP budgets, while the
// service-wide counters increase only for the operations actually requested. Daily
// windows reset at 00:00 UTC, which is 09:00 KST — every user-facing message
// must say "내일 아침 9시부터", never "내일".
const USAGE_LIMITS = {
  // The burst window is IP-only. A device budget cannot stop a scripted caller
  // (x-diary-client-id is just a header on a public endpoint), so the short
  // window is only useful where identity cannot be reset at will.
  ipBurstWindowSeconds: 10 * 60,
  ipBurst: 20,
  ipDaily: 100,
  // 무료로 주는 하루 기회. 리워드 광고를 끝까지 보면 여기에 adRewardBonus가
  // 더해져 하루 최대 3회가 됩니다.
  userDaily: 2,
  // 광고로 늘릴 수 있는 하루 최대 횟수. 이 값이 곧 "광고는 하루 한 번만"이라는
  // 규칙 자체이고, 실제 상한은 DB의 grant 함수가 잡습니다.
  adRewardBonus: 1,
  // Cost circuit breaker: the real ceiling on a day's spend. Split per action
  // so a flood of cheap analyses cannot starve the expensive sketch budget.
  serviceDaily: { sketch: 150, analyze: 250 },
} as const;

// The mini-app ships to a Korean audience inside the Toss app, so a caller from
// anywhere else is far more likely to be a script than a child writing a diary.
// This does not lower the cost ceiling — USAGE_LIMITS.serviceDaily already does
// that — it keeps that fixed budget pointed at the people it is for.
const ALLOWED_COUNTRIES = new Set(["KR"]);

// Supabase documents no country header for Edge Functions, and its own location
// example resolves the country by sending x-forwarded-for to a third-party
// service. These are the headers a Cloudflare-fronted edge *may* forward, tried
// in order — so this gate may legitimately find nothing and do nothing, which
// the `region.country` field in every response makes visible.
const COUNTRY_HEADERS = ["cf-ipcountry", "x-country", "x-vercel-ip-country"];

class FunctionError extends Error {
  constructor(
    readonly code: string,
    readonly status = 500,
  ) {
    super(code);
  }
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

// Verbose diagnostics stay off unless DIARY_AI_DEBUG is set as a Secret.
// Supabase caps a function at 100 log events per 10 seconds and one message at
// 10,000 characters, so normal traffic emits one line per request plus whatever
// failed, and the noisy detail is opt-in.
const DEBUG = ["1", "true", "on"].includes(
  (Deno.env.get("DIARY_AI_DEBUG") ?? "").trim().toLowerCase(),
);

// This is intentionally an Edge Function Secret, not a request header or a
// VITE_* value. Browser environment variables are public, so trusting one here
// would let any caller turn off the production cost guard. It must be enabled
// separately from the client-side VITE_AI_TEST_MODE flag.
const QUOTA_TEST_MODE = ["1", "true", "on"].includes(
  (Deno.env.get("DIARY_AI_TEST_MODE") ?? "").trim().toLowerCase(),
);

/**
 * Stamps every line with a short per-request id and the elapsed time. Requests
 * overlap heavily here — one sketch runs 30-60 seconds — so without an id the
 * lines from concurrent callers interleave into something unreadable.
 *
 * Nothing logged may carry user content. The diary text and the photo are
 * covered by an explicit consent notice about where they travel, and the raw IP
 * is deliberately hashed before it is ever stored, so putting either in a log
 * would quietly undo both. Log sizes, codes and decisions — never values.
 */
class RequestLog {
  private readonly id = Math.random().toString(36).slice(2, 8);
  private readonly startedAt = Date.now();

  private write(level: "log" | "error", message: string): void {
    console[level](`[${this.id} +${Date.now() - this.startedAt}ms] ${message}`);
  }

  info(message: string): void {
    this.write("log", message);
  }

  error(message: string): void {
    this.write("error", message);
  }

  /** Only emitted when DIARY_AI_DEBUG is set. */
  debug(message: string): void {
    if (DEBUG) {
      this.write("log", message);
    }
  }
}

// Written once per isolate at cold start instead of being exposed as a "ping"
// action: it answers the same "is this deployment actually configured?"
// question without adding an unauthenticated probe to a public endpoint. Only
// presence is ever reported, never a value.
console.log(
  `diary-ai boot — ${[
    "OPENAI_API_KEY",
    "RATE_LIMIT_SALT",
    "SUPABASE_URL",
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
    "OPENAI_MODEL",
    "OPENAI_IMAGE_MODEL",
    "OPENAI_IMAGE_QUALITY",
    "DIARY_AI_DEBUG",
  ]
    .map((name) => `${name}=${Deno.env.get(name) ? "set" : "missing"}`)
    .join(" ")}`,
);

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new FunctionError(`invalid-${name}`, 400);
  }
  return value;
}

function getSupabaseSecret(): string {
  const secretKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (secretKeys) {
    try {
      const parsed = JSON.parse(secretKeys) as { default?: unknown };
      if (typeof parsed.default === "string" && parsed.default !== "") {
        return parsed.default;
      }
    } catch {
      throw new FunctionError("invalid-supabase-secret", 500);
    }
  }

  const legacySecret = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!legacySecret) {
    throw new FunctionError("missing-supabase-secret", 500);
  }
  return legacySecret;
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0];
  return (
    forwarded?.trim() ||
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    null
  );
}

function requestCountry(request: Request): string | null {
  for (const name of COUNTRY_HEADERS) {
    const value = request.headers.get(name)?.trim().toUpperCase();
    // Cloudflare sends XX when it cannot place the address, and T1 for Tor.
    // Both mean "unknown", which is not the same as "somewhere else".
    if (value && value !== "XX" && value !== "T1") {
      return value;
    }
  }
  return null;
}

/**
 * An unknown country is allowed through deliberately. Failing closed would take
 * the entire app down the moment the signal disappears — and the country is a
 * best-effort signal here, not something the platform promises.
 */
function regionAllowed(country: string | null): boolean {
  return country === null || ALLOWED_COUNTRIES.has(country);
}

function requestRegion(request: Request): QuotaRegion {
  const country = requestCountry(request);
  return { allowed: regionAllowed(country), country };
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

interface QuotaCounter {
  used: number;
  limit: number;
  remaining: number;
}

interface QuotaRegion {
  allowed: boolean;
  /** ISO-3166 alpha-2, or null when no header carried one. */
  country: string | null;
}

// What the client is allowed to see: its shared counter, when it resets, and
// one reason string when something shared is blocking. The raw service-wide
// numbers stay server-side — publishing how much headroom is left would help
// somebody time a burst against it. The caller's own country is not a secret
// from the caller, and returning it is how we can tell whether the header the
// region gate depends on exists at all.
interface QuotaSnapshot {
  all: QuotaCounter;
  resetAt: string;
  blocked: null | "device" | "ip-burst" | "ip-daily" | "service";
  region: QuotaRegion;
  /** Lets the client hide quota UI while the server deliberately bypasses it. */
  testMode: boolean;
  /**
   * False once today's rewarded-ad bonus has been claimed. The client needs
   * this to stop offering the ad — `all.limit` alone cannot say whether a limit
   * of 3 means "bonus already added" or "bonus still available".
   */
  adRewardAvailable: boolean;
}

// Raw counters as the database returns them.
interface QuotaCounts {
  userAll: number;
  /** Extra daily requests this device unlocked by watching a rewarded ad. */
  userBonus: number;
  ipShort: number;
  ipDay: number;
  serviceSketch: number;
  serviceAnalyze: number;
}

interface Reservation {
  runSketch: boolean;
  runAnalyze: boolean;
  userHash: string;
  ipHash: string;
  // Kept from the consume call rather than recomputed when refunding: a request
  // consumed at 23:59 UTC that fails at 00:01 must give its request back to
  // yesterday's row — a harmless no-op, since that budget already reset —
  // instead of handing out a free credit against today's.
  shortWindowStart: string;
  dayWindowStart: string;
  snapshot: QuotaSnapshot;
}

// Carries the snapshot so a rejection can tell the client "0 left" in the same
// response instead of forcing a follow-up quota-status call.
class QuotaError extends FunctionError {
  constructor(
    code: string,
    readonly quota: QuotaSnapshot,
  ) {
    super(code, 429);
  }
}

function windowStarts(): { shortWindowStart: string; dayWindowStart: string } {
  const burstMs = USAGE_LIMITS.ipBurstWindowSeconds * 1000;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  return {
    shortWindowStart: new Date(
      Math.floor(Date.now() / burstMs) * burstMs,
    ).toISOString(),
    dayWindowStart: dayStart.toISOString(),
  };
}

function adminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    throw new FunctionError("missing-supabase-url", 500);
  }
  return createClient(supabaseUrl, getSupabaseSecret(), {
    auth: { persistSession: false },
  });
}

async function hashIdentifiers(
  request: Request,
): Promise<{ userHash: string; ipHash: string }> {
  const clientId = requireString(
    request.headers.get("x-diary-client-id"),
    "client-id",
  );
  const salt = Deno.env.get("RATE_LIMIT_SALT");
  if (!salt) {
    throw new FunctionError("missing-rate-limit-salt", 500);
  }

  // Supabase normally supplies x-forwarded-for. If it is absent, keep the
  // request usable without collapsing every visitor into one shared bucket;
  // the device bucket still enforces the per-action limits.
  const ip = clientIp(request) ?? `unavailable:${clientId}`;
  const [userHash, ipHash] = await Promise.all([
    sha256(`user:${salt}:${clientId}`),
    sha256(`ip:${salt}:${ip}`),
  ]);
  return { userHash, ipHash };
}

const COUNT_KEYS = [
  "userAll",
  "userBonus",
  "ipShort",
  "ipDay",
  "serviceSketch",
  "serviceAnalyze",
] as const;

function parseCounts(data: unknown): QuotaCounts | null {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const record = data as Record<string, unknown>;
  const counts = {} as QuotaCounts;
  for (const key of COUNT_KEYS) {
    const value = record[key];
    if (typeof value !== "number") {
      return null;
    }
    counts[key] = value;
  }
  return counts;
}

function counter(used: number, limit: number): QuotaCounter {
  return { used, limit, remaining: Math.max(limit - used, 0) };
}

// `decision` comes from consume and is authoritative for that request. A plain
// read has no decision, so the same precedence is re-derived from the counts.
// Per-device exhaustion is deliberately absent here: the shared `all`
// counter already exposes it directly.
function blockedReason(
  counts: QuotaCounts,
  decision?: string,
): QuotaSnapshot["blocked"] {
  if (decision !== undefined && decision !== "allowed") {
    if (decision === "device-daily") return "device";
    if (decision === "ip-short") return "ip-burst";
    if (decision === "ip-daily") return "ip-daily";
    if (decision === "service-daily") return "service";
    return null;
  }
  if (counts.ipShort >= USAGE_LIMITS.ipBurst) return "ip-burst";
  if (counts.ipDay >= USAGE_LIMITS.ipDaily) return "ip-daily";
  if (
    counts.serviceSketch >= USAGE_LIMITS.serviceDaily.sketch &&
    counts.serviceAnalyze >= USAGE_LIMITS.serviceDaily.analyze
  ) {
    return "service";
  }
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function buildSnapshot(
  counts: QuotaCounts,
  dayWindowStart: string,
  region: QuotaRegion,
  decision?: string,
): QuotaSnapshot {
  return {
    // The bonus raises this device's ceiling rather than discounting its usage,
    // so "2/3" after an ad reads the same way "1/2" did before it.
    all: counter(counts.userAll, USAGE_LIMITS.userDaily + counts.userBonus),
    resetAt: new Date(Date.parse(dayWindowStart) + DAY_MS).toISOString(),
    blocked: blockedReason(counts, decision),
    region,
    testMode: false,
    adRewardAvailable: counts.userBonus < USAGE_LIMITS.adRewardBonus,
  };
}

/** A syntactically normal response for test mode; no identifiers or DB rows. */
function testModeSnapshot(request: Request): QuotaSnapshot {
  const { dayWindowStart } = windowStarts();
  const emptyCounter = { used: 0, limit: 0, remaining: 0 };
  return {
    all: emptyCounter,
    resetAt: new Date(Date.parse(dayWindowStart) + DAY_MS).toISOString(),
    blocked: null,
    region: requestRegion(request),
    testMode: true,
    // Test mode bypasses the counters entirely, so there is no exhausted state
    // for an ad to relieve — offering one would be a button that does nothing.
    adRewardAvailable: false,
  };
}

function rejectionCode(decision: string): string {
  if (decision === "device-daily") return "daily-limit-exceeded";
  if (decision === "ip-short") return "ip-burst-limit-exceeded";
  if (decision === "ip-daily") return "ip-daily-limit-exceeded";
  if (decision === "service-daily") return "service-daily-limit-exceeded";
  return "";
}

/**
 * Consumes one request up front, before any paid call. Doing it in this order
 * — rather than charging after a successful response — is what makes the limit
 * hold under concurrency: check-then-call would let every parallel request read
 * the same pre-increment count and pass.
 */
async function reserveQuota(
  request: Request,
  runSketch: boolean,
  runAnalyze: boolean,
  log: RequestLog,
): Promise<Reservation> {
  const { userHash, ipHash } = await hashIdentifiers(request);
  const { shortWindowStart, dayWindowStart } = windowStarts();
  const region = requestRegion(request);

  const { data, error } = await adminClient().rpc(
    "consume_diary_ai_inspection_quota",
    {
      p_run_sketch: runSketch,
      p_run_analyze: runAnalyze,
      p_user_hash: userHash,
      p_ip_hash: ipHash,
      p_short_window_start: shortWindowStart,
      p_day_window_start: dayWindowStart,
      p_user_daily_limit: USAGE_LIMITS.userDaily,
      p_ip_short_limit: USAGE_LIMITS.ipBurst,
      p_ip_daily_limit: USAGE_LIMITS.ipDaily,
      p_service_sketch_daily_limit: USAGE_LIMITS.serviceDaily.sketch,
      p_service_analyze_daily_limit: USAGE_LIMITS.serviceDaily.analyze,
    },
  );

  const counts = parseCounts(data);
  const decision = (data as { decision?: unknown } | null)?.decision;
  if (error || counts === null || typeof decision !== "string") {
    log.error(`quota consume failed — ${error?.message ?? "invalid result"}`);
    // Fail closed: a database outage must not turn into unlimited paid calls.
    throw new FunctionError("rate-limit-unavailable", 503);
  }

  // All six counters on one line: when a user reports being blocked, which of
  // the four budgets did it is the first thing worth knowing, and only the
  // device pair ever reaches the client.
  log.debug(
    `quota inspect(${runSketch ? "sketch" : ""}${runSketch && runAnalyze ? "+" : ""}${runAnalyze ? "analyze" : ""}) ${decision} — device ${counts.userAll}, ip ${counts.ipShort}/${counts.ipDay}, service ${counts.serviceSketch}/${counts.serviceAnalyze}`,
  );

  if (decision !== "allowed") {
    const code = rejectionCode(decision);
    if (code === "") {
      throw new FunctionError("rate-limit-unavailable", 503);
    }
    throw new QuotaError(
      code,
      buildSnapshot(counts, dayWindowStart, region, decision),
    );
  }

  return {
    runSketch,
    runAnalyze,
    userHash,
    ipHash,
    shortWindowStart,
    dayWindowStart,
    snapshot: buildSnapshot(counts, dayWindowStart, region, decision),
  };
}

/**
 * Gives a reserved request back. Never throws: this runs inside the error path,
 * and replacing the original failure with a refund failure would hide what
 * actually went wrong. A lost refund costs one request and heals at the reset.
 */
async function refundQuota(
  reservation: Reservation,
  log: RequestLog,
): Promise<QuotaSnapshot | null> {
  try {
    const { data, error } = await adminClient().rpc(
      "refund_diary_ai_inspection_quota",
      {
        p_run_sketch: reservation.runSketch,
        p_run_analyze: reservation.runAnalyze,
        p_user_hash: reservation.userHash,
        p_ip_hash: reservation.ipHash,
        p_short_window_start: reservation.shortWindowStart,
        p_day_window_start: reservation.dayWindowStart,
      },
    );
    const counts = parseCounts(data);
    if (error || counts === null) {
      log.error(`quota refund failed — ${error?.message ?? "invalid result"}`);
      return null;
    }
    // The region came from the same request that made the reservation, so it is
    // carried on the snapshot rather than re-derived from headers we no longer
    // have here.
    return buildSnapshot(
      counts,
      reservation.dayWindowStart,
      reservation.snapshot.region,
    );
  } catch (cause) {
    log.error(
      `quota refund threw — ${cause instanceof Error ? cause.message : cause}`,
    );
    return null;
  }
}

async function readQuota(
  request: Request,
  log: RequestLog,
): Promise<QuotaSnapshot> {
  const { userHash, ipHash } = await hashIdentifiers(request);
  const { shortWindowStart, dayWindowStart } = windowStarts();

  const { data, error } = await adminClient().rpc(
    "read_diary_ai_inspection_quota",
    {
      p_user_hash: userHash,
      p_ip_hash: ipHash,
      p_short_window_start: shortWindowStart,
      p_day_window_start: dayWindowStart,
    },
  );

  const counts = parseCounts(data);
  if (error || counts === null) {
    log.error(`quota read failed — ${error?.message ?? "invalid result"}`);
    throw new FunctionError("rate-limit-unavailable", 503);
  }
  return buildSnapshot(counts, dayWindowStart, requestRegion(request));
}

/**
 * Adds today's rewarded-ad bonus for this device.
 *
 * Deliberately idempotent rather than "once per call": the client can only tell
 * us an ad finished, and a dropped response, a double tap or a replayed request
 * would otherwise each buy another request. The database caps the counter at
 * `adRewardBonus`, so every call after the first is a no-op that still returns
 * the current numbers — which is exactly what the client needs to re-render.
 *
 * There is no server-side verification of the ad itself; the Toss rewarded-ad
 * API exposes no SSV callback, so a caller that never watched anything can
 * still claim the bonus. That is bounded on purpose: one extra request per
 * device per day, under the same IP and service ceilings as everything else.
 */
async function grantAdReward(
  request: Request,
  log: RequestLog,
): Promise<QuotaSnapshot> {
  const { userHash, ipHash } = await hashIdentifiers(request);
  const { shortWindowStart, dayWindowStart } = windowStarts();

  const { data, error } = await adminClient().rpc("grant_diary_ai_ad_reward", {
    p_user_hash: userHash,
    p_ip_hash: ipHash,
    p_short_window_start: shortWindowStart,
    p_day_window_start: dayWindowStart,
    p_max_bonus: USAGE_LIMITS.adRewardBonus,
  });

  const counts = parseCounts(data);
  const decision = (data as { decision?: unknown } | null)?.decision;
  if (error || counts === null || typeof decision !== "string") {
    log.error(`ad reward failed — ${error?.message ?? "invalid result"}`);
    throw new FunctionError("rate-limit-unavailable", 503);
  }

  log.debug(
    `ad reward ${decision} — device ${counts.userAll}/${
      USAGE_LIMITS.userDaily + counts.userBonus
    }, bonus ${counts.userBonus}`,
  );

  return buildSnapshot(counts, dayWindowStart, requestRegion(request));
}

type ProgressAction =
  | "progress-visit"
  | "progress-status"
  | "progress-complete"
  | "progress-delete";

const PROGRESS_RPC_BY_ACTION: Record<ProgressAction, string> = {
  "progress-visit": "record_diary_app_visit",
  "progress-status": "read_diary_progress",
  "progress-complete": "record_diary_completion",
  "progress-delete": "delete_diary_progress",
};

function isProgressAction(value: unknown): value is ProgressAction {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PROGRESS_RPC_BY_ACTION, value)
  );
}

/**
 * Keeps progress writes behind the Edge Function so the browser never receives
 * the salted identifier hash or direct table/RPC privileges. Unlike AI work,
 * progress is available outside Korea and does not require OPENAI_API_KEY.
 */
async function runProgressAction(
  request: Request,
  action: ProgressAction,
  log: RequestLog,
): Promise<unknown> {
  const clientId = requireString(
    request.headers.get("x-diary-client-id"),
    "client-id",
  );
  enforceStatusLimit(clientId);
  const { userHash } = await hashIdentifiers(request);
  const { data, error } = await adminClient().rpc(
    PROGRESS_RPC_BY_ACTION[action],
    { p_user_hash: userHash },
  );

  if (error) {
    log.error(`progress RPC failed — ${error.message}`);
    throw new FunctionError("progress-unavailable", 503);
  }
  if (action === "progress-delete") {
    if (typeof data !== "boolean") {
      throw new FunctionError("progress-unavailable", 503);
    }
  } else if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new FunctionError("progress-unavailable", 503);
  }

  return data;
}

// Denylist, not an allowlist: anything not explicitly the user's fault gets
// refunded, so a code added later defaults to giving the request back. Charging
// somebody for our own bug is the worse of the two failures. The invariant that
// keeps this honest: HTTP 400 means the user's fault, which means no refund.
const NON_REFUNDABLE = new Set([
  "content-blocked",
  "invalid-image",
  "invalid-input",
  "invalid-content",
]);

function shouldRefund(error: unknown): boolean {
  return error instanceof FunctionError
    ? !NON_REFUNDABLE.has(error.code)
    : true;
}

// analyze() returns whatever JSON the model produced, so spreading it blindly
// would turn an array or a scalar into {0: ..., 1: ...}. quota goes last so a
// model that happens to emit a "quota" key cannot shadow the real one.
function withQuota(result: unknown, quota: QuotaSnapshot): unknown {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return result;
  }
  return { ...(result as Record<string, unknown>), quota };
}

// quota-status spends no money and moves no counters, so it does not need the
// database-backed limiter — this only stops one client from hammering the read
// in a loop. Isolates are ephemeral and there are several, so treat it as a
// speed bump rather than a guarantee.
const STATUS_LIMIT = 30;
const STATUS_WINDOW_MS = 10 * 60 * 1000;
const statusHits = new Map<string, number>();
let statusWindowStart = 0;

function enforceStatusLimit(clientId: string): void {
  const windowStart =
    Math.floor(Date.now() / STATUS_WINDOW_MS) * STATUS_WINDOW_MS;
  if (windowStart !== statusWindowStart) {
    // Clearing on the window roll keeps the map bounded without an O(n) sweep
    // on every new client.
    statusWindowStart = windowStart;
    statusHits.clear();
  }
  const count = (statusHits.get(clientId) ?? 0) + 1;
  statusHits.set(clientId, count);
  if (count > STATUS_LIMIT) {
    throw new FunctionError("rate-limited", 429);
  }
}

async function openAiError(
  response: Response,
  log: RequestLog,
): Promise<FunctionError> {
  let code = "";
  let message = "";
  try {
    const body = await response.json();
    code = typeof body?.error?.code === "string" ? body.error.code : "";
    message =
      typeof body?.error?.message === "string" ? body.error.message : "";
  } catch {
    // Use the HTTP status mapping below when OpenAI returns a non-JSON body.
  }

  // The single most useful line in these logs: everything below collapses many
  // distinct upstream problems into a handful of client-facing codes, and this
  // is the only place the original reason survives.
  log.error(
    `OpenAI ${response.status}${code ? ` ${code}` : ""}${
      message ? ` — ${message.slice(0, 300)}` : ""
    }`,
  );

  if (response.status === 401) return new FunctionError("invalid-key", 502);
  if (code === "insufficient_quota") {
    return new FunctionError("quota-exceeded", 429);
  }
  if (response.status === 429) return new FunctionError("rate-limited", 429);
  if (code === "moderation_blocked" || message.includes("safety system")) {
    return new FunctionError("content-blocked", 400);
  }
  if (
    response.status === 403 ||
    code === "model_not_found" ||
    message.toLowerCase().includes("verif")
  ) {
    return new FunctionError("model-unavailable", 502);
  }
  return new FunctionError("api-error", 502);
}

async function requestAnalysis(
  apiKey: string,
  userContent: Array<Record<string, unknown>>,
  log: RequestLog,
): Promise<unknown> {
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  log.debug(`chat → openai ${model}`);

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: 1200,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ANALYSIS_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    throw await openAiError(response, log);
  }

  const body = await response.json();
  const raw = body?.choices?.[0]?.message?.content;
  if (typeof raw !== "string") {
    log.error("OpenAI returned no message content");
    throw new FunctionError("invalid-response", 502);
  }

  try {
    return JSON.parse(raw);
  } catch {
    log.error(`OpenAI returned ${raw.length} chars of non-JSON`);
    log.debug(`non-JSON content: ${raw.slice(0, 500)}`);
    throw new FunctionError("invalid-response", 502);
  }
}

const HIGHLIGHT_SENTENCE_END_PATTERN = /[.!?…。！？]+$/u;
const HIGHLIGHT_SENTENCE_PATTERN = /[^.!?…。！？]+(?:[.!?…。！？]+|$)/gu;
const HIGHLIGHT_TOKEN_PATTERN = /\S+/gu;
const HIGHLIGHT_LINE_BREAK_PATTERN = /[\r\n]/u;
const MEANINGFUL_HIGHLIGHT_PATTERN = /[\p{L}\p{N}]/u;
const MIN_HIGHLIGHT_SENTENCE_LENGTH = 8;
const MAX_HIGHLIGHT_SENTENCE_LENGTH = 20;

// Keep this list aligned with src/utils/profanity.ts in the app repository.
// The prompt is guidance; this server-side check is the enforcement layer.
const UNSAFE_HIGHLIGHT_WORDS = [
  "개씨발새끼",
  "개씨발년",
  "개씨발놈",
  "개씨발",
  "씨발새끼",
  "씨발년",
  "씨발놈",
  "씨발련",
  "씨발",
  "시발새끼",
  "시발년",
  "시발놈",
  "시발련",
  "시발",
  "씨팔",
  "시팔",
  "씨벌",
  "시벌",
  "씨바",
  "시바",
  "씹새끼",
  "씹년",
  "씹놈",
  "씹창",
  "씹덕",
  "씹빨",
  "씹할",
  "씹",
  "좆병신",
  "좆대가리",
  "좆같은년",
  "좆같은놈",
  "좆같다",
  "좆같네",
  "좆같",
  "좆까라",
  "좆까",
  "좆밥",
  "좆망",
  "좆나",
  "좆",
  "개새끼",
  "개색기",
  "개세끼",
  "개쉐끼",
  "개새",
  "개자식",
  "개잡놈",
  "개잡년",
  "개잡종",
  "개같은년",
  "개같은놈",
  "개같다",
  "개같네",
  "개같",
  "개년",
  "개놈",
  "병신새끼",
  "병신같은년",
  "병신같은놈",
  "병신같다",
  "병신같네",
  "병신같",
  "병신",
  "븅신",
  "빙신",
  "볍신",
  "븅",
  "븁",
  "미친새끼",
  "미친년",
  "미친놈",
  "미친련",
  "미친자식",
  "니애미",
  "니애비",
  "니에미",
  "니에비",
  "네애미",
  "네애비",
  "느금마",
  "느금",
  "너거미",
  "니미",
  "애미뒤진",
  "애비뒤진",
  "부모없는새끼",
  "후레자식",
  "호로자식",
  "호로새끼",
  "창녀",
  "창년",
  "창놈",
  "걸레년",
  "걸레같은년",
  "걸레같",
  "몸파는년",
  "몸파는놈",
  "암캐",
  "갈보",
  "잡년",
  "잡놈",
  "고아새끼",
  "고아련",
  "염병할",
  "염병",
  "지랄맞",
  "지랄하",
  "지랄",
  "존나",
  "존내",
  "존니",
  "존라",
  "엿먹어",
  "엿먹",
  "꺼져버려",
  "닥쳐",
  "죽어버려",
  "motherfucking",
  "motherfucker",
  "motherfuckers",
  "fucking",
  "fucker",
  "fuckers",
  "fuckface",
  "fuckhead",
  "fuckoff",
  "fuckyou",
  "fuck",
  "bullshitting",
  "bullshit",
  "shithead",
  "shitface",
  "shitbag",
  "shitty",
  "shitting",
  "shit",
  "sonofabitch",
  "bitches",
  "bitching",
  "bitch",
  "assholes",
  "asshole",
  "arsehole",
  "bastards",
  "bastard",
  "dumbass",
  "jackass",
  "dipshit",
  "dickhead",
  "dickface",
  "douchebag",
  "scumbag",
  "pieceofshit",
  "prick",
  "cunt",
  "cunts",
  "dick",
  "cocksucker",
  "slut",
  "sluts",
  "whore",
  "whores",
] as const;

interface CompactHighlightSource {
  value: string;
  sourceIndexes: number[];
}

interface UnsafeHighlightRange {
  start: number;
  end: number;
}

function compactHighlightSource(value: string): CompactHighlightSource {
  let compact = "";
  const sourceIndexes: number[] = [];
  let sourceIndex = 0;

  for (const character of value) {
    const normalized = character.normalize("NFKC").toLowerCase();

    for (const normalizedCharacter of normalized) {
      if (/[\p{L}\p{N}]/u.test(normalizedCharacter)) {
        compact += normalizedCharacter;

        for (
          let normalizedIndex = 0;
          normalizedIndex < normalizedCharacter.length;
          normalizedIndex += 1
        ) {
          sourceIndexes.push(sourceIndex);
        }
      }
    }

    sourceIndex += character.length;
  }

  return {
    value: compact,
    sourceIndexes,
  };
}

function compactHighlightText(value: string): string {
  return compactHighlightSource(value).value;
}

function escapeHighlightRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const UNSAFE_HIGHLIGHT_PATTERN = new RegExp(
  [...UNSAFE_HIGHLIGHT_WORDS]
    .sort((first, second) => second.length - first.length)
    .map(escapeHighlightRegExp)
    .join("|"),
  "gu",
);

function findUnsafeHighlightRanges(value: string): UnsafeHighlightRange[] {
  const compact = compactHighlightSource(value);
  const ranges: UnsafeHighlightRange[] = [];

  for (const match of compact.value.matchAll(UNSAFE_HIGHLIGHT_PATTERN)) {
    if (match.index === undefined || match[0] === "") continue;

    const compactStart = match.index;
    const compactEnd = compactStart + match[0].length - 1;
    const start = compact.sourceIndexes[compactStart];
    const endSourceIndex = compact.sourceIndexes[compactEnd];
    if (start === undefined || endSourceIndex === undefined) continue;

    const lastCharacter = String.fromCodePoint(
      value.codePointAt(endSourceIndex) ?? 0,
    );

    ranges.push({
      start,
      end: endSourceIndex + lastCharacter.length,
    });
  }

  return ranges;
}

function containsUnsafeHighlight(value: string): boolean {
  return findUnsafeHighlightRanges(value).length > 0;
}

function overlapsUnsafeHighlight(
  sentence: string,
  content: string,
): boolean {
  const start = content.indexOf(sentence);
  if (start < 0) return true;

  const end = start + sentence.length;
  return findUnsafeHighlightRanges(content).some(
    (range) => start < range.end && end > range.start,
  );
}

function getHighlightLength(value: string): number {
  return Array.from(value).length;
}

function isUsableHighlightSentence(
  sentence: string,
  content: string,
): boolean {
  const length = getHighlightLength(sentence);

  return (
    sentence !== "" &&
    length >= MIN_HIGHLIGHT_SENTENCE_LENGTH &&
    length <= MAX_HIGHLIGHT_SENTENCE_LENGTH &&
    !HIGHLIGHT_LINE_BREAK_PATTERN.test(sentence) &&
    MEANINGFUL_HIGHLIGHT_PATTERN.test(sentence) &&
    content.includes(sentence) &&
    !containsUnsafeHighlight(sentence) &&
    !overlapsUnsafeHighlight(sentence, content)
  );
}

function addHighlightCandidate(
  candidates: string[],
  seen: Set<string>,
  candidate: string,
  content: string,
): void {
  const trimmed = candidate.trim();
  if (
    !seen.has(trimmed) &&
    isUsableHighlightSentence(trimmed, content)
  ) {
    seen.add(trimmed);
    candidates.push(trimmed);
  }
}

function collectHighlightCandidates(content: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const line of content.split(/\r\n|\r|\n/u)) {
    if (line.trim() === "") continue;

    // Prefer a complete short sentence when one exists.
    for (const match of line.matchAll(HIGHLIGHT_SENTENCE_PATTERN)) {
      addHighlightCandidate(candidates, seen, match[0], content);
    }

    // Next prefer a phrase composed of complete whitespace-delimited words.
    const tokens = Array.from(line.matchAll(HIGHLIGHT_TOKEN_PATTERN));
    for (let start = 0; start < tokens.length; start += 1) {
      for (let end = start; end < tokens.length; end += 1) {
        const startIndex = tokens[start].index;
        const endIndex = tokens[end].index;
        if (startIndex === undefined || endIndex === undefined) continue;

        const phrase = line.slice(
          startIndex,
          endIndex + tokens[end][0].length,
        );
        if (getHighlightLength(phrase.trim()) > MAX_HIGHLIGHT_SENTENCE_LENGTH) {
          break;
        }
        addHighlightCandidate(candidates, seen, phrase, content);
      }
    }

    // Last resort for text without useful spacing: an exact 8-20 character
    // window. It still cannot cross a user-entered line break or include abuse.
    const boundaries = [0];
    let offset = 0;
    for (const character of line) {
      offset += character.length;
      boundaries.push(offset);
    }

    for (let start = 0; start < boundaries.length - 1; start += 1) {
      const remaining = boundaries.length - 1 - start;
      const longest = Math.min(MAX_HIGHLIGHT_SENTENCE_LENGTH, remaining);
      for (
        let length = longest;
        length >= MIN_HIGHLIGHT_SENTENCE_LENGTH;
        length -= 1
      ) {
        addHighlightCandidate(
          candidates,
          seen,
          line.slice(boundaries[start], boundaries[start + length]),
          content,
        );
      }
    }
  }

  return candidates;
}

function exactSafeHighlightAnchors(
  value: unknown,
  content: string,
): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(
      (item, index, items) =>
        item !== "" &&
        MEANINGFUL_HIGHLIGHT_PATTERN.test(item) &&
        content.includes(item) &&
        !containsUnsafeHighlight(item) &&
        !overlapsUnsafeHighlight(item, content) &&
        items.indexOf(item) === index,
    );
}

function resolveHighlightSentence(
  value: unknown,
  content: string,
  anchors: string[],
): string | null {
  const candidates = collectHighlightCandidates(content);

  if (typeof value === "string") {
    const candidate = value.trim();
    if (isUsableHighlightSentence(candidate, content)) return candidate;

    const withoutEnding = candidate
      .replace(HIGHLIGHT_SENTENCE_END_PATTERN, "")
      .trimEnd();
    if (isUsableHighlightSentence(withoutEnding, content)) return withoutEnding;

    // Recover an exact original substring when the model changed only spacing,
    // punctuation, case, or Unicode width.
    const compactCandidate = compactHighlightText(candidate);
    if (compactCandidate !== "" && !containsUnsafeHighlight(candidate)) {
      const restored = candidates.find(
        (item) => compactHighlightText(item) === compactCandidate,
      );
      if (restored !== undefined) return restored;
    }
  }

  // Prefer a safe phrase containing a model-selected highlight/star anchor.
  const anchored = candidates.find((candidate) =>
    anchors.some((anchor) => candidate.includes(anchor))
  );
  if (anchored !== undefined) return anchored;

  // A normal diary with at least eight safe characters gets a deterministic
  // underline even when the model returned null or malformed text.
  return candidates[0] ?? null;
}

function normalizeAnalysisResult(
  result: unknown,
  content: string,
): unknown {
  if (
    typeof result !== "object" ||
    result === null ||
    Array.isArray(result)
  ) {
    return result;
  }

  const record = result as Record<string, unknown>;
  const anchors = [
    ...exactSafeHighlightAnchors(record.highlight_words, content),
    ...exactSafeHighlightAnchors(record.star_words, content),
  ].filter((item, index, items) => items.indexOf(item) === index);

  return {
    ...record,
    highlight_sentence: resolveHighlightSentence(
      record.highlight_sentence ?? record.highlightSentence,
      content,
      anchors,
    ),
  };
}

async function analyze(
  input: unknown,
  apiKey: string,
  log: RequestLog,
): Promise<unknown> {
  if (typeof input !== "object" || input === null) {
    throw new FunctionError("invalid-input", 400);
  }
  const record = input as Record<string, unknown>;
  const content = requireString(record.content, "content");

  // Sizes only. The diary text is exactly the thing the consent notice promises
  // goes to the model and nowhere else.
  log.debug(
    `analyze input — content ${content.length}, photo ${
      typeof record.photoDataUrl === "string"
        ? `${Math.round(record.photoDataUrl.length / 1365)}KB`
        : "none"
    }`,
  );

  const userContent: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: `일기:\n${content}`,
    },
  ];
  if (typeof record.photoDataUrl === "string") {
    userContent.push({
      type: "image_url",
      image_url: { url: record.photoDataUrl, detail: "low" },
    });
  }

  const result = await requestAnalysis(apiKey, userContent, log);
  return normalizeAnalysisResult(result, content);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(",");
  const match = /^data:([^;]+);base64$/.exec(dataUrl.slice(0, comma));
  if (comma === -1 || !match) {
    throw new FunctionError("invalid-image", 400);
  }

  // atob throws a DOMException on malformed base64. Without this guard it would
  // escape as a generic api-error 500 and be classified as refundable, even
  // though a broken payload is the caller's fault and must not be refunded.
  let binary: string;
  try {
    binary = atob(dataUrl.slice(comma + 1));
  } catch {
    throw new FunctionError("invalid-image", 400);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1] });
}

async function sketch(
  photoDataUrl: unknown,
  apiKey: string,
  log: RequestLog,
): Promise<unknown> {
  const photo = requireString(photoDataUrl, "image");
  const quality = Deno.env.get("OPENAI_IMAGE_QUALITY") || "medium";
  if (!["low", "medium", "high"].includes(quality)) {
    throw new FunctionError("invalid-image-quality", 500);
  }

  const model = Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-1";
  log.debug(
    `sketch → ${model} quality=${quality}, photo ${Math.round(photo.length / 1365)}KB`,
  );

  const form = new FormData();
  form.append("model", model);
  form.append("image", dataUrlToBlob(photo), "photo.jpg");
  form.append("prompt", SKETCH_PROMPT);
  form.append("size", "auto");
  form.append("quality", quality);
  form.append("output_format", "jpeg");
  form.append("n", "1");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) throw await openAiError(response, log);
  const body = await response.json();
  const imageBase64 = body?.data?.[0]?.b64_json;
  if (typeof imageBase64 !== "string" || imageBase64 === "") {
    log.error("OpenAI returned an images/edits body with no b64_json");
    throw new FunctionError("invalid-response", 502);
  }
  log.debug(`sketch ok — image ${Math.round(imageBase64.length / 1365)}KB`);
  return { imageBase64 };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return responseJson({ code: "method-not-allowed" }, 405);
  }

  const log = new RequestLog();
  // Held outside the try so the catch can tell "nothing was consumed yet" from
  // "one request is charged and may need giving back".
  let reservation: Reservation | null = null;
  // Same reason: the catch names the action that failed, and a body that never
  // parsed still has to log something.
  let action = "(unparsed)";

  try {
    const body = await request.json();
    if (typeof body?.action === "string") {
      action = body.action;
    }

    // The country is on every request line on purpose: the region gate depends
    // on a header Supabase does not promise to forward, so this is how we find
    // out whether it arrives at all. The IP itself is never logged — it is
    // hashed before storage precisely so it does not sit around in the clear.
    const country = requestCountry(request);
    log.info(
      `${action} — country=${country ?? "none"}, client-id=${
        request.headers.get("x-diary-client-id") ? "present" : "none"
      }, bytes=${request.headers.get("content-length") ?? "?"}`,
    );

    // Routed before the OPENAI_API_KEY check on purpose: a missing key is a
    // server misconfiguration that must not break the usage counters, and
    // answering a status request with invalid-key would be actively misleading.
    if (body?.action === "quota-status") {
      if (QUOTA_TEST_MODE) {
        log.info("quota-status ok — test mode (not counted)");
        return responseJson({ quota: testModeSnapshot(request) });
      }
      enforceStatusLimit(
        requireString(request.headers.get("x-diary-client-id"), "client-id"),
      );
      const quota = await readQuota(request, log);
      log.debug(
        `quota-status ok — all ${quota.all.used}/${quota.all.limit}`,
      );
      return responseJson({ quota });
    }
    // Same placement rationale as quota-status: this only touches counters, so
    // a missing OPENAI_API_KEY must not stop a user from banking their reward.
    if (body?.action === "grant-ad-reward") {
      if (QUOTA_TEST_MODE) {
        log.info("grant-ad-reward ok — test mode (not counted)");
        return responseJson({ quota: testModeSnapshot(request) });
      }
      enforceStatusLimit(
        requireString(request.headers.get("x-diary-client-id"), "client-id"),
      );
      const quota = await grantAdReward(request, log);
      return responseJson({ quota });
    }
    if (isProgressAction(body?.action)) {
      const progress = await runProgressAction(request, body.action, log);
      log.info(`${action} ok`);
      return responseJson({ progress });
    }
    if (body?.action !== "inspect") {
      throw new FunctionError("invalid-action", 400);
    }
    const runSketch = body.runSketch === true;
    const runAnalyze = body.runAnalyze === true;
    if (!runSketch && !runAnalyze) {
      throw new FunctionError("invalid-input", 400);
    }

    // Before reserveQuota, so a refused caller consumes nothing and there is
    // nothing to refund. quota-status is deliberately left open above: it is
    // how the client finds out it is blocked, and it costs no money.
    if (!regionAllowed(country)) {
      throw new FunctionError("region-blocked", 403);
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) throw new FunctionError("invalid-key", 500);

    // Reserve before validating the payload: a junk request must still count
    // against the shared IP budget, or throwing garbage at this endpoint would
    // be a free way to probe it.
    const quota = QUOTA_TEST_MODE
      ? testModeSnapshot(request)
      : (reservation = await reserveQuota(
          request,
          runSketch,
          runAnalyze,
          log,
        )).snapshot;
    const [analysisResult, sketchResult] = await Promise.all([
      runAnalyze ? analyze(body.input, apiKey, log) : Promise.resolve(null),
      runSketch
        ? sketch(body.photoDataUrl, apiKey, log)
        : Promise.resolve(null),
    ]);
    const result = {
      ...(runAnalyze ? { analysis: analysisResult } : {}),
      ...(runSketch ? (sketchResult as Record<string, unknown>) : {}),
    };
    log.info(`${action} ok`);
    return responseJson(withQuota(result, quota));
  } catch (error) {
    // Classifying in one place covers every failure — including the ones that
    // are not FunctionErrors, like a bug in our own code — and lets the
    // corrected snapshot ride along on the error response.
    let quota =
      reservation?.snapshot ??
      (error instanceof QuotaError ? error.quota : undefined);
    // Whether the caller kept the charge is the question every quota complaint
    // turns into, so the outcome of that decision goes in the log line.
    let charge = reservation === null ? "" : ", charged";
    if (reservation !== null && shouldRefund(error)) {
      const refreshed = await refundQuota(reservation, log);
      charge = refreshed === null ? ", refund-failed" : ", refunded";
      quota = refreshed ?? quota;
    }

    if (error instanceof FunctionError) {
      log.error(`${action} failed — ${error.code} ${error.status}${charge}`);
      return responseJson(
        { code: error.code, ...(quota ? { quota } : {}) },
        error.status,
      );
    }
    // Not a FunctionError: our own bug, or something never classified. The
    // stack is the only thing that helps here, and it is too long for a line
    // every deployment pays for.
    log.error(
      `${action} crashed${charge} — ${
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      }`,
    );
    if (error instanceof Error && typeof error.stack === "string") {
      log.debug(error.stack.slice(0, 2000));
    }
    return responseJson(
      { code: "api-error", ...(quota ? { quota } : {}) },
      500,
    );
  }
});
