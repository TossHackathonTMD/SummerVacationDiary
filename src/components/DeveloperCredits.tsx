import {
  Device,
  getOperationalEnvironment,
} from "@apps-in-toss/web-framework";
import { Modal, useToast } from "@toss/tds-mobile";
import { useState } from "react";

import { DiaryButton } from "./DiaryButton";

const TEAM_MEMBERS = [
  {
    name: "이도연",
    github: "LeeTheY",
    url: "https://github.com/LeeTheY",
    lead: true,
    badge: "PROJECT LEAD",
  },
  {
    name: "김준",
    github: "kimjun-dev",
    url: "https://github.com/kimjun-dev",
    badge: "PROJECT CREW",
  },
  {
    name: "김태훈",
    github: "asasds145",
    url: "https://github.com/asasds145",
    badge: "PROJECT CREW",
  },
  {
    name: "손제희",
    github: "jasonwpgml",
    url: "https://github.com/jasonwpgml",
    badge: "PROJECT CREW",
  },
  {
    name: "이돈민",
    github: "idonmin",
    url: "https://github.com/idonmin",
    badge: "PROJECT CREW",
  },
  {
    name: "이승찬",
    github: "stevechan970427",
    url: "https://github.com/stevechan970427",
    badge: "PROJECT CREW",
  },
] as const;

function isInsideTossApp(): boolean {
  try {
    const environment = getOperationalEnvironment();
    return environment === "toss" || environment === "sandbox";
  } catch {
    return false;
  }
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18a2.65 2.65 0 0 0-1.11-1.46c-.91-.62.07-.61.07-.61a2.1 2.1 0 0 1 1.53 1.03 2.13 2.13 0 0 0 2.91.83 2.13 2.13 0 0 1 .63-1.34c-2.22-.25-4.56-1.11-4.56-4.94a3.87 3.87 0 0 1 1.03-2.68 3.6 3.6 0 0 1 .1-2.64s.84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.3 2.75-1.02 2.75-1.02a3.6 3.6 0 0 1 .1 2.64 3.86 3.86 0 0 1 1.03 2.68c0 3.84-2.34 4.68-4.57 4.93a2.39 2.39 0 0 1 .68 1.86v2.75c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"
      />
    </svg>
  );
}

function HandDrawnTeamIcon() {
  return (
    <svg viewBox="0 0 32 25" aria-hidden="true">
      <path d="M11.3 11.2c-2.5-.2-4.2-2.1-4-4.6.2-2.4 2-4 4.4-3.8 2.5.2 4.1 2 3.9 4.4-.2 2.5-1.9 4.1-4.3 4Z" />
      <path d="M21.5 11.7c-2.4 0-4.1-1.7-4.1-4.1 0-2.3 1.7-4 4-4.1 2.4-.1 4.2 1.6 4.2 4 0 2.3-1.7 4.1-4.1 4.2Z" />
      <path d="M3.8 22.1c.6-5.2 3.4-8.1 7.5-8.1 3 0 5.2 1.5 6.6 4.3" />
      <path d="M14.9 21.8c.7-4.8 3-7.3 6.6-7.3 3.7 0 6.1 2.6 6.7 7.5" />
      <path className="developer-credits-team-icon-smile" d="m10.1 7.5 1.1.7 1.4-.8" />
    </svg>
  );
}

export function DeveloperCredits() {
  const [open, setOpen] = useState(false);
  const toast = useToast();

  const openGithubProfile = async (url: string) => {
    try {
      if (isInsideTossApp()) {
        await Device.openURL(url);
        return;
      }

      const opened = window.open(url, "_blank");
      if (opened === null) {
        throw new Error("Browser blocked the new tab");
      }
      opened.opener = null;
    } catch {
      toast.openToast(
        "GitHub 프로필을 열지 못했어요. 잠시 후 다시 시도해 주세요.",
      );
    }
  };

  return (
    <>
      <div className="developer-credits-entry">
        <button
          type="button"
          className="developer-credits-trigger"
          onClick={() => setOpen(true)}
        >
          <HandDrawnTeamIcon />
          <span>만든 사람들</span>
        </button>
      </div>

      <Modal open={open} onOpenChange={setOpen}>
        <Modal.Overlay />
        <Modal.Content
          className="app-modal-panel developer-credits-modal"
          aria-labelledby="developer-credits-title"
          aria-describedby="developer-credits-description"
        >
          <div className="app-modal-layout developer-credits-layout">
            <header className="developer-credits-header">
              <span className="developer-credits-kicker">OUR TEAM</span>
              <h2 id="developer-credits-title" className="app-modal-title">
                함께 만든 사람들
              </h2>
              <p id="developer-credits-description">
                기획과 디자인, 개발을 함께 고민하며 만든 여섯 명의 팀입니다.
              </p>
            </header>

            <ul className="developer-credits-list">
              {TEAM_MEMBERS.map((member) => (
                <li key={member.github}>
                  <button
                    type="button"
                    className="developer-credit-member"
                    aria-label={`${member.name} GitHub 프로필 열기`}
                    onClick={() => void openGithubProfile(member.url)}
                  >
                    <span className="developer-credit-member-copy">
                      <span className="developer-credit-name-row">
                        <strong>{member.name}</strong>
                        <span
                          className={`developer-credit-badge ${"lead" in member && member.lead ? "is-lead" : "is-crew"}`}
                        >
                          {member.badge}
                        </span>
                      </span>
                      <span className="developer-credit-github">
                        @{member.github}
                      </span>
                    </span>
                    <span className="developer-credit-link-icon">
                      <GithubMark />
                      <span aria-hidden="true">↗</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <footer className="app-modal-footer developer-credits-footer">
              <DiaryButton
                autoFocus
                tone="secondary"
                stable
                fullWidth
                onClick={() => setOpen(false)}
              >
                닫기
              </DiaryButton>
            </footer>
          </div>
        </Modal.Content>
      </Modal>
    </>
  );
}
