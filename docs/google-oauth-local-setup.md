# Google OAuth 생성과 로컬 연결

현재 단계: T-011 베타 준비. D-01 본인 전용 베타 확정, 실제 Google 로그인 미검증.

## 1. Google Cloud에서 직접 준비

1. [Google Cloud Console](https://console.cloud.google.com/)에서 로그인할 본인 계정을 확인하고 전용 프로젝트(예: `web-planner-beta`)를 생성·선택한다. 기존 Drive 연결 계정과 같을 필요는 없다.
2. Google Auth Platform → Branding에서 앱 이름 `Web Planner Beta`, 지원 이메일과 개발자 연락처를 설정한다.
3. Audience는 개인 Gmail 사용 시 External로 설정하고 Testing 상태를 유지한다. Test users에 본인 계정을 추가한다. Google의 테스트 사용자 설정만으로 앱 접근 제한을 대신하지 않는다.
4. Data Access에는 로그인용 `openid`, `email` 범위만 사용한다. 제품은 Drive·Calendar API 권한을 요청하지 않는다.
5. Clients → Create client → Web application. 클라이언트 이름은 `Web Planner Local`로 정한다.
6. Authorized redirect URI를 정확히 `http://127.0.0.1:3000/api/auth/callback/google`로 등록한다. 현재 서버 리다이렉트 흐름에 JavaScript origins는 필수가 아니다. 설정하는 경우 origin은 `http://127.0.0.1:3000`이다.
7. 생성 화면의 Client ID·Client secret을 보관하고 로컬 `.env.local`에 직접 입력한다. secret은 생성 직후에만 표시될 수 있다. 채팅·PR·스크린샷·일반 Drive 문서에 붙이지 않는다.

위 생성과 비밀 입력은 사용자가 진행한다. 이 안내 작성으로 Cloud 프로젝트·클라이언트를 생성하거나 과금 리소스를 만들지 않았다.

## 2. 로컬 설정

저장소 루트 `.env.local`은 Git에서 제외한다. 파일이 없다면 `.env.example`을 복사하고 비밀을 안전한 로컬 방식으로 생성한다. 기존 파일은 덮어쓰지 않는다. 다음 항목을 설정한다.

```dotenv
BETTER_AUTH_URL=http://127.0.0.1:3000
BETTER_AUTH_SECRET=<32바이트 이상의 로컬 난수>
GOOGLE_CLIENT_ID=<생성한 웹 클라이언트 ID>
GOOGLE_CLIENT_SECRET=<생성한 비밀>
AUTH_ALLOWED_EMAILS=<본인 Google 이메일 하나>
AUTH_ALLOW_SIGN_UP=true
DATABASE_URL=postgresql://planner_local:planner_local_only@127.0.0.1:54329/planner_local
```

Node 24에서 다음 순서로 실행한다. Docker Desktop이 실행 중이어야 한다.

```sh
npm ci
npm run db:up
npm run db:migrate
npm run dev
```

브라우저 주소도 `http://127.0.0.1:3000`으로 통일한다. `localhost`를 쓴다면 BETTER_AUTH_URL·등록 callback·브라우저 주소를 모두 localhost로 일치시켜야 한다. 설정 변경 후 서버를 재시작한다. 다른 origin의 테스트 서버(3100/3101) 설정을 실제 OAuth에 복사하지 않는다.

## 3. 실제 검증 문턱

- 본인 Google 로그인 → 새 계정·시간대 확인 → 과제 저장 → 새로고침 후 유지.
- 로그인 취소 후 오류 복구와 재시도, 로그아웃 후 세션 API 401.
- 다른 계정은 로그인·가입이 거부되고 계정·과제 데이터가 노출되지 않음.
- 재로그인으로 기존 과제·계정 시간대가 유지되며 권한은 로그인 범위만 요청.
- 초기 본인 가입 성공 후 `AUTH_ALLOW_SIGN_UP=false`로 되돌리고 재시작한 뒤 기존 본인 재로그인 확인.

실제 시험을 수행하기 전에는 위 항목을 통과로 표시하지 않는다. 배포 시에는 별도 HTTPS origin·callback과 환경별 비밀 관리·운영 검증이 필요하다.

## 문제 확인

`redirect_uri_mismatch`: 프로토콜·호스트·포트·경로가 등록값과 같은지 확인한다. Google 설정 반영에 시간이 걸릴 수 있다. 로그인 버튼 비활성화: 필수 환경 변수와 명시적 허용 이메일 목록을 확인한다. 본인 첫 가입 거절: 정확한 허용 이메일과 가입 플래그를 확인한다. 오류 조사 시 URL의 code/state·쿠키·환경 변수 원문을 공유하지 않는다.

## 확인한 공식 문서

- [Google OAuth 클라이언트 관리](https://support.google.com/cloud/answer/15549257?hl=en): 웹 클라이언트·origin·redirect 규칙과 생성 시 비밀 보관.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): 프로젝트·브랜딩·자격 증명·최소 로그인 범위.

확인일: 2026-11-07.
