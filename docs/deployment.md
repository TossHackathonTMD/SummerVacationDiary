# 배포

[README로 돌아가기](../README.md) · [개발 환경 설정](./setup.md) · [아키텍처](./architecture.md)

## 배포 대상

실행 앱은 Apps in Toss WebView track용 React 웹 번들입니다.

| 설정          | 값                        | 근거                                   |
| ------------- | ------------------------- | -------------------------------------- |
| appName       | `summer-vacation-diary`   | `granite.config.ts`                    |
| 표시 이름     | `나의 여름방학 일기`      | `src/constants/brand.ts`               |
| build command | `vite build`              | `granite.config.ts#web.commands.build` |
| output        | `dist`                    | `granite.config.ts#outdir`             |
| SDK command   | `ait build`, `ait deploy` | `package.json`                         |
| 앱 권한       | 빈 배열                   | `granite.config.ts#permissions`        |

앱 아이콘은 코드의 `brand.icon`이 아니라 Apps in Toss 콘솔 업로드로 관리하도록 설정 주석에 기록되어 있습니다.

## 배포 전 검증

```bash
npm ci
npm run lint
./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
npm run build
```

성공하면 `dist/`와 `.ait` 산출물이 생성됩니다. 둘 다 `.gitignore` 대상이며 Git에 커밋하지 않습니다.

