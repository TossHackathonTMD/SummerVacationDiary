import { useCallback, useEffect, useState } from "react";

import { seasonCopy, type SeasonTheme } from "../constants/seasonTheme";

const SEASON_THEME_STORAGE_KEY = "summer-vacation-diary:season-theme:v1";

function readStoredTheme(): SeasonTheme {
  try {
    return localStorage.getItem(SEASON_THEME_STORAGE_KEY) === "winter"
      ? "winter"
      : "summer";
  } catch {
    return "summer";
  }
}

export function useSeasonTheme() {
  const [theme, setTheme] = useState<SeasonTheme>(readStoredTheme);

  const activateWinter = useCallback(() => {
    setTheme("winter");
    try {
      localStorage.setItem(SEASON_THEME_STORAGE_KEY, "winter");
    } catch {
      // The visual switch still works for this execution when storage is full
      // or unavailable.
    }
  }, []);

  const returnToSummer = useCallback(() => {
    setTheme("summer");
    try {
      localStorage.removeItem(SEASON_THEME_STORAGE_KEY);
    } catch {
      // Keep the current in-memory theme even if persistence is unavailable.
    }
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.seasonTheme = theme;
    document.title = seasonCopy(theme).displayName;

    return () => {
      delete root.dataset.seasonTheme;
    };
  }, [theme]);

  return { theme, activateWinter, returnToSummer };
}
