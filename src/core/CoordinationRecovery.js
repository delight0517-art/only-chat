'use strict';

// Only a local, typed pre-tool contention failure can authorize automatic replay.
function workspaceRecovery(error, executionEvidence, expectedResourceKey) {
  const evidence = error?.evidence;
  if (error?.code !== 'WORKSPACE_BUSY' || error.retryable !== true
    || executionEvidence?.attemptedCount !== 0 || executionEvidence?.successfulCount !== 0
    || executionEvidence?.failedCount !== 0 || executionEvidence?.allowedToolViolationCount !== 0
    || evidence?.scope !== 'workspace_execution' || evidence.repositoryWide !== false
    || evidence.resourceKey !== expectedResourceKey
    || !['free', 'stale', 'held'].includes(evidence.state)
    || (evidence.state !== 'free' && evidence.sameHost !== true)
    || !Number.isFinite(Date.parse(evidence.readAt))) return null;
  return { code: 'WORKSPACE_BUSY', scope: evidence.scope, resourceKey: expectedResourceKey,
    observedAt: evidence.readAt, phase: 'before_tools',
    plan: '같은 작업공간의 실제 소유권을 다시 확인하고, 해제되면 원래 허용 범위의 작업을 재개합니다. 다른 작업은 계속 진행합니다.' };
}

function canRecoverWorkspace(result) {
  const recovery = result?.recovery;
  return result?.status === 'blocked' && recovery?.code === 'WORKSPACE_BUSY'
    && recovery.scope === 'workspace_execution' && recovery.phase === 'before_tools'
    && /^[a-f0-9]{64}$/.test(recovery.resourceKey || '')
    && result.executionEvidence?.attemptedCount === 0
    && result.executionEvidence?.successfulCount === 0
    && result.executionEvidence?.failedCount === 0
    && result.executionEvidence?.allowedToolViolationCount === 0;
}

module.exports = { workspaceRecovery, canRecoverWorkspace };
