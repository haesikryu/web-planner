# 인증·데이터 기반 구현과 검증

기준일: 2026-11-07. T-003·T-004의 코드와 격리 검증 결과다. 실제 Google 계정·OAuth 클라이언트나 실행 중인 PostgreSQL 18 서버를 사용한 통합 검수와 구분한다.

## 구현

- Google 리다이렉트 로그인 시작·콜백, 세션 조회, 로그아웃 및 설정 유무에 따른 화면 연결.
- Google 공개키로 ID 토큰 서명·issuer·audience·만료·nonce를 검증하고 검증된 sub로 계정을 식별한다. scope는 openid·email뿐이다. 프로필 이름·사진을 요구하지 않는다.
- Better Auth 1.7.18의 공급자 확장 지점에서 nonce 생성·전달과 명시적 토큰 검증을 결합했다. 기본 공급자 동작만으로 ADR-001 충족을 가정하지 않았다.
- 세션은 DB에 SHA-256 해시만 저장한다. 어댑터 경계에서 생성·조회·수정·폐기·트랜잭션의 토큰 조건을 변환한다. 사용자별 세션 목록의 해시는 인증값으로 사용할 수 없다. 공급자 토큰은 저장하지 않는다.
- HTTPS 세션 쿠키는 `__Host-planner-session`, Secure·HttpOnly·SameSite=Lax·Path=/, Domain 없음. 로컬 HTTP 예외는 `planner-session`이다. 브라우저 저장소에 인증 토큰을 넣지 않는다.
- 서버 DB 조건부 갱신으로 유휴 12시간·절대 7일을 적용한다. 쿠키 캐시·라이브러리의 자동 연장을 끄고 제품 세션 경계에서 확인한다. 로그아웃은 DB 폐기 실패 시 성공으로 응답하지 않는다.
- 쓰기 요청은 정확한 Origin, 세션 ID에 결합한 HMAC CSRF 토큰을 검증한다. 로그인 시작은 사전 세션이 없는 흐름이므로 Origin과 OAuth state·PKCE를 사용한다.
- 라이브러리의 직접 토큰 로그인·세션 조회·사용자 수정·계정 연결 등의 우회 경로를 노출하지 않는다. 로그인 콜백 목적지는 서버가 고정한다. 오류는 비밀·토큰·SQL 없이 반환하고 no-store를 적용한다.
- 신규 가입은 기본 차단이다. D-01 결정 후 운영자가 `AUTH_ALLOW_SIGN_UP=true`를 명시하는 환경에서만 허용한다. 테스트의 가입 허용은 합성 격리 인스턴스에 한정한다.
- users·identities·sessions·verifications·tasks·task_activities·idempotency_records 7개 테이블과 Drizzle 생성 SQL을 추가했다. 버전, 완료 상태, 제목, 소유자 복합 외래키, 공급자 subject, 요청 키 유일 제약을 적용한다.

## 검증 증거

`npm run check`에서 명세 구조·린트·타입과 26개 테스트가 통과했다. 10개 설정 경계, 2개 요청 보호, 14개 인증·DB 통합 검사다. 통합 DB는 PGlite 0.5.15의 격리된 PostgreSQL 엔진이며 Docker PostgreSQL 18과 동일한 운영 환경이라는 주장은 하지 않는다.

합성 RSA 키·서명 토큰과 모형 토큰 교환을 사용해 Google 시작 → state 쿠키 → 서명·nonce 검증 → 콜백 → 자체 세션 발급을 확인했다. 실제 Google 네트워크 인증은 수행하지 않았다. 잘못된 서명·nonce·issuer·audience·만료·미검증 이메일, state 재사용, 같은 이메일의 다른 subject 병합, CSRF·Origin 실패, 세션 만료·폐기도 확인했다.

동일 SQL 마이그레이션 재실행, 잘못된 과제·다른 소유자의 활동 연결 거부, 요청 키 소유자별 유일성, 실패한 트랜잭션 롤백, DB 스냅샷의 별도 인스턴스 복원을 확인했다. PostgreSQL 서버의 pg_dump·pg_restore와 운영 백업 복원은 후속 검증이다.

`npm run build`와 PC·360px 모바일 Playwright 8개 회귀 검사가 통과했다. 로컬 테스트 서버의 sandbox 포트 제한은 허용된 실행으로 해소했다. [PR #3 GitHub CI](https://github.com/haesikryu/web-planner/actions/runs/42325214534)는 코드 커밋 `c19c1e63d3716b305168590cf8870a9a2988b8f8`에서 설치·명세·린트·타입·26개 테스트·빌드·브라우저 설치·8개 E2E 전 단계를 통과했다. PR은 Draft이며 선행 PR #2와 함께 미병합 상태다. 의존성 클린 설치와 esbuild override를 확인했으며 npm 감사의 알려진 취약점은 0건이다. override는 Drizzle Kit 전이 의존성의 esbuild만 0.28.2로 고정하며 마이그레이션 재생성과 타입 검사로 호환성을 확인한다.

## 남은 통과 조건

1. Google Cloud의 실제 OAuth 클라이언트·테스트 사용자·정확한 리다이렉트 URI 설정 후 실제 로그인·취소·실패·로그아웃 통합 시험.
2. Docker PostgreSQL 18 기동 후 서버 연결·마이그레이션·동시 요청·pg_dump/pg_restore 검증. PGlite 결과로 대체하지 않는다.
3. D-01 가입 대상 확정. 실제 도메인과 비밀 저장소·운영 요청 제한 정책 확정.
4. T-005 제목·IANA 시간대·DST 모듈 및 설정 API. 현재 신규 사용자는 UTC 기본값이고 기기 시간대 제안·변경은 미구현이다.
5. 과제 API·입력·오늘 화면과 미저장 입력의 계정 전환 처리. 현재 입력 편집 화면은 없으므로 FR-14-05 전체를 완료 처리하지 않는다.

FEAT-001 전체 수용 시나리오, 요구사항 완료·승인·검수 비율은 이 결과만으로 변경하지 않는다.

## 참고

- [Better Auth 세션 설정](https://better-auth.com/docs/concepts/session-management)
- [Better Auth 옵션](https://better-auth.com/docs/reference/options)
- [PGlite Drizzle 지원](https://pglite.dev/docs/orm-support)
- [PGlite API와 데이터 디렉터리](https://pglite.dev/docs/api)
