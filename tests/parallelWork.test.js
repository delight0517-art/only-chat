/**
 * @project My-Codex
 * @provenance:rogan-core
 * @description Test Suite verifying Skill Live-Reload, Adaptive Memory Dispatcher, and Ownership Locks.
 */
'use strict';

const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const { SkillManager } = require('../src/core/SkillManager.js');
const { ParallelDispatcher } = require('../src/core/ParallelDispatcher.js');
const { OwnershipLock } = require('../src/core/OwnershipLock.js');
const { HandoffAdapter } = require('../src/core/HandoffAdapter.js');

async function testParallelSystem() {
  console.log('🧪 [Test Suite] Rogan 요구사항 핵심 4대 엔진 검증 시작...\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-parallel-'));
  let skillManager;
  let dispatcher;
  try {
  const pluginCacheDir = path.join(tmpDir, 'plugin-cache');
  const skillFile = path.join(pluginCacheDir, 'remote', 'plugin', '1.0.0', 'skills', 'fixture', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.writeFileSync(skillFile, 'fixture skill content');

  // 1. Skill discovery and hot-reload shortcut
  console.log('▶ Test 1: 중첩된 Codex 플러그인 캐시 스킬 발견 및 $단축키 주입');
  skillManager = new SkillManager({ workspaceDir: tmpDir, pluginCacheDir });
  const prompt = '검증: $fixture';
  const resolved = skillManager.resolvePromptShortcuts(prompt);
  assert.ok(resolved.injectedSkills.includes('fixture'));
  assert.ok(resolved.text.includes('fixture skill content'));
  assert.ok(skillManager.resolvePromptShortcuts('$parallel-work').injectedSkills.includes('parallel-work'));
  console.log('  ✓ 중첩된 플러그인 캐시와 기본 스킬이 발견됨');

  // 2. Adaptive Memory Dispatcher Test
  console.log('▶ Test 2: OS 메모리(RAM) 여유율 기반 적응형 동시 작업수 산출 검증');
  dispatcher = new ParallelDispatcher();
  const mem = dispatcher.getMemoryMetrics();
  console.log(`  - 시스템 총 RAM: ${mem.totalGb} GB, 여유 RAM: ${mem.freeGb} GB (${mem.freePercent}%)`);
  console.log(`  - 메모리 압력 등급: ${mem.pressureLevel}, 허용 병렬 워커: ${mem.allowedWorkers}개`);
  assert.ok(typeof mem.allowedWorkers === 'number');

  // Enqueue test batch
  const testBatch = [
    { title: 'Task 1: Focus Fence 서명 점검', files: ['focus.swift'], allowedTools: ['read_file'] },
    { title: 'Task 2: M-Oasis 핫리로드 통합', files: ['moasis.js'], allowedTools: ['read_file'] },
    { title: 'Task 3: For AI 피드백 큐 정리', files: ['for-ai.md'], allowedTools: ['read_file'] }
  ];
  const enqueued = dispatcher.enqueueTasks(testBatch);
  assert.strictEqual(enqueued.length, 3);
  console.log('  ✓ 3개 요청이 메모리 보호 큐에 등록되고 동시 실행 감시 시작됨 확인');
  dispatcher.stop();

  // 3. Ownership Lock & Collision Prevention Test
  console.log('▶ Test 3: 파일 소유권 잠금 (File Ownership Lock) 및 충돌 방지 검증');
  const lock = new OwnershipLock({ workspaceDir: tmpDir });
  const lock1 = lock.acquireLocks('task_worker_1', ['src/app.js']);
  assert.strictEqual(lock1.acquired, true);

  // Attempt to acquire same file from another task
  const lock2 = lock.acquireLocks('task_worker_2', ['src/app.js']);
  assert.strictEqual(lock2.acquired, false);
  assert.ok(lock2.reason.includes('병렬 충돌 방지를 위해 직렬화 대기합니다'));
  console.log('  ✓ 동일 파일 동시 수정 시 충돌 방지 대기(Serialization) 정상 작동 확인');

  lock.releaseLocks('task_worker_1');
  const lock3 = lock.acquireLocks('task_worker_2', ['src/app.js']);
  assert.strictEqual(lock3.acquired, true);
  console.log('  ✓ 이전 작업 완료 후 잠금 해제 및 다음 작업 락 획득 성공');

  // 4. Windows Handoff & Resume Test
  console.log('▶ Test 4: 재시작 자동 복구 및 Windows handoff 번들 생성 검증');
  const handoff = new HandoffAdapter({ storageDir: tmpDir });
  const saved = handoff.saveCheckpoint({ sessionId: 'ses_123', status: 'in-flight' });
  const loaded = handoff.loadCheckpoint();
  assert.strictEqual(loaded.sessionId, 'ses_123');

  const winScript = handoff.exportWindowsBundle(tmpDir);
  assert.ok(fs.existsSync(winScript));
  console.log('  ✓ Windows 원격 재개 스크립트(run-windows.ps1) 및 체크포인트 영속화 성공');

  console.log('\n🎉 [성공] 병렬 시스템 소스 검사 완료');
  } finally {
    skillManager?.stopWatching();
    dispatcher?.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

testParallelSystem().catch(err => {
  console.error('\n❌ 테스트 실패:', err);
  process.exitCode = 1;
});
