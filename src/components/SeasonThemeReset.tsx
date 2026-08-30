export function SeasonThemeReset({ onReset }: { onReset: () => void }) {
  return (
    <button type="button" className="season-theme-reset" onClick={onReset}>
      여름으로 돌아가기
    </button>
  );
}
