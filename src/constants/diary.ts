// Central place for product rules from the planning doc (AI_weekly_picture_diary_2.md),
// so screens and validation never drift apart when a rule changes.

export const WEATHER_OPTIONS = [
  { value: "sunny", label: "맑음", iconUrl: "/weather/sunny.webp" },
  {
    value: "partly-cloudy",
    label: "구름 조금",
    iconUrl: "/weather/partly-cloudy.webp",
  },
  { value: "cloudy", label: "흐림", iconUrl: "/weather/cloudy.webp" },
  { value: "rainy", label: "비", iconUrl: "/weather/rainy.webp" },
  {
    value: "stormy",
    label: "천둥번개",
    iconUrl: "/weather/stormy.webp",
  },
  {
    value: "unknown",
    label: "모름",
    iconUrl: "/weather/unknown.webp",
  },
] as const;

export type WeatherValue = (typeof WEATHER_OPTIONS)[number]["value"];

export function weatherLabel(value: WeatherValue): string {
  return (
    WEATHER_OPTIONS.find((option) => option.value === value)?.label ??
    WEATHER_OPTIONS[0].label
  );
}

export function weatherIconUrl(value: WeatherValue): string {
  return (
    WEATHER_OPTIONS.find((option) => option.value === value)?.iconUrl ??
    WEATHER_OPTIONS[0].iconUrl
  );
}

/** "2026-07-15" → "2026년 7월 15일" — shared by the preview and the saved image. */
export function formatKoreanDate(date: string): string {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) {
    return date;
  }
  return `${year}년 ${month}월 ${day}일`;
}

// The actual handwritten font is narrower than its nominal 40px em box.
// The title region clips at the AI badge boundary as a final safety net.
export const TITLE_MAX_LENGTH = 15;
export const AI_CONTENT_WATERMARK = "AI 생성 콘텐츠";

// User credits refill one at a time, while IP/service cost guards still reset
// their daily windows. Keep their wording separate so neither promises the
// wrong recovery behavior.
export const AI_CREDIT_REFILL_NOTICE = "다음 기회는 아침 9시에 1개 충전돼요.";
export const AI_CREDIT_POLICY_NOTICE =
  "매일 아침 9시에 1개가 충전돼요. 최대 2개까지 보관할 수 있어요.";
export const DAILY_LIMIT_RESET_NOTICE =
  "내일 아침 9시부터 다시 이용할 수 있어요.";

// The writing date is always today. Keep the capacity dialog copy shared by
// the early writing-step check and the final save guard so an old
// selected-date message cannot reappear in only one of those paths.
export const TODAY_DIARY_FULL_TITLE = "오늘 일기가 가득 찼어요";

export function todayDiaryFullDescription(limit: number): string {
  return `하루에는 일기를 최대 ${limit}개까지 저장할 수 있어요. 오늘 새 일기를 쓰려면 기존 일기를 삭제해 주세요.`;
}

// The expandable frame supports 100 characters across ten 11-cell rows.
export { CONTENT_MAX_LENGTH } from "../utils/diaryFrameLayout";

// Upload rules from the spec: JPG/JPEG/PNG/WEBP, max 10MB, reject tiny images.
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_IMAGE_FILE_BYTES = 10 * 1024 * 1024;
export const MIN_IMAGE_DIMENSION_PX = 200;

// Versioned key so a future draft-shape change can just bump the suffix
// instead of writing migration code for old localStorage data.
// v2 clears the previously persisted test photo so the new bundled
// family-drawing placeholder is visible on first launch.
export const DRAFT_STORAGE_KEY = "summer-vacation-diary:draft:v2";
