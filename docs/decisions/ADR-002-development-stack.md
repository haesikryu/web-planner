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
| 스키마 도구 | Drizzle Kit 0.31.11 | 검토 가능한 SQL·변경 이력 생성 |
| 정적 검사 | Biome 2.6.6 | 지원 종료된 ESLint 9와 React 플러그인의 ESLint 10 peer 충돌을 피하고 유지보수되는 도구 사용 |
| 단위 테스트 | Vitest 5.1.0 | Node 24에서 격리된 규칙·경계 검사 |
| 브라우저 테스트 | Playwright 1.65.0 | PC·360px 모바일과 HTTP 응답 회귀 검사 |

## 개발 환경

`.node-version`과 `.nvmrc`는 Node 24.19.0을 지정하며 `engines`와 engine-strict로 오래된 Node 사용을 막는다. 사용자의 전역 Node를 변경하지 않는다. 초기 검증은 개발 호스트에 이미 제공된 Node 24 런타임으로 수행한다.

PostgreSQL은 compose.yaml로 로컬 loopback 포트 54329에만 노출한다. 예제 계정은 로컬 개발 전용이며 운영에 사용하지 않는다. postgres:18은 패치 업데이트를 허용하는 개발용 major 태그다. 운영 이미지와 digest는 호스팅 선정 시 별도로 고정한다.

## 인증 구현 경계

T-003~T-009에서 인증·설정·과제 API와 화면을 구현했다. OAuth 설정이 없으면 로그인 버튼을 비활성화한다. 과제는 PostgreSQL·브라우저로 검증했으며 실제 Google 공급자 통합은 대기 중이다.

Better Auth 기본 동작만으로 ADR-001 적합성을 가정하지 않는다. 공급자 확장과 저장 어댑터로 nonce·서명 검증·해시 저장·쿠키·CSRF·폐기 경계를 구현하고 격리 검증했다. 실제 Google 연결 시험은 남아 있다.

## 검증 범위와 후속 작업

T-004에서 Drizzle Kit 0.31.11과 PGlite 0.5.15를 개발 도구로 추가했다. Kit 전이 의존성 esbuild에 0.28.2 override를 적용해 깨끗한 설치·SQL 생성·타입 검사와 알려진 취약점 0건을 확인했다. PGlite는 격리 SQL 검증용이며 PostgreSQL 18 서버 검증을 대체하지 않는다. 강제 major 변경이나 audit 경고 숨김은 사용하지 않는다.

빌드·타입·린트·단위 테스트·기본 화면 E2E가 개발 기반의 완료 조건이다. 이 결과는 실제 Google 인증·DB 연결·과제 API 검증과 별개다. DB 데몬이 없으면 연결 성공으로 기록하지 않는다. 기술 변경 시 명세·잠금 파일·CI·실행 문서를 함께 갱신한다.

## 근거

날짜 경계는 `@js-temporal/polyfill`의 PlainDate·ZonedDateTime으로 계산하고 DST의 23/25시간·자정 변경·사라진 달력 날짜를 시험한다. 계약 검증은 Ajv 2020·ajv-formats, 접근성 자동 검사는 axe-core/Playwright를 사용한다. 정확한 버전은 잠금 파일 기준이다.

- [Next.js 설치와 실행 조건](https://nextjs.org/docs/app/getting-started/installation)
- [Better Auth Next 통합](https://better-auth.com/docs/integrations/next)
- [Better Auth Google 공급자](https://better-auth.com/docs/authentication/google)
- [Better Auth Drizzle 어댑터](https://better-auth.com/docs/adapters/drizzle)
- [Vitest 실행 조건](https://vitest.dev/guide/)
- [Biome linter](https://biomejs.dev/linter/)
- 버전·peer 범위는 2026-11-07 npm 공식 레지스트리의 각 패키지 메타데이터로 확인했다.
