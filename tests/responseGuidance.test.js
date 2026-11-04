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
  assert.match(RESPONSE_GUIDANCE, /앱 기능\)/);
  assert.match(RESPONSE_GUIDANCE, /한 경로의 잠금은 저장소 전체 잠금이 아니/);
  assert.match(RESPONSE_GUIDANCE, /출처, 정확한 저장소\/작업공간\/경로, 잠금 종류, 결과, 확인 시각을 행별로 분리한다/);
  assert.match(RESPONSE_GUIDANCE, /현재 대상과 다른 저장소의 측정값은 명시적으로 제외/);
  assert.match(RESPONSE_GUIDANCE, /정확한 대상의 새 조회가 없으면 잠금 상태는 unknown/);
});

test('separates source edits, reload eligibility, loaded revision, and visible behavior', () => {
  assert.match(RESPONSE_GUIDANCE, /소스 수정, 수정 모듈의 재적용 가능 여부, 실행 중 프로세스가 불러온 리비전, 화면\/동작 확인을 별도 증거로 보고한다/);
  assert.match(RESPONSE_GUIDANCE, /소스 수정이나 성공한 reload 명령만으로 실행 중 앱에 반영됐다고 말하지 않는다/);
});
