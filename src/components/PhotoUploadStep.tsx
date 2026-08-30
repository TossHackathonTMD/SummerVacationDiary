import {
  Checkbox,
  Modal,
  Paragraph,
  useDialog,
  useToast,
} from "@toss/tds-mobile";
import { colors } from "@toss/tds-colors";
import { graniteEvent } from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";

import familyDiaryPlaceholder from "../assets/family-diary-placeholder.jpg";

import { ALLOWED_IMAGE_TYPES } from "../constants/diary";
import {
  IMAGE_ERROR_MESSAGES,
  ImageProcessError,
  loadImageFileForCrop,
  validateImageFile,
} from "../utils/image";
import { hashPhotoFile } from "../services/sketchCache";
import { isAiTestMode, isSupabaseConfigured } from "../services/supabaseEdge";
import { DiaryButton } from "./DiaryButton";
import { PhotoCropModal } from "./PhotoCropModal";

export interface PhotoSelection {
  dataUrl: string;
  /** SHA-256 of the source file, or null when hashing was unavailable. */
  sourceHash: string | null;
}

interface PhotoUploadStepProps {
  photoDataUrl: string | null;
  selectButtonLabel: string;
  onPhotoChange: (selection: PhotoSelection) => void;
  /** Handles the root upload screen's native navigation-bar back action. */
  onRequestExit: () => Promise<void>;
  /** Kept only for the lifetime of the current mini-app execution. */
  hasSessionConsent: boolean;
  onSessionConsent: () => void;
  /** True while a drawing for that source file is still on its way. */
  isDrawingInProgress: (sourceHash: string | null) => boolean;
}

/**
 * Step 1: pick a photo from the device.
 *
 * A plain <input type="file"> is used instead of the apps-in-toss album SDK:
 * it opens the native picker in both the local browser and the Toss WebView,
 * and it needs no permission entry in granite.config.ts. The SDK album API can
 * replace this later if multi-select or finer permission UX becomes necessary.
 */
