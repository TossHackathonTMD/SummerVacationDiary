# 개발 환경 설정

[README로 돌아가기](../README.md) · [아키텍처](./architecture.md) · [배포](./deployment.md)

## 요구 환경

| 항목          | 요구사항                             | 근거                                         |
| ------------- | ------------------------------------ | -------------------------------------------- |
| Node.js       | `>=24`                               | AIT Devtools 3.1.1의 `engines.node`          |
| 패키지 매니저 | npm                                  | `package-lock.json` lockfile v3              |
| 기본 개발 OS  | macOS                                | 저장소 작업 지침                             |
| 브라우저 실행 | 최신 Canvas·Web Crypto 지원 브라우저 | 이미지 처리, 익명 ID와 AIT Devtools          |
| 실기기 확인   | Apps in Toss 콘솔 QR 테스트          | SDK 3.x는 샌드박스 개발 서버를 사용하지 않음 |

`package.json#engines`도 Node 24 이상을 요구합니다.

## 설치

```bash
git clone https://github.com/TossHackathonTMD/SummerVacationDiary.git
cd SummerVacationDiary
npm ci
```

`package-lock.json`과 정확히 맞춘 설치에는 `npm ci`를 사용합니다. 의존성을 의도적으로 갱신할 때만 `npm install`과 lockfile 변경을 함께 검토합니다.

## 로컬 브라우저 실행

```bash
npm run dev
```

`http://localhost:5173`을 엽니다. SDK 3.x용 AIT Devtools가 SDK 브리지를 mock하고 화면 우측 하단에 테스트 패널을 표시합니다.

- Supabase 설정 없음: 외부로 사진·일기를 보내지 않음
- `VITE_AI_TEST_MODE` 미설정: 로컬 연필 필터 + mock 분석
- 토스 저장 API: `<a download>`로 대체
- 토스 공유 API: Web Share 또는 현재 URL 복사로 대체
- 일기 달력 보관: 브라우저 localStorage로 대체

## 환경 변수

```bash
cp .env.example .env
```

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_AI_TEST_MODE=true
```

| 변수                            | 기본값                              | 동작                         |
| ------------------------------- | ----------------------------------- | ---------------------------- |
| `VITE_SUPABASE_URL`             | 빈 값                               | Function base URL            |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | 빈 값                               | `apikey` header              |
| `VITE_AI_TEST_MODE`             | 코드 기본 `false`, 예시 파일 `true` | `true`면 그림 생성 요청 생략 |
| `VITE_AD_PLACEHOLDER`           | 빈 값                               | `true`면 배너 광고 자리 표시 |
| `VITE_USE_TEST_ADS`             | 빈 값                               | `true`면 테스트 광고 ID 사용 |

`VITE_AD_PLACEHOLDER=true`는 실제 광고가 뜨지 않는 환경(브라우저·샌드박스)에서 배너 자리에 96px 자리표시자를 그립니다. 레이아웃 확인 전용이므로 배포 빌드에서는 설정하지 않습니다.

`VITE_USE_TEST_ADS`는 `.env`에 두지 않는 편이 안전합니다. QR 테스트 빌드는 `npm run build:test`가 이 값을 직접 넘기므로, `.env`에 남겨두면 출시 빌드까지 테스트 ID로 나갈 수 있습니다. 자세한 내용은 [배포](./deployment.md#광고-id와-빌드-구분)를 참고합니다.

두 Supabase 값 중 하나만 있으면 `isSupabaseConfigured`가 false가 되어 전체 외부 요청을 사용하지 않습니다.

### 비밀값 규칙

`VITE_*`는 Vite가 번들에 포함하므로 공개 가능한 값만 둡니다.

```text
허용: VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY, VITE_AI_TEST_MODE
금지: OpenAI API key, Supabase secret/service-role key
```

Edge Function source와 DB bootstrap SQL은 각각 `supabase/diary-ai/`, `supabase/sql/001_app_database.sql`에서 version 관리합니다. secret과 운영 배포 설정은 저장소에 포함하지 않습니다. 실제 Function을 연결할 때는 SQL을 먼저 적용하고 [API 명세](./api-specification.md), [ERD](./erd.md)의 계약과 배포본을 대조합니다.

## 실행 모드 선택

### 로컬 필터까지 확인

`.env`를 만들지 않거나 다음처럼 둡니다.

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_AI_TEST_MODE=false
```

사진은 Canvas 연필 필터, 분석은 mock을 사용합니다.

