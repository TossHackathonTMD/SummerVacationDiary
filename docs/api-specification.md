# API 명세

[README로 돌아가기](../README.md) · [기능 명세](./functional-specification.md) · [ERD](./erd.md) · [보안·데이터 처리](./security.md)

## 문서 범위

아래 명세는 클라이언트가 실제로 호출하고 검증하는 계약, 저장소의 `supabase/diary-ai/index.ts`, `supabase/sql/001_app_database.sql`을 기준으로 합니다. 운영 배포본과 저장소 source의 일치 여부는 배포 환경에서 확인해야 합니다.

- **확인된 범위:** method·CORS, action별 입력 검증, OpenAI endpoint와 기본 model, 사용량 제한값, 차감·환불 분기, 응답·오류 계약
- **확인 필요:** 운영 배포 version, secret 값, 로그·DB 보존 작업의 실제 schedule
- **근거:** `src/services/supabaseEdge.ts`, `src/services/diaryProgress.ts`, `src/services/diaryAnalysis.ts`, `src/services/styleTransfer.ts`, `src/services/aiQuotaStore.ts`, `src/hooks/useAiQuota.ts`, `supabase/diary-ai/index.ts`, `supabase/sql/001_app_database.sql`

이 API는 이 앱의 AI·사용량·연속 기록 외부 경계입니다. 완성 일기의 사진·본문·JPEG 저장·조회·삭제는 기기 저장소에서만 처리하고, 서버에는 익명 hash 기반 활동일만 저장합니다.

## 공통 계약

| 항목           | 값                                                                               |
| -------------- | -------------------------------------------------------------------------------- |
| Method         | `POST`                                                                           |
| Endpoint       | `{VITE_SUPABASE_URL}/functions/v1/diary-ai`                                      |
| Content-Type   | `application/json`                                                               |
| Supabase key   | `apikey: {VITE_SUPABASE_PUBLISHABLE_KEY}`                                        |
| 익명 요청 식별 | `x-diary-client-id: toss:{anonymousKey}` 또는 `web:{uuid}` 또는 `session:{uuid}` |
| 사용자 인증    | 없음. `Authorization` header를 보내지 않음                                       |
| 성공 판정      | Fetch `response.ok === true`인 2xx 응답                                          |
| 응답 형식      | JSON                                                                             |

- `OPTIONS`는 CORS preflight로 `200 ok`를 반환합니다.
- `POST`가 아니면 `405 method-not-allowed`를 반환합니다.
- CORS 허용 header는 `apikey`, `content-type`, `x-diary-client-id`입니다.

두 `VITE_SUPABASE_*` 값이 모두 있어야 호출합니다. 하나라도 없으면 클라이언트가 mock 또는 로컬 필터를 사용합니다.

### 공통 quota 응답

차감 이후의 성공·오류 응답과 `quota-status`는 다음 `quota`를 포함합니다. JSON 파싱 실패, 잘못된 action, 지역 차단, 서버 key 누락처럼 quota 예약 전에 끝난 오류에는 `quota`가 없을 수 있습니다. 필드가 없거나 잘못되어도 본 작업 응답 자체를 클라이언트가 곧바로 실패시키지는 않습니다.

```json
{
  "quota": {
    "all": {
      "used": 0,
      "limit": 2,
      "remaining": 2
    },
    "nextRefillAt": "2026-08-31T00:00:00.000Z",
    "resetAt": "2026-08-31T00:00:00.000Z",
    "blocked": null,
    "region": {
      "allowed": true,
      "country": "KR"
    },
    "testMode": false
  }
}
```

| 필드             | 타입·제약                                                   |
| ---------------- | ----------------------------------------------------------- |
| `all`            | 필수 통합 AI 검사 카운터, `limit`은 2                       |
| `nextRefillAt`   | 다음 1개 충전 시각인 ISO date string                        |
| `resetAt`        | 이전 클라이언트 호환 필드, `nextRefillAt`과 같은 값         |
| `blocked`        | `null`, `device`, `ip-burst`, `ip-daily`, `service` 중 하나 |
| `region.allowed` | boolean. 누락 시 클라이언트는 `true`로 호환 처리            |
| `region.country` | ISO 3166-1 alpha-2 string 또는 `null`로 기대                |
| `testMode`       | `true`일 때만 true, 누락 시 false                           |

