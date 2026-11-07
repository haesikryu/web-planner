# 첫 기능 논리 데이터 설계

상태: PostgreSQL·Drizzle 실행 스키마와 초기 SQL 마이그레이션 구현, 격리 DB 검증 완료. 실제 PostgreSQL 18 서버 통합은 대기 중이다.

| 엔터티 | 핵심 필드 | 제약 |
|---|---|---|
| users | id, timezone, created_at | timezone은 검증된 IANA ID |
| identities | user_id, provider_id, subject | google 공급자·고정 issuer 검증, provider_id·subject 유일, 이메일 자동 병합 금지 |
| sessions | id, token_hash, user_id, created_at, updated_at, expires_at | bearer 원문은 해시 저장. updated_at은 마지막 활동, created_at은 절대 만료 기준. CSRF는 세션 ID와 서버 비밀로 도출 |
| tasks | id, owner_id, title, status, scheduled_date, due_date, is_unprocessed, completed_at, version, created_at, updated_at | owner 필수, title 규칙, version 양수 |
| task_activities | id, owner_id, task_id, type, occurred_at, invalidated_by | 완료·완료취소·실행일변경·정리 상태변경 기록 |
| idempotency_records | owner_id, method, path, key, request_hash, state, response, expires_at | owner·method·path·key 유일 |

tasks의 날짜 필드는 NULL 허용 달력 날짜, 시각 필드는 UTC instant다. 첫 기능의 due_date는 원문 보존용 nullable 필드이며 이 기능 API에서 신규 지정·변경하지 않는다. 후속 명세에서 추가한다. status는 첫 기능 open·completed만 사용하며 보류·취소 확대 시 마이그레이션한다.

완료 상태는 completed_at 존재 여부와 일치한다. 완료 취소는 completed_at을 비우고 이전 완료 활동을 새 취소 활동과 연결한다. 활동 행은 과제 소유자와 같은 owner를 강제하며 다른 사용자의 과제를 연결하지 않는다.

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

실행 기준은 `src/server/db/schema.ts`와 `migrations/0000_auth_and_task_foundation.sql`이다. users의 timezone·settings_version은 UTC·1로 시작한다. identities의 라이브러리 호환 필드는 공급자 토큰·비밀번호 저장을 CHECK로 차단한다. verifications에는 10분 OAuth state·PKCE 정보를 저장하고 라이브러리가 일회 소비한다. 만료 레코드 정리의 운영 주기는 T-011에서 정한다. 시간대 검증·제목 Unicode 공백 정규화는 T-005에서 완성한다.

전체 사용자 삭제·휴지통 정책은 FEAT-001의 실행 범위 밖이지만 이후 도입을 막지 않도록 owner 경계를 유지한다. 운영 데이터 내보내기·삭제와 백업 보관 기간은 별도 명세에서 연결한다. 개인정보 본문·제목·토큰·키 응답을 일반 로그에 기록하지 않는다. idempotency 응답 저장소도 개인 데이터이므로 접근 제어와 TTL 정리를 적용한다.
