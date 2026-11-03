# My-Codex (Sovereign Cleanroom Edition)

> **Rogan Kim의 Codex 스타일 에이전트 하네스 프로젝트**  
> REA(Reverse Engineer Anything) 분석을 참고해 구조와 보안 문제를 점검하는 Node.js 프로젝트

## 현재 전달 상태 (2026-10-27)

- 이 저장소는 Node.js CLI와 로컬 웹 UI를 제공합니다. 이 Mac에는 WKWebView 창으로 여는 `~/Applications/Only Chat.app`을 설치했습니다. 번들은 현재 Antigravity 소스 폴더와 이 Mac의 Node.js 실행 파일을 사용합니다.
- macOS 앱은 `./scripts/build-macos-app.sh`로 다시 빌드할 수 있습니다. 이 로컬 개발 서명은 외부 배포 서명이나 공증을 뜻하지 않습니다. Windows 설치 패키지는 없습니다.
- Google Drive `OnlyChat_NCHISim_Sync` 폴더에 소스와 Windows 실행 스크립트가 있습니다. Windows 쪽 실제 실행 및 양방향 동기화는 아직 기기에서 검증되지 않았습니다.
- Windows x64 설치기와 Node 런타임 포함 포터블 ZIP은 `npm install` 후 `npm run build:windows`로 만들 수 있습니다. Windows 빌드 안내는 [WINDOWS-BUILD.md](WINDOWS-BUILD.md)를 보세요.
- Google OAuth를 연결하면 Only Chat의 Codex CLI 채팅에 로컬 stdio MCP를 통해 Google Drive 검색·텍스트 읽기와 Gmail 검색·본문 읽기를 제공합니다. 토큰은 Only Chat이 사용하는 로컬 Google connector 저장소를 읽으며, MCP 도구는 읽기 전용입니다. 실제 Google 계정 동의, 서비스 호출 및 Windows 수신은 별도 확인이 필요합니다.
- Mac 화면 제어는 Only Chat 네이티브 macOS 앱에서만 제공하는 선택 기능입니다. 기본은 꺼짐이며, 사용자가 켠 뒤 macOS Screen Recording과 Accessibility 권한을 부여해야 합니다. Codex CLI는 기본 디스플레이를 캡처하고 화면 클릭·텍스트/키 입력·스크롤을 요청할 수 있습니다. 캡처는 현재 대화로 전달되며 앱은 캡처 파일을 저장하지 않습니다. macOS 14 이상이 필요하고, 실제 권한 승인/화면 조작 runtime 및 Windows 대응은 별도 검증 대상입니다.
- REA는 OnlyChat 제품에 내장된 기능이 아니라 개발 분석 도구입니다. 설치된 ChatGPT 앱과 OnlyChat 소스를 REA CLI로 정적 분석했고, 분석 결과에서 확인된 로컬 API 출처 검증·OAuth state·브라우저 명령 인수 처리 문제를 수정했습니다. 분석은 실행 동작을 증명하지 않습니다.
- 설치 앱 목록은 Mac과 Windows 경로를 각각 검색합니다. 가짜 REA 청사진 응답을 제거하고 화면 제목을 `로컬 앱 후보`로 고쳤습니다.
- macOS 앱 창과 로컬 서버 HTTP 200을 확인했고, 검색·앱 목록 집중 테스트가 통과했습니다. Windows 런타임, 기기간 동기화, 외부 계정 연결은 별도 검증이 필요합니다.
- 아래 기능 설명은 저장소에 있는 구현과 설계 목표를 요약합니다. 실제 계정 연결, 모델 폴백, 음성, 브라우저 자동화, UI 동작이 모두 검증됐다는 뜻은 아닙니다.

---

## 🌟 주요 특징

1. **독립 소스 기반 아키텍처**:
   - 독점 바이너리 종속성 제로.
   - 상호운용성을 목표로 독립적으로 구현했습니다. MIT LICENSE와 파일별 출처 고지를 확인하세요. 이 README는 법률 검토가 아닙니다.
   - 향후 자유로운 기능 추가와 GUI 패키징을 위한 Node.js 소스 구조입니다.

2. **3단계 우선순위 체인 코드**:
   - 세 공급자 티어와 계정 상태를 다루는 로직이 있습니다.
   - 계정·모델·쿼터 상태는 제공자 설정에 따라 달라집니다. 실제 로그인, 무중단 폴백, 비용·쿼터 특성은 이 저장소만으로 보증되지 않습니다.

3. **풀스택 에이전트 도구 및 실행 루프**:
   - 로컬 셸 실행 (`bash`/`zsh` 실시간 스트리밍).
   - 정밀 파일 읽기, 쓰기, 타깃 치환 편집 (`read_file`, `write_file`, `edit_file`).
   - 세션 영속화 (JSONL 스레드 히스토리 및 롤백).
   - Codex 공식 App-Server (JSON-RPC 2.0 stdio) 브릿지 내장.

