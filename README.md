# Web Planner

상태: 첫 과제 흐름 구현·로컬 자동 검증 완료, 실제 OAuth·베타 환경 준비 대기
최종 갱신: 2026-11-07

**[전체 진행 현황과 현재 위치](PROGRESS.md)**

가치와 목표에 기반한 계획, 빠른 일상 기록, 주간 회고를 결합한 개인용 웹 플래너를 개발한다. 첫 개발 단위는 과제를 입력하고 오늘 화면에서 완료하는 흐름이다.

## 관리 위치

| 대상 | 기준 위치 | 상태 |
|---|---|---|
| 코드·승인된 명세·설계·테스트 | haesikryu/web-planner 공개 저장소 | 명세 초안 검토 |
| 요구 접수·우선순위·승인·담당자 | 비공개 Google Drive 관리표 | 기존 요구사항 관리표 사용 |
| 검토 자료·디자인·릴리스 증적 | Google Drive 프로젝트 폴더 | 프로젝트 자료 구조 준비 |

Google 로그인·세션 코드, 설정·과제 API와 입력함·오늘·완료·완료 취소를 구현했다. 실제 PostgreSQL의 중복 요청·경쟁 조건·롤백·백업 복원과 PC·모바일 브라우저를 검증했다. 실제 사용에는 OAuth 설정과 DB가 필요하며 설정 전에는 로그인 버튼을 비활성화한다. 문서·제품 수용 승인을 자동으로 간주하지 않는다. 비공개 자료의 접근 정보는 공개 저장소에 게시하지 않는다.

## 개발 실행

Node 24.19.0과 Python 3을 준비한 뒤 다음 명령을 실행한다.

```sh
npm ci
npm run dev
```

기본 앱은 http://127.0.0.1:3000 에서 확인한다. [개발·검증 안내](docs/development.md)와 [실행 기술 결정](docs/decisions/ADR-002-development-stack.md)을 참고한다.

## 시작 문서

- `docs/principles.md`: 구현이 따라야 할 공통 원칙.
- `docs/process.md`: 명세부터 운영까지의 진행 기준.
- `specs/001-capture-complete/spec.md`: 첫 기능 명세 초안.
- `specs/001-capture-complete/acceptance.feature`: 첫 기능 수용 시나리오 초안.
- `docs/decisions/ADR-001-google-authentication.md`: Google 단일 로그인 결정과 세션 설계.
- `docs/domain/rules.md`: 제목·날짜·상태·중복 요청의 공통 규칙.
- `specs/001-capture-complete/plan.md`: 첫 기능 설계와 검증 전략.
- `contracts/openapi.json`: 제품 데이터 API 계약 초안.
- `specs/001-capture-complete/tasks.md`: 개발 작업과 선행 조건.

## 다음 실행 순서

1. 과제 흐름 PR 검토와 원격 자동 검사.
2. 실제 Google OAuth·가입 대상·베타 환경 구성.
3. 운영 관측·요청 제한·부하·복원 검증과 수용 검토.
4. 일정·재계획 등 후속 기능 명세로 진행.

명세·코드·검수는 ID로 연결하고, 제품 동작 설명의 기준은 승인된 저장소 명세로 둔다. 구글 시트에는 링크와 기준 버전을 연결한다. 실제 사용자 일기·개인 데이터·인증 비밀은 GitHub에 넣지 않는다. 테스트에는 합성 데이터를 사용한다.
