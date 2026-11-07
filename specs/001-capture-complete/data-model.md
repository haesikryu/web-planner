# 첫 기능 논리 데이터 설계

상태: PostgreSQL·Drizzle 실행 스키마와 SQL 마이그레이션 구현. 각 변경의 실제 PostgreSQL·격리 DB 검증 결과는 최신 검증 기록을 따른다.

| 엔터티 | 핵심 필드 | 제약 |
|---|---|---|
| users | id, timezone, created_at | timezone은 검증된 IANA ID |
| identities | user_id, provider_id, subject | google 공급자·고정 issuer 검증, provider_id·subject 유일, 이메일 자동 병합 금지 |
| sessions | id, token_hash, user_id, created_at, updated_at, expires_at | bearer 원문은 해시 저장. updated_at은 마지막 활동, created_at은 절대 만료 기준. CSRF는 세션 ID와 서버 비밀로 도출 |
| verifications | id, identifier, value, expires_at, created_at, updated_at | OAuth state·PKCE의 단기 보관과 일회 소비 |
| tasks | id, owner_id, title, priority, kind, status, scheduled_date, due_date, is_unprocessed, completed_at, version, created_at, updated_at | owner 필수, title 규칙, version 양수 |
| task_activities | id, owner_id, task_id, type, occurred_at, invalidated_by | 완료·완료취소·미룸·취소·복원·실행일·정리·우선순위·유형 변경 기록 |
| journal_entries | owner_id, entry_date, content, version, updated_at | owner·entry_date 복합 기본키, 0~10,000 코드 포인트, 양수 저장 버전 |
| schedule_entries | owner_id, entry_date, slots, version, updated_at | owner·entry_date 복합키, 정렬된 최대 36개 슬롯 JSONB, 양수 저장 버전 |
| idempotency_records | owner_id, method, path, key, request_hash, state, response, expires_at | owner·method·path·key 유일 |

tasks의 날짜 필드는 NULL 허용 달력 날짜, 시각 필드는 UTC instant다. 첫 기능의 due_date는 원문 보존용 nullable 필드이며 이 기능 API에서 신규 지정·변경하지 않는다. 후속 명세에서 추가한다. status는 open·completed·deferred·canceled이고 화면에 □ 진행 전·✓ 완료·→ 미룸·× 취소로 표시한다. 우선순위 priority는 high·medium·low(상·중·하)다. 등록 화면은 제목만 입력받고 selected date를 scheduledDate로, isUnprocessed=false로 보내 priority의 기본값 medium을 사용한다. 현재 화면은 view=day에서만 우선순위를 선택한다. 날짜를 생략한 API 생성의 날짜 없음·미정리 기본값은 유지한다.

기존 kind 필드의 task·appointment·event와 기본값 task는 기존 자료·API·요청 재생 호환을 위해 내부적으로 보존한다. 유형은 현재 사용 기능이 아니며 화면에서 선택·표시하지 않고 생성·수정 폼도 kind를 전송하지 않는다. `0002_task_priority_kind_and_status.sql`은 기존 제목·날짜·버전을 보존한 채 priority·kind를 추가한다. 유형 화면 제거 때문에 기존 API·DB 제약을 바꾸거나 kind 값을 재기록하지 않는다. 자유 기록은 별도 `0003_daily_journal.sql`로 추가하며 기존 과제 자료를 변경하지 않는다. 자유 기록을 추가한 0003 이후 일정의 0004를 포함하면 실행 테이블은 9개, 순차 마이그레이션은 5개다.

완료 상태는 completed_at 존재 여부와 일치한다. completed에서 어느 다른 상태로 이동해도 completed_at을 비우고 이전 완료 활동을 completion_undone 활동과 연결한다. canceled·deferred에서 다시 completed로 전환하면 새로운 완료 활동을 생성하며 유효 완료 활동은 하나만 남는다. 미룸은 상태 표시만 변경하고 실행일을 유지하며, 날짜 변경은 별도 명시적 수정으로 처리한다. 취소는 삭제가 아니므로 같은 날짜에서 표시하고 open으로 복원할 수 있다. 활동 행은 과제 소유자와 같은 owner를 강제하며 다른 사용자의 과제를 연결하지 않는다.

