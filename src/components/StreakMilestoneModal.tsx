import { Modal } from "@toss/tds-mobile";

import {
  seasonalMilestoneMessage,
  type SeasonTheme,
} from "../constants/seasonTheme";
import type { DiaryMilestone } from "../services/diaryProgress";
import { DiaryButton } from "./DiaryButton";

export function StreakMilestoneModal({
  milestone,
  theme,
  onClose,
}: {
  milestone: DiaryMilestone;
  theme: SeasonTheme;
  onClose: () => void;
}) {
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <Modal.Overlay />
      <Modal.Content
        className="app-modal-panel streak-milestone-modal"
        aria-labelledby="streak-milestone-title"
        aria-describedby="streak-milestone-description"
      >
        <div className="app-modal-layout streak-milestone-layout">
          <div className="streak-milestone-body">
            <img
              className="streak-milestone-mascot"
              src="/mascot/stamp-friend-milestone.png"
              alt="기뻐하는 일기 도장 친구"
              draggable={false}
            />
            <span className="streak-milestone-kicker">
              {milestone.metric === "streak"
                ? `${milestone.threshold}일 연속 달성`
                : `누적 ${milestone.threshold}일 달성`}
            </span>
            <h2 id="streak-milestone-title" className="app-modal-title">
              {milestone.title}
            </h2>
            <p id="streak-milestone-description">
              {seasonalMilestoneMessage(
                theme,
                milestone.threshold,
                milestone.message,
              )}
            </p>
          </div>
          <div className="app-modal-footer streak-milestone-footer">
            <DiaryButton stable fullWidth onClick={onClose}>
              내 일기 보기
            </DiaryButton>
          </div>
        </div>
      </Modal.Content>
    </Modal>
  );
}
