# 첫 기능 수용 조건과 검증 연결

V-01~V-11의 첫 기능 경계를 단위·계약·실제 PostgreSQL·브라우저로 검증했다. V-08의 실제 Google 계정·공급자 환경 시험과 운영 수용 검수는 남아 있다. 자동 시나리오 통과와 사용자 수용 승인은 구분한다.

2026-11-07의 최신 사용자 요청에 따라 V-12는 선택 날짜에 제목만 직접 등록하고 우선순위·상태를 지정하는 흐름과 하루 5개 제한을 검수한다. 날짜 없는 제목만의 API 생성은 기존 입력함 호환 검수로 유지한다. 유형 기능은 화면에서 제거하고 기존 kind는 자료·API·재생 호환으로만 검수한다. V-12의 구현 기준과 회귀 검수 연결은 아래와 같으며 실제 실행 결과는 검증 기록에서 별도로 관리한다. 같은 날의 후속 사용자 요청은 V-13으로 연결하여 왼쪽 할 일·오른쪽 날짜별 자유 기록을 첫 기능에 확장한다. 후속 V-14는 왼쪽 06:00~24:00의 36칸 일정을 검수한다. 전체 일기·회고·일정 요구를 완료 처리하지 않는다.

| 검증 ID | 수용 시나리오 | 관련 요구 | 검증 수준 |
|---|---|---|---|
| V-01 | 목표 없는 과제 생성·날짜 생략 API의 입력함 호환 | FR-01-02, FR-02-03 | 통합·E2E |
| V-02 | 빈 제목·길이·정규화 | FR-02-02, Q-001 | 단위·계약 |
| V-03 | 중복 생성과 동시 요청 | FR-02-04 | 통합 |
| V-04 | 날짜 배정·완료·원본 공유와 실제 완료일 기록 | FR-04-02, FR-04-05, FR-05-05 | 통합·E2E |
| V-05 | 저장 실패와 불확실 응답 재시도 | FR-02-05 | 통합·E2E |
| V-06 | 비로그인·타인 항목 격리 | FR-01-03, NFR-05 | 통합·보안 |
| V-07 | 재생 키 만료·본문 충돌·트랜잭션 실패 | FR-02-04, FR-02-05 | 통합·계약 |
| V-08 | Google 검증·세션·CSRF·계정 변경·본인 허용 목록과 기존 세션 철회 | D-01, FR-01, FR-14, NFR-05 | 통합·보안 |
| V-09 | 완료 취소·재완료와 유효 활동 | FR-07-04, Q-002 | 통합·E2E |
| V-10 | 자정·DST·기기/계정 시간대 차이 | D-05, FR-01-04, FR-06-03 | 단위·통합 |
| V-11 | 버전 충돌·동일 요청 재전송 | FR-14-03, FR-14-04 | 통합·E2E |
| V-12 | 선택 날짜 직접 등록·모든 상태를 세는 5개 제한·이동 경합, 우선순위·상태·복원, 입력함 접근·편집 보호·기존 자료 호환 | 최신 사용자 요청(2026-11-07), FR-02-05, FR-07-04, FR-14-03, FR-14-04 | 단위·계약·마이그레이션·통합·E2E |
| V-13 | 왼쪽 할 일·오른쪽 날짜별 자유 기록, 본문 보존, owner·날짜 격리, 명시적 저장·초안·경고·잠금, 신규 저장 경합·재생·충돌·응답 유실 복구 | 최신 사용자 요청(2026-11-07), FR-02-05, FR-14-03, FR-14-04, NFR-02, NFR-05 | 단위·계약·마이그레이션·통합·E2E |
| V-14 | 06:00~24:00의 36칸 일정·날짜별 저장, 슬롯 검증·owner 분리·동시 첫 저장·재생·초안·잠금·충돌 복구 | 최신 사용자 요청(2026-11-07), FR-02-05, FR-14-03, FR-14-04, NFR-02, NFR-05 | 단위·계약·마이그레이션·통합·E2E |

추가된 Q-001·Q-002·D-05 세부 설계값은 원문 요구의 구체화로 검토한다. 관련 FR 전체를 이 첫 기능만으로 완료 처리하지 않는다. 접근성은 NFR-02를 적용하고 키보드·포커스·알림·360px 레이아웃을 확인한다. 성능과 복원은 원문 NFR-03~06의 시험 조건을 별도로 구성한다.