## 하루 할 일 한도와 일정 저장 (V-12·V-14)

하루 할 일 한도는 owner_id·scheduled_date의 모든 상태를 합산한다. 같은 날짜의 미정리 항목·완료·취소도 각각 1개이며 신규 생성 또는 다른 날짜에서의 이동을 처리할 때 최대 5개를 검사한다. `task-day` scope의 날짜별 advisory lock과 개수 확인을 같은 쓰기 트랜잭션 안에서 수행한다. 가득 차면 422 DAILY_TASK_LIMIT로 거부하고 과제·활동·성공 재생 상태를 남기지 않는다. 날짜가 그대로인 제목·상태 변경과 기존 5개 초과 자료의 읽기를 제한하지 않으며, 일괄 삭제나 잘라내기 마이그레이션은 없다.

기존 view=scheduled는 완료를 제외하는 호환 조회다. 신규 view=day는 해당 실행일의 모든 상태를 생성 시각·ID 순으로 반환하며, 현재 화면과 5개 집계가 사용한다. 날짜 없는 과제는 한도에 포함하지 않는다. API의 POST는 기존 제목만 생성도 유지하지만, 화면은 title·scheduledDate·isUnprocessed=false를 명시하여 바로 하루 할 일에 넣는다.

`0004_daily_schedule.sql`은 `schedule_entries`와 JSONB 검증 함수를 추가한다. 각 행은 계정·날짜별 36칸 일정 문서이고 자유 기록·과제와 독립된다. slots는 `{startMinute, title}` 객체의 배열이며 시작 분 360~1410, 30분 배수, 중복 없음, 오름차순을 강제한다. 제목은 NFC·trim 후 1~200 코드 포인트이고 CR·LF·NUL은 금지한다. API에서 입력 순서를 정규화하고 DB 제약으로 배열 구조·중복·범위·제목을 재검증한다. 빈 배열은 유효하며 updated_at은 UTC instant다.

API 0.7의 `GET/PUT /api/schedule/{date}`는 date·slots·version·updatedAt과 ETag를 사용한다. 없는 날의 GET은 빈 slots·v0·updatedAt null이며 행을 만들지 않는다. 빈 최초 PUT과 현재 정규화 배열이 같은 PUT은 no-op이다. 실제 저장은 version을 증가시키며 슬롯 삭제도 배열 교체로 원자적으로 반영한다.

일정 PUT은 세션·Origin·CSRF·요청 키·If-Match 확인 후 재생을 먼저 검사하고, `schedule` scope의 owner·날짜 advisory lock과 행 잠금으로 v0 최초 저장 경합까지 보호한다. 오래된 버전은 412, 같은 키의 다른 본문·버전은 409다. 일정 변경과 재생 응답은 같은 트랜잭션에 커밋·롤백하고, 공통 24시간 보관 기간의 재시도 정책을 적용한다. 일정은 과제 활동을 만들지 않으며 task-day·journal·schedule 잠금 scope를 구분한다.

일정의 시각은 로컬 날짜에 붙은 표시용 분 값이다. 06:00~24:00의 36칸은 시간대·DST에 따라 UTC 이벤트로 재계산하지 않고, 시간대 변경으로 저장 날짜나 슬롯을 이동하지 않는다. 반복·기간 이벤트·알림·외부 캘린더와의 연결은 후속 모델에서 다룬다.

## 날짜별 자유 기록과 동시 저장 (V-13)

`journal_entries`의 원본 키는 인증된 owner_id와 entry_date다. entry_date는 0001-01-01~9999-12-31의 달력 날짜이며 과제 실행일·마감일·완료 시각과 독립된다. updated_at은 UTC instant다. 계정 시간대는 처음 열 날짜를 정하지만 기존 글의 키나 내용을 시간대 변경으로 옮기지 않는다. users에 대한 FK는 계정 삭제 시 연관 행을 제거하며 모든 읽기·쓰기에는 현재 owner 조건이 필요하다.