클라이언트는 `quota.all`만 통합 `AI 검사 기회`의 권위값으로 사용합니다.
Edge Function은 필요한 작업을 하나의 `inspect` 요청으로 묶고, 사용자 기회와 IP counter를 요청당 한 번 예약하는 `consume_diary_ai_inspection_quota_v2` RPC를 호출합니다. 서비스 counter는 실제 요청한 sketch·analyze 작업별로 전달하며, 저장소 SQL은 advisory transaction lock과 사용자 행 잠금으로 같은 식별자의 동시 차감을 직렬화합니다.

사용자 기회는 최초 2개이며 매일 `00:00 UTC`, 한국 시간 `09:00`에 1개를 충전하고 최대 2개까지만 보관합니다. IP·서비스 일일 window는 같은 시각에 전체 초기화됩니다. `DIARY_AI_TEST_MODE=true`인 서버 테스트 모드는 DB를 읽거나 차감하지 않고 `testMode: true`, limit `0`인 snapshot을 반환합니다.

## A-01 사용량 조회

### 요청

```json
{
  "action": "quota-status"
}
```

- **목적:** 경과한 충전을 반영하되 작업은 차감하지 않고 통합 AI 검사 잔여량과 지역 상태를 조회
- **timeout:** 10초
- **Path·Query parameter:** 없음
- **권한:** 공통 publishable key와 익명 식별 header
- **Request validation:** `x-diary-client-id`가 비어 있으면 `400 invalid-client-id`
- **보조 제한:** isolate 메모리에서 client ID별 10분 30회까지 허용하며 초과 시 `429 rate-limited`. 여러 isolate에 걸친 강제 제한은 아님

### 성공 응답

공통 `quota` 객체를 기대합니다. 추가 필드는 클라이언트가 무시합니다.

### 오류 처리

모든 오류를 호출부에서 삼키고 사용량 표시를 `unknown`으로 유지합니다. 이 조회 실패만으로 제작 흐름을 차단하지 않습니다.

- **관련 기능:** F-01, F-10
- **구현 파일:** `src/hooks/useAiQuota.ts`, `src/services/supabaseEdge.ts`

## A-02 통합 AI 검사

### 요청

```json
{
  "action": "inspect",
  "runSketch": true,
  "runAnalyze": true,
  "photoDataUrl": "data:image/jpeg;base64,...",
  "input": {
    "photoDataUrl": "data:image/jpeg;base64,...",
    "content": "가족과 계곡에서 물놀이를 해서 정말 즐거웠다."
  }
}
```

| 필드                 | 타입             | 클라이언트 조건                       |
| -------------------- | ---------------- | ------------------------------------- |
| `action`             | string           | 항상 `inspect`                        |
| `runSketch`          | boolean          | 새 그림이 필요할 때 true              |
| `runAnalyze`         | boolean          | 새 본문 분석이 필요할 때 true         |
| `photoDataUrl`       | string           | `runSketch=true`일 때 JPEG data URL   |
| `input.photoDataUrl` | string 또는 null | `runAnalyze=true`일 때 현재 사진      |
| `input.content`      | string           | `runAnalyze=true`일 때 현재 일기 본문 |

