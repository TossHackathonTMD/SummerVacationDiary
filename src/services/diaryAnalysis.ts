import {
  AI_CREDIT_REFILL_NOTICE,
  DAILY_LIMIT_RESET_NOTICE,
} from "../constants/diary";
import { containsProfanity } from "../utils/profanity";
import {
  requestInspectionAnalysis,
  type DiaryInspectionContext,
} from "./diaryInspection";
import {
  EdgeFunctionError,
  isSupabaseConfigured,
  isKnownErrorCode,
  mapEdgeFunctionErrorCode,
} from "./supabaseEdge";

// ---------------------------------------------------------------------------
// Stage 2 (AI 분석) service layer.
//
// The UI only talks to `analyzeDiary()`. Behind it there are two providers:
//  - a Supabase Edge Function when the public Supabase config is set
//  - a deterministic local mock otherwise, so the whole flow can be built
//    and tested before any key exists
// The OpenAI key and model configuration live only in Supabase Secrets.
// ---------------------------------------------------------------------------

export interface DiaryAnalysisInput {
  photoDataUrl: string | null;
  content: string;
}

export type DiaryStamp = "great" | "effort";

export interface DiaryAnalysis {
  photoKeywords: string[];
  diaryKeywords: string[];
  emotions: string[];
  /** Verbatim substrings of the diary content, to be circled in the preview. */
  highlightWords: string[];
  /** One verbatim sentence of the diary content, underlined in the preview. */
  highlightSentence: string | null;
  /** Verbatim diary expressions praised with a star in the preview. */
  starWords: string[];
  /** The teacher-style one-line comment. */
  comment: string;
  /** The stamp displayed on the completed diary. */
  stamp: DiaryStamp;
}

export type AnalysisErrorCode =
  | "timeout"
  | "network"
  | "invalid-key"
  | "rate-limited"
  | "region-blocked"
  | "ip-burst-limit-exceeded"
  | "ip-daily-limit-exceeded"
  | "service-daily-limit-exceeded"
  | "daily-limit-exceeded"
  | "api-error"
  | "invalid-response";

export const ANALYSIS_ERROR_MESSAGES: Record<AnalysisErrorCode, string> = {
  timeout: "분석이 너무 오래 걸려요. 잠시 후 다시 시도해 주세요.",
  network: "네트워크 연결을 확인하고 다시 시도해 주세요.",
  "invalid-key": "AI 연결 설정을 확인해 주세요.",
  "rate-limited": "지금은 요청이 많아요. 잠시 후 다시 시도해 주세요.",
  "region-blocked": "해외에서는 선생님이 일기를 검사해 줄 수 없어요.",
  "ip-burst-limit-exceeded":
    "잠깐 사이에 요청이 너무 많았어요. 잠시 후 다시 시도해 주세요.",
  "ip-daily-limit-exceeded": `같은 인터넷에서 오늘 이용할 수 있는 횟수를 모두 사용했어요.\n${DAILY_LIMIT_RESET_NOTICE}`,
  "service-daily-limit-exceeded": `오늘은 많은 친구들이 이용했어요.\n${DAILY_LIMIT_RESET_NOTICE}`,
  "daily-limit-exceeded": `AI 검사 기회를 모두 사용했어요.\n${AI_CREDIT_REFILL_NOTICE}`,
  "api-error": "분석 서비스에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.",
  "invalid-response": "분석 결과를 읽지 못했어요. 다시 시도해 주세요.",
};

// Retrying these can never succeed immediately: the user's next credit has not
// arrived, a daily safety window is exhausted, or the country is refused.
const NON_RETRYABLE_ANALYSIS_CODES: readonly AnalysisErrorCode[] = [
  "region-blocked",
  "ip-daily-limit-exceeded",
  "service-daily-limit-exceeded",
  "daily-limit-exceeded",
];

export class AnalysisError extends Error {
  constructor(public readonly code: AnalysisErrorCode) {
    super(code);
    this.name = "AnalysisError";
  }
}

export function analysisErrorCode(error: unknown): AnalysisErrorCode {
  return error instanceof AnalysisError ? error.code : "api-error";
}

export function analysisErrorMessage(error: unknown): string {
  return ANALYSIS_ERROR_MESSAGES[analysisErrorCode(error)];
}

