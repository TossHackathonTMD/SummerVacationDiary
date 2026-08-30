/**
 * Keeps finished diaries on the device so a later screen can list and reopen
 * them. This is the archive, not the draft.
 *
 * Why it throws where `useDiaryDraft` stays quiet: the draft is a mirror of
 * what is still on screen, so a failed write costs nothing the user cannot
 * retype. An archived diary is the only remaining copy of something the user
 * already finished, so a silent failure would look exactly like a successful
 * save until the diary is missing. Every write failure surfaces here.
 *
 * Why the Toss `Storage` bridge instead of localStorage: web storage inside the
 * WebView is scoped to the mini-app URL and can be evicted by the OS, and the
 * QR-test and release builds do not even share an origin. The native store is
 * the durable one. localStorage stays as the fallback so `npm run dev:web`
 * works in a plain browser.
 *
 * Layout — one index plus one key per diary:
 *
 *   summer-vacation-diary:diary-index:v1     DiarySummary[]  (no images)
 *   summer-vacation-diary:diary:v1:<id>      DiaryRecord     (~0.5 MB each)
 *
 * Listing therefore never loads image bytes, and saving never rewrites the
 * diaries already stored. The cost is two writes per save, so the invariant is:
 * the index may briefly point at an entry that is gone (a save interrupted
 * between its two writes), and `getDiary` heals that on the only read that can
 * observe it. The opposite — an entry with no index reference — is invisible
 * and accepted; the bridge exposes no way to enumerate keys and sweep them.
 *
 * Schema changes bump the `v1` in both keys rather than migrating, matching
 * DRAFT_STORAGE_KEY in constants/diary.ts.
 */

import {
  getOperationalEnvironment,
  Storage,
} from "@apps-in-toss/web-framework";
import {
  CONTENT_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  WEATHER_OPTIONS,
} from "../constants/diary";
import type { WeatherValue } from "../constants/diary";

const INDEX_STORAGE_KEY = "summer-vacation-diary:diary-index:v1";
const ENTRY_STORAGE_KEY_PREFIX = "summer-vacation-diary:diary:v1:";
export const MAX_DIARIES_PER_DATE = 2;

function entryStorageKey(id: string): string {
  return `${ENTRY_STORAGE_KEY_PREFIX}${id}`;
}

/** What a list screen needs. Deliberately excludes the image. */
export interface DiarySummary {
  id: string;
  /**
   * Identifies one logical draft across edits. Optional only so records saved
   * before this field existed remain readable.
   */
  draftId?: string;
  /** Hash of the AI input revision: original photo + diary body. */
  revisionKey?: string;
  /** The day the diary was written, local YYYY-MM-DD — as in the draft. */
  date: string;
  /** ISO 8601 instant of the save itself; formatting it is the screen's job. */
  savedAt: string;
  title: string;
  weather: WeatherValue;
}

export interface DiaryRecord extends DiarySummary {
  content: string;
  /** Completed 1080x1350 JPEG data URL from composeDiaryImage(). */
  imageDataUrl: string;
  includesAiGeneratedContent: boolean;
}

export type SaveDiaryInput = Omit<
  DiaryRecord,
  "id" | "savedAt" | "draftId" | "revisionKey"
> & {
  draftId: string;
  revisionKey: string;
};

export interface SaveDiaryResult {
  record: DiaryRecord;
  diariesOnDate: number;
  limit: number;
}

export interface DiaryDateCapacity {
  diariesOnDate: number;
  limit: number;
  isFull: boolean;
}

export type DiaryStoreErrorCode =
  "storage-full" | "read-failed" | "daily-limit";

export class DiaryStoreError extends Error {
  constructor(
    public readonly code: DiaryStoreErrorCode,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "DiaryStoreError";
  }
}

function storageFullError(): DiaryStoreError {
  return new DiaryStoreError(
    "storage-full",
    "일기를 저장하지 못했어요. 기기 저장 공간을 확인한 뒤 다시 시도해 주세요.",
  );
}

