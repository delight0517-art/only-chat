'use strict';

function presentWorkspaceOwnership(payload) {
  const lease = payload?.workspaceLease;
  let leaseText = '작업 상태를 알 수 없습니다.';
  let leaseDetail = '';

  if (lease?.state === 'free') leaseText = '현재 작업이 없습니다.';
  else if (lease?.state === 'held' && lease.sameHost === true) {
    leaseText = '이 Mac에서 작업 중입니다.';
    leaseDetail = formatLeaseDetail(lease);
  } else if (lease?.state === 'stale' && lease.sameHost === true) {
    leaseText = '이 Mac에 오래된 잠금이 있습니다.';
    leaseDetail = formatLeaseDetail(lease);
  } else if (lease?.state === 'held' && lease.sameHost === false) {
    leaseText = '다른 호스트의 잠금 파일이 있습니다. 오래된 잠금인지 판단할 수 없습니다.';
  }

  const gitStatus = payload?.gitStatus;
  const uncommitted = payload?.uncommitted ?? gitStatus?.uncommitted;
  let gitText = 'Git 상태를 확인할 수 없습니다.';
  if (gitStatus?.available === true && Array.isArray(uncommitted)) {
    gitText = uncommitted.length > 0
      ? `커밋되지 않은 변경 경로 ${uncommitted.length}개가 있습니다.`
      : '커밋되지 않은 변경 사항이 없습니다.';
  }

  return { leaseText, leaseDetail, gitText };
}

function formatLeaseDetail(lease) {
  const parts = [];
  if (Number.isSafeInteger(lease.pid) && lease.pid > 0) parts.push(`PID ${lease.pid}`);
  const timestamp = typeof lease.startedAt === 'string' && Number.isFinite(Date.parse(lease.startedAt))
    ? new Date(lease.startedAt).toLocaleString() : '';
  if (timestamp) parts.push(`시작 ${timestamp}`);
  return parts.join(' · ');
}

const WORKBENCH_STATUSES = {
  planned: ['대기', 'quiet'], claimed: ['담당 배정', 'active'], executing: ['작업 중', 'active'],
  verifying: ['검증 중', 'active'], integrating: ['통합 중', 'active'], reviewing: ['검토 중', 'active'],
  blocked: ['막힘', 'attention'], failed: ['실패 기록', 'attention'], completed: ['완료 기록', 'done']
};

// This is the recorded current phase, not proof that earlier phases passed.
const WORKBENCH_PHASES = { planned: 0, claimed: 0, executing: 1, verifying: 2, reviewing: 2, integrating: 3, completed: 3 };

function presentWorkbenchTasks(tasks, now = Date.now()) {
  if (!Array.isArray(tasks)) throw new TypeError('Task snapshot must be an array');
  const seen = new Set();
  const rows = tasks.filter(task => {
    if (!task || typeof task.taskKey !== 'string' || seen.has(task.taskKey)) return false;
    seen.add(task.taskKey);
    return true;
  }).map(task => {
    const repository = typeof task.repositoryPath === 'string' ? task.repositoryPath : '';
    const app = /[/\\]my-codex[/\\]?$/u.test(repository) ? 'Only Chat'
      : repository.split(/[/\\]/u).filter(Boolean).pop() || '앱 미지정';
    let [label, tone] = WORKBENCH_STATUSES[task.status] || ['상태 미확인', 'attention'];
    // An old checkpoint is not proof that its owner is still executing.
    if (tone === 'active' && (!task.ownerChatId || !Number.isFinite(Date.parse(task.leaseExpiresAt))
      || Date.parse(task.leaseExpiresAt) <= now)) [label, tone] = ['담당 확인 필요', 'attention'];
    const evidence = Array.isArray(task.checkpoint?.evidenceRefs)
      ? task.checkpoint.evidenceRefs.filter(ref => typeof ref === 'string' && ref) : [];
    const executionProgress = Array.isArray(task.executionProgress)
      ? task.executionProgress.filter(item => item && typeof item.title === 'string' && typeof item.status === 'string').map(item => ({
        title: item.title.slice(0, 120), status: item.status,
        attempt: Number.isSafeInteger(item.attempt) && item.attempt >= 0 ? item.attempt : 0,
        result: typeof item.result === 'string' ? item.result.slice(0, 8_000) : '',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 2_000) : '',
        error: typeof item.error === 'string' ? item.error.slice(0, 2_000) : '',
        history: Array.isArray(item.history) ? item.history.filter(entry => entry && typeof entry.status === 'string').map(entry => ({
          attempt: Number.isSafeInteger(entry.attempt) && entry.attempt >= 0 ? entry.attempt : 0,
          status: entry.status, result: typeof entry.result === 'string' ? entry.result.slice(0, 8_000) : '',
          reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 2_000) : '',
          error: typeof entry.error === 'string' ? entry.error.slice(0, 2_000) : ''
        })) : []
      })) : [];
    const leaseExpired = !task.ownerChatId || !Number.isFinite(Date.parse(task.leaseExpiresAt)) || Date.parse(task.leaseExpiresAt) <= now;
    const canResume = Boolean(task.execution && executionProgress.some(item => item.status !== 'completed')
      && (task.status === 'blocked' || (['claimed', 'executing'].includes(task.status) && leaseExpired)));
    if (task.status === 'completed' && !evidence.length) [label, tone] = ['완료 근거 확인 필요', 'attention'];
    return {
      key: task.taskKey, title: typeof task.title === 'string' ? task.title : task.taskKey,
      repository, app, label, tone, status: task.status,
      phase: tone === 'attention' ? null : WORKBENCH_PHASES[task.status] ?? null,
      owner: typeof task.ownerChatId === 'string' ? task.ownerChatId : '',
      next: typeof task.checkpoint?.nextAction === 'string' ? task.checkpoint.nextAction : '',
      blocker: typeof task.checkpoint?.blocker === 'string' ? task.checkpoint.blocker : '',
      paths: Array.isArray(task.paths) ? task.paths.filter(item => typeof item === 'string') : [],
      evidence, executionProgress,
      creatorChatId: typeof task.creatorChatId === 'string' ? task.creatorChatId : '', canResume
    };
  });
  const priority = { attention: 0, active: 1, quiet: 2, done: 3 };
  rows.sort((a, b) => priority[a.tone] - priority[b.tone]);
  return {
    rows, apps: new Set(rows.map(row => row.repository).filter(Boolean)).size,
    active: rows.filter(row => row.tone === 'active').length,
    attention: rows.filter(row => row.tone === 'attention').length
  };
}

const workspaceOwnershipPresentation = { presentWorkspaceOwnership, presentWorkbenchTasks };
if (typeof window !== 'undefined') window.workspaceOwnershipPresentation = workspaceOwnershipPresentation;
if (typeof module !== 'undefined') module.exports = workspaceOwnershipPresentation;