---

## 🧬 핫리로드 _ 신체 변형 시스템 (Metamorphic Hub)

저장소에는 핫리로드와 슬롯 기반 모듈 경로가 구현되어 있습니다. 무중단 동작과 각 슬롯의 독립성은 실제 실행 검증 전까지 보장되지 않습니다.

1. **지원 경로별 안전한 핫리로드 (Scoped Hot-Reload)**:
   - CSS는 SSE 감지 후 stylesheet cache-bust로 갱신합니다. UI HTML/JS는 진행 중 응답·초안·첨부·대화가 없을 때만 렌더러를 다시 읽습니다.
   - 서버/엔진 모듈과 네이티브 변경은 현재 자동 핫리로드 대상이 아니며, 별도 안전 재시작 또는 빌드가 필요합니다. 모든 변경이 무중단으로 즉시 적용된다고 가정하지 않습니다.
2. **허브 & 플러그인 모듈 조립형 신체 구조 (Decoupled Metamorphic Organs)**:
   - `theme-slot` (UI / 디자인 / 글래스모피즘 / 컬러)
   - `font-slot` (타이포그래피 / 폰트 / 줄간격)
   - `ui-slot` (레이아웃 / 사이드바 / 위젯)
   - `features-slot` (도구 실행기 / 병렬 디스패처 / 우선순위 체인)
   - 각 장기가 서로 독립되어 있어, 디자인이나 폰트만 변경해도 다른 기능에 일체 영향이 없습니다.
3. **앱 내부 변형 가드 (In-Process Mutation Guard)**:
   - Metamorphic Hub의 `canMutate()`는 앱 안에서 진행 중인 요청/파일 쓰기와 설정 변경 충돌을 제한합니다.
   - 이 메모리 가드는 Codex 채팅 간 소스 파일 lease가 아니며, 현재 `collisionLedger`도 프로세스 간 잠금으로 동작하지 않습니다. 공유 소스 편집은 실제 thread 상태와 정확한 파일 lease/writer를 별도로 확인해야 합니다.
4. **선택적 부분 핫스왑과 안전한 UI 갱신**:
   - CSS 변경은 대화를 건드리지 않고 갱신합니다. UI HTML/JS 변경은 SSE로 알리고, 현재 요청·초안·첨부·대화가 비어 있을 때 안전 재로드합니다. 바쁜 상태에서는 재로드를 미룹니다.
   - 이 구현은 임의 컴포넌트의 상태 보존 핫스왑을 보장하지 않습니다. 엔진/서버 변경은 기존 대화 상태를 보존할 별도 안전 절차를 마련한 뒤 재시작해야 합니다.

---

## 🚀 빠른 시작 가이드

### 1. 로컬 웹 UI 실행
```bash
my-codex app
# 또는
npm run app
```
- 로컬 HTTP 서버를 시작하고 기본 브라우저에서 UI를 엽니다.
- 좌측 사이드바: 새 세션(`⌘N`), 세션 검색 및 히스토리, 하단 실시간 우선순위/쿼터 카드
- 중앙 타임라인: 접이식 생각 과정(`Thinking...`), 실시간 Zsh/Bash 터미널 실행 콘솔, File Diff 뷰어
- 하단 컴포저: 멀티라인 입력기, 계정 체인 선택기, 샌드박스 정책(`Workspace Write` / `Read Only` / `Danger Full Access`)
- 슬라이드 드로어: 우선순위 체인 3단계 실시간 제어, Google / ChatGPT 멀티 계정 즉시 등록

### 2. 상태 및 활성 계정 확인
```bash
my-codex status
```

### 2. 대화형 터미널 TUI 모드 실행
```bash
my-codex
```
- 실시간 터미널에서 대화 및 명령어 실행
- 슬래시 명령어: `/status`, `/switch <1|2|3>`, `/accounts`, `/login`, `/sessions`, `/exit`

### 3. 계정 등록 및 로그인 관리
```bash
# 구글 Antigravity 계정 등록
my-codex login add google rogan2534@gmail.com <token>

# ChatGPT / OpenAI 계정 등록
my-codex login add chatgpt f123123ff@gmail.com <token>
```

### 4. 1회성 비대화형 명령 실행 (CLI Exec)
```bash
my-codex exec "현재 디렉토리의 파일 목록을 확인해줘"
```

### 5. App-Server 브릿지 실행 (Desktop / VSCode 연동)
```bash
my-codex app-server
```

---

## 📄 라이선스 & 권한
- 소유권: Rogan Kim (GeunHu Kim)
- 라이선스: MIT License (적용 범위와 포함 파일은 LICENSE 및 각 파일의 출처 고지를 따릅니다.)
- 상세 내역: [PROVENANCE_MANIFEST.md](file:///Users/rogan/.gemini/antigravity/scratch/my-codex/PROVENANCE_MANIFEST.md)