export function isAnalysisErrorRetryable(error: unknown): boolean {
  return !NON_RETRYABLE_ANALYSIS_CODES.includes(analysisErrorCode(error));
}

function isAnalysisErrorCode(
  value: string | undefined,
): value is AnalysisErrorCode {
  return isKnownErrorCode(ANALYSIS_ERROR_MESSAGES, value);
}

// Analysis remains available in test mode. Only the costly image-generation
// operation is bypassed there.
export const isAiConnected = isSupabaseConfigured;

/**
 * Analyzes the photo + diary text and returns keywords, emotions, highlight
 * targets and the one-line comment (개발 단계 2단계).
 */
export function analyzeDiary(
  input: DiaryAnalysisInput,
  inspection?: DiaryInspectionContext,
): Promise<DiaryAnalysis> {
  return isAiConnected
    ? analyzeWithEdgeFunction(input, inspection)
    : analyzeWithMock(input);
}

// --- Supabase Edge Function provider ---------------------------------------

function toStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is string => typeof item === "string" && item.trim() !== "",
    )
    .map((item) => item.trim())
    .slice(0, max);
}

function toDiaryStamp(value: unknown): DiaryStamp {
  return value === "effort" ? "effort" : "great";
}

function capComment(comment: string): string {
  const characters = Array.from(comment);
  if (characters.length <= 40) {
    return comment;
  }
  return `${characters.slice(0, 39).join("").trimEnd()}…`;
}

const GENERIC_HIGHLIGHT_WORDS = new Set([
  "너무",
  "많이",
  "정말",
  "진짜",
  "아주",
  "매우",
  "완전",
  "되게",
  "엄청",
  "굉장히",
  "조금",
  "좀",
  "더",
  "가장",
  "제일",
  "계속",
]);

function isSpecificHighlightWord(word: string): boolean {
  return !GENERIC_HIGHLIGHT_WORDS.has(word.trim());
}

// The model's JSON is untrusted input: every field is validated, and highlight
// targets that are not verbatim substrings of the diary are dropped so the
// preview never marks text that isn't there.
function parseAnalysis(parsed: unknown, content: string): DiaryAnalysis {
  if (typeof parsed !== "object" || parsed === null) {
    throw new AnalysisError("invalid-response");
  }
  const record = parsed as Record<string, unknown>;

  const comment =
    typeof record.comment === "string" ? record.comment.trim() : "";
  if (comment === "") {
    // The comment is the one field the user actually reads — without it the
    // response is useless, so treat it as a failure (spec: 한마디 생성 실패).
    throw new AnalysisError("invalid-response");
  }

  // Verbatim-filter BEFORE capping at 4: if the model pads the list with
  // paraphrased words, slicing first could throw away the valid ones.
  const highlightWords = toStringArray(record.highlight_words, 8)
    .filter(
      (word) =>
        content.includes(word) &&
        !containsProfanity(word) &&
        isSpecificHighlightWord(word),
    )
    .slice(0, 4);
  const starWords = toStringArray(record.star_words, 4)
    .filter((word) => content.includes(word) && !containsProfanity(word))
    .slice(0, 2);
  const sentence =
    typeof record.highlight_sentence === "string"
      ? record.highlight_sentence.trim()
      : "";
  // Length cap: underlining a huge "sentence" would decorate most of the
  // diary, against the spec's 첨삭 원칙 (지나치게 많이 사용하지 않음).
  const sentenceIsUsable =
    sentence !== "" &&
    sentence.length <= 100 &&
    content.includes(sentence) &&
    !containsProfanity(sentence);

  return {
    photoKeywords: toStringArray(record.photo_keywords, 3),
    diaryKeywords: toStringArray(record.diary_keywords, 4).filter(
      (keyword) => !containsProfanity(keyword),
    ),
    emotions: toStringArray(record.emotions, 3),
    highlightWords,
    highlightSentence: sentenceIsUsable ? sentence : null,
    starWords,
    comment: capComment(comment),
    stamp: toDiaryStamp(record.stamp),
  };
}

