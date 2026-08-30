# 배포

[README로 돌아가기](../README.md) · [개발 환경 설정](./setup.md) · [아키텍처](./architecture.md)

## 배포 대상

실행 앱은 Apps in Toss WebView track용 React 웹 번들입니다.

| 설정          | 값                        | 근거                                        |
| ------------- | ------------------------- | ------------------------------------------- |
| appName       | `summer-vacation-diary`   | `apps-in-toss.config.ts`                    |
| 표시 이름     | `나의 여름방학 일기`      | Apps in Toss 콘솔, `src/constants/brand.ts` |
| build command | `vite build && ait build` | `package.json`                              |
| web output    | `dist`                    | `apps-in-toss.config.ts#webBundleDir`       |
| SDK           | Web Framework `3.1.1`     | `package.json`                              |
| 앱 권한       | 빈 배열                   | `apps-in-toss.config.ts#permissions`        |

SDK 3.x 설정의 `brand`에는 `primaryColor`만 둡니다. 표시 이름과 앱 아이콘은 Apps in Toss 콘솔에서 관리합니다.

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

`ait deploy`는 `.ait` 번들을 콘솔에 업로드하고 테스트용 앱 스킴을 만드는 단계입니다. 업로드만으로 사용자에게 즉시 공개되지 않으며, 테스트 완료 후 콘솔의 검토 요청·승인·출시 단계를 별도로 거칩니다.

## 광고 ID와 빌드 구분

인앱 광고는 실제 토스 앱에서만 렌더링됩니다. 브라우저와 샌드박스는 인앱 광고를 지원하지 않으므로, 광고 확인은 콘솔 `테스트하기` QR로 실제 토스 앱에서만 가능합니다.

QR 테스트에는 반드시 테스트 광고 ID를 사용합니다. 라이브 ID로 테스트하면 정책 위반으로 간주될 수 있습니다. 심사 제출 번들은 테스트한 번들과 동일할 필요가 없으므로, 두 번 빌드해 각각 배포합니다.

| 목적      | 명령                 | 광고 ID   |
| --------- | -------------------- | --------- |
| QR 테스트 | `npm run build:test` | 테스트 ID |
| 심사·출시 | `npm run build`      | 라이브 ID |

`build:test`는 `VITE_USE_TEST_ADS=true`를 넘깁니다. 기본값이 라이브인 이유는, 플래그를 잊었을 때 정상 동작하는 출시본이 나오는 편이 수익이 0인 출시본보다 낫기 때문입니다. 분기는 `src/constants/ads.ts`에 있습니다.

출시 빌드는 산출물에서 테스트 ID가 없는지 확인합니다.

```bash
grep -c "ait-ad-test" dist/assets/index-*.js   # 0이어야 합니다
```

## 외부 기능 배포

클라이언트는 `{VITE_SUPABASE_URL}/functions/v1/diary-ai`를 호출합니다. 서버 source는 `supabase/diary-ai/`, 전체 DB bootstrap은 `supabase/sql/001_app_database.sql`에서 version 관리합니다. secret과 운영 배포 설정은 저장소에 넣지 않습니다.

권장 배포 순서는 다음과 같습니다.