### 이미지 처리 없이 UI만 확인

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_AI_TEST_MODE=true
```

사진은 원본, 분석은 mock을 사용합니다.

### 실제 분석만 확인

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
VITE_AI_TEST_MODE=true
```

사진은 원본을 사용하고 분석과 quota는 호환 Edge Function에 요청합니다. 서버 측 테스트 모드와 quota 우회 설정은 저장소 밖이므로 별도 확인이 필요합니다.

### 실제 그림 생성과 분석 확인

```dotenv
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
VITE_AI_TEST_MODE=false
```

그림과 분석을 모두 Edge Function에 요청합니다. 외부 비용과 서버 사용량 제한이 발생할 수 있으므로 의도한 환경에서만 사용합니다.

환경 변수를 바꾼 뒤에는 Vite를 재시작합니다.

## Apps in Toss 실기기 확인

```bash
npm run build:test
npm run deploy
```

SDK 3.x에서는 `granite dev`와 샌드박스 bridge를 사용하지 않습니다. 광고가 포함된 QR 테스트는 반드시 `npm run build:test`의 테스트 광고 ID 번들로 진행합니다. 검증이 끝나면 `npm run build`로 라이브 광고 ID가 포함된 심사·출시 번들을 다시 생성합니다. SDK 3.x 번들을 출시한 뒤에는 SDK 2.x로 롤백할 수 없으므로 출시 전에 AIT Devtools와 QR 테스트를 모두 완료합니다.

## 품질 확인

```bash
npm run lint
./node_modules/.bin/tsc --noEmit -p tsconfig.app.json
npm run build
```

`npx tsc`는 사용하지 않습니다. 저장소에 자동 테스트 framework와 `npm test` script는 없습니다. UI 변경은 [기능 명세의 수동 회귀 확인](./functional-specification.md#수동-회귀-확인)을 함께 수행합니다.

## 자주 확인할 실패 원인

| 증상                              | 확인할 항목                                                         |
| --------------------------------- | ------------------------------------------------------------------- |
| 항상 체험 모드                    | 두 `VITE_SUPABASE_*` 값이 모두 채워졌는지, Vite를 재시작했는지      |
| 그림 생성이 호출되지 않음         | `VITE_AI_TEST_MODE`가 `true`인지                                    |
| AIT Devtools가 표시되지 않음      | Node 24 이상인지, `npm run dev`로 개발 서버를 실행했는지            |
| 저장이 브라우저 다운로드로 동작   | Toss 운영 환경이 아니면 정상 fallback                               |
| 배너 광고가 보이지 않음           | 브라우저에서는 `VITE_AD_PLACEHOLDER=true`로 레이아웃 확인           |
| 일기 달력 기록이 다른 환경에 없음 | 브라우저 origin과 Toss `Storage`는 서로 동기화되지 않는 것이 정상   |
| 세 번째 일기가 보관되지 않음      | 같은 날짜에는 서로 다른 완성 일기를 최대 2개까지 보관               |
| 이전 일기가 시작 시 복원되지 않음 | 현재 `App.tsx`가 `restoreOnStart: false`로 의도적으로 새 draft 사용 |

## 기능별 로컬 확인 순서

1. 사진 동의 → 세로·가로 사진 선택 → 3:2 이동·확대·90° 회전 자르기
2. 제목·날씨·낮/밤 배경·본문 입력과 오늘 날짜 자동 표시 확인
3. `검사 받기` 후 그림·첨삭 미리보기 확인
4. `일기 완성하기` 후 JPEG 자동 보관, 오늘의 도장 적립과 `일기와 오늘의 도장을 저장했어요! (현재 개수/2)` 토스트 확인
5. 저장 일기 상세의 `저장 및 공유` 모달에서 다운로드와 앱 링크 공유 확인
6. 업로드 화면의 `일기장 보기`에서 해당 날짜 도장 확인
7. 같은 사진·본문의 제목·날씨 변경 시 기존 기록 교체, 사진 또는 본문 수정 후 저장 시 별도 기록 유지, `저장 및 공유`와 삭제 확인
8. 업로드의 오늘 도장·연속 기록, 달력의 연속·누적 기록, 특별 마일스톤 모달 확인
9. 같은 날 여러 일기는 화살표와 그림 영역의 좌우 스와이프로만 순환하고, 세로 제스처는 무시되며 상세 뒤쪽 달력이 스크롤되지 않는지 확인

## 관련 문서

- [API 명세](./api-specification.md)
- [배포](./deployment.md)
- [보안·데이터 처리](./security.md)
