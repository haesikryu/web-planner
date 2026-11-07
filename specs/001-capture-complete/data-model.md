# 첫 기능 논리 데이터 설계

상태: PostgreSQL·Drizzle 실행 스키마와 SQL 마이그레이션 구현. 각 변경의 실제 PostgreSQL·격리 DB 검증 결과는 최신 검증 기록을 따른다.

| 엔터티 | 핵심 필드 | 제약 |
|---|---|---|
| users | id, timezone, created_at | timezone은 검증된 IANA ID |
| identities | user_id, provider_id, subject | google 공급자·고정 issuer 검증, provider_id·subject 유일, 이메일 자동 병합 금지 |
| sessions | id, token_hash, user_id, created_at, updated_at, expires_at | bearer 원문은 해시 저장. updated_at은 마지막 활동, created_at은 절대 만료 기준. CSRF는 세션 ID와 서버 비밀로 도출 |
| tasks | id, owner_id, title, priority, kind, status, scheduled_date, due_date, is_unprocessed, completed_at, version, created_at, updated_at | owner 필수, title 규칙, version 양수 |
| task_activities | id, owner_id, task_id, type, occurred_at, invalidated_by | 완료·완료취소·미룸·취소·복원·실행일·정리·우선순위·유형 변경 기록 |
| idempotency_records | owner_id, method, path, key, request_hash, state, response, expires_at | owner·method·path·key 유일 |

tasks의 날짜 필드는 NULL 허용 달력 날짜, 시각 필드는 UTC instant다. 첫 기능의 due_date는 원문 보존용 nullable 필드이며 이 기능 API에서 신규 지정·변경하지 않는다. 후속 명세에서 추가한다. status는 open·completed·deferred·canceled이고 화면에 □ 진행 전·✓ 완료·→ 미룸·× 취소로 표시한다. 우선순위 priority는 high·medium·low(상·중·하)다. 등록 화면은 제목만 받고 priority의 기본값 medium을 사용하며, 등록 후 scheduled 목록에서만 우선순위를 선택한다.

기존 kind 필드의 task·appointment·event와 기본값 task는 기존 자료·API·요청 재생 호환을 위해 내부적으로 보존한다. 유형은 현재 사용 기능이 아니며 화면에서 선택·표시하지 않고 생성·수정 폼도 kind를 전송하지 않는다. 이미 제공된 세 번째 마이그레이션은 기존 제목·날짜·버전을 보존한 채 priority·kind를 추가한다. 이번 화면 단순화로 API·DB 제약이나 마이그레이션을 변경하거나 기존 kind 값을 재기록하지 않는다.

완료 상태는 completed_at 존재 여부와 일치한다. completed에서 어느 다른 상태로 이동해도 completed_at을 비우고 이전 완료 활동을 completion_undone 활동과 연결한다. canceled·deferred에서 다시 completed로 전환하면 새로운 완료 활동을 생성하며 유효 완료 활동은 하나만 남는다. 미룸은 상태 표시만 변경하고 실행일을 유지하며, 날짜 변경은 별도 명시적 수정으로 처리한다. 취소는 삭제가 아니므로 같은 날짜에서 표시하고 open으로 복원할 수 있다. 활동 행은 과제 소유자와 같은 owner를 강제하며 다른 사용자의 과제를 연결하지 않는다.

## 원자적 쓰기

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

전체 사용자 삭제·휴지통 정책은 FEAT-001의 실행 범위 밖이지만 이후 도입을 막지 않도록 owner 경계를 유지한다. 운영 데이터 내보내기·삭제와 백업 보관 기간은 별도 명세에서 연결한다. 개인정보 본문·제목·토큰·키 응답을 일반 로그에 기록하지 않는다. idempotency 응답 저장소도 개인 데이터이므로 접근 제어와 TTL 정리를 적용한다.

## 우선순위·상태 조회와 기존 필드 호환

- 날짜별 scheduled 조회는 completed를 제외하여 미룸·취소 기호를 유지한다. overdue는 open·deferred만 포함하며 취소 항목은 제외한다. 입력함은 기존 is_unprocessed 규칙을 유지한다.
- priority 변경과 호환 API의 kind 변경은 버전 조건과 요청 재생·소유권 검사를 거치고 활동을 남긴다. 동일 값 변경은 버전과 활동을 늘리지 않는다. 현재 화면은 kind 변경 기능을 제공하지 않으며 다른 필드의 변경에도 기존 kind를 유지한다.
- 이전 API 요청의 hash를 보존하기 위해 신규 필드가 생략되면 정규화된 요청에 억지로 기본값을 추가하지 않는다. 과거 응답을 재생할 때만 누락된 priority·kind를 medium·task로 보충하며 저장된 원문 응답·버전은 변경하지 않는다.

- PATCH 결과가 날짜 없는 비완료 항목이면 is_unprocessed=true를 보충해 입력함 접근을 보장한다. 명시적인 false 지정은 422로 거절한다. 완료에서 다른 상태로 복원하거나 실행일을 비울 때도 동일하며, 보충값은 행 잠금과 버전 검사 후에 계산하고 원래 요청의 재생 hash는 유지한다. 보충으로 실제 값이 바뀌면 같은 트랜잭션에서 버전과 processing_changed 활동을 기록하며, 이미 입력함에 있으면 동일 값 변경은 no-op이다. 과거 자료의 일괄 보정은 수행하지 않는다.