본문 content는 일반 텍스트이며 CRLF를 LF로 바꾼 뒤 최대 10,000 Unicode 코드 포인트를 허용한다. NUL은 API·공통 규칙에서 거부하고 PostgreSQL text에도 저장하지 않는다. trim·NFC 정규화는 하지 않으며 연속 공백·빈 줄·마지막 줄바꿈을 보존한다. 빈 문자열은 유효하다. DB는 길이·CRLF·날짜 범위·양수 저장 버전 제약을 유지하고, 클라이언트와 서버는 `src/domain/journal.ts`를 공유한다.

OpenAPI 0.7의 `GET /api/journal/{date}`와 `PUT /api/journal/{date}`는 `{date, content, version, updatedAt}`과 ETag를 사용한다. 없는 날짜는 행을 만들지 않고 빈 content·version 0·updatedAt null·ETag `"v0"`를 반환한다. DB에 실제 저장된 행은 version 1 이상이다. 없는 날짜에 빈 본문을 PUT하면 no-op으로 v0를 유지하며, 기존 글을 비우면 같은 행을 빈 본문으로 변경하고 버전을 증가시킨다.

자유 기록의 쓰기 순서는 다음과 같다.

1. 세션·Origin·CSRF·요청 키·본문·날짜·If-Match를 검증한다. 본문은 `{content}`만 받고 소유자는 세션에서 결정한다. journal 경로만 최대 65,536바이트의 요청 본문을 허용하며 다른 API의 크기 제한을 확대하지 않는다.
2. owner·method·path·key 범위에서 키를 선점하거나 같은 정규화 본문·If-Match의 보관 중 응답을 먼저 재생한다. 같은 키의 다른 본문·버전은 409이며 이전 버전을 사용한 동일 재시도도 재생 대상이다.
3. 트랜잭션에서 owner·날짜의 advisory lock을 획득한 뒤 기존 행을 잠근다. 행이 아직 없는 최초 저장도 직렬화하여 행 잠금만으로 빠지는 신규 삽입 경합을 막는다. 제한 시간 내 잠금을 얻지 못하면 409 REQUEST_IN_PROGRESS로 같은 요청 재시도를 안내한다.
4. 현재 행 버전 또는 없는 날짜의 0과 If-Match를 비교한다. 오래된 버전은 412이며 글을 덮어쓰지 않는다. 현재 본문과 같으면 버전·updated_at을 바꾸지 않는다. 실제 변경이면 신규 삽입 또는 조건부 수정을 수행한다.
5. 글 변경과 재생 응답을 같은 트랜잭션에 저장하고 커밋 후 200을 반환한다. 중간 실패는 글과 처리 완료 키를 함께 롤백한다. 글 변경을 과제 완료 활동으로 기록하지 않는다.

같은 날짜에 서로 다른 키로 처음 저장하는 두 v0 요청은 둘 다 성공하여 덮어쓸 수 없다. 한 요청이 v1을 만들면 다른 요청은 412를 받거나 잠금 경합 시 재시도 가능한 응답을 받는다. 같은 키의 동시 재시도는 하나의 결과만 저장한다. 재생 보관 기간 24시간이 지나면 클라이언트는 불확실 요청을 재전송하지 않고 GET 확인 후 명시적 복구를 진행한다.

화면 초안은 DB 행과 다르다. 같은 계정의 날짜별 메모리 캐시에 본문·읽은 버전·저장 상태를 보관하여 날짜 이동 때 초안을 유지한다. 이전 날짜·계정의 지연 응답이 현재 글을 덮지 않으며 계정 변경 때 캐시를 폐기한다. 성공 저장은 재조회해 확인하고, 미저장 초안은 새로고침·이탈 확인 후 사라질 수 있다. 체험 경로는 같은 계약을 sessionStorage에 구현하되 실제 DB·인증 쿠키·제품 API와 연결하지 않는다.

## 원자적 과제 쓰기

