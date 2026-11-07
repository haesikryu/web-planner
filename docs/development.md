# 로컬 개발과 검증

## 실행 조건

Node 24.19.0과 Python 3을 사용한다. `.nvmrc`를 지원하는 도구가 있다면 `nvm install` 후 `nvm use`로 맞춘다. 다른 버전 관리 도구에서는 `.node-version`을 사용한다. Node 20으로 설치하면 의도적으로 중단된다.

```sh
npm ci
npm run dev
```

기본 주소는 http://127.0.0.1:3000 이다. OAuth 설정 전에는 로그인 준비 화면을 표시한다. 인증 설정과 마이그레이션을 마치면 Google 로그인 버튼이 동작한다. 비밀값과 DB 서버 없이도 기본 화면·빌드·합성 인증·격리 DB 테스트를 실행할 수 있다.

## 검사

```sh
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

`check`는 명세 구조·린트·타입·단위/격리 통합 테스트다. E2E는 비밀값 없는 프로덕션 빌드를 3100 포트에서 별도로 실행한다. 테스트 서버와 포트를 공유하지 않는다. 360px 모바일과 PC에서 화면·접근성·상태 API·세션 미인증·우회 경로 차단·설정 누락 오류를 확인한다.

`/api/health`는 프로세스 liveness만 알리며 DB·Google 인증 readiness를 의미하지 않는다. 개인 데이터나 설정 값을 반환하지 않는다. 실제 기능 검증 상태는 PROGRESS.md와 기능별 traceability.md에 별도로 기록한다.

## 데이터베이스

Docker 엔진을 직접 실행한 뒤 다음 명령을 사용한다.

```sh
npm run db:up
npm run db:migrate
npm run db:stop
```

먼저 `.env.local`에 DATABASE_URL을 설정한다. `db:migrate`는 이 파일을 읽고 검토된 SQL을 트랜잭션과 마이그레이션 이력으로 적용한다. `db:up`만으로 앱 스키마를 생성하지 않는다. 볼륨은 정지 후에도 유지되며 데이터 삭제 스크립트는 제공하지 않는다. 스키마 변경은 `src/server/db/schema.ts` 수정 → `npm run db:generate -- --name 설명` → SQL 검토 → 테스트 순서다. 적용된 SQL을 수정하지 말고 새 마이그레이션을 추가한다. 운영 실행은 별도 변경 검토 대상이다.

`tests/unit/auth-database.test.ts`는 PGlite 인메모리 DB에서 같은 SQL과 실제 Drizzle 어댑터를 실행한다. 복원은 PGlite 데이터 디렉터리 스냅샷 기준이며 PostgreSQL 18 서버의 pg_dump/pg_restore·다중 연결 경쟁 조건 시험과 구분한다.

## 환경변수와 Google OAuth

인증 연결 단계에서 `.env.example`을 무시되는 `.env.local`로 복사하고 직접 값을 입력한다. `BETTER_AUTH_SECRET`은 충분히 긴 무작위 비밀값으로 생성한다. 예제·실제 비밀값을 코드·PR·Drive 일반 문서에 게시하지 않는다. `NEXT_PUBLIC_` 환경변수로 서버 비밀을 내보내지 않는다.

필요 항목은 BETTER_AUTH_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL이다. 로컬 Google OAuth 콜백 계획은 `http://localhost:3000/api/auth/callback/google`이다. 실제 로그인 검증 시 localhost 기반 URL로 접속해 설정한 origin과 맞춘다. 운영은 별도 HTTPS origin과 OAuth 설정을 사용한다.

`src/server/config.ts`는 누락 값, 짧은 비밀, 잘못된 DB 프로토콜, 외부 HTTP·인증정보·경로가 포함된 인증 origin을 거부한다. 오류에는 항목명만 포함하며 값은 출력하지 않는다. 이 경계의 통과가 인증 서버 구현이나 동작 검증을 뜻하지 않는다.

Google Cloud에서 웹 애플리케이션 OAuth 클라이언트를 만들고 위 콜백을 정확히 등록한다. 테스트 공개 상태에서는 허용한 테스트 사용자로 확인한다. 비밀값은 채팅·PR·Drive 문서로 보내지 않고 무시되는 로컬 환경 파일이나 배포 비밀 저장소에 직접 입력한다. 신규 가입은 `AUTH_ALLOW_SIGN_UP=false`가 기본이며 D-01 대상 사용자 결정 후 해당 환경에서 명시적으로 허용한다. 신규 계정에는 검증된 기기 시간대를 제안하고 없으면 UTC다. 기존 계정의 시간대는 재로그인 때 바꾸지 않는다.

공개 인증 경로는 POST `/api/auth/sign-in/social`, GET `/api/auth/callback/google`뿐이다. 제품 계약의 세션·로그아웃·설정·과제 7개 API를 구현했다. 쓰기 요청에는 세션 CSRF·정확한 Origin을 사용하고 설정·과제 수정에는 Idempotency-Key·If-Match가 필요하다. 서버는 본문·SQL·비밀 없이 no-store 오류를 반환한다. 인증 경로의 설정 불가는 503, 제품 저장 실패는 500이며 UI는 같은 요청을 보존한다.

## 실제 PostgreSQL·제품 브라우저 검사

실제 데이터와 분리된 loopback DB `planner_test_product`, `planner_test_e2e`를 사용한다. 테스트는 고정된 합성 사용자 자료만 정리한다. 실제 사용 DB를 지정하지 않는다.

```sh
PLANNER_TEST_DATABASE_URL=... npm run check
PLANNER_E2E_DATABASE_URL=... npm run test:e2e:product
```

첫 명령은 별도 연결의 PostgreSQL 경쟁 조건을 포함한다. URL을 생략하면 PGlite에서 실행하고 해당 별도 연결 검사 1개만 명시적으로 생략한다. 두 번째 명령은 합성 세션을 테스트 DB에 준비하고 3101 포트의 개발 서버에서 실제 제품 HTTP·PC·모바일 흐름을 확인한다. 테스트용 로그인 API는 없다. 기본 `test:e2e`는 비밀값 없이 빌드한 안내 화면을 3100 포트에서 확인한다. 두 테스트 서버는 자동 종료된다.

API 응답은 OpenAPI JSON Schema로 검사하며 `npm run db:prune`은 만료된 요청·OAuth state·세션만 제한된 묶음으로 정리한다. [베타 진입 조건](release-readiness.md)과 [최신 검증](verification/planner-core.md)을 따른다.

## CI

`.github/workflows/verify.yml`은 PR에서 명세·린트·타입·단위/격리 통합·빌드·브라우저 검사를 실행한다. OAuth 비밀은 CI에 넣지 않으며 합성 키·토큰·테스트 DB만 사용한다. 로컬·원격 CI 결과와 실제 Google·PostgreSQL 서버 통합 검증은 별도로 기록한다.

## 본인 전용 베타

테스트 중 Google 로그인을 잠시 중지하려면 `.env.local`에 `AUTH_LOGIN_ENABLED=false`를 설정한다. 버튼에 일시 중지 안내가 표시되고 로그인 시작·Google 콜백이 503으로 차단된다. 재개하려면 `true`로 바꾸고 서버를 재시작한다. 이 설정은 새 로그인 발급을 제어하며 기존 세션은 세션 만료·로그아웃 정책을 따른다.

[Google OAuth 생성·로컬 설정](google-oauth-local-setup.md)을 따른다. `AUTH_ALLOWED_EMAILS` 누락 시 인증이 비활성화된다. 실제 허용 이메일·OAuth 비밀은 무시되는 `.env.local`에만 저장한다.
