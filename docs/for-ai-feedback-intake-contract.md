# For AI → Only Chat 피드백 수신 계약 초안

상태: **검토용 초안 — For AI 송신 측 인증·ID·보존 결정 미확인, API 미구현**  
범위: TODO-501의 최소 수신 경계. 이 문서는 서버 라우트, 큐, UI 또는 외부 연동이 이미 동작한다는 증거가 아닙니다.

## 현재 확인된 경계

- Only Chat의 로컬 서버는 loopback `Host`와 `Origin`을 제한합니다. 이 검사는 브라우저 교차 출처 요청을 줄이는 경계이지, 다른 로컬 프로세스가 호출할 때 For AI의 신원을 증명하는 인증 수단은 아닙니다.
- `server.js`의 일반 `_readBody()`는 크기 제한이 없습니다. `_readLimitedBody()` 구현은 있지만 피드백 receiver route에서 사용되는 것은 확인되지 않았습니다. 새 수신 경로는 본문 크기·JSON 형식 검증을 먼저 해야 합니다.
- 현재 Only Chat 소스에서 For AI 피드백 수신 route/API는 확인되지 않았습니다. `TODO-501`은 인증 수단과 계약을 For AI 측 실제 기능에 근거해 정하라고 요구합니다.

## 제안 인터페이스

경로는 초안 이름이며 구현 전 API 소유자가 확정합니다.

- 수신: `POST /api/integrations/for-ai/feedback`
- 상태 재확인: `GET /api/integrations/for-ai/feedback/{feedbackId}`
- 두 경로 모두 같은 검증된 For AI 신원에 묶인 인증을 요구합니다. loopback, CORS, `Origin`, 요청 본문에 든 `source` 값만으로 인증을 통과시키지 않습니다.

요청은 UTF-8 JSON 한 건만 받습니다. 필드와 상한은 For AI 측 capability 조사 뒤 확정합니다. 최소 후보는 다음과 같습니다.

```json
{
  "schemaVersion": 1,
  "feedbackId": "sender-stable-opaque-id",
  "source": "for-ai",
  "createdAt": "RFC3339 UTC timestamp",
  "body": "feedback text"
}
```

`feedbackId`는 재전송 동안 변하지 않는 송신 측 ID여야 합니다. `source`는 인증된 송신 주체와 일치해야 하고, 임의의 source를 요청자가 선택하게 두지 않습니다. 본문은 문자열이어야 하며 잘못된 인코딩, 누락 필드, 타입 불일치와 미지원 schema version은 거부합니다. 첨부·계정 식별자·원문 transcript·임의 URL은 이 최소 계약에 포함하지 않습니다.

### 크기와 검증

- body 전체에 명시된 최대 바이트 수를 적용하며, 초과 시 본문을 계속 버퍼링하지 않고 `413 payload_too_large`를 반환합니다. 현재 코드의 256 KiB body limit은 다른 일정 API의 값일 뿐이므로 For AI의 요구량 확인 전 이 계약의 최종 제한으로 간주하지 않습니다.
- `Content-Type: application/json`과 UTF-8, 정확한 필드 형식, 필수 문자열의 공백 여부를 확인합니다. 원문 본문이나 인증 값은 로그·오류 응답에 넣지 않습니다.
- rate/queue 용량 한계와 처리 타임아웃은 구현 전 실제 dispatcher의 영속성·동시성 검토 뒤 수치화합니다.

### 인증 결정 게이트

수신 API 구현 전 For AI 측 코드·공식 연결 경계에서 다음을 확인합니다.

1. For AI가 실제로 사용할 수 있는 caller identity 또는 credential 발급·회전·폐기 기능.
2. 해당 자격 증명을 Only Chat 프로세스에 안전하게 전달할 수 있는 경로.
3. 인증 실패·권한 축소·송신 앱 재설치 때의 동작.
4. 로컬 loopback 서버만으로는 다른 로컬 프로세스를 구분하지 못한다는 위협 모델 수용 여부.