- 두 실행 값 중 하나 이상이 true여야 합니다.
- **timeout:** 150초
- **Path·Query parameter:** 없음
- **권한:** 공통 publishable key와 익명 식별 header
- **서버 validation:** `inspect` action과 실행 flag를 먼저 검사합니다. 분석은 object 입력과 비어 있지 않은 `content`, 그림은 Base64 data URL 문법과 디코딩 가능 여부를 검사합니다. 서버 코드에는 별도 MIME allowlist·byte 상한이 없으므로 클라이언트의 10MB·이미지 규칙과 동일한 서버 방어로 간주하면 안 됩니다.
- **rate limit:** 사용자 기회 최대 2개·매일 1개 충전, IP 20회/10분, IP 100회/UTC day. 서비스 한도는 sketch 150회/UTC day, analyze 250회/UTC day
- **지역 제한:** `cf-ipcountry` → `x-country` → `x-vercel-ip-country` 순으로 국가를 읽고, 확인된 국가가 `KR`이 아니면 예약 전에 `403 region-blocked`. 국가가 없거나 `XX`, `T1`이면 unknown으로 보고 허용

### 성공 응답

```ts
interface InspectionResponse {
  imageBase64?: string;
  analysis?: Record<string, unknown>;
  quota: QuotaSnapshot;
}
```

- 요청한 작업의 결과만 응답에 포함됩니다.
- `runSketch=true`이면 `imageBase64`는 비어 있지 않은 string이어야 합니다.
- `runAnalyze=true`이면 `analysis` 객체가 있어야 합니다.
- 클라이언트는 `data:image/jpeg;base64,` prefix를 붙여 디코딩한 뒤 최대 1280px, 품질 0.85 JPEG로 재압축합니다.
- 누락·빈 값·디코딩 실패는 `invalid-response`입니다.

서버는 분석과 그림이 모두 필요하면 하나의 quota를 예약한 뒤 두 OpenAI 요청을 `Promise.all`로 병렬 실행합니다.

| 작업 | OpenAI endpoint        | 기본 model    | 주요 설정                                                 |
| ---- | ---------------------- | ------------- | --------------------------------------------------------- |
| 분석 | `/v1/chat/completions` | `gpt-4o-mini` | JSON object 응답, `max_completion_tokens: 1200`, 사진 low |
| 그림 | `/v1/images/edits`     | `gpt-image-1` | `size: auto`, JPEG, `n: 1`, 기본 quality `medium`         |

model과 이미지 quality는 각각 `OPENAI_MODEL`, `OPENAI_IMAGE_MODEL`, `OPENAI_IMAGE_QUALITY` secret으로 바꿀 수 있습니다.

### 오류 응답

클라이언트가 기대하는 최소 body:

```ts
interface ErrorResponse {
  code?: string;
  quota: QuotaSnapshot;
}
```

| HTTP 또는 code                 | 클라이언트 결과    |
| ------------------------------ | ------------------ |
| abort                          | `timeout`          |
| 요청 단계 실패                 | `network`          |
| JSON 파싱 실패                 | `invalid-response` |
| `401`, `403` + 알 수 없는 code | `invalid-key`      |
| `429` + 알 수 없는 code        | `rate-limited`     |
| 알려진 `code`                  | 같은 code를 보존   |

인식하는 server code:

```text
timeout
network
invalid-key
invalid-image
model-unavailable
rate-limited
region-blocked
ip-burst-limit-exceeded
ip-daily-limit-exceeded
service-daily-limit-exceeded
daily-limit-exceeded
quota-exceeded
content-blocked
api-error
invalid-response
```

제공된 서버 스냅샷이 추가로 만들 수 있는 운영·입력 code는 다음과 같습니다. 클라이언트의 알려진 code 집합에 없는 값은 HTTP status 또는 일반 `api-error` 경로로 축약될 수 있습니다.

```text
method-not-allowed
invalid-action
invalid-input
invalid-client-id
invalid-content
invalid-image-quality
invalid-supabase-secret
missing-supabase-secret
missing-supabase-url
missing-rate-limit-salt
rate-limit-unavailable
```

`content-blocked`, `invalid-image`는 사용자 입력 오류이므로 차감을 유지하고, 그 밖의 서버·네트워크 계열 실패는 서버가 차감을 환불합니다.

제공된 서버 스냅샷은 `invalid-input`, `invalid-content`도 차감 유지 대상으로 분류합니다. quota 예약 전에 발생한 오류는 애초에 차감하지 않습니다. 환불 RPC가 실패하면 원래 오류를 유지하고 해당 1회는 다음 UTC day reset까지 복구되지 않을 수 있습니다.

