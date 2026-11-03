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
  let gitText = 'Git 상태를 확인할 수 없습니다.';
  if (gitStatus?.available === true) {
    gitText = Array.isArray(gitStatus.uncommitted) && gitStatus.uncommitted.length > 0
      ? `커밋되지 않은 변경 경로 ${gitStatus.uncommitted.length}개가 있습니다.`
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

if (typeof window !== 'undefined') window.workspaceOwnershipPresentation = { presentWorkspaceOwnership };
if (typeof module !== 'undefined') module.exports = { presentWorkspaceOwnership };