function readFailedError(): DiaryStoreError {
  return new DiaryStoreError(
    "read-failed",
    "저장된 일기를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.",
  );
}

function dailyLimitError(): DiaryStoreError {
  return new DiaryStoreError(
    "daily-limit",
    `하루에는 일기를 최대 ${MAX_DIARIES_PER_DATE}개까지 저장할 수 있어요.`,
  );
}

interface KeyValueBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function isInsideTossApp(): boolean {
  try {
    const environment = getOperationalEnvironment();
    return environment === "toss" || environment === "sandbox";
  } catch {
    return false;
  }
}

const tossBackend: KeyValueBackend = {
  getItem: (key) => Storage.getItem(key),
  setItem: (key, value) => Storage.setItem(key, value),
  removeItem: (key) => Storage.removeItem(key),
};

// localStorage is synchronous, so these wrappers exist only to give both
// backends one shape. A thrown QuotaExceededError becomes a rejection.
const browserBackend: KeyValueBackend = {
  getItem: async (key) => localStorage.getItem(key),
  setItem: async (key, value) => localStorage.setItem(key, value),
  removeItem: async (key) => localStorage.removeItem(key),
};

// The environment cannot change mid-session, and one operation makes several
// backend calls, so the guard runs once instead of per call.
let backend: KeyValueBackend | null = null;

function getBackend(): KeyValueBackend {
  backend ??= isInsideTossApp() ? tossBackend : browserBackend;
  return backend;
}

// Every operation reads the index, changes it, then writes it back. With an
// async backend two overlapping calls could interleave and drop an entry, which
// the existing synchronous localStorage services never had to worry about.
// Serializing the whole module is cheap here: the app never issues these
// concurrently on purpose, so the queue is almost always empty.
let queue: Promise<unknown> = Promise.resolve();

function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const WEATHER_VALUES = WEATHER_OPTIONS.map((option) => option.value);
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isWeatherValue(value: unknown): value is WeatherValue {
  return WEATHER_VALUES.some((weather) => weather === value);
}

// Anything that fails these checks is treated as absent rather than repaired.
// A half-valid diary cannot be rendered, and guessing at the missing half would
// put words in the user's diary that they never wrote.
function isSummary(value: unknown): value is DiarySummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { id, draftId, revisionKey, date, savedAt, title, weather } =
    value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    id !== "" &&
    (draftId === undefined ||
      (typeof draftId === "string" && draftId !== "")) &&
    (revisionKey === undefined ||
      (typeof revisionKey === "string" && revisionKey !== "")) &&
    typeof date === "string" &&
    DATE_PATTERN.test(date) &&
    typeof savedAt === "string" &&
    !Number.isNaN(Date.parse(savedAt)) &&
    typeof title === "string" &&
    isWeatherValue(weather)
  );
}

function isRecord(value: unknown): value is DiaryRecord {
  if (!isSummary(value)) {
    return false;
  }
  const { content, imageDataUrl, includesAiGeneratedContent } =
    value as unknown as Record<string, unknown>;
  return (
    typeof content === "string" &&
    typeof imageDataUrl === "string" &&
    imageDataUrl.startsWith("data:image/") &&
    typeof includesAiGeneratedContent === "boolean"
  );
}

function toSummary(record: DiaryRecord): DiarySummary {
  return {
    id: record.id,
    ...(record.draftId === undefined ? {} : { draftId: record.draftId }),
    ...(record.revisionKey === undefined
      ? {}
      : { revisionKey: record.revisionKey }),
    date: record.date,
    savedAt: record.savedAt,
    title: record.title,
    weather: record.weather,
  };
}

/**
 * A corrupt index resolves to an empty list instead of an error: throwing would
 * make every future save fail too, which turns one damaged key into a store
 * that can never be used again. A backend rejection is different — the data may
 * be perfectly fine — so it propagates to the caller.
 */
