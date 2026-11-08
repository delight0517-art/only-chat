'use strict';

const SESSION_ID = /^ses_[a-f0-9]{16}$/;

function update(engine, checkpoint, values) {
  return engine.handoff.updateCheckpoint(checkpoint.sessionId, values);
}

function finish(engine, checkpoint, status, reason = '') {
  update(engine, checkpoint, { status, recoveryReason: reason, recoveredAt: Date.now() });
  try {
    engine.sessions.appendItem(checkpoint.sessionId, {
      type: 'session_metadata', metadata: { restartRecovery: { status, reason } }
    });
  } catch (_) {}
  return { status, sessionId: checkpoint.sessionId, reason };
}

async function recoverInterruptedTurn(engine, { enabled = true } = {}) {
  if (!enabled || !engine?.handoff || !engine?.sessions) return { status: 'disabled' };
  const checkpoint = engine.handoff.loadCheckpoint();
  if (!checkpoint || checkpoint.version !== 2) return { status: 'no_recoverable_checkpoint' };
  if (checkpoint.status === 'resuming') return finish(engine, checkpoint, 'needs_review', '이전 자동 재개가 다시 중단되어 중복 실행을 막았습니다.');
  if (!['running', 'restart_pending'].includes(checkpoint.status)) return { status: 'no_recoverable_checkpoint' };
  if (checkpoint.autoResume !== true || checkpoint.recoveryDisabledReason || checkpoint.resumeAttempts >= 1) {
    return finish(engine, checkpoint, 'needs_review', '저장된 실행 권한이나 재개 횟수를 확인할 수 없어 자동 재개하지 않았습니다.');
  }
  if (typeof checkpoint.sessionId !== 'string' || !SESSION_ID.test(checkpoint.sessionId)
    || typeof checkpoint.lastPrompt !== 'string' || !checkpoint.lastPrompt.trim()) {
    return finish(engine, checkpoint, 'needs_review', '재개 체크포인트의 세션 또는 요청을 검증하지 못했습니다.');
  }

  const records = engine.sessions.readSession(checkpoint.sessionId);
  if (!Array.isArray(records)) return finish(engine, checkpoint, 'needs_review', '저장된 대화를 찾지 못했습니다.');
  const lastUserIndex = records.findLastIndex(record => record.type === 'user_message' && record.content === checkpoint.lastPrompt);
  if (lastUserIndex < 0) return finish(engine, checkpoint, 'needs_review', '체크포인트와 저장된 사용자 요청이 일치하지 않습니다.');
  const after = records.slice(lastUserIndex + 1);
  if (after.some(record => record.type === 'assistant_message')) return finish(engine, checkpoint, 'completed');
  if (after.some(record => record.type === 'turn_error')) return finish(engine, checkpoint, 'interrupted', '마지막 실행은 오류로 종료되어 자동 재요청하지 않았습니다.');

  const calls = after.filter(record => record.type === 'assistant_tool_calls').flatMap(record => record.toolCalls || []);
  const callIds = new Set(calls.map(call => call?.id).filter(id => typeof id === 'string' && id));
  if (calls.some(call => !call || typeof call.id !== 'string' || typeof call.name !== 'string')) {
    return finish(engine, checkpoint, 'needs_review', '저장된 도구 호출 기록을 검증하지 못했습니다.');
  }
  const starts = new Set(after.filter(record => record.type === 'tool_start').map(record => record.tool_call_id));
  const results = new Set(after.filter(record => record.type === 'tool_result').map(record => record.tool_call_id).filter(Boolean));
  if ([...starts].some(id => !callIds.has(id)) || [...results].some(id => !callIds.has(id))) {
    return finish(engine, checkpoint, 'needs_review', '도구 실행 기록의 연결이 일치하지 않습니다.');
  }
  if ([...starts].some(id => !results.has(id))) {
    return finish(engine, checkpoint, 'needs_review', '재시작 시점에 도구가 실행 중이었을 수 있어 중복 실행을 막았습니다. 현재 상태를 먼저 확인해야 합니다.');
  }

  for (const call of calls) {
    if (results.has(call.id)) continue;
    engine.sessions.appendItem(checkpoint.sessionId, {
      type: 'tool_result', tool_call_id: call.id, tool: call.name,
      result: { error: '앱 재시작 전에 이 도구는 시작되지 않았습니다. 현재 상태를 확인한 뒤 다시 판단하세요.', blocked: true }
    });
  }

  const session = engine.sessions.resumeSession(checkpoint.sessionId);
  if (!session || session.source !== 'internal' || session.cwd !== checkpoint.workspaceDir
    || (checkpoint.route?.provider && checkpoint.route.provider !== session.provider)) {
    return finish(engine, checkpoint, 'needs_review', '저장된 세션의 작업공간 또는 AI 제공자를 확인할 수 없습니다.');
  }

  const route = checkpoint.route || { provider: session.provider, model: session.model };
  if (typeof route.model !== 'string' || !route.model.trim()) {
    return finish(engine, checkpoint, 'needs_review', '재개할 AI 모델을 확인할 수 없습니다.');
  }
  update(engine, checkpoint, { status: 'resuming', resumeAttempts: checkpoint.resumeAttempts + 1, resumedAt: Date.now() });
  engine.sessions.appendItem(checkpoint.sessionId, {
    type: 'session_metadata', metadata: { restartRecovery: { status: 'resuming', model: route.model } }
  });
  engine.loadInternalSession(session);
  try {
    await engine.executeTurn('', {
      restartRecovery: true,
      modelSelection: route.model,
      ...(route.provider === 'account-router' ? { accountRouterModelSelection: route.model } : {}),
      reasoningEffort: checkpoint.reasoningEffort,
      toolProfile: checkpoint.toolProfile,
      allowedTools: checkpoint.allowedTools
    });
    return { status: 'resumed', sessionId: checkpoint.sessionId, model: route.model };
  } catch (error) {
    return finish(engine, checkpoint, 'recovery_failed', String(error?.message || error).slice(0, 240));
  }
}

module.exports = { recoverInterruptedTurn };