async function analyzeWithEdgeFunction(
  input: DiaryAnalysisInput,
  inspection?: DiaryInspectionContext,
): Promise<DiaryAnalysis> {
  try {
    if (inspection === undefined) {
      throw new AnalysisError("invalid-response");
    }
    const body = await requestInspectionAnalysis(inspection, input);
    return parseAnalysis(body, input.content);
  } catch (error) {
    if (error instanceof AnalysisError) {
      throw error;
    }
    if (error instanceof EdgeFunctionError) {
      throw new AnalysisError(
        mapEdgeFunctionErrorCode(error, isAnalysisErrorCode),
      );
    }
    throw new AnalysisError("api-error");
  }
}

// --- Mock provider ----------------------------------------------------------
// Deterministic on purpose: the same diary always produces the same result,
// which makes the preview UI stable to build against and easy to eyeball.

const MOCK_DELAY_MS = 1200;

// The three example comments from the planning doc, so the mock output looks
// like what the real model is asked to produce.
const MOCK_COMMENTS = [
  "시원한 바다와 함께한 여유로운 하루가 글에 잘 담겨 있네요.",
  "친구들과 보낸 즐거운 여름의 순간이 오래 기억에 남을 것 같아요.",
  "파도 소리와 편안했던 마음이 함께 전해지는 기록이에요.",
];

const MOCK_EMOTION_RULES: Array<{ pattern: RegExp; emotion: string }> = [
  { pattern: /즐거|즐겁|재밌|재미|신나/, emotion: "즐거움" },
  { pattern: /편안|여유|힐링/, emotion: "편안함" },
  { pattern: /행복|좋았|좋아/, emotion: "행복" },
  { pattern: /시원|바다|계곡|수영/, emotion: "시원함" },
  { pattern: /설레|기대/, emotion: "설렘" },
];

// Naive tokenizer: split on whitespace, strip edge punctuation, keep 2-8 char
// words. Longest-first is arbitrary but deterministic — good enough for a
// stand-in until the real model picks meaningful words.
function extractCandidateWords(content: string): string[] {
  const seen = new Set<string>();
  for (const token of content.split(/\s+/)) {
    const word = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (word.length >= 2 && word.length <= 8) {
      seen.add(word);
    }
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

// Pieces produced by split() are contiguous substrings of the content, and
// trimming only removes edge whitespace — so the pick stays verbatim, which
// the highlight renderer requires.
function pickHighlightSentence(content: string): string | null {
  const pieces = content
    .split(/[.!?…\n]+/)
    .map((piece) => piece.trim())
    // 10-80 chars: long enough to be a sentence, short enough that the
    // underline stays an accent instead of covering the whole diary.
    .filter((piece) => piece.length >= 10 && piece.length <= 80);
  if (pieces.length === 0) {
    return null;
  }
  return pieces.reduce((longest, piece) =>
    piece.length > longest.length ? piece : longest,
  );
}

function mockStamp(content: string): DiaryStamp {
  const normalized = content.replace(/\s/g, "");

  if (normalized.length < 3) {
    return "effort";
  }

  const uniqueCharacters = new Set(Array.from(normalized));

  if (normalized.length >= 6 && uniqueCharacters.size <= 2) {
    return "effort";
  }

  return "great";
}

async function analyzeWithMock(
  input: DiaryAnalysisInput,
): Promise<DiaryAnalysis> {
  // Simulated latency so the loading UI is actually exercised in dev.
  await new Promise((resolve) => setTimeout(resolve, MOCK_DELAY_MS));

  const words = extractCandidateWords(input.content).filter(
    (word) => !containsProfanity(word),
  );
  const highlightSentence = pickHighlightSentence(input.content);
  const emotions = MOCK_EMOTION_RULES.filter((rule) =>
    rule.pattern.test(input.content),
  )
    .map((rule) => rule.emotion)
    .slice(0, 3);

  return {
    // No client-side vision here — fixed summer-themed placeholders.
    photoKeywords: ["여름", "추억"],
    diaryKeywords: words.slice(0, 4),
    emotions: emotions.length > 0 ? emotions : ["행복", "여유"],
    highlightWords: words.filter(isSpecificHighlightWord).slice(0, 3),
    highlightSentence:
      highlightSentence !== null && !containsProfanity(highlightSentence)
        ? highlightSentence
        : null,
    starWords: words.slice(0, 2),
    comment: MOCK_COMMENTS[input.content.length % MOCK_COMMENTS.length],
    stamp: mockStamp(input.content),
  };
}