위 확인과 API 소유자의 명시적 승인 전에는 receiver를 기본 비활성 상태로 둡니다. 인증 provider가 초기화되지 않았거나 sender identity를 검증할 수 없으면 queue에 쓰지 않고 fail-closed 응답을 반환해야 합니다. 구현 회귀에는 라우트 비활성, 자격 증명 누락·오류·폐기, 다른 주체 credential 거부를 포함합니다.

확인 전까지 Bearer token, 계정, 환경변수, Keychain 항목 또는 새 페어링 방식을 만들어 내지 않습니다. 기존 OAuth/Passkey 자격 증명을 For AI sender identity로 재사용한다고 가정하지 않습니다.

## 멱등성 및 응답

유효한 인증과 payload를 모두 통과한 뒤에만 수신을 확정합니다. 멱등 키는 `(authenticatedSource, feedbackId)`입니다.

- 같은 키와 같은 canonical payload가 다시 오면 기존 receipt/status/task ID를 반환하고 새 dispatcher 작업을 만들지 않습니다.
- 같은 키에 다른 payload가 오면 `409 id_conflict`를 반환하며 기존 내용을 덮거나 새 작업을 만들지 않습니다. 이는 sender의 ID 재사용/데이터 무결성 오류입니다. 이 응답을 무한 자동 재시도하지 않습니다. 실제 수정된 피드백은 새 stable ID를 사용해야 하며, 기존 항목 갱신 API는 이 계약 범위에 없습니다.
- 새 항목은 영속 receipt가 기록되고 dispatcher가 수락된 뒤에만 `202 accepted`와 `receiptId`, `taskId`, `status: queued`를 반환합니다. 영속성 확인 전 성공 응답을 주지 않습니다.
- 후속 상태는 `queued`, `running`, `completed`, `blocked`, `failed` 중 하나이며 작업 결과와 차단/실패 이유를 개인정보가 불필요하게 재노출되지 않게 readback합니다.

초안 오류 envelope: `{"error":{"code":"invalid_request","retryable":false}}`. 제안 상태 코드는 인증 없음 `401`, 인증된 호출자 권한 없음 `403`, JSON/schema 오류 `400`, 크기 초과 `413`, 같은 ID payload 충돌 `409`, 제한/임시 용량 초과 `429`, 수신 저장 또는 큐 수락 실패 `503`입니다. 응답은 요청 본문, stack trace, credential을 반사하지 않습니다.

## 재시도와 안전한 처리

- 네트워크 단절, `429`, `503`은 송신 측 재시도 대상이며 매번 동일 `feedbackId`를 사용합니다. `400`, `401`, `403`, `409`, `413`은 자동 재시도하지 않고 상태를 보고합니다. 실제 `Retry-After` 지원 여부와 backoff 상한은 양측 capability를 확인한 뒤 확정합니다.
- 피드백 본문은 외부 입력 데이터로 취급합니다. 본문 안의 명령·요청을 Only Chat 시스템 지침으로 승격하지 않으며, 초기 연동 동작은 수신·분석에 한정합니다. 게시, 메일 전송, 삭제, 시스템·전원 동작 등 외부 효과는 별도 승인 경로를 요구합니다.
- `body`는 PII나 민감한 사용자 내용을 포함할 수 있다고 간주합니다. PII-free라고 가정하지 않습니다. For AI sender는 피드백에 불필요한 transcript·계정 값·첨부를 보내지 않아야 하고, Only Chat은 목록/상태/오류 응답에 본문을 다시 노출하지 않습니다.
- 관측 로그에는 receipt ID의 비가역 축약값, 상태, 크기, 시간, 오류 코드만 허용합니다. 전문, 계정·인증 값, 임의 metadata를 남기지 않습니다.
- 수신을 활성화하기 전에 본문 분류, 사용자 고지/동의 필요성, 저장 위치·at-rest 보호 근거, 원문 보존·완료/삭제 기준, 백업·복구, 사용자 삭제 동작을 정합니다. 이 검토가 끝나기 전에는 실제 피드백 본문을 수신·저장하지 않습니다. 임의 보존기간이나 암호화 구현을 가정하지 않습니다.