실행 범위는 [과제 흐름 검증](../../docs/verification/planner-core.md)에 기록했다. rules.test.ts는 V-02·V-10, product-api.test.ts는 V-01~V-04·V-06~V-07·V-09~V-11, auth-database.test.ts는 합성 V-08을 검증한다. planner.spec.ts는 입력·오늘·완료 취소·응답 유실·24시간 제한·계정 전환·충돌 선택을 확인한다. Gherkin은 검토 가능한 시나리오이며 별도의 Cucumber 실행기를 사용했다는 주장은 하지 않는다.

V-12는 다음 테스트와 연결한다. 기존 검증 그룹을 대체하지 않고 저장 실패(V-05), 완료 활동(V-09), 버전·재생(V-07·V-11)의 확장 사례로 함께 검토한다.

| V-12 검수 범위 | 구현·검증 연결 |
|---|---|
| high·medium·low 검증, 상태 전환·목록 필터·입력함 복귀·동일 값·재생, 내부 kind의 기존 API 계약 보존 | `src/domain/task-options.ts`, `src/server/product/tasks.ts`, `contracts/openapi.json`, `tests/unit/product-api.test.ts` |
| 기존 DB 항목에 medium·task 추가, 제목·실행일·상태·버전 보존과 새 제약 | `migrations/0002_task_priority_kind_and_status.sql`, `tests/unit/task-options-migration.test.ts` |
| v1 체험 자료 보존, 성공한 저장에서만 스키마 변경, 실패 보존, API와 같은 입력함·상태 규칙 | `src/app/demo/transport.ts`, `tests/unit/demo-transport.test.ts` |
| 선택 날짜 직접 등록, view=day에서만 상·중·하 선택, 생성·수정 폼의 우선순위 제거와 모든 화면의 유형 제거, □·✓·→·× 상태 표시, 실행일 유지·취소 복원·편집 보호·새로고침 후 확인 | `src/app/planner.tsx`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |

새 필드를 생략한 기존 요청의 해시를 유지하고, 과거 응답을 재생할 때만 누락된 기본값을 보충한다. kind는 현재 사용 기능이 아니며 기존 DB·브라우저 자료와 API·재시도의 호환을 위해 보존한다. V-12 유형 화면 단순화는 백엔드·API·마이그레이션을 변경하지 않는다. V-13 자유 기록은 0003, V-14 일정은 0004로 확장하며 현재 계약은 API 0.7이다. 하루 5개 한도와 view=day는 V-12의 추가 계약이다. 기존 자료 전체의 정리 상태도 일괄 보정하지 않는다. 구조 검사 `check:spec`의 통과는 V-12 제품 동작이나 실제 OAuth 검증 통과를 뜻하지 않는다.


## V-13 자유 기록 검수 연결

| V-13 검수 범위 | 구현·검증 연결 |
|---|---|
| 일반 텍스트 10,000 코드 포인트, CRLF→LF, NUL 거부, 공백·빈 줄·빈 글 보존 | `src/domain/journal.ts`, `tests/unit/product-api.test.ts`, `tests/unit/demo-transport.test.ts` |
| 없는 날짜 v0, owner·날짜 분리, Origin·CSRF·If-Match, 동일 본문 no-op, 요청 크기 제한 | `src/app/api/journal/[date]/route.ts`, `src/server/product/journal.ts`, `contracts/openapi.json`, `tests/unit/product-api.test.ts` |
| owner·날짜 복합키, 기존 자료 보존, 원자적 최초 저장·두 v0 경합·동일 키 재생·롤백·잠금 제한 | `migrations/0003_daily_journal.sql`, `src/server/db/schema.ts`, `src/server/product/journal.ts`, `tests/unit/product-api.test.ts`, `tests/unit/auth-database.test.ts` |
| 왼쪽 상단 하루 할 일·일정표·접힌 이전 기록, 오른쪽 자유 기록, 날짜별 본문·초안·명시적 저장·공백/줄바꿈·새로고침 | `src/app/planner.tsx`, `src/app/journal-editor.tsx`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |
| 다른 날짜의 초안까지 이탈 경고, 계정 변경 폐기·일시 401 초안 보존과 복구, 수정·저장·pending의 상호 잠금 | `src/app/planner.tsx`, `src/app/journal-editor.tsx`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |
| 성공 응답 유실 후 같은 키와 version 재생, 412에서 두 선택, 과거 날짜 지연 응답 격리 | `src/app/journal-editor.tsx`, `tests/e2e/planner.spec.ts` |
| 24시간 후 재전송 차단과 GET 확인, 저장된 글 불일치 비교, 조회 실패 복구 | `src/app/journal-editor.tsx`, `acceptance.feature`의 V-13·V-05·V-07·V-11 시나리오와 추가 검수 |
| 기존 체험 자료와 저장 실패 보존, 날짜별 저장·복원, 제품 API·쿠키와 분리 | `src/app/demo/transport.ts`, `tests/unit/demo-transport.test.ts`, `tests/e2e/demo.spec.ts` |

