import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { DesktopServer } = await import('../src/ui/desktop/server.js');
const { MetamorphicHub } = await import('../src/morph/Hub.js');
const { OwnershipLock } = await import('../src/core/OwnershipLock.js');

console.log('🚀 [E2E Live Test] Only Chat & GPT 시스템 전면 실증 테스트 시작...\n');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onlychat-e2e-live-'));
const workspaceDir = path.join(tmpDir, 'workspace');
fs.mkdirSync(workspaceDir, { recursive: true });

let app = null;

try {
  // 1. 서버 기동 및 상태 확인
  console.log('▶ Step 1: DesktopServer 기동 및 /api/status 확인');
  app = new DesktopServer({
    port: 0,
    isolated: true,
    dataDir: tmpDir,
    workspaceDir,
    enableQuotaRefresh: false,
    providerAdapter: async (tier, history, hooks, context) => {
      // Synthetic provider for testing
      if (context.signal?.aborted) {
        const err = new Error('Turn aborted by client');
        err.name = 'AbortError';
        throw err;
      }
      return { content: '안녕하세요! Only Chat 실증 응답입니다.', toolCalls: [] };
    }
  });

  const { port, url } = await app.start();
  console.log(`  ✓ 서버 실행 확인: ${url} (port: ${port})`);

  const statusRes = await fetch(`${url}/api/status`);
  assert.equal(statusRes.status, 200);
  const statusData = await statusRes.json();
  assert.ok(['chat', 'priority-first'].includes(statusData.mode));
  console.log(`  ✓ /api/status 200 OK 수신 (mode: ${statusData.mode})`);

  // 2. 신체 개조 핫리로드 (/api/morph/mutate) 지연 큐 및 턴 종료 즉시 반영 테스트
  console.log('▶ Step 2: 신체 개조(Body Mod) 핫리로드 - 작업 중 지연 큐잉 및 턴 종료 자동 반영 테스트');
  app.activeTurns = 1; // 작업 중 상태 시뮬레이션
  const mutateRes = await fetch(`${url}/api/morph/mutate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ organ: 'theme', key: 'accentCyan', value: '#38bdf8', author: 'e2e-test' })
  });
  assert.equal(mutateRes.status, 202, '작업 중에는 HTTP 202 Accepted로 큐잉되어야 함');
  const mutateData = await mutateRes.json();
  assert.equal(mutateData.queued, true);
  assert.equal(app.hub.getHubStatus().pendingMutationsCount, 1, '변형 요청이 큐에 안전하게 적재됨');
  console.log('  ✓ 작업 중 변형 요청 유실 없이 HTTP 202로 큐잉 확인');

  // 작업 완료 시점 트리거
  app._decrementActiveTurns();
  assert.equal(app.activeTurns, 0);
  assert.equal(app.hub.getHubStatus().pendingMutationsCount, 0, '턴 종료 즉시 큐 플러시 완료');
  assert.equal(app.hub.getOrganData('theme').accentCyan, '#38bdf8', '테마 값이 외과적으로 반영됨');
  console.log('  ✓ 턴 종료 즉시 신체 개조(테마 변형) 자동 반영 확인 (accentCyan -> #38bdf8)');

  // 3. 작업 중단 (Turn Abort / Cancel) 테스트
  console.log('▶ Step 3: 작업 중단 (Turn Abort / Cancellation) 테스트');
  let abortCalled = false;
  const mockController = new AbortController();
  mockController.signal.addEventListener('abort', () => { abortCalled = true; });
  app.activeTurnControllers.add(mockController);
  app.activeTurns += 1;
  assert.equal(app.activeTurns, 1);

  // 클라이언트 취소 신호 시뮬레이션
  mockController.abort(new Error('사용자 작업 취소'));
  assert.equal(abortCalled, true);
  app.activeTurnControllers.delete(mockController);
  app._decrementActiveTurns();
  assert.equal(app.activeTurns, 0);
  console.log('  ✓ 작업 중단 신호 정상 수신 및 activeTurns 안전 0 복귀 확인');

  // 4. 소유권 회수 및 전이 (Take Over / Transfer) 테스트
  console.log('▶ Step 4: 소유권 락(Ownership Lock) 회수 및 전이(Take Over) 테스트');
  const ownership = new OwnershipLock({ workspaceDir });
  const testFile = 'src/test-feature.js';
  fs.mkdirSync(path.join(workspaceDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, testFile), '// initial work');

  // 이전 소유자 'gpt-agent-previous'가 잠금
  const initialLock = ownership.acquireLocks('gpt-agent-previous', [testFile], { ttlMs: 300_000 });
  assert.equal(initialLock.acquired, true);
  const normPath = ownership.normalizePath(testFile);
  assert.equal(ownership.locks.get(normPath)?.taskId, 'gpt-agent-previous');
  console.log('  ✓ 이전 작업자(gpt-agent-previous) 소유권 잠금 확인');

  // 새 작업자 'only-chat-takeover'가 take over(전이) 수행
  const transferred = ownership.transferLocks('gpt-agent-previous', 'only-chat-takeover', [testFile], 300_000);
  assert.equal(transferred.length, 1);
  assert.equal(ownership.locks.get(normPath)?.taskId, 'only-chat-takeover');
  console.log('  ✓ 소유권 전이(Take Over) 성공: 소유자 gpt-agent-previous -> only-chat-takeover');

  ownership.releaseLocks('only-chat-takeover', [testFile]);
  assert.equal(ownership.locks.has(normPath), false);
  console.log('  ✓ 소유권 안전 해제 확인');

  // 5. TODO 태스크 디스패처 큐잉 및 실행 테스트
  console.log('▶ Step 5: TODO 태스크 디스패처 큐잉 및 자율 실행 테스트');
  const todoTask = {
    id: 'e2e-todo-task-001',
    title: '신체 개조 및 코디네이션 자가 점검 TODO',
    prompt: 'Check system health and report status',
    allowedTools: ['read_file'],
    requireToolExecution: false
  };

  const enqueueRes = await fetch(`${url}/api/dispatcher/enqueue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify(todoTask)
  });
  assert.equal(enqueueRes.status, 200);
  const enqueueData = await enqueueRes.json();
  assert.ok(enqueueData.enqueued.length > 0);
  console.log('  ✓ TODO 태스크 디스패처 등록 성공 (/api/dispatcher/enqueue)');

  const dispatchSnapshotRes = await fetch(`${url}/api/dispatcher`);
  assert.equal(dispatchSnapshotRes.status, 200);
  const dispatchSnapshot = await dispatchSnapshotRes.json();
  assert.ok(
    dispatchSnapshot.queue.some(t => t.id === 'e2e-todo-task-001') ||
    dispatchSnapshot.completedTasks?.some(t => t.id === 'e2e-todo-task-001') ||
    dispatchSnapshot.activeWorkers?.some(w => w.task?.id === 'e2e-todo-task-001') ||
    dispatchSnapshot.terminalTasks?.some(t => t.id === 'e2e-todo-task-001')
  );
  console.log('  ✓ 디스패처 큐 스냅샷 내 TODO 태스크 확인 완료');

  console.log('\n🎉 [성공] Only Chat E2E 라이브 테스트 100% 통과!\n');
} finally {
  if (app) app.stop();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