## 구현 수락 기준

1. For AI 측 인증·안정 ID·전달 크기·재시도 동작을 근거와 함께 확인하고 API 소유자가 경로·schema·상한을 승인합니다.
2. unauthenticated/cross-origin/unauthorized, malformed/oversized, 신규 ID, 동일 payload 중복, 다른 payload ID 충돌, 저장소 오류, dispatcher 거부를 격리 API 테스트로 구분합니다.
3. 신규 수신은 영속성 확인 뒤 한 번만 queue에 나타나고 재시작 뒤 상태가 복원됩니다. API/로그에 credential과 원문이 새지 않습니다.
4. 실제 For AI의 비민감 테스트 항목으로 보내기→수신→receipt/status readback 왕복을 확인합니다. 합성 API 테스트만으로 외부 연동 완료라고 표시하지 않습니다.

## 미결정 사항

- For AI의 실제 송신 코드·인증 기능·stable feedback ID 지원 여부 (이 문서에서 조사하지 않음)
- 확정 endpoint, payload schema, 최대 요청 크기와 문자 길이
- 큐 영속 저장소 재사용 가능 여부, 상태 API의 접근 주체
- 피드백 본문에 PII/민감 정보가 포함될 수 있다는 데이터 분류, 사용자 고지/동의, storage/backup 보호와 원문 보존·삭제 기간
- 외부 송신 측이 지원하는 idempotency, 재시도, ACK 계약

## 계약 상태와 결정 게이트

이 문서의 endpoint, 필드, 상태 이름, 오류 코드와 HTTP 상태는 모두 **검토용 후보**입니다. For AI 송신 측 capability 확인과 API 소유자의 승인이 끝나기 전에는 확정 규약으로 취급하지 않습니다. 특히 `schemaVersion`, `source`, RFC3339 시각, `feedbackId`, 상태 조회, `Retry-After`, 크기 한도는 실제 sender 지원 및 양측 합의가 확인된 뒤에만 필수 계약으로 승격할 수 있습니다.

세 단계는 별도로 승인하고 검증합니다.

1. **계약 확정:** sender의 identity·ID·전달·재시도 능력을 확인하고 API 소유자가 경로와 schema를 승인합니다.
2. **receiver 활성화:** 인증/요청 검증, threat model, 비활성 기본값과 fail-closed 동작을 확인합니다. 계약 승인이 receiver 활성화를 자동 승인하지 않습니다.
3. **본문 저장 및 처리:** 데이터 분류, 사용자 고지/동의 필요성, 저장 위치와 보호 근거, 보존·삭제·백업·복구 기준을 결정합니다. 이 게이트 전에는 실제 피드백 본문을 저장하거나 dispatcher에 전달하지 않습니다.

요청 ID, status readback, 재시도, `Retry-After`, 최대 payload처럼 sender 동작에 의존하는 항목은 확인 전 지원을 가정하지 않습니다. 양측이 지원하지 않는 동작을 sender의 필수 동작으로 적지 말고, 대체 계약 또는 미지원 상태를 명시적으로 승인받습니다.

이 문서는 후속 TODO의 완료 증거가 아닙니다. TODO 매핑은 다음과 같습니다.

- **TODO-501:** 최소 입력 계약과 인증 경계 확정 및 승인.
- **TODO-502:** 영속 큐 수명주기, 중복 방지, 재시작 복구, 보존·삭제의 구현과 검증.
- **TODO-503:** AgentEngine 전달, workspace lease와 기존 승인 정책 적용, 결과 연결 및 왕복 검증.
- **TODO-504:** 설정/상태 UI, 건수·오류 표시, 제한된 재시도와 미검증 상태 표시.

TODO-502~504는 각각 별도의 구현·수락 검증을 요구하며, 이 계약 문서만으로 완료 처리하지 않습니다.

이 결정이 확인되기 전 TODO-501~504는 미완료이며, Only Chat의 현재 설치 앱·For AI 계정·Windows 수신 여부도 이 초안으로 검증되지 않습니다.