async function readIndex(): Promise<DiarySummary[]> {
  const raw = await getBackend().getItem(INDEX_STORAGE_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isSummary) : [];
  } catch {
    return [];
  }
}

async function writeIndex(index: DiarySummary[]): Promise<void> {
  await getBackend().setItem(INDEX_STORAGE_KEY, JSON.stringify(index));
}

/** Drops a dangling reference. Never rewrites diary content, only forgets it. */
async function healIndex(id: string): Promise<void> {
  try {
    const index = await readIndex();
    if (index.some((summary) => summary.id === id)) {
      await writeIndex(index.filter((summary) => summary.id !== id));
    }
  } catch {
    // The read still succeeds; the stale reference just survives to next time.
  }
}

// Same pattern as createClientId() in supabaseEdge.ts, copied rather than
// imported so this module stays free of the Supabase config it would drag in.
function createDiaryId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/** Counts code points, matching how the draft and the frame layout count. */
function clamp(text: string, maxLength: number): string {
  return Array.from(text).slice(0, maxLength).join("");
}

/**
 * Stores one finished diary and returns it with the target date's saved count.
 *
 * The entry is written before the index on purpose. If the second write fails
 * the leftover is an entry nothing references — invisible to every screen. The
 * other order would leave a diary in the list that can never be opened.
 */
export function saveDiary(input: SaveDiaryInput): Promise<SaveDiaryResult> {
  return withLock(async () => {
    let index: DiarySummary[];
    try {
      index = await readIndex();
    } catch {
      throw readFailedError();
    }

    const normalizedTitle = clamp(input.title, TITLE_MAX_LENGTH);
    const normalizedContent = clamp(input.content, CONTENT_MAX_LENGTH);
    // A revision follows the exact AI input: original photo + diary body.
    // Title and weather edits update that revision; changing either AI input
    // creates a new record even inside the same draft.
    const replacedIds = new Set(
      index
        .filter(
          (summary) =>
            summary.draftId === input.draftId &&
            summary.revisionKey === input.revisionKey,
        )
        .map((summary) => summary.id),
    );
    let diariesOnDate = 0;
    for (const summary of index) {
      if (replacedIds.has(summary.id)) {
        continue;
      }
      const isTargetDate = summary.date === input.date;
      if (!isTargetDate) {
        continue;
      }

      let raw: string | null;
      try {
        raw = await getBackend().getItem(entryStorageKey(summary.id));
      } catch {
        throw readFailedError();
      }
      let existing: unknown = null;
      try {
        existing = raw === null ? null : JSON.parse(raw);
      } catch {
        // Corrupt entries are absent and do not consume the daily limit.
      }

      if (!isRecord(existing)) {
        continue;
      }
      // Migrate an exact same-date record saved by the older schema into the
      // draft-ID model rather than leaving one legacy duplicate behind.
      if (existing.imageDataUrl === input.imageDataUrl) {
        replacedIds.add(summary.id);
        continue;
      }
      diariesOnDate += 1;
    }

    if (diariesOnDate >= MAX_DIARIES_PER_DATE) {
      throw dailyLimitError();
    }

    const record: DiaryRecord = {
      id: createDiaryId(),
      draftId: input.draftId,
      revisionKey: input.revisionKey,
      date: input.date,
      savedAt: new Date().toISOString(),
      title: normalizedTitle,
      content: normalizedContent,
      weather: input.weather,
      imageDataUrl: input.imageDataUrl,
      includesAiGeneratedContent: input.includesAiGeneratedContent,
    };

    try {
      await getBackend().setItem(
        entryStorageKey(record.id),
        JSON.stringify(record),
      );
    } catch {
      // Nothing was written, so there is nothing to undo.
      throw storageFullError();
    }

    try {
      await writeIndex([
        ...index.filter((summary) => !replacedIds.has(summary.id)),
        toSummary(record),
      ]);
    } catch {
      try {
        await getBackend().removeItem(entryStorageKey(record.id));
      } catch {
        // Leaves an orphan entry. It costs space but shows up nowhere.
      }
      throw storageFullError();
    }

    // The index swap above is the visible commit. Old entry cleanup is best
    // effort: a failure leaves only unreachable bytes, never duplicate dates.
    for (const replacedId of replacedIds) {
      try {
        await getBackend().removeItem(entryStorageKey(replacedId));
      } catch {
        // The old record is already absent from the index.
      }
    }

    return {
      record,
      diariesOnDate: diariesOnDate + 1,
      limit: MAX_DIARIES_PER_DATE,
    };
  });
}

