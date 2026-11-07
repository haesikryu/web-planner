# 로컬 개발과 검증

## 실행 조건

Node 24.19.0과 Python 3을 사용한다. `.nvmrc`를 지원하는 도구가 있다면 `nvm install` 후 `nvm use`로 맞춘다. 다른 버전 관리 도구에서는 `.node-version`을 사용한다. Node 20으로 설치하면 의도적으로 중단된다.

```sh
npm ci
npm run dev
```

기본 주소는 http://127.0.0.1:3000 이다. 현재는 로그인 준비 화면과 `/api/health`만 실행된다. OAuth 비밀값과 DB가 없어도 기본 화면·빌드·기반 테스트는 가능하다.

## 검사

```sh
npm run check
npm run build
npx playwright install chromium
npm run test:e2e
```

`check`는 명세 구조·린트·타입·단위 테스트다. E2E는 프로덕션 빌드를 3100 포트에서 별도로 실행한다. 테스트가 사용하는 서버와 3100 포트를 공유하지 않는다. 360px 모바일과 PC에서 화면, 준비 중 표시, 가로 넘침, 키보드 진입, 상태 API와 보안 헤더를 확인한다.

`/api/health`는 프로세스 liveness만 알리며 DB·Google 인증 readiness를 의미하지 않는다. 개인 데이터나 설정 값을 반환하지 않는다. 실제 기능 검증 상태는 PROGRESS.md와 기능별 traceability.md에 별도로 기록한다.

## 데이터베이스

Docker 엔진을 직접 실행한 뒤 다음 명령을 사용한다.

```sh
npm run db:up
npm run db:stop
```

볼륨은 정지 후에도 유지된다. 데이터 삭제 명령은 기본 스크립트에 제공하지 않는다. 스키마와 마이그레이션은 T-004에서 추가하므로 현재 `db:up`만으로 앱 스키마가 생성되지는 않는다.

## 환경변수와 Google OAuth

인증 연결 단계에서 `.env.example`을 무시되는 `.env.local`로 복사하고 직접 값을 입력한다. `BETTER_AUTH_SECRET`은 충분히 긴 무작위 비밀값으로 생성한다. 예제·실제 비밀값을 코드·PR·Drive 일반 문서에 게시하지 않는다. `NEXT_PUBLIC_` 환경변수로 서버 비밀을 내보내지 않는다.

필요 항목은 BETTER_AUTH_URL, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, DATABASE_URL이다. 로컬 Google OAuth 콜백 계획은 `http://localhost:3000/api/auth/callback/google`이다. 실제 로그인 검증 시 localhost 기반 URL로 접속해 설정한 origin과 맞춘다. 운영은 별도 HTTPS origin과 OAuth 설정을 사용한다.

`src/server/config.ts`는 누락 값, 짧은 비밀, 잘못된 DB 프로토콜, 외부 HTTP·인증정보·경로가 포함된 인증 origin을 거부한다. 오류에는 항목명만 포함하며 값은 출력하지 않는다. 이 경계의 통과가 인증 서버 구현이나 동작 검증을 뜻하지 않는다.

## CI

`.github/workflows/verify.yml`은 PR에서 명세·린트·타입·단위·빌드·브라우저 검사를 수행하도록 구성한다. 로컬 통과와 원격 CI 통과를 구분해 기록한다. OAuth 비밀을 CI에 넣지 않으며 모든 기반 테스트는 합성 설정만 사용한다. 실제 인증·DB 통합 검증은 이후 격리 환경으로 추가한다.
