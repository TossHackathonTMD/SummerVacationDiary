import {
  getOperationalEnvironment,
  getTossShareLink,
  share as shareThroughToss,
} from "@apps-in-toss/web-framework";

import { seasonCopy, type SeasonTheme } from "../constants/seasonTheme";

const APP_DEEP_LINK = "intoss://summer-vacation-diary";

export class DiaryShareError extends Error {
  constructor(public readonly userMessage: string) {
    super(userMessage);
    this.name = "DiaryShareError";
  }
}

function isInsideTossApp(): boolean {
  try {
    const environment = getOperationalEnvironment();

    return environment === "toss" || environment === "sandbox";
  } catch {
    return false;
  }
}

function browserFallbackUrl(): string {
  return window.location.href;
}

/**
 * 토스 앱에서는 미니앱 공유 링크를 만들고,
 * 일반 브라우저에서는 현재 페이지 주소를 반환합니다.
 */
export async function getDiaryAppShareLink(): Promise<string> {
  if (!isInsideTossApp()) {
    return browserFallbackUrl();
  }

  try {
    return await getTossShareLink(APP_DEEP_LINK);
  } catch {
    throw new DiaryShareError(
      "공유 링크를 만들지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  }
}

async function copyWithBrowser(text: string): Promise<void> {
  if (navigator.clipboard?.writeText !== undefined) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const field = document.createElement("textarea");

  field.value = text;
  field.setAttribute("readonly", "");
  field.className = "clipboard-copy-field";

  document.body.appendChild(field);
  field.select();

  const copied = document.execCommand("copy");

  field.remove();

  if (!copied) {
    throw new Error("copy failed");
  }
}

function isShareCancelled(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "AbortError" || error.name === "NotAllowedError")
  );
}

/**
 * 토스 또는 운영체제의 공유창을 엽니다.
 *
 * 실제 공유 완료 여부는 확인하지 않으며,
 * 성공 및 취소 시에는 별도의 결과를 반환하지 않습니다.
 * 공유 기능 실행 자체가 실패한 경우에만 예외를 발생시킵니다.
 */
export async function shareDiaryAppLink(theme: SeasonTheme): Promise<void> {
  const link = await getDiaryAppShareLink();
  const { shareTitle, shareText } = seasonCopy(theme);
  const message = `${shareText}\n${link}`;

  try {
    if (isInsideTossApp()) {
      await shareThroughToss({ message });
      return;
    }

    if (navigator.share !== undefined) {
      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: link,
      });
      return;
    }

    await copyWithBrowser(link);
  } catch (error) {
    // 사용자가 공유창을 닫거나 취소한 경우에는 아무것도 표시하지 않습니다.
    if (isShareCancelled(error)) {
      return;
    }

    throw new DiaryShareError(
      "공유창을 열지 못했어요. 잠시 후 다시 시도해 주세요.",
    );
  }
}
