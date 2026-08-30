import { Modal } from "@toss/tds-mobile";
import { useRef, useState } from "react";

import type { SeasonTheme } from "../constants/seasonTheme";
import { DiaryExportError, exportDiaryImage } from "../services/diaryExport";
import { DiaryShareError, shareDiaryAppLink } from "../services/diaryShare";
import { DiaryButton } from "./DiaryButton";

interface DiaryShareModalProps {
  open: boolean;
  theme: SeasonTheme;
  imageDataUrl: string;
  fileName: string;
  onClose: () => void;
}

type ShareAction = "save" | "share";

type ActionFeedback = {
  message: string;
};

export function DiaryShareModal({
  open,
  theme,
  imageDataUrl,
  fileName,
  onClose,
}: DiaryShareModalProps) {
  const [busyAction, setBusyAction] = useState<ShareAction | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const completionTitleRef = useRef<HTMLHeadingElement>(null);

  const run = async (action: ShareAction) => {
    if (busyAction !== null) {
      return;
    }

    setFeedback(null);
    setBusyAction(action);

    try {
      if (action === "save") {
        await exportDiaryImage(imageDataUrl, fileName);
      } else {
        await shareDiaryAppLink(theme);
      }
    } catch (error) {
      const message =
        error instanceof DiaryShareError || error instanceof DiaryExportError
          ? error.userMessage
          : "요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.";

      setFeedback({ message });
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <Modal open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <Modal.Overlay />

      <Modal.Content
        className="app-modal-panel diary-share-modal-panel"
        aria-labelledby="diary-completion-title"
        aria-describedby="diary-completion-description"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          completionTitleRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="app-modal-layout diary-share-layout">
          <div className="diary-share-body">
            <div className="diary-share-summary">
              <h2
                ref={completionTitleRef}
                id="diary-completion-title"
                className="app-modal-title diary-share-summary-title"
                tabIndex={-1}
              >
                저장 및 공유
              </h2>

              <p
                id="diary-completion-description"
                className="diary-share-description"
              >
                이미지를 기기에 저장하거나 앱 링크를 공유할 수 있어요.
              </p>
            </div>

            <p className="diary-share-note">
              이미지 저장 시 기기의 저장 화면이 열릴 수 있어요.
            </p>
          </div>

          <div className="app-modal-footer diary-share-footer">
            <div className="diary-share-primary-actions">
              <DiaryButton
                tone="neutral"
                stable
                fullWidth
                disabled={busyAction !== null && busyAction !== "share"}
                aria-busy={busyAction === "share"}
                onClick={() => void run("share")}
              >
                앱 공유하기
              </DiaryButton>

              <DiaryButton
                stable
                fullWidth
                disabled={busyAction !== null}
                aria-busy={busyAction === "save"}
                onClick={() => void run("save")}
              >
                이미지 저장하기
              </DiaryButton>
            </div>

            <DiaryButton
              tone="secondary"
              stable
              fullWidth
              disabled={busyAction !== null}
              onClick={onClose}
            >
              창 닫기
            </DiaryButton>

            {feedback !== null && (
              <p
                className="diary-share-feedback diary-share-feedback-error"
                role="alert"
              >
                {feedback.message}
              </p>
            )}
          </div>
        </div>
      </Modal.Content>
    </Modal>
  );
}
