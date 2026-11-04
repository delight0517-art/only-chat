'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RESPONSE_GUIDANCE, withResponseGuidance } = require('../src/providers/responseGuidance.js');

test('requires lock claims to name their measured scope and lock kind', () => {
  assert.match(RESPONSE_GUIDANCE, /저장소\/작업공간\/경로와 잠금 종류/);
  assert.match(RESPONSE_GUIDANCE, /leases_clear.*도구와 범위를 확인하기 전까지/);
  assert.match(RESPONSE_GUIDANCE, /확인하지 못한 범위는 모름/);
  assert.match(withResponseGuidance('USER\ninspect lock'), /다른 저장소나 작업의 잠금 상태를 현재 대상의 상태로 옮겨 말하지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /lease 종류·경로·task·owner/);
  assert.match(RESPONSE_GUIDANCE, /해당 lease가 현재 수정 경로와 충돌하는지 확인/);
  assert.match(RESPONSE_GUIDANCE, /integration guard의 실패는 소스 통합 가능성에 대한 측정/);
  assert.match(RESPONSE_GUIDANCE, /앱의 스케줄 잠금\/해제 측정으로 바꾸어 말하지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /`leases_clear:false`만으로 실제 lease의 존재·소유자·충돌 여부를 단정하지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /앱 기능\)/);
  assert.match(RESPONSE_GUIDANCE, /한 경로의 잠금은 저장소 전체 잠금이 아니/);
  assert.match(RESPONSE_GUIDANCE, /출처, 정확한 저장소\/작업공간\/경로, 잠금 종류, 결과, 확인 시각을 행별로 분리한다/);
  assert.match(RESPONSE_GUIDANCE, /현재 대상과 다른 저장소의 측정값은 명시적으로 제외/);
  assert.match(RESPONSE_GUIDANCE, /Detox 저장소의 편집 lease가 있어도 Focus Fence 저장소가 잠겼다는 뜻은 아니다/);
  assert.match(RESPONSE_GUIDANCE, /Focus Fence 저장소를 직접 조회한 결과만으로 설명/);
  assert.match(RESPONSE_GUIDANCE, /Detox lease는 그 결론의 원인이나 근거에서 제외/);
  assert.match(RESPONSE_GUIDANCE, /정확한 대상의 새 조회가 없으면 잠금 상태는 unknown/);
  assert.match(RESPONSE_GUIDANCE, /사용자가 앞선 잠금·기능 상태 판단이 틀렸다고 지적하면 먼저/);
  assert.match(RESPONSE_GUIDANCE, /대상 리소스의 상태를 다시 읽고/);
  assert.match(RESPONSE_GUIDANCE, /관련 없는 저장소 lease나 통합 경고를 이유로 기능 결함 판단·수정을 보류하지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /런타임을 확인할 수 없으면 수정 결과와 런타임 미검증을 분리해 보고한다/);
  assert.match(RESPONSE_GUIDANCE, /재현하지 않은 원인까지 사실로 단정하지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /“고장이라고 단정할 수 없다”는 말로 조사를 끝내지 않는다/);
  assert.match(RESPONSE_GUIDANCE, /대상 구현, 잠금 해제\/해제 조건, 데이터 저장 경로와 호출자를 추적/);
  assert.match(RESPONSE_GUIDANCE, /런타임 증거가 없으면 동작 성공 여부만 미검증으로 남기며/);
  assert.match(RESPONSE_GUIDANCE, /앞선 답에서 섞인 측정값과 잘못된 추론을 명시/);
  assert.match(RESPONSE_GUIDANCE, /기능 재현이 없다는 이유로 수정 요청을 무시하지 않는다/);
});

test('separates source edits, reload eligibility, loaded revision, and visible behavior', () => {
  assert.match(RESPONSE_GUIDANCE, /소스 수정, 수정 모듈의 재적용 가능 여부, 실행 중 프로세스가 불러온 리비전, 화면\/동작 확인을 별도 증거로 보고한다/);
  assert.match(RESPONSE_GUIDANCE, /소스 수정이나 성공한 reload 명령만으로 실행 중 앱에 반영됐다고 말하지 않는다/);
});