/**
 * Newest first, by diary date and then by save time. Both fields are
 * fixed-width formats, so comparing them as strings is the same as comparing
 * them as dates and avoids parsing every row.
 *
 * Sorting happens here rather than at write time so that saving stays a plain
 * append with no ordering to keep intact.
 */
export function listDiaries(): Promise<DiarySummary[]> {
  return withLock(async () => {
    let index: DiarySummary[];
    try {
      index = await readIndex();
    } catch {
      throw readFailedError();
    }

    return [...index].sort((left, right) => {
      if (left.date !== right.date) {
        return left.date < right.date ? 1 : -1;
      }
      if (left.savedAt !== right.savedAt) {
        return left.savedAt < right.savedAt ? 1 : -1;
      }
      return 0;
    });
  });
}

/**
 * Checks whether a date can accept another diary without loading image bytes
 * for unrelated dates. Every stored record counts: the caller asks before its
 * own diary is saved, so none of the records found here is that diary.
 */
export function getDiaryDateCapacity(date: string): Promise<DiaryDateCapacity> {
  return withLock(async () => {
    let index: DiarySummary[];
    try {
      index = await readIndex();
    } catch {
      throw readFailedError();
    }

    let diariesOnDate = 0;
    for (const summary of index) {
      if (summary.date !== date) {
        continue;
      }

      let raw: string | null;
      try {
        raw = await getBackend().getItem(entryStorageKey(summary.id));
      } catch {
        throw readFailedError();
      }

      let existing: unknown = null;
      try {
        existing = raw === null ? null : JSON.parse(raw);
      } catch {
        // Corrupt entries are absent and do not consume a date slot.
      }
      if (isRecord(existing)) {
        diariesOnDate += 1;
      }
    }

    return {
      diariesOnDate,
      limit: MAX_DIARIES_PER_DATE,
      isFull: diariesOnDate >= MAX_DIARIES_PER_DATE,
    };
  });
}

/**
 * Returns null when the diary is missing or unreadable, and takes the stale
 * index reference with it. This is the only read that touches an entry, so it
 * is the only place a broken reference can be noticed.
 */
export function getDiary(id: string): Promise<DiaryRecord | null> {
  return withLock(async () => {
    let raw: string | null;
    try {
      raw = await getBackend().getItem(entryStorageKey(id));
    } catch {
      throw readFailedError();
    }

    if (raw === null) {
      await healIndex(id);
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (!isRecord(parsed)) {
      try {
        await getBackend().removeItem(entryStorageKey(id));
      } catch {
        // Unreadable either way; the reference below is what matters.
      }
      await healIndex(id);
      return null;
    }

    return parsed;
  });
}

/**
 * Removes the index reference first: once that write lands the diary is gone
 * from every screen, so failing the call over the entry cleanup that follows
 * would report a failure the user cannot see. Deleting an unknown id still
 * sweeps its entry key, which is how an orphan from an interrupted save is
 * eventually cleaned up.
 */
export function deleteDiary(id: string): Promise<void> {
  return withLock(async () => {
    try {
      const index = await readIndex();
      if (index.some((summary) => summary.id === id)) {
        await writeIndex(index.filter((summary) => summary.id !== id));
      }
    } catch {
      throw storageFullError();
    }

    try {
      await getBackend().removeItem(entryStorageKey(id));
    } catch {
      // Already invisible to the user; the leftover bytes are the only cost.
    }
  });
}
