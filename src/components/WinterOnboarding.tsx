import { SeasonThemeReset } from "./SeasonThemeReset";

const WINTER_DECORATIONS = [
  ["snowflake-large", "snowflake.png"],
  ["cloud-big", "cloud-big.png"],
  ["cloud-small", "cloud-small.png"],
  ["snowflake-one", "snowflake.png"],
  ["snowflake-two", "snowflake.png"],
  ["sled", "sled.png"],
  ["snowman", "snowman.png"],
  ["pine-tree", "pine-tree.png"],
  ["girl", "girl-and-cat.png"],
  ["snow-fort", "snow-fort.png"],
  ["mittens", "mittens.png"],
  ["penguin", "penguin.png"],
] as const;

const TITLE_CHARACTERS = [
  ["na", "나"],
  ["ui", "의"],
  ["gyeo", "겨"],
  ["ul", "울"],
  ["bang", "방"],
  ["hak", "학"],
  ["il", "일"],
  ["gi", "기"],
] as const;

export function WinterOnboarding({
  onStart,
  onReset,
}: {
  onStart: () => void;
  onReset: () => void;
}) {
  return (
    <main
      className="winter-onboarding"
      aria-label="나의 겨울방학 일기 시작 화면"
    >
      <div className="winter-onboarding-scene">
        {WINTER_DECORATIONS.map(([name, file]) => (
          <img
            key={name}
            className={`winter-onboarding-decoration winter-onboarding-${name}`}
            src={`/winter-theme/${file}`}
            alt=""
            aria-hidden="true"
            draggable={false}
          />
        ))}

        <img
          className="winter-onboarding-flight-team"
          src="/winter-theme/santa-rudolph-team-v2.png"
          alt=""
          aria-hidden="true"
          draggable={false}
        />

        <h1 className="winter-onboarding-title" aria-label="나의 겨울방학 일기">
          {TITLE_CHARACTERS.map(([name, character]) => (
            <span
              key={name}
              className={`winter-onboarding-title-character winter-onboarding-title-${name}`}
              aria-hidden="true"
            >
              {character}
            </span>
          ))}
        </h1>
      </div>

      <SeasonThemeReset onReset={onReset} />

      <div className="winter-onboarding-action-area">
        <button
          className="summer-diary-button summer-diary-button-primary summer-diary-button-onboarding"
          type="button"
          onClick={onStart}
        >
          시작하기
        </button>
      </div>
    </main>
  );
}