자동 테스트가 없으므로 [수동 회귀 확인](./functional-specification.md#수동-회귀-확인)을 별도로 수행합니다.

## Apps in Toss 배포

```bash
npm run deploy
```

이 명령은 `ait deploy`를 실행합니다. 다음 외부 조건이 필요합니다.

- Apps in Toss 콘솔에 `summer-vacation-diary` 등록
- 콘솔 표시 이름 `나의 여름방학 일기`
- 배포 권한과 콘솔 API key
- 콘솔에 업로드한 앱 아이콘

이 저장소에는 콘솔 credential을 저장하지 않습니다.

## 광고 ID와 빌드 구분

인앱 광고는 실제 토스 앱에서만 렌더링됩니다. 브라우저와 샌드박스는 인앱 광고를 지원하지 않으므로, 광고 확인은 콘솔 `테스트하기` QR로 실제 토스 앱에서만 가능합니다.

QR 테스트에는 반드시 테스트 광고 ID를 사용합니다. 라이브 ID로 테스트하면 정책 위반으로 간주될 수 있습니다. 심사 제출 번들은 테스트한 번들과 동일할 필요가 없으므로, 두 번 빌드해 각각 배포합니다.

| 목적          | 명령                 | 광고 ID   |
| ------------- | -------------------- | --------- |
| QR 테스트     | `npm run build:test` | 테스트 ID |
| 심사·출시     | `npm run build`      | 라이브 ID |

`build:test`는 `VITE_USE_TEST_ADS=true`를 넘깁니다. 기본값이 라이브인 이유는, 플래그를 잊었을 때 정상 동작하는 출시본이 나오는 편이 수익이 0인 출시본보다 낫기 때문입니다. 분기는 `src/constants/ads.ts`에 있습니다.

출시 빌드는 산출물에서 테스트 ID가 없는지 확인합니다.

```bash
grep -c "ait-ad-test" dist/web/assets/index-*.js   # 0이어야 합니다
```

## 외부 기능 배포

클라이언트는 `{VITE_SUPABASE_URL}/functions/v1/diary-ai`를 호출합니다. 서버 source는 `supabase/diary-ai/`, 전체 DB bootstrap은 `supabase/sql/001_app_database.sql`에서 version 관리합니다. secret과 운영 배포 설정은 저장소에 넣지 않습니다.

권장 배포 순서는 다음과 같습니다.

1. Supabase SQL Editor에서 `supabase/sql/001_app_database.sql` 전체를 실행합니다.
2. `OPENAI_API_KEY`, `RATE_LIMIT_SALT`, Supabase secret 등 [API 명세](./api-specification.md#서버-환경-변수)의 server secret을 설정합니다.
3. `supabase/diary-ai` source를 프로젝트의 `diary-ai` Edge Function으로 배포합니다.
4. `quota-status`, `progress-visit`, `progress-complete`, `inspect` 순으로 smoke test합니다.
5. 공개 URL과 publishable key만 프론트엔드 build 환경에 주입합니다.

프론트엔드 배포만으로 실제 그림 생성·분석·사용량 강제·연속 기록 동기화가 활성화되지는 않습니다. 운영 배포 version, rate-limit 정리 schedule과 보존 기간은 실제 서버에서 확인해야 합니다.

## 환경별 권장 확인

| 환경           | 확인 항목                                                           |
| -------------- | ------------------------------------------------------------------- |
| 브라우저       | mock/필터, JPEG 다운로드, Web Share·링크 복사, localStorage 달력    |
| Toss 샌드박스  | deep link, safe area, `saveBase64Data`, Toss 공유창, `Storage` 달력 |
| iOS 실기기     | cover 자르기·회전, native back, 앞·뒤 스와이프 차단, 보관 일기 관리 |
| Android 실기기 | 빈 MIME, 저장 파일명, native back, 키보드 닫힘 뒤 하단 CTA 복원     |
| 실제 Supabase  | inspect·quota-status·progress action, 멱등 완료, timeout, 오류 code |

## 출시 전 체크리스트

- [ ] 앱 이름에 금지된 단어가 포함되지 않고 `appName`이 `summer-vacation-diary`다.
- [ ] 콘솔 표시 이름과 `BRAND_DISPLAY_NAME`이 `나의 여름방학 일기`로 일치한다.
- [ ] 콘솔 아이콘이 현재 앱 아이콘과 일치한다.
- [ ] `VITE_*` bundle에 비밀값이 없다.
- [ ] 처리 동의 문구가 실제 외부 전송·보존 정책과 일치한다.
- [ ] 한국·해외 IP의 실제 지역 제한 동작을 확인했다.
- [ ] 사용량 제한과 09:00 KST reset 안내가 실제 서버와 일치한다.
- [ ] iOS·Android에서 저장·공유를 실기기로 확인했다.
- [ ] 완성 JPEG가 일기 달력에 자동 보관되고 앱 재실행 후에도 열리는지 확인했다.
- [ ] 날짜별 3개 제한, 같은 사진·본문의 제목·날씨 변경 시 기존 기록 교체, 사진 또는 본문 수정 시 별도 기록 유지, 삭제 확인과 저장소 부족 오류를 확인했다.
- [ ] 일기 날짜가 초안 생성 시점으로 확정되고 화면에서 사용자가 바꿀 수 없다.
- [ ] SQL을 Function보다 먼저 적용했고, 같은 한국 날짜의 `progress-complete` 반복 호출이 1일만 적립한다.
- [ ] 연속 기록 장애가 일기 저장을 막지 않고 같은 날 앱 복귀 시 완료 동기화를 재시도한다.
- [ ] 업로드와 달력에 현재 연속·누적 작성 기록이 표시되고 특별 마일스톤 모달이 기록 공개 뒤 한 번만 열린다.
- [ ] 같은 날 여러 일기는 화살표 버튼으로 이동하며 좌우 스와이프가 동작하지 않는다.
- [ ] iOS 앞·뒤 스와이프가 비활성화되고 하단 버튼·네이티브 back이 동일한 제작 단계로 이동한다.
- [ ] 보관 기록이 계정·기기·브라우저 환경 사이에 동기화되지 않는다는 제품 안내가 운영 정책과 맞다.
- [ ] Edge Function 장애 시 원본 사진과 mock이 아니라 명시적 오류/fallback이 나타난다.
- [ ] 린트, 타입 검사, build가 성공했다.

## CI/CD 상태

`.github/workflows/discord-merge-notification.yml`은 `main` 대상 PR merge 후 Discord 알림만 전송합니다. build, lint, typecheck, test, deploy 자동화는 없습니다.

자동 배포를 수행한다고 문서화할 근거가 없으므로 배포는 현재 수동 명령으로만 명세합니다.

## rollback과 운영

저장소에는 release tag 정책, rollback script, 이전 `.ait` 보관 정책이 없습니다. Apps in Toss 콘솔의 실제 rollback 지원과 운영 절차는 `확인 필요`입니다.

## 관련 문서

- [개발 환경 설정](./setup.md)
- [API 명세](./api-specification.md)
- [ERD](./erd.md)
- [보안·데이터 처리](./security.md)
