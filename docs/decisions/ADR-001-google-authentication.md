# Google 단일 로그인

상태: 로그인 수단 확정, 인증·세션 코드와 격리 검증 완료, 실제 OAuth 통합 대기

2026-11-06 사용자가 MVP에 Google 로그인만 제공하기로 선택했다. 이메일 매직 링크와 자체 비밀번호 로그인은 MVP 범위에서 제외한다. 개발자가 쓰는 GitHub·Drive 연결 계정은 서비스 이용자의 계정과 별개다.

## 인증 설계

검증된 인증 라이브러리로 Google OpenID Connect Authorization Code 흐름을 구현한다. state·nonce·PKCE와 정확한 리다이렉트 URI 검증을 적용한다. 라이브러리·운영 도메인은 기술 선정 시 고정한다. 로그인용 scope는 openid·email로 제한하고 Drive·Calendar 권한을 요청하지 않는다.

2026-11-07 ADR-002에서 Better Auth 1.7.18을 선정했다. T-003에서 공급자 확장으로 nonce·서명 검증, 해시 세션 저장, 제품 세션·CSRF 경계를 구현하고 합성 토큰·격리 DB로 검증했다. 실제 Google 계정 통합은 OAuth 설정 후 수행한다. 운영 도메인은 아직 미정이다.

외부 계정 키는 검증된 issuer와 sub의 조합이다. 이메일은 변경될 수 있으므로 계정 소유권 키로 사용하지 않는다. 서명·issuer·audience·만료·nonce 검증에 실패하면 세션을 발급하지 않는다. 콜백 오류에서 토큰이나 개인정보를 화면·로그에 노출하지 않는다.

브라우저에는 서비스 자체의 불투명 세션 쿠키를 사용한다. 운영 HTTPS에서 Secure·HttpOnly·SameSite=Lax, Path=/를 사용하고 Domain은 지정하지 않는다. 인증 토큰을 localStorage에 저장하지 않는다. 쓰기 API는 세션에 결합한 CSRF 토큰과 Origin 검사를 적용한다. SameSite만으로 CSRF 방어를 대체하지 않는다.

세션 만료는 유휴 12시간·절대 7일을 초기 설계값으로 둔다. 로그아웃은 서버 세션 폐기 후 쿠키를 지운다. 미저장 입력이 있으면 로그아웃 전에 안내하며 다른 계정으로 입력을 자동 넘기지 않는다.

## 외부 설정과 범위

실제 Google 로그인 시험에는 OAuth 클라이언트와 허용 리다이렉트 URI가 필요하다. 비밀값은 환경별 비밀 저장소에 두며 GitHub·일반 Drive 문서에 넣지 않는다. 인증 공급자 변경·비용 계약·외부 앱 권한 설정은 이 문서 작성으로 실행하지 않는다.

공개 저장소가 서비스 가입 개방을 의미하지 않는다. 가입 허용 정책 D-01은 배포 전 확정한다. 테스트는 합성 내부 ID와 인증 모형으로 시작하고, 실제 공급자 통합 시험은 별도 환경에서 수행한다.

## 근거

현재 구현 증거는 [과제 흐름 검증](../verification/planner-core.md)에 있다. 신규 가입은 기본 차단이며 D-01과 환경 설정 전에는 열지 않는다. 쿠키 캐시·자동 세션 연장을 끄고 유휴 12시간·절대 7일을 제품 API의 DB 조건으로 검사한다. 신규 계정만 검증된 기기 시간대 제안을 사용하고 없으면 UTC다. 재로그인 때 변경하지 않으며 명시적 설정 API를 사용한다.

- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)
- [OpenID Connect Core](https://www.openid.net/specs/openid-connect-core-1_0.html)
- [OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
