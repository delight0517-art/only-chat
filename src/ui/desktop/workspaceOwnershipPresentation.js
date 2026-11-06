'use strict';

function presentWorkspaceOwnership(payload) {
  const pathLockState = payload?.pathLocks;
  const pathLocks = Array.isArray(pathLockState?.locks)
    ? pathLockState.locks
    : Array.isArray(payload?.locks) ? payload.locks : null;
  const pathLockText = pathLocks === null
    ? '개별 파일 잠금 상태를 확인할 수 없습니다.'
    : pathLocks.length > 0
      ? `현재 보유 중인 개별 경로 잠금 ${pathLocks.length}개 (저장소 전체 잠금 아님)`
      : '현재 보유 중인 개별 경로 잠금이 없습니다. 다른 작업의 부재를 뜻하지는 않습니다.';

  const lease = payload?.workspaceLease;
  let leaseText = '작업 상태를 알 수 없습니다.';
  let leaseDetail = '';

  if (lease?.state === 'unknown') {
    const reason = typeof lease.reason === 'string' && lease.reason ? lease.reason : 'source_unavailable';
    leaseDetail = `잠금 출처 확인 불가 · 원인 ${reason} · 소유자를 확인하기 전에는 임의 해제할 수 없습니다.`;
  } else if (lease?.state === 'free') leaseText = '이 작업공간의 실행 임대가 없습니다. 경로 편집 잠금이나 저장소 전체 잠금 상태를 뜻하지는 않습니다.';
  else if (lease?.state === 'held' && lease.sameHost === true) {
    leaseText = '이 Mac에서 이 작업공간의 실행 임대를 사용 중입니다. 개별 경로 잠금 및 통합 준비 상태와 별도입니다.';
    leaseDetail = formatLeaseDetail(lease);
  } else if (lease?.state === 'stale' && lease.sameHost === true) {
    leaseText = '이 작업공간에 오래된 실행 임대가 있습니다. 개별 경로 잠금 및 통합 준비 상태와 별도입니다.';
    leaseDetail = formatLeaseDetail(lease);
  } else if (lease?.state === 'held' && lease.sameHost === false) {
    leaseText = '다른 호스트가 이 작업공간의 실행 임대를 보유합니다. 오래된 잠금인지 판단할 수 없고, 개별 경로 잠금과도 별도입니다.';
    leaseDetail = formatLeaseDetail(lease);
  }

  const gitStatus = payload?.gitStatus;
  const uncommitted = payload?.uncommitted ?? gitStatus?.uncommitted;
  let gitText = 'Git 상태를 확인할 수 없습니다.';
  if (gitStatus?.available === true && Array.isArray(uncommitted)) {
    gitText = uncommitted.length > 0
      ? `커밋되지 않은 변경 경로 ${uncommitted.length}개가 있습니다.`
      : '커밋되지 않은 변경 사항이 없습니다.';
  }

  return { pathLockText, leaseText, leaseDetail, gitText };
}

function formatLeaseDetail(lease) {
  const parts = [];
  parts.push(typeof lease.sourceChatId === 'string' && lease.sourceChatId
    ? `출처 채팅 ${lease.sourceChatId}` : '출처 채팅 미기록');
  if (typeof lease.host === 'string' && lease.host) parts.push(`호스트 ${lease.host}`);
  if (Number.isSafeInteger(lease.pid) && lease.pid > 0) parts.push(`PID ${lease.pid}`);
  const timestamp = typeof lease.startedAt === 'string' && Number.isFinite(Date.parse(lease.startedAt))
    ? new Date(lease.startedAt).toLocaleString() : '';
  if (timestamp) parts.push(`시작 ${timestamp}`);
  const expiresAt = typeof lease.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(lease.leaseExpiresAt))
    ? new Date(lease.leaseExpiresAt).toLocaleString() : '';
  if (expiresAt) parts.push(`임대 만료 ${expiresAt}`);
  else if (lease.releaseCondition === 'operation_completion_or_verified_process_death') {
    parts.push('고정 만료 시각 없음 · 실행 완료 또는 확인된 소유 프로세스 종료 시 해제');
  } else if (lease.releaseCondition === 'owner_operation_completion_or_explicit_owner_release') {
    parts.push('고정 만료 시각 없음 · 원격 소유자의 실행 완료 또는 명시적 해제 시 종료');
  } else parts.push('만료 시각 확인 필요');
  return parts.join(' · ');
}

