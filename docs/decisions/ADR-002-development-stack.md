# 개발 실행 기술과 검증 도구

상태: 개발 기반에 적용. 운영 호스팅은 미선정.

2026-11-07 공식 패키지 메타데이터와 문서를 확인하고 아래 버전을 고정했다. 재현 가능한 전체 의존성은 package-lock.json으로 관리한다. 설치 시 최신 버전을 무조건 선택하지 않고 peer 지원 범위를 함께 확인한다.

| 영역 | 선택 | 이유 |
|---|---|---|
| 런타임 | Node 24.19.0, npm | 앱·서버·Vitest가 지원하는 런타임을 통일 |
| 웹·API | Next.js 16.4.5 App Router | 동일 출처 UI·서버 경계와 타입 검사 |
| UI | React·React DOM 19.3.1 | Next의 공식 peer 지원 범위 |
| 언어 | TypeScript 6.0.3 strict | 이 기반의 타입·빌드 검증 대상으로 고정 |
| 인증 | Better Auth 1.7.18 | Google 공급자와 Next 통합 지원. 실제 연결은 T-003에서 구현 |
| 데이터 | PostgreSQL 18, Drizzle ORM 0.45.4, pg 8.23.1 | 트랜잭션·유일 제약·타입 기반 데이터 접근 |
| 스키마 도구 | 후속 T-004에서 선정 | 아직 사용하지 않는 CLI를 기반 설치에 포함하지 않음 |
| 정적 검사 | Biome 2.6.6 | 지원 종료된 ESLint 9와 React 플러그인의 ESLint 10 peer 충돌을 피하고 유지보수되는 도구 사용 |
| 단위 테스트 | Vitest 5.1.0 | Node 24에서 격리된 규칙·경계 검사 |
| 브라우저 테스트 | Playwright 1.65.0 | PC·360px 모바일과 HTTP 응답 회귀 검사 |

## 개발 환경

`.node-version`과 `.nvmrc`는 Node 24.19.0을 지정하며 `engines`와 engine-strict로 오래된 Node 사용을 막는다. 사용자의 전역 Node를 변경하지 않는다. 초기 검증은 개발 호스트에 이미 제공된 Node 24 런타임으로 수행한다.

PostgreSQL은 compose.yaml로 로컬 loopback 포트 54329에만 노출한다. 예제 계정은 로컬 개발 전용이며 운영에 사용하지 않는다. postgres:18은 패치 업데이트를 허용하는 개발용 major 태그다. 운영 이미지와 digest는 호스팅 선정 시 별도로 고정한다.

## 인증 구현 경계

이 단계는 의존성·환경변수 경계·기본 앱을 준비한다. 로그인 라우트·인증 DB 스키마·Google 콜백은 아직 구현하지 않는다. 로그인 버튼은 비활성화하고 준비 중임을 표시한다. 사용 가능한 로그인이나 저장 기능을 모형으로 가장하지 않는다.

Better Auth의 기본 세션·쿠키·계정 저장 방식이 기존 ADR-001과 완전히 일치한다고 가정하지 않는다. T-003에서 쿠키 이름과 속성, CSRF, 세션 폐기, issuer·subject 연결과 로그 정책을 계약에 맞게 확인한다. Drizzle 인증 어댑터는 해당 단계에서 같은 버전 계열을 추가한다.

## 검증 범위와 후속 작업

설치 평가에서 사용하지 않는 drizzle-kit의 개발 도구 의존성에 moderate 경고가 확인돼 기반 의존성에서 제외했다. T-004에서 실제 마이그레이션 방식을 선정하면서 다시 검토한다. 의존성 검사에 강제 major 변경이나 숨기는 audit 설정을 적용하지 않는다.

빌드·타입·린트·단위 테스트·기본 화면 E2E가 개발 기반의 완료 조건이다. 이 결과는 실제 Google 인증·DB 연결·과제 API 검증과 별개다. DB 데몬이 없으면 연결 성공으로 기록하지 않는다. 기술 변경 시 명세·잠금 파일·CI·실행 문서를 함께 갱신한다.

## 근거

- [Next.js 설치와 실행 조건](https://nextjs.org/docs/app/getting-started/installation)
- [Better Auth Next 통합](https://better-auth.com/docs/integrations/next)
- [Better Auth Google 공급자](https://better-auth.com/docs/authentication/google)
- [Better Auth Drizzle 어댑터](https://better-auth.com/docs/adapters/drizzle)
- [Vitest 실행 조건](https://vitest.dev/guide/)
- [Biome linter](https://biomejs.dev/linter/)
- 버전·peer 범위는 2026-11-07 npm 공식 레지스트리의 각 패키지 메타데이터로 확인했다.
