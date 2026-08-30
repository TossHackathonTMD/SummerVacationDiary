import { useToast } from "@toss/tds-mobile";
import { useEffect, useRef } from "react";

const UNLOCK_TAP_COUNT = 5;
const UNLOCK_RESET_MS = 2_000;

export function SeasonThemeUnlock({ onUnlock }: { onUnlock: () => void }) {
  const toast = useToast();
  const tapCountRef = useRef(0);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    [],
  );

  const registerTap = () => {
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }

    const nextCount = tapCountRef.current + 1;
    if (nextCount >= UNLOCK_TAP_COUNT) {
      tapCountRef.current = 0;
      resetTimerRef.current = null;
      onUnlock();
      toast.openToast("겨울방학 테마가 열렸어요.");
      return;
    }

    tapCountRef.current = nextCount;
    if (nextCount >= 2) {
      toast.openToast(
        `겨울방학까지 ${UNLOCK_TAP_COUNT - nextCount}번 남았어요.`,
      );
    }

    resetTimerRef.current = window.setTimeout(() => {
      tapCountRef.current = 0;
      resetTimerRef.current = null;
    }, UNLOCK_RESET_MS);
  };

  return (
    <button type="button" className="season-theme-unlock" onClick={registerTap}>
      여름
    </button>
  );
}