1. Supabase SQL Editor에서 `supabase/sql/001_app_database.sql` 전체를 실행합니다.
2. `OPENAI_API_KEY`, `RATE_LIMIT_SALT`, Supabase secret 등 [API 명세](./api-specification.md#서버-환경-변수)의 server secret을 설정합니다.
3. `supabase/diary-ai` source를 프로젝트의 `diary-ai` Edge Function으로 배포합니다.
4. `quota-status` 최초 2개 지급과 1개 차감·환불, `grant-ad-reward`의 0→1·1→2 충전과 같은 영수증 중복 방지를 확인한 뒤 `progress-visit`, `progress-complete`, `inspect` 순으로 smoke test합니다.
5. 공개 URL과 publishable key만 프론트엔드 build 환경에 주입합니다.

프론트엔드 배포만으로 실제 그림 생성·분석·사용량 강제·연속 기록 동기화가 활성화되지는 않습니다. 2026-08-30 운영 환경에는 bootstrap SQL과 `diary-ai` v136을 SQL → Edge Function 순서로 배포했고, 아래 항목을 확인했습니다.

- v2 quota 함수 5개와 사용자 기회·광고 영수증 테이블 2개 설치
- `service_role` RPC 실행 허용, `anon` 직접 실행 차단
- `quota-status` 최초 2개와 다음 09:00 KST 충전 시각 응답
- 트랜잭션 롤백 방식의 2→1 소진, 1→2 광고 충전, 동일 `rewardId` 중복 방지
- 배포된 Edge Function source와 저장소 `supabase/diary-ai/` 일치

이 기록은 해당 날짜의 운영 배포 확인 결과입니다. 이후 서버를 다시 배포하면 같은 순서로 계약을 재검증해야 하며, rate-limit 정리 schedule과 데이터 보존 기간은 별도 운영 설정으로 남아 있습니다.

### CORS와 Origin

SDK 3.1.1 이상은 SDK 2.x와 같은 Origin을 사용합니다.

- 실제 서비스: `https://summer-vacation-diary.apps.tossmini.com`
- 콘솔 QR 테스트: `https://summer-vacation-diary.private-apps.tossmini.com`

저장소의 Edge Function은 현재 `Access-Control-Allow-Origin: *`이므로 두 Origin을 이미 허용합니다. 운영 배포본에서 wildcard를 별도 allowlist로 제한했다면 위 두 Origin을 모두 추가해야 합니다.

## 환경별 권장 확인

| 환경           | 확인 항목                                                                          |
| -------------- | ---------------------------------------------------------------------------------- |
| AIT Devtools   | mock/필터, 권한·네트워크·safe area, localStorage Origin 병합                       |
| 콘솔 QR 테스트 | `saveBase64Data`, Toss 공유창, `Storage` 달력, 네이티브 뒤로가기                   |
| iOS 실기기     | cover 자르기·회전, native back, 앞·뒤 스와이프 차단, 보관 일기 관리                |
| Android 실기기 | 빈 MIME, 저장 파일명, native back, 키보드 닫힘 뒤 하단 CTA 복원                    |
| 실제 Supabase  | inspect·quota-status·광고 반복 충전·progress action, 멱등 완료, timeout, 오류 code |

## 출시 전 체크리스트

- [ ] 앱 이름에 금지된 단어가 포함되지 않고 `appName`이 `summer-vacation-diary`다.
- [ ] 콘솔 표시 이름과 `BRAND_DISPLAY_NAME`이 `나의 여름방학 일기`로 일치한다.
- [ ] 콘솔 아이콘이 현재 앱 아이콘과 일치한다.
- [ ] `VITE_*` bundle에 비밀값이 없다.
- [ ] 처리 동의 문구가 실제 외부 전송·보존 정책과 일치한다.
- [ ] 한국·해외 IP의 실제 지역 제한 동작을 확인했다.
- [ ] AI 검사 기회가 최초 2개이고 09:00 KST에 1개만 충전되며 최대 2개를 넘지 않는다.
- [ ] 잔여량 0/2와 1/2에서 작은 광고 CTA가 표시되고 광고마다 1개가 충전되며 2/2에서 숨겨진다.
- [ ] 같은 광고 `rewardId` 중복 요청은 한 번만 반영되고, 충전 기회를 소진하면 새 광고로 다시 충전할 수 있다.
- [ ] iOS·Android에서 저장·공유를 실기기로 확인했다.
- [ ] 서비스·QR Origin에서 Supabase preflight와 실제 요청이 성공한다.
- [ ] SDK 3.0/3.1.0 Origin에 데이터가 있으면 현재 값은 유지되고 누락된 앱 key만 복원된다.
- [ ] 완성 JPEG가 일기 달력에 자동 보관되고 앱 재실행 후에도 열리는지 확인했다.
- [ ] 날짜별 2개 제한, 같은 사진·본문의 제목·날씨 변경 시 기존 기록 교체, 사진 또는 본문 수정 시 별도 기록 유지, 삭제 확인과 저장소 부족 오류를 확인했다.
- [ ] 일기 날짜가 초안 생성 시점으로 확정되고 화면에서 사용자가 바꿀 수 없다.
- [ ] SQL을 Function보다 먼저 적용했고, 같은 한국 날짜의 `progress-complete` 반복 호출이 1일만 적립한다.
- [ ] 연속 기록 장애가 일기 저장을 막지 않고 같은 날 앱 복귀 시 완료 동기화를 재시도한다.
- [ ] 업로드와 달력에 현재 연속·누적 작성 기록이 표시되고 특별 마일스톤 모달이 기록 공개 뒤 한 번만 열린다.
- [ ] 같은 날 여러 일기는 화살표 버튼과 그림 영역의 좌우 스와이프로 순환하며 다른 날짜로 넘어가지 않는다.
- [ ] 일기 상세가 열린 동안 뒤쪽 달력은 스크롤되지 않고, 닫으면 기존 스크롤 위치가 유지된다.
- [ ] iOS 앞·뒤 스와이프가 비활성화되고 하단 버튼·네이티브 back이 동일한 제작 단계로 이동한다.
- [ ] 보관 기록이 계정·기기·브라우저 환경 사이에 동기화되지 않는다는 제품 안내가 운영 정책과 맞다.
- [ ] Edge Function 장애 시 원본 사진과 mock이 아니라 명시적 오류/fallback이 나타난다.
- [ ] 린트, 타입 검사, build가 성공했다.

## CI/CD 상태

`.github/workflows/discord-merge-notification.yml`은 `main` 대상 PR merge 후 Discord 알림만 전송합니다. build, lint, typecheck, test, deploy 자동화는 없습니다.

자동 배포를 수행한다고 문서화할 근거가 없으므로 배포는 현재 수동 명령으로만 명세합니다.

## rollback과 운영

SDK 3.x 번들을 출시한 뒤에는 SDK 2.x 번들로 롤백할 수 없습니다. 저장소에는 release tag 정책과 이전 `.ait` 보관 정책이 없으므로 AIT Devtools와 콘솔 QR 테스트를 통과한 번들만 출시해야 합니다.

## 관련 문서

- [개발 환경 설정](./setup.md)
- [API 명세](./api-specification.md)
- [ERD](./erd.md)
- [보안·데이터 처리](./security.md)
