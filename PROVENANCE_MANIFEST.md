# My-Codex 코드 출처(Provenance) 및 클린룸 독자 권한 보장 선언서

> **발행일**: 2026-10-27  
> **소유권자**: 근후 (Rogan Kim / GeunHu Kim)  
> **목적**: OpenAI Codex의 아키텍처 및 프로토콜을 REA(Reverse Engineer Anything) 기반 클린룸 방식으로 독자 재현하고, Rogan의 독자 자산인 M-Oasis 멀티 계정 우선순위 체인(Priority Chain)을 이식하여 법적 분쟁 없는 100% 독립 상용 앱 권한 확보.

---

## 1. 🛡️ 법적 클린룸 엔지니어링 및 상용화 보증 (Legal Assurance)

1. **상호운용성 보장을 위한 역공학 적법성 (Interoperability Exception)**:
   - 본 프로젝트의 Codex 프로토콜 및 인터페이스 재현은 미국 판례(Sega v. Accolade, Sony v. Connectix) 및 유럽연합 소프트웨어 지침(EU Software Directive)에 명시된 **"소프트웨어 간 상호운용성(Interoperability)을 위한 정당한 분석 및 인터페이스 호환"** 원칙을 준수하여 작성되었습니다.
   - 독점 바이너리(`codex` Mach-O 바이너리)를 직접 복제하거나 변조(Patch)하여 재배포하지 않으며, 공개 CLI 표준 및 REA 관측 프로토콜 스펙(JSON-RPC, REST, MCP)을 바탕으로 독자적인 JavaScript/TypeScript 런타임으로 재구현되었습니다.

2. **M-Oasis 독자 자산 100% 이식 (@provenance:rogan-core)**:
   - M-Oasis 프로젝트(Rogan & AI 협업 개발)에서 자체 개발된 핵심 모듈인 `priority-chain.js`, `modeldock.js`, `apiauth.js`를 정식으로 추출하여 내장하였습니다.
   - Rogan의 고유 저작물로서 타 서드파티의 라이선스 제약 없이 영구히 수정, 배포, 상용화, Mac App Store 등록이 가능합니다.

3. **라이선스 권한 (License Freedom)**:
   - 본 프로젝트의 전체 코드는 **MIT License**로 배포 및 소유되며, Rogan 개인의 완전한 독점적 권한 하에 자유롭게 커스터마이징하거나 상용 출시할 수 있습니다.

---

## 2. 🧩 아키텍처 및 계정 우선순위 설계 (3-Tier Priority Chain)

M-Oasis에서 실증된 3단계 스마트 폴백(Failover) 시스템이 완벽히 결합되어 있습니다:

| 순위 (Tier) | 서비스 / 계정 | 사용 모델 | 역할 및 특징 |
|---|---|---|---|
| **1순위 (Tier 1)** | **Antigravity (Google)**<br>`rogan2534@gmail.com` | `gemini-3.8-flash-medium` | 초고속 무제한 로컬 쿼터, 일상 코딩/추론 기본 담당 (비용 0원 최적화) |
| **2순위 (Tier 2)** | **Codex Secondary**<br>`f123123ff@gmail.com` | `gpt-6-luna` | 보조 계정 쿼터 자동 사용 (1순위 한도 도달 또는 고난도 코드 처리) |
| **3순위 (Tier 3)** | **Codex Primary**<br>`rogan2534@gmail.com` | `gpt-6-luna` | 메인 구독 계정 보호 및 최종 폴백 (잔여 한도 10% 미만 시 지능형 방어) |

---

## 3. 📁 모듈별 출처 분류 (Provenance Mapping)

| 모듈 경로 | 성격 | 출처 및 라이선스 | 비고 |
|---|---|---|---|
| `bin/codex.js` | CLI 진입점 | `@provenance:rogan-core` (MIT) | `my-codex` 단독 실행 바이너리 |
| `src/core/AgentEngine.js` | 에이전트 턴 & 도구 루프 | `@provenance:rogan-core` (MIT) | OpenAI Codex 턴/도구 수명주기 독자 재구현 |
| `src/core/SessionStore.js` | 세션 및 대화 영속화 | `@provenance:rogan-core` (MIT) | JSONL 및 SQLite 히스토리 저장소 |
| `src/tools/ToolRegistry.js` | 도구 실행기 (Shell, File, MCP) | `@provenance:rogan-core` (MIT) | 안전 샌드박스 정책 포함 도구 실행기 |
| `src/auth/AuthManager.js` | 멀티 계정 인증 관리기 | `@provenance:rogan-core` (MIT) | ChatGPT + Google OAuth 토큰 보안 스토리지 |
| `src/priority/PriorityChainEngine.js` | 우선순위 체인 엔진 | `@provenance:rogan-core` (MIT) | M-Oasis 원본에서 이식된 지능형 자동 전환기 |
| `src/ui/TerminalTui.js` | 터미널 대화형 인터페이스 | `@provenance:rogan-core` (MIT) | 실시간 스트리밍, 생각 과정 및 diff 시각화 |
| `src/ui/AppServerBridge.js` | JSON-RPC App-Server 브릿지 | `@provenance:rogan-core` (MIT) | Codex 공식 프로토콜 v2 양방향 호환 |