export function PhotoUploadStep({
  photoDataUrl,
  selectButtonLabel,
  onPhotoChange,
  onRequestExit,
  hasSessionConsent,
  onSessionConsent,
  isDrawingInProgress,
}: PhotoUploadStepProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const consentScrollRef = useRef<HTMLDivElement>(null);
  const consentTitleRef = useRef<HTMLHeadingElement>(null);
  const consentCheckRef = useRef<HTMLDivElement>(null);

  const [processing, setProcessing] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  // The File object exists only inside handleFileChange, so its hash is stashed
  // here to survive the trip through the crop modal.
  const sourceHashRef = useRef<string | null>(null);

  const toast = useToast();
  const { openAlert } = useDialog();

  useEffect(() => {
    const handleBack = (event: PopStateEvent) => {
      if (event.state?.diaryOverlayReturn === "crop") {
        const state = { ...event.state };
        delete state.diaryOverlayReturn;
        window.history.replaceState(state, "");
        setCropSource(null);
      }
    };

    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, []);

  useEffect(() => {
    if (cropSource === null) {
      return;
    }

    window.history.replaceState(
      { ...window.history.state, diaryOverlayReturn: "crop" },
      "",
    );
    window.history.pushState(
      { ...window.history.state, diaryOverlayReturn: undefined },
      "",
    );

    if (!("ReactNativeWebView" in window)) {
      return;
    }

    return graniteEvent.addEventListener("backEvent", {
      onEvent: () => window.history.back(),
    });
  }, [cropSource]);

  useEffect(() => {
    if (!consentOpen || !("ReactNativeWebView" in window)) {
      return;
    }

    return graniteEvent.addEventListener("backEvent", {
      onEvent: () => {
        setConsentOpen(false);
        setAgreed(false);
      },
    });
  }, [consentOpen]);

  useEffect(() => {
    if (
      cropSource !== null ||
      consentOpen ||
      !("ReactNativeWebView" in window)
    ) {
      return;
    }

    return graniteEvent.addEventListener("backEvent", {
      onEvent: () => {
        void onRequestExit();
      },
    });
  }, [consentOpen, cropSource, onRequestExit]);

  const closeCrop = () => {
    setCropSource(null);
    window.history.back();
  };

  const commitPhoto = (croppedDataUrl: string) => {
    const sourceHash = sourceHashRef.current;
    // The drawing cache inside useSketch is keyed by the exact cropped image.
    // An identical crop can therefore reuse its in-session result, while even
    // a subtle crop change gets a fresh drawing without asking the user to
    // compare two images that no longer line up.
    onPhotoChange({ dataUrl: croppedDataUrl, sourceHash });
  };

  const requestPhotoSelection = () => {
    // 이전 사진 처리가 진행 중이면 중복 선택을 막습니다.
    if (processing) {
      return;
    }

    // 한 번 동의한 앱 실행 중에는 사진을 바꾸거나 새 일기를 시작해도
    // 같은 처리 내용을 반복해서 묻지 않습니다.
    if (photoDataUrl !== null || hasSessionConsent) {
      fileInputRef.current?.click();
      return;
    }

    setAgreed(false);
    setConsentOpen(true);
  };

  const scrollToConsentCheck = () => {
    consentCheckRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  };

  const openPickerAfterConsent = () => {
    if (processing) {
      return;
    }

    // 아직 동의하지 않았다면 체크박스 영역으로 이동합니다.
    if (!agreed) {
      toast.openToast("필수 동의 항목을 확인해 주세요.");
      scrollToConsentCheck();
      return;
    }

    setConsentOpen(false);
    onSessionConsent();

    // 모바일 브라우저에서 파일 선택기가 차단되지 않도록
    // 사용자 클릭 이벤트 안에서 바로 실행합니다.
    fileInputRef.current?.click();
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];

    // 같은 파일을 다시 선택해도 onChange가 발생하도록 초기화합니다.
    event.target.value = "";

    if (file === undefined) {
      return;
    }

    const validationError = validateImageFile(file);

    if (validationError !== null) {
      toast.openToast(IMAGE_ERROR_MESSAGES[validationError]);
      return;
    }

    setProcessing(true);

    try {
      // Hashed before the crop so the key describes the photo the user picked,
      // not the rectangle they happened to drag.
      sourceHashRef.current = await hashPhotoFile(file);

      // Re-picking a photo whose drawing is still on its way is not an error —
      // the request is reused rather than repeated — but saying nothing reads
      // as "my tap did nothing". Told here rather than after cropping so the
      // user knows which photo the friend is on before doing that work.
      if (isDrawingInProgress(sourceHashRef.current)) {
        await openAlert({
          title: "이 사진은 친구가 이미 그림을 그리고 있어요.",
          description: "조금만 기다리면 그림이 완성돼요.",
          alertButton: <DiaryButton placement="dialog">확인</DiaryButton>,
          closeOnDimmerClick: false,
        });
      }

      setCropSource(await loadImageFileForCrop(file));
    } catch (error) {
      const code =
        error instanceof ImageProcessError ? error.code : "load-failed";

      toast.openToast(IMAGE_ERROR_MESSAGES[code]);
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="step-body">
      {photoDataUrl !== null ? (
        <div className="photo-selected">
          <img
            className="photo-preview"
            src={photoDataUrl}
            alt="선택한 사진 미리보기"
          />

          <DiaryButton
            tone="secondary"
            stable
            fullWidth
            size="medium"
            disabled={processing}
            onClick={requestPhotoSelection}
          >
            다른 사진 선택하기
          </DiaryButton>
        </div>
      ) : (
        <div className="photo-selected">
          <button
            type="button"
            className="photo-placeholder"
            onClick={requestPhotoSelection}
            disabled={processing}
          >
            <img
              className="photo-placeholder-image"
              src={familyDiaryPlaceholder}
              alt=""
              aria-hidden
            />

            <span className="photo-placeholder-copy">
              <Paragraph as="span" typography="t7" color={colors.grey600}>
                JPG · PNG · WEBP, 10MB 이하 사진 1장
              </Paragraph>
            </span>
          </button>

          <DiaryButton
            stable
            fullWidth
            size="medium"
            disabled={processing}
            onClick={requestPhotoSelection}
          >
            {selectButtonLabel}
          </DiaryButton>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(",")}
        hidden
        onChange={handleFileChange}
      />

      {cropSource !== null && (
        <PhotoCropModal
          imageDataUrl={cropSource}
          onCancel={closeCrop}
          onConfirm={(croppedDataUrl) => {
            closeCrop();
            void commitPhoto(croppedDataUrl);
          }}
          onError={() => {
            toast.openToast(IMAGE_ERROR_MESSAGES["load-failed"]);
          }}
        />
      )}

      <Modal
        open={consentOpen}
        onOpenChange={(open) => {
          setConsentOpen(open);

          if (!open) {
            setAgreed(false);
          }
        }}
      >
        <Modal.Overlay />

        <Modal.Content
          className="app-modal-panel"
          onOpenAutoFocus={(event) => {
            // 모달이 열릴 때 체크박스가 자동으로 포커스되면서
            // 아래로 스크롤되는 현상을 방지합니다.
            event.preventDefault();

            consentTitleRef.current?.focus({
              preventScroll: true,
            });

            if (consentScrollRef.current !== null) {
              consentScrollRef.current.scrollTop = 0;
              consentScrollRef.current.scrollLeft = 0;
            }
          }}
        >
          <div className="app-modal-layout">
            <header className="photo-consent-header">
              <div className="photo-consent-heading-row">
                <h2
                  ref={consentTitleRef}
                  className="app-modal-title"
                  tabIndex={-1}
                >
                  사진·일기 처리 동의
                </h2>

                <span className="photo-consent-required">필수</span>
              </div>

              <p className="photo-consent-description">
                그림일기 제작에 필요한 정보 처리 내용을 확인해 주세요.
              </p>
            </header>

            <div
              ref={consentScrollRef}
              className="modal-scroll-body photo-consent-scroll-body"
            >
              <div className="photo-consent-details">
                <section className="photo-consent-section">
                  <h3>처리하는 정보</h3>

                  <p>
                    AI 분석에는 선택한 사진과 일기 본문을 사용해요.
                    제목·날짜·날씨는 완성 이미지 표시에만 사용하며, 사용량
                    제한을 위해 기기 식별값·IP를 처리해요.
                  </p>
                </section>

                <section className="photo-consent-section">
                  <h3>이용 목적</h3>

                  <p>
                    사진을 크레파스 그림으로 바꾸고 일기를 분석해 한마디와
                    첨삭을 만들며, 반복 요청과 서비스 남용을 막는 데만 사용해요.
                  </p>
                </section>

                <section className="photo-consent-section">
                  <h3>전송 및 보관</h3>

                  {isSupabaseConfigured ? (
                    <p>
                      사진과 일기 본문은 Supabase Edge Function을 거쳐 OpenAI로
                      전송돼요.{" "}
                      {isAiTestMode &&
                        "테스트 모드에서는 분석만 진행하고 그림 변환 모델은 호출하지 않아요. "}
                      앱의 Supabase 데이터베이스에는 사진과 일기 원본을 따로
                      저장하지 않으며, 기기 식별값과 IP는 해시 처리한 사용량
                      기록으로만 저장해요.
                    </p>
                  ) : (
                    <p>
                      Supabase 설정이 없어 사진과 일기는 외부 서버로 전송되지
                      않아요. 원본 사진과 기기 안의 예시 분석을 사용해요.
                    </p>
                  )}

                  <p>
                    선택한 사진과 작성 중인 내용은 임시 저장을 위해 이 기기에
                    보관돼요. 새 일기를 시작하거나 토스의 미니앱 용량 삭제
                    기능을 사용하면 지울 수 있어요.
                  </p>
                </section>

                <section className="photo-consent-section">
                  <h3>동의 거부</h3>

                  <p>
                    동의하지 않고 닫을 수 있어요. 동의하지 않으면 사진 선택과
                    그림일기 제작 기능을 이용할 수 없어요.
                  </p>
                </section>

                <p className="photo-consent-caution">
                  주민등록번호·계좌번호·비밀번호 등 민감정보는 가리고, 다른
                  사람의 얼굴이나 개인정보가 포함된 사진은 올리지 말아 주세요.
                </p>
              </div>

              <div ref={consentCheckRef} className="photo-consent-check-row">
                <Checkbox.Line
                  checked={agreed}
                  onCheckedChange={setAgreed}
                  aria-label="필수 사진 및 일기 처리에 동의"
                />

                <button
                  type="button"
                  className="photo-consent-check-label"
                  onClick={() => setAgreed((checked) => !checked)}
                >
                  위 내용을 확인했으며 사진·일기 처리에 동의해요.
                </button>
              </div>
            </div>

            <div className="app-modal-footer photo-consent-actions">
              <DiaryButton
                tone="secondary"
                stable
                fullWidth
                onClick={() => setConsentOpen(false)}
              >
                닫기
              </DiaryButton>

              <DiaryButton
                placement="guide"
                stable
                fullWidth
                aria-disabled={!agreed || processing}
                disabled={processing}
                onClick={openPickerAfterConsent}
              >
                동의하고 사진 선택
              </DiaryButton>
            </div>
          </div>
        </Modal.Content>
      </Modal>
    </div>
  );
}