1. 세션·CSRF·입력 형식 확인.
2. 사용자 범위에서 대상 과제 소유권 확인.
3. 키 선점 또는 동일 요청 재생 확인.
4. 버전 조건을 포함한 과제 삽입·수정.
5. 필요한 활동과 재생 응답 저장.
6. 트랜잭션 커밋 후 성공 응답.

동일 요청이 동시에 도착해도 유일 제약으로 중복을 차단한다. 완료 취소·재완료와 활동 변경은 과제 버전의 경쟁 조건 안에서 수행한다. 실패한 트랜잭션이 완료 활동이나 처리 완료 키만 남기지 않도록 한다.

## 조회와 인덱스

모든 조회에는 owner 조건이 포함된다. 초기 인덱스 후보는 owner·is_unprocessed·created_at, owner·status·scheduled_date, owner·completed_at, task_id·occurred_at이다. 실제 실행 계획과 부하 검증 후 확정한다.

오늘 완료 조회는 현지 날짜 범위를 UTC 구간으로 변환해 현재 유효 완료 시각으로 조회한다. 날짜 경계 계산은 공통 모듈 하나가 담당한다. 모든 목록은 cursor 기반 페이지 처리, 기본 50개·최대 100개다. cursor에는 조회 조건을 결합하고 다른 사용자·다른 조회에 재사용하면 400으로 거부한다.

## 보관과 운영

실행 기준은 `src/server/db/schema.ts`와 migrations의 SQL 이력이다. users는 검증된 기기 시간대·설정 버전 1로 생성하며 제안이 없으면 UTC다. identities는 공급자 토큰·비밀번호 저장을 CHECK로 차단한다. verifications의 10분 state·PKCE는 라이브러리가 일회 소비한다. T-005의 Unicode 제목·시간대 규칙을 API와 화면에서 공유한다. 두 번째 마이그레이션은 과제당 현재 유효 완료 활동 하나와 양수 설정 버전을 강제한다. db:prune으로 만료 기록을 제한된 묶음으로 정리하며 운영 주기는 T-011에서 정한다.

전체 사용자 삭제·휴지통 정책은 FEAT-001의 실행 범위 밖이지만 이후 도입을 막지 않도록 owner 경계를 유지한다. 운영 데이터 내보내기·삭제와 백업 보관 기간은 별도 명세에서 연결한다. 자유 기록 본문을 포함한 개인정보 본문·제목·토큰·키 응답을 일반 로그에 기록하지 않는다. idempotency 응답 저장소도 개인 데이터이므로 접근 제어와 TTL 정리를 적용한다.

## 우선순위·상태 조회와 기존 필드 호환

- 현재 day 조회는 모든 상태를 포함한다. 기존 scheduled 조회는 completed를 제외하여 미룸·취소 기호를 유지한다. overdue는 open·deferred만 포함하며 취소 항목은 제외한다. 입력함은 기존 is_unprocessed 규칙을 유지한다.
- priority 변경과 호환 API의 kind 변경은 버전 조건과 요청 재생·소유권 검사를 거치고 활동을 남긴다. 동일 값 변경은 버전과 활동을 늘리지 않는다. 현재 화면은 kind 변경 기능을 제공하지 않으며 다른 필드의 변경에도 기존 kind를 유지한다.
- 이전 API 요청의 hash를 보존하기 위해 신규 필드가 생략되면 정규화된 요청에 억지로 기본값을 추가하지 않는다. 과거 응답을 재생할 때만 누락된 priority·kind를 medium·task로 보충하며 저장된 원문 응답·버전은 변경하지 않는다.

- PATCH 결과가 날짜 없는 비완료 항목이면 is_unprocessed=true를 보충해 입력함 접근을 보장한다. 명시적인 false 지정은 422로 거절한다. 완료에서 다른 상태로 복원하거나 실행일을 비울 때도 동일하며, 보충값은 행 잠금과 버전 검사 후에 계산하고 원래 요청의 재생 hash는 유지한다. 보충으로 실제 값이 바뀌면 같은 트랜잭션에서 버전과 processing_changed 활동을 기록하며, 이미 입력함에 있으면 동일 값 변경은 no-op이다. 과거 자료의 일괄 보정은 수행하지 않는다.