- **관련 기능:** F-05, F-10
- **구현 파일:** `src/services/styleTransfer.ts`, `src/services/supabaseEdge.ts`, `src/services/sketchLedger.ts`

## A-03 일기 분석 결과

### 통합 요청의 분석 입력

분석 입력은 A-02의 `inspect` 요청 안에 포함되며 `runAnalyze=true`일 때만
전송됩니다. 결과는 최상위 `analysis` 객체로 반환됩니다.

제목·날짜·날씨·낮/밤 배경은 완성 이미지와 화면 표현에만 사용하며 분석 API에는 전송하지 않습니다.

- **timeout:** 통합 요청 기준 150초
- **Path·Query parameter:** 없음
- **권한:** 공통 publishable key와 익명 식별 header
- **서버 validation·rate limit:** A-02의 통합 요청 정책과 동일

### 성공 응답

```ts
interface AnalyzeResponse {
  photo_keywords?: unknown;
  diary_keywords?: unknown;
  emotions?: unknown;
  highlight_words?: unknown;
  highlight_sentence?: unknown;
  star_words?: unknown;
  comment?: unknown;
  stamp?: unknown;
}
```

### 클라이언트 응답 validation

| 필드                 | 처리                                                           |
| -------------------- | -------------------------------------------------------------- |
| `comment`            | 비어 있으면 전체 실패, 50자 초과 시 49자와 말줄임표로 제한     |
| `photo_keywords`     | string 배열에서 최대 3개                                       |
| `diary_keywords`     | string 배열에서 최대 4개, 비속어 제외                          |
| `emotions`           | string 배열에서 최대 3개                                       |
| `highlight_words`    | 본문의 실제 부분 문자열·비속어 아님·일반 강조어 아님, 최대 4개 |
| `highlight_sentence` | 본문의 실제 부분 문자열·비속어 아님·100자 이하, 아니면 null    |
| `star_words`         | 본문의 실제 부분 문자열·비속어 아님, 최대 2개                  |
| `stamp`              | `effort`만 effort, 그 외 값은 great로 정규화                   |

### 오류 응답

최소 body와 HTTP 매핑 방식은 A-02와 같습니다. 인식하는 분석 server code:

```text
timeout
network
invalid-key
rate-limited
region-blocked
ip-burst-limit-exceeded
ip-daily-limit-exceeded
service-daily-limit-exceeded
daily-limit-exceeded
api-error
invalid-response
```

지역·일일 한도 오류는 재시도 불가로 표시하고, timeout·network·burst·일반 API 오류는 재시도 가능으로 표시합니다.

- **관련 기능:** F-06, F-10
- **구현 파일:** `src/services/diaryAnalysis.ts`, `src/hooks/useDiaryAnalysis.ts`, `src/services/supabaseEdge.ts`

## A-04 연속 기록

네 action은 모두 빈 body의 `action` 값과 공통 `x-diary-client-id` header만 사용합니다. Edge Function이 client ID를 salt 포함 SHA-256으로 변환하고 service role로 아래 RPC를 호출하므로, 브라우저에는 hash나 DB 실행 권한이 노출되지 않습니다.

| action              | RPC                       | 의미                                        |
| ------------------- | ------------------------- | ------------------------------------------- |
| `progress-visit`    | `record_diary_app_visit`  | 한국 날짜 기준 방문일 기록 후 snapshot 조회 |
| `progress-status`   | `read_diary_progress`     | 쓰기 없는 현재 snapshot 조회                |
| `progress-complete` | `record_diary_completion` | 오늘 작성일을 멱등 기록하고 마일스톤 반환   |
| `progress-delete`   | `delete_diary_progress`   | 해당 익명 hash의 진행 데이터 삭제           |

요청 예시:

```json
{ "action": "progress-complete" }
```

조회·방문·완료 성공 응답은 `{ "progress": { ... } }`이며 주요 필드는 다음과 같습니다.

