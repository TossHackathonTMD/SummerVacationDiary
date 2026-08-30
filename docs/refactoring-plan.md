# 리팩토링 현황

[README로 돌아가기](../README.md) · [아키텍처](./architecture.md)

## 목적

이 문서는 현재 코드의 구조 정리 현황과 다음 변경에서 주의할 기술 부채를 기록합니다. 기능 요구사항은 [기능 명세](./functional-specification.md)를 기준으로 합니다.

## 완료된 정리

- [x] AI 사용량 안내를 `AiQuotaNotice`와 통합 quota 상태로 정리
- [x] 단계·모달·달력의 버튼 표현을 `DiaryButton`으로 공통화
- [x] 별표·체크·첨삭 자산 위치 선택을 `positionedAsset`으로 공통화
- [x] 이미지 디코딩·크기 검증을 `utils/image.ts`로 통합
- [x] 사진 변환의 중복 과금 방지를 cache·ledger·진행 Promise로 분리
- [x] 분석 결과를 입력 signature 기준으로 캐시하고 오래된 응답 반영 차단
- [x] 완성 일기 저장을 index와 일기별 record로 분리해 목록 조회 시 이미지 로드를 방지
- [x] 토스 `Storage`와 브라우저 localStorage를 하나의 `diaryStore` 계약으로 통합
- [x] 사진 자르기를 원본 기반 `cover` 3:2·90° 회전 좌표로 통일
- [x] 미리보기 처리 중 하단 작업 바를 유지하고 카드·도장 공개 완료 시점까지 잠금
- [x] 첨삭 체크·별표 자산을 투명도와 원본 질감을 보존하는 PNG로 교체
- [x] 연속 기록 조회·완료 동기화를 `useDiaryProgress`와 `diaryProgress` 서비스로 분리
- [x] 제작 화면 이동을 History API와 토스 `backEvent`에 연결하고 iOS WebView 앞·뒤 스와이프를 차단

## 현재 기술 부채

### 권장 우선순위

1. 자동 테스트 도입
   - 이미지 검증, 날짜 계산, quota parser, `diaryStore` 손상 복구와 하루 2개 제한을 우선 대상으로 합니다.
   - 현재 품질 gate는 lint·TypeScript·build와 수동 회귀뿐입니다.
2. `App.tsx` 흐름 분리
   - 온보딩, 제작 wizard, 완성 처리, 달력 이동 상태가 한 컴포넌트에 모여 있습니다.
   - router 도입보다 먼저 완료 orchestration과 navigation state를 hook으로 분리하는 편이 현재 구조에 맞습니다.
3. 저장소 용량 가시화
   - 완성 JPEG를 data URL로 보관하므로 기기 저장소 한도에 빨리 도달할 수 있습니다.
   - 항목 크기 측정, 오래된 기록 정리 UX, 실제 토스 `Storage` 한도 검증이 필요합니다.
4. Edge Function·DB migration version 관리
   - Edge Function과 전체 DB bootstrap은 저장소에 있고 2026-08-30 운영 v136 확인 기록은 `docs/deployment.md`에 남겼지만, 변경 단위 migration과 자동 배포 이력은 없습니다.
   - 운영 DB의 `pg_get_functiondef` 결과와 table DDL을 순차 migration으로 보관하고 배포 version을 함께 기록해야 rollback과 환경 재현이 가능합니다.
5. 문서와 코드 계약 자동 확인
   - 환경 변수, storage key, 입력 길이, API action 같은 값은 코드 변경 시 문서가 어긋날 수 있습니다.

### 유지해야 할 경계

- `diaryStore`: 완성 기록 보관
- `useDiaryDraft`: 현재 작성 중인 임시 사본
- `diaryExport`: JPEG 파일 내보내기
- `diaryShare`: 앱 링크 공유
- `diaryProgress`: 방문·완료 기록, 로컬 대체 경로와 당일 실패 재시도
- `supabaseEdge`: 외부 AI Function 호출과 공통 오류·quota·progress snapshot
- `supabase/diary-ai/index.ts`: OpenAI 요청, 지역 제한, quota와 진행 기록 orchestration
- PostgreSQL RPC: 사용자·IP·서비스 counter의 원자적 read·consume·refund

서로 이름이 비슷해도 보관, 파일 저장, 앱 공유는 사용자 결과가 다르므로 하나의 서비스로 합치지 않습니다.

## 완료 기준

- 기존 사용자 문구와 표시 조건을 의도 없이 바꾸지 않는다.
- 사진·분석 요청의 중복 방지와 quota 차감 규칙을 유지한다.
- 미리보기, 저장 JPEG, 일기 달력 JPEG가 동일한 결과를 사용한다.
- `npm run lint`
- `./node_modules/.bin/tsc --noEmit -p tsconfig.app.json`
- `npm run build`