function presentTaskResumeFailure(result = {}) {
  const owner = typeof result.ownerChatId === 'string' && result.ownerChatId
    ? `담당 채팅 ${result.ownerChatId}` : '담당 채팅 출처 미확인';
  const expiresAt = typeof result.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(result.leaseExpiresAt))
    ? new Date(result.leaseExpiresAt).toLocaleString() : '만료 시각 미확인';
  if (result.reason === 'path_scope_conflict') {
    const paths = Array.isArray(result.paths) ? result.paths.filter(item => typeof item === 'string' && item) : [];
    const blockingTask = result.blockingTask || result.blockedExecutors?.flatMap(item => item.blockingTasks || [])[0];
    const source = blockingTask && [
      `요청 채팅 ${blockingTask.sourceChatId || '미기록'}`,
      `마지막 기록 채팅 ${blockingTask.lastUpdatedByChatId || '미기록'}`,
      `기기 ${blockingTask.lastUpdatedByHostId || blockingTask.sourceHostId || '미기록'}`,
      `기록 시각 ${blockingTask.lastUpdatedAt && Number.isFinite(Date.parse(blockingTask.lastUpdatedAt))
        ? new Date(blockingTask.lastUpdatedAt).toLocaleString() : '미기록'}`
    ].join(' · ');
    const blockerTitle = blockingTask?.title ? ` (${blockingTask.title})` : '';
    const blockerOwner = blockingTask?.ownerChatId || owner.replace(/^담당 채팅 /u, '');
    const blockerExpiry = blockingTask?.leaseExpiresAt && Number.isFinite(Date.parse(blockingTask.leaseExpiresAt))
      ? new Date(blockingTask.leaseExpiresAt).toLocaleString() : expiresAt;
    return `경로 충돌 · 작업 ${result.blockingTaskKey || blockingTask?.taskKey || '출처 미확인'}${blockerTitle} · ${source || owner} · 담당 채팅 ${blockerOwner || '출처 미확인'} · 임대 ${blockerExpiry}${paths.length ? ` · 충돌 경로 ${paths.join(', ')}` : ''}. 겹치지 않는 경로의 작업은 계속 진행할 수 있습니다.`;
  }
  if (result.reason === 'task_still_leased' || result.reason === 'owned_by_other_chat') {
    return `이 작업은 ${owner}가 담당 중입니다 · 임대 ${expiresAt}. 다른 작업은 각 경로 소유권을 확인해 계속 진행할 수 있습니다.`;
  }
  return typeof result.reason === 'string' && result.reason
    ? `재개 대기 · ${result.reason}`
    : typeof result.error === 'string' && result.error ? result.error : '재개 요청을 접수하지 못했습니다.';
}

const WORKBENCH_STATUSES = {
  planned: ['대기', 'quiet'], claimed: ['담당 배정', 'active'], executing: ['작업 중', 'active'],
  verifying: ['검증 중', 'active'], integrating: ['통합 중', 'active'], reviewing: ['검토 중', 'active'],
  blocked: ['막힘', 'attention'], failed: ['실패 기록', 'attention'], completed: ['완료 기록', 'done']
};

// This is the recorded current phase, not proof that earlier phases passed.
const WORKBENCH_PHASES = { planned: 0, claimed: 0, executing: 1, verifying: 2, reviewing: 2, integrating: 3, completed: 3 };

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : '';
}

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
        sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
        attempt: Number.isSafeInteger(item.attempt) && item.attempt >= 0 ? item.attempt : 0,
        result: typeof item.result === 'string' ? item.result.slice(0, 8_000) : '',
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 2_000) : '',
        error: typeof item.error === 'string' ? item.error.slice(0, 2_000) : '',
        history: Array.isArray(item.history) ? item.history.filter(entry => entry && typeof entry.status === 'string').map(entry => ({
          attempt: Number.isSafeInteger(entry.attempt) && entry.attempt >= 0 ? entry.attempt : 0,
          status: entry.status, result: typeof entry.result === 'string' ? entry.result.slice(0, 8_000) : '',
          sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : '',
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
      sourceChatId: typeof task.creatorChatId === 'string' ? task.creatorChatId : '',
      sourceHostId: typeof task.sourceHostId === 'string' ? task.sourceHostId : '',
      createdAt: validTimestamp(task.createdAt),
      lastUpdatedByChatId: typeof task.lastUpdatedByChatId === 'string' ? task.lastUpdatedByChatId : '',
      lastUpdatedByHostId: typeof task.lastUpdatedByHostId === 'string' ? task.lastUpdatedByHostId : '',
      lastUpdatedAt: validTimestamp(task.lastUpdatedAt) || validTimestamp(task.updatedAt),
      leaseExpiresAt: validTimestamp(task.leaseExpiresAt),
      next: typeof task.checkpoint?.nextAction === 'string' ? task.checkpoint.nextAction : '',
      blocker: typeof task.checkpoint?.blocker === 'string' ? task.checkpoint.blocker : '',
      paths: Array.isArray(task.paths) ? task.paths.filter(item => typeof item === 'string') : [],
      leasePaths: Array.isArray(task.leasePaths) ? task.leasePaths.filter(item => typeof item === 'string') : [],
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

const workspaceOwnershipPresentation = { presentWorkspaceOwnership, presentWorkbenchTasks, presentTaskResumeFailure };
if (typeof window !== 'undefined') window.workspaceOwnershipPresentation = workspaceOwnershipPresentation;
if (typeof module !== 'undefined') module.exports = workspaceOwnershipPresentation;