```json
{
  "progress": {
    "activityDate": "2026-08-03",
    "daysAway": 0,
    "visitDays": 7,
    "currentStreak": 5,
    "totalActivityDays": 12,
    "completedToday": true,
    "newlyCompleted": true,
    "milestones": [
      {
        "metric": "streak",
        "threshold": 5,
        "tier": "special",
        "title": "다섯 날의 리듬"
      }
    ]
  }
}
```

`newlyCompleted`와 `milestones`는 완료 응답에만 필요합니다. 날짜별 활동 목록은 내려주지 않고 현재 연속 일수와 누적 작성일만 제공합니다. 같은 사용자·같은 한국 날짜의 완료는 primary key 충돌을 무시해 중복 적립하지 않으며, 두 요청이 동시에 와도 advisory transaction lock으로 직렬화합니다. 오류는 `503 { "error": "progress-unavailable" }`이며 일기 기기 저장을 되돌리지 않습니다.

## 보안과 공개 범위

- publishable key는 클라이언트 공개 값이며 server secret이 아닙니다.
- OpenAI API key와 Supabase service-role key는 요청이나 저장소에 포함하지 않습니다.
- 사용자 계정 token이나 session 인증은 없습니다.
- `x-diary-client-id`는 남용 방지 힌트이며 인증 수단이 아닙니다.
- 원본 사진과 일기는 JSON request body로 전송됩니다.
- 제목·날짜·날씨·낮/밤 배경과 완성 JPEG는 전송하지 않습니다.
- 완성 일기의 사진·본문·JPEG 보관과 달력 조회에는 네트워크 요청이 없습니다. 완성 성공 뒤 활동일 적립만 별도 진행 API를 호출합니다.
- 사용자 ID와 IP는 `SHA-256("user|ip:{RATE_LIMIT_SALT}:{원본}")` 형식으로 각각 hash한 뒤 RPC에 전달하며 원본 IP를 DB에 보내지 않습니다.
- 일반 요청 로그에는 action, 국가 header, client ID 존재 여부, body byte 크기와 결과 code만 남기도록 구현되어 있습니다. 사진·일기·원본 IP 값은 기록하지 않습니다.

## 서버 환경 변수

| 변수                        | 용도                                                  |
| --------------------------- | ----------------------------------------------------- |
| `OPENAI_API_KEY`            | OpenAI 분석·이미지 요청                               |
| `RATE_LIMIT_SALT`           | client ID·IP hash salt                                |
| `SUPABASE_URL`              | quota RPC를 호출할 프로젝트 URL                       |
| `SUPABASE_SECRET_KEYS`      | JSON의 `default` secret key                           |
| `SUPABASE_SERVICE_ROLE_KEY` | legacy fallback secret                                |
| `OPENAI_MODEL`              | 분석 model override                                   |
| `OPENAI_IMAGE_MODEL`        | 이미지 model override                                 |
| `OPENAI_IMAGE_QUALITY`      | `low`, `medium`, `high`                               |
| `DIARY_AI_TEST_MODE`        | DB quota를 읽거나 차감하지 않는 서버 전용 테스트 모드 |
| `DIARY_AI_DEBUG`            | 값·원문 없이 상세 timing·counter 진단 로그 활성화     |

`DIARY_AI_TEST_MODE`는 브라우저에 공개되는 `VITE_AI_TEST_MODE`와 별개입니다.

자세한 데이터 흐름과 확인 필요 항목은 [보안·데이터 처리](./security.md)를 참고하세요.

## OpenAPI 상태

Edge Function과 SQL 계약은 저장소에서 version 관리하지만 `openapi.yaml`은 아직 생성하지 않았습니다. 배포 자동 검증을 추가할 때 현재 action union과 JSON validation을 기준으로 함께 생성합니다.

## 관련 문서

- [기능 명세](./functional-specification.md)
- [ERD](./erd.md)
- [아키텍처](./architecture.md)
- [보안·데이터 처리](./security.md)
