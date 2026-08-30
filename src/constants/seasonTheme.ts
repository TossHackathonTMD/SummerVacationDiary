export type SeasonTheme = "summer" | "winter";

interface SeasonCopy {
  displayName: string;
  uploadTitle: string;
  selectPhoto: string;
  shareTitle: string;
  shareText: string;
  milestoneMessages: Partial<Record<number, string>>;
}

const COPY: Record<SeasonTheme, SeasonCopy> = {
  summer: {
    displayName: "나의 여름방학 일기",
    uploadTitle: "어떤 여름이었나요?",
    selectPhoto: "여름 사진을 선택하세요",
    shareTitle: "나의 여름방학 일기",
    shareText: "사진 한 장으로 나만의 여름방학 그림일기를 만들어 보세요!",
    milestoneMessages: {
      1: "오늘의 여름을 멋지게 남겼어요.",
      7: "한 주의 여름이 일기장에 담겼어요.",
    },
  },
  winter: {
    displayName: "나의 겨울방학 일기",
    uploadTitle: "어떤 겨울이었나요?",
    selectPhoto: "겨울 사진을 선택하세요",
    shareTitle: "나의 겨울방학 일기",
    shareText: "사진 한 장으로 나만의 겨울방학 그림일기를 만들어 보세요!",
    milestoneMessages: {
      1: "오늘의 겨울을 멋지게 남겼어요.",
      7: "한 주의 겨울이 일기장에 담겼어요.",
    },
  },
};

export function seasonCopy(theme: SeasonTheme): SeasonCopy {
  return COPY[theme];
}

export function seasonalMilestoneMessage(
  theme: SeasonTheme,
  threshold: number,
  fallback: string,
): string {
  return seasonCopy(theme).milestoneMessages[threshold] ?? fallback;
}