V-13의 테스트 연결은 검증 범위를 명시하며 통과 결과를 대신하지 않는다. 실제 PostgreSQL의 advisory lock·신규 삽입 경합은 해당 환경에서 확인하고, 메모리 DB 결과로 대신 통과 처리하지 않는다. 브라우저는 데스크톱·360px 모바일에서 저장과 실패 복구를 확인한다. `check:spec`는 API 참조와 V-13 태그 연결의 구조 검사이며 사용자 수용 승인·실제 OAuth·운영 배포 준비를 뜻하지 않는다.


## V-12 한도 확장과 V-14 일정 검수 연결

| 검수 범위 | 구현·검증 연결 |
|---|---|
| 선택 날짜 직접 생성, 기존 날짜 없는 API 생성·scheduled 호환, day 전체 상태 조회 | `src/app/planner.tsx`, `src/server/product/tasks.ts`, `contracts/openapi.json`, `tests/unit/product-api.test.ts`, `tests/e2e/planner.spec.ts` |
| 완료·취소 포함 5개, 여섯 번째 거부, 날짜 이동 후 자리 확보·대상 날짜 제한, 생성·이동 동시 경합과 롤백, 기존 5개 초과 보존 | `src/server/product/tasks.ts`, `src/server/product/date-lock.ts`, `tests/unit/product-api.test.ts`, `tests/unit/demo-transport.test.ts`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |
| 36칸·360~1410·30분 배수·중복·정렬·NFC 제목·빈 배열 검증 | `src/domain/schedule.ts`, `tests/unit/schedule.test.ts`, `contracts/openapi.json` |
| schedule_entries와 기존 자료 보존·DB 제약 | `migrations/0004_daily_schedule.sql`, `src/server/db/schema.ts`, `tests/unit/schedule-migration.test.ts` |
| owner·날짜 분리, v0·no-op·조건부 쓰기·최초 저장 경합·재생·412·롤백 | `src/app/api/schedule/[date]/route.ts`, `src/server/product/schedule.ts`, `tests/unit/product-api.test.ts` |
| 36개 입력 이름·첫/마지막 행·스크롤·날짜별 저장/초안·새로고침·모바일 가로 넘침 | `src/app/schedule-editor.tsx`, `src/app/planner.tsx`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |
| 일정 응답 유실 후 같은 키/version 재생, 412 두 선택, 계정 전환 초안 폐기, 할 일 수정 중 잠금 | `src/app/schedule-editor.tsx`, `tests/e2e/planner.spec.ts`, `tests/e2e/demo.spec.ts` |
| 체험 일정 저장과 API 미호출, 기존 저장 자료·저장 실패 보존 | `src/app/demo/transport.ts`, `tests/unit/demo-transport.test.ts`, `tests/e2e/demo.spec.ts` |

반복·기간 이벤트·외부 캘린더 동기화는 V-14에 포함하지 않는다. 9개 테이블·5개 마이그레이션·11개 제품 API 작업은 현재 구현 범위이며, 구조 검사만으로 실제 PostgreSQL 경합·브라우저·사용자 수용 검수를 완료 처리하지 않는다. 새 검증 결과는 진행 현황과 검증 기록에서 별도로 확정한다.
