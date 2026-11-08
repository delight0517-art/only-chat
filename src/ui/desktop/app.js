/**
 * @project Only Chat (Codex Sovereign Edition)
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Frontend Client powering Only Chat with M-Oasis Priority Chain,
 * Metamorphic Hot-Reload, Passkey Vault, and Built-in Aside Browser.
 */
'use strict';

const { groupInternalSessions: groupInternalSessionsModel } = window.internalSessionGrouping;
const {
  createSessionMetadataGuard: createSessionMetadataGuardModel,
  hasInternalSessionDragType: hasInternalSessionDragTypeModel,
  mapSessionDropDestination: mapSessionDropDestinationModel
} = window.sessionDropMapping;
const sessionMetadataGuard = createSessionMetadataGuardModel();
const {
  presentWorkspaceOwnership: presentWorkspaceOwnershipModel,
  presentTaskResumeFailure: presentTaskResumeFailureModel
} = window.workspaceOwnershipPresentation;

let currentSessionId = null;
let currentCodexThreadId = null;
let activeAssistantCard = null;
let activeTier = null;
let priorityStatus = null;
let priorityStatusRequestId = 0;
let stagePriorityLoadRequestId = 0;
let threefControlAllowed = false;
let macScreenControlAllowed = false;
let isGenerating = false;
let activeSendInFlight = false;
let currentAbortController = null;
let isRecording = false;
let speechRecorder = null;
let speechMediaStream = null;
let speechChunks = [];
let speechTranscribing = false;
let speechTranscriptionRunning = false;
let speechStarting = false;
let pendingSpeechMemoBlob = null;
let pendingSpeechAutoSendPrompt = null;
let speechAudioContext = null;
let speechAnalyser = null;
let speechAnimationFrame = null;
let speechDraftPrefix = null;
let speechDraftSuffix = '';
let fullAccessEnabled = false;
const FULL_ACCESS_SESSION_MODES_KEY = 'onlyChatFullAccessSessionModes';
let fullAccessSessionModes = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(FULL_ACCESS_SESSION_MODES_KEY) || '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch (_) { return {}; }
})();
let pendingUiMorphReload = false;
let uiMorphReloadTimer = null;
const UI_ZOOM_KEY = 'onlyChatUiZoom';
const MIN_UI_ZOOM = 0.8;
const MAX_UI_ZOOM = 1.8;
const FANTASY_WARRIOR_MODE_KEY = 'onlyChatFantasyWarriorMode';
let fantasyWarriorMode = localStorage.getItem(FANTASY_WARRIOR_MODE_KEY) === 'true';
let uiZoom = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, Number(localStorage.getItem(UI_ZOOM_KEY)) || 1));
document.documentElement.style.zoom = String(uiZoom);
document.documentElement.dataset.theme = fantasyWarriorMode ? 'fantasy' : 'default';

function adjustUiZoom(step) {
  uiZoom = Math.min(MAX_UI_ZOOM, Math.max(MIN_UI_ZOOM, Math.round((uiZoom + step) * 10) / 10));
  document.documentElement.style.zoom = String(uiZoom);
  localStorage.setItem(UI_ZOOM_KEY, String(uiZoom));
}

// DOM Elements
const timeline = document.getElementById('timeline');
const emptyState = document.getElementById('emptyState');
const composerInput = document.getElementById('composerInput');
const managerModeToggle = document.getElementById('managerModeToggle');
const btnSend = document.getElementById('btnSend');
const approvalPolicySelects = [document.getElementById('settingApprovalPolicy'), document.getElementById('settingsApprovalSelect')].filter(Boolean);
const approvalPolicyStatuses = [document.getElementById('settingApprovalPolicyStatus'), document.getElementById('settingsApprovalPolicyStatus')].filter(Boolean);
const APPROVAL_POLICY_VALUES = new Set(['on-request', 'never', 'read-only']);
let activeApprovalPolicy = null;
const sessionList = document.getElementById('sessionList');
const sessionSearchStatus = document.getElementById('sessionSearchStatus');
const pinnedSessionList = document.getElementById('pinnedSessionList');
const codexProjectGroup = document.getElementById('codexProjectGroup');
const projectList = document.getElementById('projectList');
const pinnedSessionGroup = document.getElementById('pinnedSessionGroup');
const titlebarThreadTitle = document.getElementById('titlebarThreadTitle');
const btnSidebarSearch = document.getElementById('btnSidebarSearch');
const sessionTitleSearch = document.getElementById('sessionTitleSearch');
const sidebarScrollable = document.querySelector('.sidebar-scrollable');
const railHomeBtn = document.getElementById('railHomeBtn');
const railProjectsBtn = document.getElementById('railProjectsBtn');
const railHistoryBtn = document.getElementById('railHistoryBtn');
const railSchedulesBtn = document.getElementById('railSchedulesBtn');

// Drawers & Overlays
const drawerPriority = document.getElementById('drawerPriority');
const drawerSettings = document.getElementById('drawerSettings');
const drawerMorph = document.getElementById('drawerMorph');
const drawerBrowser = document.getElementById('drawerBrowser');
const btnTogglePriority = document.getElementById('btnTogglePriority');
const btnToggleSettings = document.getElementById('btnToggleSettings');
const btnToggleMorph = document.getElementById('railGridBtn');
const btnToggleBrowser = document.getElementById('btnToggleBrowser');
const btnClosePriority = document.getElementById('btnClosePriority');
const btnCloseSettings = document.getElementById('btnCloseSettings');
const btnCloseMorph = document.getElementById('btnCloseMorph');
const btnCloseBrowser = document.getElementById('btnCloseBrowser');
const drawerTierList = document.getElementById('drawerTierList');
const morphSlotsList = document.getElementById('morphSlotsList');

// Reference 4 Elements (Usage Quota Popup)
const btnUsageQuota = document.getElementById('btnUsageQuota');
const usageQuotaPopup = document.getElementById('usageQuotaPopup');
const popupUsageSource = document.getElementById('popupUsageSource');
const popupWeeklyLimit = document.getElementById('popupWeeklyLimit');
const popupCredits = document.getElementById('popupCredits');
const btnManageUsage = document.getElementById('btnManageUsage');

// Reference 3 Elements (Model Dropdown, Mic, Orange Button)
const modelPillTrigger = document.getElementById('modelPillTrigger');
const modelSelectorPopup = document.getElementById('modelSelectorPopup');
const activeModelLabel = document.getElementById('activeModelLabel');
const activeModelAccount = document.getElementById('activeModelAccount');
const activeModelVariant = document.getElementById('activeModelVariant');
const MODEL_SELECTION_KEY = 'onlyChatSelectedModel';
let selectedModelId = localStorage.getItem(MODEL_SELECTION_KEY) || 'auto';
const effortPillTrigger = document.getElementById('effortPillTrigger');
const effortSelectorPopup = document.getElementById('effortSelectorPopup');
const activeEffortLabel = document.getElementById('activeEffortLabel');
const effortPopupLevel = document.getElementById('effortPopupLevel');
const effortPopupModel = document.getElementById('effortPopupModel');
const effortSlider = document.getElementById('effortSlider');
const effortLevelButtons = [...document.querySelectorAll('.effort-level-button')];
const reasoningEffortLevels = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra High', value: 'xhigh' },
  { label: 'Max', value: 'max' }
];
const REASONING_EFFORT_KEY = 'onlyChatReasoningEffort';
let selectedReasoningEffort = localStorage.getItem(REASONING_EFFORT_KEY) || 'low';
let modelSwitchSchedule = null;
const btnMicrophone = document.getElementById('btnMicrophone');
const btnAccessToggle = document.getElementById('btnAccessToggle');

function persistFullAccessSessionMode(sessionId = currentSessionId) {
  if (typeof sessionId !== 'string' || !/^(?:session_\d{10,16}|ses_[a-f0-9]{16})$/.test(sessionId)) return;
  fullAccessSessionModes[sessionId] = fullAccessEnabled;
  for (const key of Object.keys(fullAccessSessionModes)) {
    if (!/^(?:session_\d{10,16}|ses_[a-f0-9]{16})$/.test(key) || typeof fullAccessSessionModes[key] !== 'boolean') delete fullAccessSessionModes[key];
  }
  while (Object.keys(fullAccessSessionModes).length > 256) delete fullAccessSessionModes[Object.keys(fullAccessSessionModes)[0]];
  localStorage.setItem(FULL_ACCESS_SESSION_MODES_KEY, JSON.stringify(fullAccessSessionModes));
}

function renderFullAccessToggle() {
  if (!btnAccessToggle) return;
  const isTurbo = activeApprovalPolicy === 'never';
  const effectiveFullAccess = fullAccessEnabled || isTurbo;
  btnAccessToggle.setAttribute('aria-pressed', String(effectiveFullAccess));
  btnAccessToggle.classList.toggle('enabled', effectiveFullAccess);
  const label = btnAccessToggle.querySelector('.access-text');
  if (label) label.textContent = isTurbo ? 'Turbo Full access · 전체 디스크' : effectiveFullAccess ? 'Full access · 현재 대화' : 'Workspace sandbox';
  btnAccessToggle.title = isTurbo
    ? 'Turbo 모드: 전체 디스크(Whole drive) 읽기 및 쓰기 접근이 활성화되어 있으며 승인 질문을 생략합니다.'
    : effectiveFullAccess
      ? '이 대화에서 작업공간 밖의 파일과 셸 경로도 사용할 수 있습니다. 도구 승인 질문은 보안 설정의 Turbo 정책을 따릅니다.'
      : '현재 대화는 Only Chat 작업공간 안에서 실행됩니다.';
}

function applyFullAccessModeForSession(sessionId, isNewSession = false) {
  const isTurbo = activeApprovalPolicy === 'never';
  fullAccessEnabled = isTurbo || (isNewSession ? true : fullAccessSessionModes[sessionId] === true);
  if (isNewSession || isTurbo) persistFullAccessSessionMode(sessionId);
  renderFullAccessToggle();
}

function normalizeUiReasoningEffort(value) {
  return reasoningEffortLevels.find(level => level.value === value)?.value || 'low';
}

function modelSwitchStatusText(schedule) {
  if (!schedule) return '예약 없음';
  if (schedule.state === 'scheduled') return `예약됨 · ${new Date(schedule.dueAt).toLocaleTimeString()}에 다음 요청부터 전환`;
  if (schedule.state === 'applied') return '적용됨 · 이후 요청에도 목표 설정 사용';
  if (schedule.state === 'blocked') return '목표 계정 또는 모델을 사용할 수 없음';
  if (schedule.state === 'cancelled') return '예약 취소됨';
  return '예약 상태 확인 필요';
}

function renderModelSwitchSchedule(schedule) {
  modelSwitchSchedule = schedule || null;
  const status = document.getElementById('modelSwitchStatus');
  const cancel = document.getElementById('cancelModelSwitch');
  if (status) status.textContent = modelSwitchStatusText(modelSwitchSchedule);
  if (cancel) cancel.hidden = !modelSwitchSchedule || !['scheduled', 'applied'].includes(modelSwitchSchedule.state);
}

async function refreshModelSwitchSchedule() {
  if (!currentSessionId) return;
  try {
    const result = await fetch(`/api/model-switch-schedule?sessionId=${encodeURIComponent(currentSessionId)}`).then(response => response.json());
    renderModelSwitchSchedule(result.schedule);
  } catch (_) { /* The feature remains optional when the local status route is unavailable. */ }
}

async function cancelModelSwitchSchedule(reason = 'manual-change') {
  if (!currentSessionId || !modelSwitchSchedule || !['scheduled', 'applied'].includes(modelSwitchSchedule.state)) return;
  try {
    const result = await fetch('/api/model-switch-schedule', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: currentSessionId, reason })
    }).then(response => response.json());
    renderModelSwitchSchedule(result.schedule);
  } catch (_) { /* The request boundary also detects manual model or effort changes. */ }
}

function selectReasoningEffort(value) {
  const changed = selectedReasoningEffort !== normalizeUiReasoningEffort(value);
  selectedReasoningEffort = normalizeUiReasoningEffort(value);
  if (changed) void cancelModelSwitchSchedule();
  const selectedIndex = reasoningEffortLevels.findIndex(level => level.value === selectedReasoningEffort);
  const selected = reasoningEffortLevels[selectedIndex];
  localStorage.setItem(REASONING_EFFORT_KEY, selected.value);
  if (activeEffortLabel) activeEffortLabel.textContent = selected.label;
  if (effortPopupLevel) effortPopupLevel.textContent = selected.label;
  if (effortSlider) effortSlider.value = String(selectedIndex);
  if (effortPillTrigger) effortPillTrigger.title = `다음 채팅 난이도: ${selected.label}`;
  effortLevelButtons.forEach((button, index) => {
    const active = index === selectedIndex;
    button.classList.toggle('selected', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setApprovalPolicyControls(policy) {
  for (const select of approvalPolicySelects) select.value = policy;
}

function setApprovalPolicyStatus(message) {
  for (const status of approvalPolicyStatuses) status.textContent = message;
}

async function loadApprovalPolicy() {
  let endpointMissing = false;
  try {
    const response = await fetch('/api/settings/approval-policy', { cache: 'no-store' });
    if (!response.ok) {
      endpointMissing = response.status === 404;
      throw new Error('load failed');
    }
    const data = await response.json();
    if (!APPROVAL_POLICY_VALUES.has(data.policy)) throw new Error('invalid policy');
    activeApprovalPolicy = data.policy;
    if (activeApprovalPolicy === 'never') {
      fullAccessEnabled = true;
      persistFullAccessSessionMode();
    }
    setApprovalPolicyControls(activeApprovalPolicy);
    renderFullAccessToggle();
    setApprovalPolicyStatus('현재 승인 정책을 불러왔습니다.');
    for (const select of approvalPolicySelects) select.disabled = false;
  } catch (_) {
    setApprovalPolicyStatus(endpointMissing
      ? '현재 서버에서 승인 정책 API를 찾을 수 없습니다. 앱 서버 업데이트가 필요할 수 있습니다. 안전을 위해 선택을 비활성화했습니다.'
      : '승인 정책을 불러오지 못했습니다. 안전을 위해 선택을 비활성화했습니다.');
    for (const select of approvalPolicySelects) select.disabled = true;
  }
}

async function saveApprovalPolicy(policy) {
  if (!APPROVAL_POLICY_VALUES.has(policy) || !activeApprovalPolicy) return;
  const previousPolicy = activeApprovalPolicy;
  for (const select of approvalPolicySelects) select.disabled = true;
  setApprovalPolicyStatus('승인 정책 저장 중…');
  try {
    const response = await fetch('/api/settings/approval-policy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policy })
    });
    if (!response.ok) throw new Error('save failed');
    const data = await response.json();
    if (data.ok !== true || data.policy !== policy) throw new Error('save failed');
    activeApprovalPolicy = policy;
    if (activeApprovalPolicy === 'never') {
      fullAccessEnabled = true;
      persistFullAccessSessionMode();
    }
    setApprovalPolicyControls(policy);
    renderFullAccessToggle();
    setApprovalPolicyStatus('승인 정책이 저장되었습니다.');
  } catch (_) {
    setApprovalPolicyControls(previousPolicy);
    setApprovalPolicyStatus('저장하지 못했습니다. 기존 승인 정책을 유지합니다.');
  } finally {
    for (const select of approvalPolicySelects) select.disabled = false;
  }
}

// Initialize
window.addEventListener('DOMContentLoaded', async () => {
  selectReasoningEffort(selectedReasoningEffort);
  setupEventListeners();
  initWorkbench();
  initMetamorphicLiveStream();
  initPriorityLiveStream();
  initWindowsInboxLiveStream();
  const sessionsLoad = loadSessions();
  void loadCodexQueueInbox();
  setInterval(() => {
    refreshCodexQueueWhenVisible();
  }, 30000);
  document.addEventListener('visibilitychange', refreshCodexQueueWhenVisible);
  // Keep shared AI Account Router profiles in sync while Only Chat is open.
  // The status endpoint refreshes local account/model metadata; credentials
  // still become connected only after a real provider request succeeds.
  setInterval(() => {
    if (!document.hidden) void refreshPriorityStatus();
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshPriorityStatus();
  });
  startNewSession();
  void Promise.allSettled([
    refreshPriorityStatus(),
    refreshWorkbench(),
    refreshAdminManagerStatus(),
    refreshConnectorsStatus(),
    refreshVaultList(),
    loadReaApps(),
    loadApprovalPolicy()
  ]);
  window.addEventListener('focus', () => {
    void refreshPriorityStatus();
    void refreshAdminManagerStatus();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refreshAdminManagerStatus();
  });
  await sessionsLoad;
});

function initPriorityLiveStream() {
  const stream = new EventSource('/api/priority/stream');
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type !== 'priority_status' || !message.status) return;
      setPriorityStatusSnapshot(message.status);
      renderPriorityMode();
      renderActiveModelSelection();
      renderDrawerTiers();
    } catch (_) {}
  };
}

function beginPriorityStatusRefresh() {
  return ++priorityStatusRequestId;
}

function isPriorityStatusRefreshCurrent(requestId) {
  return requestId === priorityStatusRequestId;
}

function setPriorityStatusSnapshot(status) {
  if (!status || !Array.isArray(status.tiers)) return false;
  priorityStatusRequestId++;
  priorityStatus = status;
  activeTier = status?.activeTier || null;
  return true;
}

function initWindowsInboxLiveStream() {
  const stream = new EventSource('/api/evolution/inbox/stream');
  stream.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'windows_changes') renderWindowsInbox(message.status);
    } catch (_) {}
  };
}

function setupEventListeners() {
  approvalPolicySelects.forEach(select => select.addEventListener('change', () => { void saveApprovalPolicy(select.value); }));
  document.getElementById('btnRefreshWorkspaceOwnership')?.addEventListener('click', () => {
    void refreshWorkspaceOwnership();
  });
  const sidebarEl = document.getElementById('sidebar');
  const ensureSidebarVisible = () => {
    if (sidebarEl && (sidebarEl.style.display === 'none' || sidebarEl.hidden)) {
      sidebarEl.style.display = 'flex';
      sidebarEl.hidden = false;
      try { localStorage.setItem('onlychat.sidebar.visible', 'true'); } catch (_) {}
    }
  };
  const toggleSidebar = () => {
    if (!sidebarEl) return;
    const isHidden = sidebarEl.style.display === 'none' || sidebarEl.hidden;
    sidebarEl.style.display = isHidden ? 'flex' : 'none';
    sidebarEl.hidden = !isHidden;
    try { localStorage.setItem('onlychat.sidebar.visible', String(isHidden)); } catch (_) {}
  };

  try {
    const savedSidebarVisible = localStorage.getItem('onlychat.sidebar.visible');
    if (savedSidebarVisible === 'false' && sidebarEl) {
      sidebarEl.style.display = 'none';
      sidebarEl.hidden = true;
    }
  } catch (_) {}

  const focusSidebarSection = (button, target) => {
    ensureSidebarVisible();
    document.querySelectorAll('.activity-rail .rail-item').forEach(item => item.classList.toggle('active', item === button));
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  railHomeBtn?.addEventListener('click', () => {
    ensureSidebarVisible();
    document.querySelectorAll('.activity-rail .rail-item').forEach(item => item.classList.toggle('active', item === railHomeBtn));
    sidebarScrollable?.scrollTo({ top: 0, behavior: 'smooth' });
  });
  railProjectsBtn?.addEventListener('click', () => focusSidebarSection(railProjectsBtn, codexProjectGroup));
  railHistoryBtn?.addEventListener('click', () => focusSidebarSection(railHistoryBtn, sessionList?.closest('.sidebar-nav-group')));
  railSchedulesBtn?.addEventListener('click', () => { void openSchedules(); });
  document.getElementById('btnCloseSchedules')?.addEventListener('click', closeSchedules);
  document.getElementById('btnCloseCodexReauth')?.addEventListener('click', () => document.getElementById('codexReauthDialog')?.close());
  document.getElementById('scheduleModal')?.addEventListener('click', event => {
    if (event.target.id === 'scheduleModal') closeSchedules();
  });
  document.getElementById('btnNewSchedule')?.addEventListener('click', () => beginScheduleEdit());
  document.getElementById('btnScheduleIn30')?.addEventListener('click', setScheduleRunIn30Minutes);
  document.getElementById('btnScheduleResumeIn30')?.addEventListener('click', setScheduleResumeCurrentChatIn30Minutes);
  document.getElementById('btnRefreshSchedules')?.addEventListener('click', () => { void refreshScheduleList(); });
  document.getElementById('scheduleFrequency')?.addEventListener('change', renderScheduleRecurrenceFields);
  document.getElementById('btnScheduleAddFiles')?.addEventListener('click', () => document.getElementById('scheduleFiles')?.click());
  document.getElementById('scheduleFiles')?.addEventListener('change', event => { void addScheduleFiles(event.currentTarget.files); event.currentTarget.value = ''; });
  document.getElementById('scheduleForm')?.addEventListener('submit', event => { event.preventDefault(); void saveSchedule(); });
  document.getElementById('btnDeleteSchedule')?.addEventListener('click', () => { void deleteSchedule(); });
  document.getElementById('btnRunSchedule')?.addEventListener('click', () => { void runScheduleNow(); });
  document.getElementById('priorityAutoToggle')?.addEventListener('change', event => setAutomaticPriority(event.currentTarget.checked));
  document.getElementById('fantasyWarriorModeToggle')?.addEventListener('change', event => {
    fantasyWarriorMode = event.currentTarget.checked;
    localStorage.setItem(FANTASY_WARRIOR_MODE_KEY, String(fantasyWarriorMode));
    document.documentElement.dataset.theme = fantasyWarriorMode ? 'fantasy' : 'default';
    renderDrawerTiers();
    showMorphToast(fantasyWarriorMode ? '판타지 전사 모드가 켜졌습니다.' : '기본 Only Chat 디자인으로 돌아왔습니다.');
  });

  // Send / Stop action
  btnSend.addEventListener('click', () => {
    if (isGenerating) {
      abortActiveTurn();
    } else {
      handleSend();
    }
  });

  composerInput.addEventListener('keydown', handleComposerKeydown);

  document.getElementById('btnGoalToggle')?.addEventListener('click', () => {
    goalModeEnabled = !goalModeEnabled;
    const pill = document.getElementById('btnGoalToggle');
    if (pill) {
      pill.classList.toggle('active', goalModeEnabled);
      pill.setAttribute('aria-pressed', String(goalModeEnabled));
    }
  });

  document.getElementById('btnCancelGoal')?.addEventListener('click', () => {
    cancelActiveGoal('사용자가 목표 추구 배너에서 중단했습니다.');
    abortActiveTurn();
  });

  window.addEventListener('beforeunload', () => {
    if (activeGoal) {
      cancelActiveGoal('앱 종료 또는 새로고침으로 목표 추구를 중단했습니다.');
    }
  });

  document.getElementById('btnNewChat').addEventListener('click', startNewSession);

  btnSidebarSearch.addEventListener('click', () => {
    if (sessionTitleSearch.hidden) {
      sessionTitleSearch.hidden = false;
      btnSidebarSearch.setAttribute('aria-expanded', 'true');
      sessionTitleSearch.focus();
    } else {
      sessionTitleSearch.value = '';
      sessionTitleSearch.hidden = true;
      btnSidebarSearch.setAttribute('aria-expanded', 'false');
      renderFilteredSessions();
    }
  });
  sessionTitleSearch.addEventListener('input', renderFilteredSessions);
  sessionTitleSearch.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (sessionTitleSearch.value) {
        sessionTitleSearch.value = '';
        renderFilteredSessions();
      } else {
        sessionTitleSearch.hidden = true;
        btnSidebarSearch.setAttribute('aria-expanded', 'false');
        btnSidebarSearch.focus();
      }
    }
  });

  // Session Filter Bar (All / Codex / AGY / Only)
  document.querySelectorAll('.filter-tab-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tab-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter');
      updateSessionSearchScope();
      if (sessionTitleSearch?.value.trim()) {
        sessionSearchQuery = '';
        sessionSearchResults = null;
      }
      renderFilteredSessions();
    });
  });

  // Reference 4: Circle with Diamond Usage Popup toggle
  btnUsageQuota.addEventListener('click', e => {
    e.stopPropagation();
    const open = !usageQuotaPopup.classList.contains('open');
    setExclusiveDrawerOpen(null, false);
    usageQuotaPopup.classList.toggle('open', open);
    modelSelectorPopup.classList.remove('open');
  });

  document.getElementById('userAvatarBtn')?.addEventListener('click', () => {
    usageQuotaPopup.classList.remove('open');
    setExclusiveDrawerOpen(drawerPriority, true);
    void refreshPriorityStatus();
  });

  btnAccessToggle?.addEventListener('click', () => {
    fullAccessEnabled = !fullAccessEnabled;
    persistFullAccessSessionMode();
    renderFullAccessToggle();
  });

  btnManageUsage.addEventListener('click', () => {
    usageQuotaPopup.classList.remove('open');
    setExclusiveDrawerOpen(drawerPriority, true);
  });

  // Reference 3: Model Selector Popup toggle & selection
  modelPillTrigger.addEventListener('click', e => {
    e.stopPropagation();
    const open = !modelSelectorPopup.classList.contains('open');
    setExclusiveDrawerOpen(null, false);
    modelSelectorPopup.classList.toggle('open', open);
    modelPillTrigger.setAttribute('aria-expanded', String(open));
    if (open) {
      const selected = modelSelectorPopup.querySelector('.model-option[aria-selected="true"]');
      (selected || modelSelectorPopup.querySelector('.model-option'))?.focus();
    }
    effortSelectorPopup?.classList.remove('open');
    usageQuotaPopup.classList.remove('open');
  });

  effortPillTrigger?.addEventListener('click', e => {
    e.stopPropagation();
    const open = !effortSelectorPopup.classList.contains('open');
    setExclusiveDrawerOpen(null, false);
    effortSelectorPopup.classList.toggle('open', open);
    modelSelectorPopup.classList.remove('open');
    usageQuotaPopup.classList.remove('open');
    effortPillTrigger.setAttribute('aria-expanded', String(effortSelectorPopup.classList.contains('open')));
    if (effortPopupModel) effortPopupModel.textContent = activeModelLabel?.textContent || 'Default';
  });
  effortSlider?.addEventListener('input', () => {
    const index = Number(effortSlider.value);
    selectReasoningEffort(reasoningEffortLevels[index]?.value);
  });
  effortLevelButtons.forEach(button => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.effortIndex);
      selectReasoningEffort(reasoningEffortLevels[index]?.value);
    });
  });
  document.getElementById('resetEffort')?.addEventListener('click', event => {
    event.stopPropagation();
    selectReasoningEffort('low');
  });
  effortSelectorPopup?.addEventListener('click', event => event.stopPropagation());
  effortPillTrigger?.addEventListener('click', () => { void refreshModelSwitchSchedule(); });
  document.getElementById('scheduleModelSwitch')?.addEventListener('click', async () => {
    const targetModel = document.getElementById('modelSwitchTarget')?.value;
    const status = document.getElementById('modelSwitchStatus');
    if (!currentSessionId || !targetModel) { if (status) status.textContent = '먼저 계정 라우터에서 사용할 수 있는 목표 모델을 설정해 주세요.'; return; }
    try {
      const response = await fetch('/api/model-switch-schedule', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: currentSessionId, requestId: crypto.randomUUID(), currentModel: selectedModelId, currentEffort: selectedReasoningEffort,
          targetModel, targetEffort: document.getElementById('modelSwitchEffort')?.value || 'low', durationMinutes: Number(document.getElementById('modelSwitchDelay')?.value || 5) })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `예약 실패 (${response.status})`);
      renderModelSwitchSchedule(result.schedule);
    } catch (error) { if (status) status.textContent = `예약 실패 · ${error.message}`; }
  });
  document.getElementById('cancelModelSwitch')?.addEventListener('click', () => { void cancelModelSwitchSchedule('user-cancelled'); });

  modelSelectorPopup.addEventListener('click', event => {
    const option = event.target.closest('.model-option');
    if (!option || !modelSelectorPopup.contains(option) || option.hidden || option.disabled) return;
    selectedModelId = option.dataset.model || 'auto';
    void cancelModelSwitchSchedule();
    localStorage.setItem(MODEL_SELECTION_KEY, selectedModelId);
    modelSelectorPopup.classList.remove('open');
    modelPillTrigger.setAttribute('aria-expanded', 'false');
    renderActiveModelSelection();
    renderDrawerTiers();
    modelPillTrigger.focus();
  });
  modelSelectorPopup.addEventListener('keydown', event => {
    const options = [...modelSelectorPopup.querySelectorAll('.model-option')].filter(option => !option.hidden && !option.disabled);
    if (!options.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      modelSelectorPopup.classList.remove('open');
      modelPillTrigger.setAttribute('aria-expanded', 'false');
      modelPillTrigger.focus();
      return;
    }
    const current = options.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % options.length;
    else if (event.key === 'ArrowUp') next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    options[next].focus();
  });

  // Close popups on outside click
  document.addEventListener('click', e => {
    if (!usageQuotaPopup.contains(e.target) && e.target !== btnUsageQuota) {
      usageQuotaPopup.classList.remove('open');
    }
    if (!modelSelectorPopup.contains(e.target) && e.target !== modelPillTrigger) {
      modelSelectorPopup.classList.remove('open');
      modelPillTrigger.setAttribute('aria-expanded', 'false');
    }
    if (effortSelectorPopup && !effortSelectorPopup.contains(e.target) && e.target !== effortPillTrigger) {
      effortSelectorPopup.classList.remove('open');
      effortPillTrigger?.setAttribute('aria-expanded', 'false');
    }
  });

  // Reference 3: Microphone Button
  btnMicrophone.addEventListener('click', toggleSpeechInput);
  document.getElementById('btnVoiceRetry')?.addEventListener('click', () => { void transcribeSpeechMemo(pendingSpeechMemoBlob, true); });
  document.getElementById('btnVoiceFeedback')?.addEventListener('click', event => {
    void openDeveloperFeedback(event.currentTarget, '음성 전사', event.currentTarget.dataset.error || '');
  });

  // Keyboard Shortcuts: Ctrl+, and Cmd+, to open Full-Stage Settings View (Ref User UI)
  window.addEventListener('keydown', e => {
    if (e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      startNewSession();
    } else if (e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      toggleSidebar();
    } else if (e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 't' && drawerBrowser?.classList.contains('open')) {
      e.preventDefault();
      addBrowserTab();
    } else if (e.metaKey !== e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && e.key.toLowerCase() === 'w' && drawerBrowser?.classList.contains('open')) {
      if (typeof browserTabs !== 'undefined' && browserTabs.length > 1) {
        e.preventDefault();
        closeBrowserTab(activeBrowserTabId);
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.code === 'NumpadAdd' || (e.code === 'Equal' && e.shiftKey))) {
      e.preventDefault();
      adjustUiZoom(0.2);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '-' || e.code === 'NumpadSubtract')) {
      e.preventDefault();
      adjustUiZoom(-0.2);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === ',' || e.code === 'Comma')) {
      e.preventDefault();
      toggleSettingsStage();
    } else if (e.key === 'Escape') {
      // ESC closes settings stage or all open drawers & popups
      if (isSettingsStageOpen()) {
        closeSettingsStage();
      }
      setExclusiveDrawerOpen(null, false);
      usageQuotaPopup.classList.remove('open');
      modelSelectorPopup.classList.remove('open');
      modelPillTrigger.setAttribute('aria-expanded', 'false');
    }
  });

  // Top Titlebar Settings Button opens Full-Stage Settings View
  btnToggleSettings.addEventListener('click', () => toggleSettingsStage());
  btnCloseSettings.addEventListener('click', () => setExclusiveDrawerOpen(drawerSettings, false));

  // Full-Stage Settings Controls
  const btnCloseSettingsStage = document.getElementById('btnCloseSettingsStage');
  if (btnCloseSettingsStage) {
    btnCloseSettingsStage.addEventListener('click', () => closeSettingsStage());
  }

  document.getElementById('btnWindowsEvolutionConnect')?.addEventListener('click', async () => {
    const input = document.getElementById('windowsEvolutionPath');
    const status = document.getElementById('windowsEvolutionStatus');
    try {
      const response = await fetch('/api/evolution/configure', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relayRoot: input?.value.trim() }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '공유 폴더 연결 실패');
      renderWindowsInbox(result.status);
    } catch (error) { if (status) status.textContent = `연결 실패: ${error.message}`; }
  });
  document.getElementById('btnWindowsEvolutionDisable')?.addEventListener('click', async () => {
    const status = document.getElementById('windowsEvolutionStatus');
    try {
      const response = await fetch('/api/evolution/disable', { method: 'POST' });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '연결 해제 실패');
      renderWindowsInbox(result.status);
    } catch (error) { if (status) status.textContent = `연결 해제 실패: ${error.message}`; }
  });

  document.getElementById('btnRestartOnlyChatServer')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    const status = document.getElementById('serverRestartStatus');
    if (button.disabled) return;
    button.disabled = true;
    if (status) status.textContent = '안전한 재시작을 요청하는 중…';
    try {
      const response = await fetch('/api/server/restart', {
        method: 'POST',
        headers: { 'Accept': 'application/json' },
        credentials: 'same-origin'
      });
      const result = await response.json().catch(() => ({}));
      if (response.status !== 202 || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
      if (status) status.textContent = '재시작을 요청했습니다. 안전한 체크포인트가 있으면 앱이 다시 열린 뒤 이어갑니다.';
    } catch (error) {
      if (status) status.textContent = `재시작 요청 실패: ${error.message}`;
      button.disabled = false;
    }
  });

  // Settings Sub-sidebar Tabs Switching
  document.querySelectorAll('.settings-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.settings-nav-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      const tabId = item.getAttribute('data-tab');
      item.closest('.settings-menu-group')?.setAttribute('open', '');
      switchSettingsTab(tabId);
      if (tabId === 'general') void refreshWorkspaceOwnership();
    });
  });

  // Settings Search Filtering
  const settingsSearchInput = document.getElementById('settingsSearchInput');
  if (settingsSearchInput) {
    settingsSearchInput.addEventListener('input', e => {
      const q = e.target.value.toLowerCase().trim();
      document.querySelectorAll('.settings-nav-item').forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(q) ? 'flex' : 'none';
      });
      document.querySelectorAll('.settings-menu-group').forEach(group => {
        const hasMatch = [...group.querySelectorAll('.settings-nav-item')].some(item => item.style.display !== 'none');
        if (q) group.open = hasMatch;
        else group.open = Boolean(group.querySelector('.settings-nav-item.active'));
        group.hidden = Boolean(q) && !hasMatch;
      });
    });
  }

  // Full Access switch sync in Settings Stage
  const chkFullAccess = document.getElementById('chkFullAccess');
  if (chkFullAccess) {
    chkFullAccess.addEventListener('change', () => {
      const isChecked = chkFullAccess.checked;
      const pill = document.getElementById('btnAccessToggle');
      if (pill) {
        pill.querySelector('.access-text').textContent = isChecked ? 'Full access' : 'Sandbox mode';
        pill.style.opacity = isChecked ? '1' : '0.6';
      }
    });
  }

  // Change projectless folder
  const btnChangeChatFolder = document.getElementById('btnChangeChatFolder');
  if (btnChangeChatFolder) {
    btnChangeChatFolder.addEventListener('click', () => {
      const current = document.getElementById('labelProjectlessFolder').innerText;
      const next = prompt('새 프로젝트리스 대화 저장 폴더 경로를 입력하세요:', current);
      if (next && next.trim()) {
        document.getElementById('labelProjectlessFolder').innerText = next.trim();
      }
    });
  }

  // Stage Vault Save button
  const btnStageVaultSave = document.getElementById('btnStageVaultSave');
  if (btnStageVaultSave) {
    btnStageVaultSave.addEventListener('click', handleStageVaultSave);
  }

  // Drawer toggles
  btnTogglePriority?.addEventListener('click', () => setExclusiveDrawerOpen(drawerPriority, !drawerPriority.classList.contains('open')));
  btnClosePriority.addEventListener('click', () => setExclusiveDrawerOpen(drawerPriority, false));

  btnToggleMorph?.addEventListener('click', () => setExclusiveDrawerOpen(drawerMorph, !drawerMorph.classList.contains('open')));
  btnCloseMorph.addEventListener('click', () => setExclusiveDrawerOpen(drawerMorph, false));

  // Built-in Browser drawer
  btnToggleBrowser?.addEventListener('click', () => {
    const opening = !drawerBrowser.classList.contains('open');
    setExclusiveDrawerOpen(drawerBrowser, opening);
    if (opening) void refreshThreefControlStatus();
    if (opening) renderBrowserTabs();
  });
  btnCloseBrowser.addEventListener('click', () => setExclusiveDrawerOpen(drawerBrowser, false));
  document.getElementById('btnBrowserNav').addEventListener('click', () => {
    const url = document.getElementById('browserUrlInput').value.trim();
    navBrowser(url);
  });
  document.getElementById('browserUrlInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') navBrowser(event.currentTarget.value);
  });
  document.getElementById('btnBrowserThreef').addEventListener('click', handleBrowserOpenInThreef);
  document.getElementById('btnBrowserAria').addEventListener('click', handleBrowserAria);
  document.getElementById('btnBrowserRead').addEventListener('click', handleBrowserRead);
  document.getElementById('threefControlEnabled').addEventListener('change', async event => {
    const enabled = event.currentTarget.checked;
    const status = document.getElementById('threefControlStatus');
    const previous = threefControlAllowed;
    threefControlAllowed = false;
    setThreefControlUi(false);
    status.textContent = enabled ? '3F Browser 제어를 켜는 중…' : '3F Browser 제어 꺼짐';
    try {
      const response = await fetch('/api/browser/threef/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ enabled }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '설정을 저장하지 못했습니다.');
      threefControlAllowed = result.enabled === true;
      setThreefControlUi(threefControlAllowed);
      status.textContent = threefControlAllowed ? '3F Browser 제어 허용됨 · 연결 상태 미확인' : '3F Browser 제어 꺼짐';
      if (threefControlAllowed) { void refreshThreefControlStatus(); window.setTimeout(pollEmbeddedThreefCommands, 0); }
    } catch (error) {
      threefControlAllowed = previous;
      setThreefControlUi(previous);
      status.textContent = error.message;
    }
  });
  document.getElementById('btnThreefRefresh').addEventListener('click', () => { void refreshThreefControlStatus(); });
  document.getElementById('macScreenControlEnabled').addEventListener('change', async event => {
    const status = document.getElementById('macScreenControlStatus');
    const previous = macScreenControlAllowed;
    macScreenControlAllowed = false;
    status.textContent = event.currentTarget.checked ? '화면 제어를 켜는 중…' : '끄는 중…';
    try {
      const response = await fetch('/api/mac-screen/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: event.currentTarget.checked }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || '설정을 저장하지 못했습니다.');
      macScreenControlAllowed = result.enabled === true;
      event.currentTarget.checked = macScreenControlAllowed;
      status.textContent = macScreenControlAllowed ? '켜짐 · 화면 내용이 AI 대화에 공유될 수 있습니다.' : '꺼짐';
      if (macScreenControlAllowed) window.setTimeout(pollMacScreenCommands, 0);
      else {
        const preview = document.getElementById('macScreenPreview');
        preview.removeAttribute('src'); preview.hidden = true;
      }
    } catch (error) {
      macScreenControlAllowed = previous;
      event.currentTarget.checked = previous;
      status.textContent = error.message;
    }
  });
  document.getElementById('btnMacScreenPermissions').addEventListener('click', async () => {
    try { showMacScreenPermissionStatus(await callNativeMacScreen('permissions')); }
    catch (error) { document.getElementById('macScreenControlStatus').textContent = error.message; }
  });
  document.getElementById('btnMacScreenStatus').addEventListener('click', async () => {
    try { showMacScreenPermissionStatus(await callNativeMacScreen('status')); }
    catch (error) { document.getElementById('macScreenControlStatus').textContent = error.message; }
  });
  for (const button of document.querySelectorAll('[data-browser-action]')) {
    button.addEventListener('click', () => sendBrowserPanelAction(button.dataset.browserAction));
  }
  initializeBrowserSplitLayout();
  document.getElementById('btnBrowserNewTab')?.addEventListener('click', () => addBrowserTab());
  renderBrowserTabs();
  window.addEventListener('resize', syncNativeBrowserPanel);
  window.addEventListener('scroll', syncNativeBrowserPanel, true);
  drawerBrowser.addEventListener('transitionend', syncNativeBrowserPanel);
  syncNativeBrowserPanel();

  // Connectors (Google & Notion)
  document.getElementById('btnLoginGoogleWorkspace').addEventListener('click', handleGoogleLogin);
  document.getElementById('btnConnectNotion').addEventListener('click', handleNotionConnect);

  // Passkey Vault
  document.getElementById('btnVaultSave').addEventListener('click', handleVaultSave);
  document.getElementById('btnRegisterAccount').addEventListener('click', handleRegisterAccount);

  // Sidebar toggle button in titlebar
  document.getElementById('btnToggleSidebar')?.addEventListener('click', toggleSidebar);

  // Auto-resize textarea
  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(180, composerInput.scrollHeight) + 'px';
    applyPendingUiMorphReloadWhenSafe();
  });
  ['attachmentPicker', 'folderPicker'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', applyPendingUiMorphReloadWhenSafe);
  });
}

function setPrompt(text) {
  composerInput.value = text;
  composerInput.focus();
  composerInput.dispatchEvent(new Event('input'));
}

// ============================================================================
// Priority Status & Quota Management (Ref 4)
// ============================================================================

async function refreshPriorityStatus() {
  const requestId = beginPriorityStatusRefresh();
  try {
    const res = await fetch('/api/status');
    if (!res.ok) throw new Error(`Priority status request failed (${res.status}).`);
    const data = await res.json();
    if (!data || !Array.isArray(data.tiers)) throw new Error('Priority status response is invalid.');
    if (!isPriorityStatusRefreshCurrent(requestId)) return;
    priorityStatus = data;
    if (data.routerModels?.length && data.tiers.some(tier => tier.provider === 'account-router')
      && !localStorage.getItem('onlychat.router-auto-selection.v1')) {
      selectedModelId = 'auto';
      localStorage.setItem(MODEL_SELECTION_KEY, 'auto');
      localStorage.setItem('onlychat.router-auto-selection.v1', 'true');
    }
    activeTier = data.activeTier;
    const selectedRouteTier = resolveModelTierFromStatus(data, selectedModelId);
    const workspaceRootInput = document.getElementById('settingsCwdInput');
    const defaultWorkspaceRootInput = document.getElementById('settingsDefaultCwdInput');
    if (defaultWorkspaceRootInput && typeof data.defaultWorkspaceDir === 'string') {
      defaultWorkspaceRootInput.value = data.defaultWorkspaceDir;
      defaultWorkspaceRootInput.readOnly = true;
      defaultWorkspaceRootInput.title = '새 채팅을 시작할 때 사용하는 기본 작업 폴더입니다.';
    }
    if (workspaceRootInput && typeof data.workspaceDir === 'string') {
      workspaceRootInput.value = data.sessionWorkspaceDir || data.defaultWorkspaceDir || data.workspaceDir;
      workspaceRootInput.readOnly = true;
      workspaceRootInput.title = data.sessionWorkspaceDir
        ? '현재 열린 세션에 저장된 작업 폴더입니다.'
        : '현재 세션이 없어 새 채팅 기본 작업 폴더를 표시합니다.';
    }
    renderPriorityMode();
    renderActiveModelSelection();

    for (const row of document.querySelectorAll('.provider-compact-row')) {
      const isCodex = row.dataset.providerId === 'codex-cli';
      const status = data.providers?.find(item => item.id === selectedRouteTier?.id);
      const circle = row.querySelector('.provider-status-circle');
      const label = row.querySelector('.provider-type-sub');
      if (!isCodex || !selectedRouteTier || String(selectedRouteTier.provider || '').toLowerCase() !== 'codex') {
        row.hidden = true;
      } else if (status) {
        row.hidden = false;
        if (circle) { circle.classList.toggle('active', Boolean(status.connected)); circle.title = status.connected ? 'Connected' : status.message; }
        if (label) label.textContent = status.connected ? 'Connected through Codex CLI' : status.available ? 'Codex CLI sign-in required' : 'Codex CLI unavailable';
      }
    }

    // Update Reference 4 (Popup Card)
    const provider = selectedRouteTier?.providerReady;
    const providerName = String(selectedRouteTier?.provider || '').toLowerCase();
    if (popupUsageSource) popupUsageSource.textContent = providerName === 'codex' ? 'Codex CLI'
      : providerName === 'antigravity-cli' ? 'Antigravity CLI' : selectedRouteTier?.name || selectedRouteTier?.provider || '실행 계정 없음';
    if (popupWeeklyLimit) popupWeeklyLimit.textContent = provider
      ? (provider.connected ? 'Connected' : provider.available ? 'Sign-in required' : 'Unavailable')
      : selectedRouteTier ? tierQuotaLabel(selectedRouteTier) : '사용 가능한 실행 경로 없음';
    if (popupCredits) popupCredits.textContent = 'Usage not reported';

    renderDrawerTiers();
  } catch (err) {
    if (isPriorityStatusRefreshCurrent(requestId)) console.warn('Failed to load priority status:', err);
  }
}

function renderPriorityMode() {
  if (!priorityStatus) return;
  const automatic = priorityStatus.enabled === true;
  const toggle = document.getElementById('priorityAutoToggle');
  const label = document.getElementById('priorityAutoLabel');
  const description = document.getElementById('priorityModeDescription');
  if (toggle) toggle.checked = automatic;
  if (label) label.textContent = automatic ? '켜짐' : '꺼짐 · 수동';
  if (description) description.textContent = automatic
    ? '한도 10% 이하 또는 오류가 감지되면 다음 계정으로 전환'
    : '직접 선택한 계정만 사용 · 실패 시 자동 전환 없음';
  toggle?.closest('.priority-auto-control')?.classList.toggle('manual', !automatic);
  for (const badge of document.querySelectorAll('.priority-mode-badge')) {
    badge.textContent = automatic ? '자동 우선순위 켜짐' : '수동 계정 선택';
  }
}

async function setAutomaticPriority(enabled) {
  const toggle = document.getElementById('priorityAutoToggle');
  try {
    const res = await fetch('/api/priority/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || `모드 변경 실패 (${res.status})`);
    setPriorityStatusSnapshot(result.status);
    renderPriorityMode();
    renderActiveModelSelection();
    renderDrawerTiers();
    showMorphToast(enabled ? '자동 우선순위 켜짐' : '자동 우선순위 꺼짐 · 수동 계정 선택 모드');
  } catch (error) {
    if (toggle) toggle.checked = priorityStatus?.enabled === true;
    showMorphToast(`우선순위 모드를 바꾸지 못했습니다: ${error.message}`);
  }
}

function displayPriorityModel(modelId) {
  const names = {
    'gpt-6-luna': 'GPT-6 Luna',
    'gpt-6-sol': 'GPT-6 Sol',
    'gpt-6-astra': 'GPT-6 Astra',
    'gpt-6.1-sol': 'GPT-6.1 Sol',
    'gpt-6.1-terra': 'GPT-6.1 Terra',
    'gpt-5.6-sol': 'GPT-5.6 Sol',
    'gpt-5.6-terra': 'GPT-5.6 Terra',
    'gpt-5.6-luna': 'GPT-5.6 Luna',
    'gemini-3.8-flash-medium': 'Gemini 3.8 Flash Medium'
  };
  return names[String(modelId || '').toLowerCase()] || String(modelId || '모델 미지정');
}

function displaySelectedModel(modelId) {
  const prefix = 'account-router:';
  return String(modelId || '').toLowerCase().startsWith(prefix)
    ? `${displayPriorityModel(String(modelId).slice(prefix.length))} · AI Router`
    : displayPriorityModel(modelId);
}

function priorityRouteHealth(tier) {
  const health = tier?.health || {};
  const failed = health.quotaState === 'provider-unavailable' || health.throttledReason === 'provider-error';
  const ready = tier?.providerReady?.connected === true;
  const routerQuotaUnknown = tier?.provider === 'account-router' && !Number.isFinite(health.totalRemainingPercent);
  return {
    label: failed ? '최근 생성 실패' : ready ? routerQuotaUnknown ? '실행 연결됨 · 한도 미확인' : '실행 경로 연결됨' : '연결 확인 필요',
    className: failed || !ready ? 'disconnected' : 'connected'
  };
}

function renderActiveModelSelection() {
  syncAvailableModelOptions();
  const accountButton = document.getElementById('userAvatarBtn');
  const codexAccounts = (priorityStatus?.tiers || []).filter(tier => String(tier.provider || '').toLowerCase() === 'codex');
  const connectedCodex = codexAccounts.filter(tier => tier.providerReady?.connected === true).length;
  if (accountButton) {
    const accountSummary = codexAccounts.length
      ? `Codex 계정 ${connectedCodex}/${codexAccounts.length}개 연결 · 클릭해 모든 계정 확인`
      : 'Codex 계정 연결 상태 확인 중 · 클릭해 우선순위 계정 보기';
    accountButton.title = accountSummary;
    accountButton.setAttribute('aria-label', accountSummary);
  }
  const routeTier = resolveSelectedModelTier();
  const routingMode = priorityStatus?.enabled === false ? '수동 계정' : '자동';
  const selectedModel = selectedModelId === 'auto'
    ? (routeTier ? `${routingMode} · ${displayPriorityModel(routeTier.model)}${String(routeTier.model).toLowerCase() === 'gpt-6-luna' && selectedReasoningEffort === 'low' ? ' + Light' : ''}` : `${routingMode} · 모델 확인 중`)
    : selectedModelId === 'gpt-6-luna' && selectedReasoningEffort === 'low'
      ? 'GPT-6 Luna + Light'
      : displaySelectedModel(selectedModelId);
  if (!routeTier) {
    const noActiveRoute = selectedModelId === 'auto' ? '사용 가능한 실행 계정 없음' : '선택 모델을 사용할 수 있는 계정 없음';
    if (activeModelLabel) activeModelLabel.textContent = selectedModel;
    if (activeModelAccount) activeModelAccount.textContent = noActiveRoute;
    const prioritySelectedModel = document.getElementById('prioritySelectedModel');
    const priorityActualRoute = document.getElementById('priorityActualRoute');
    if (prioritySelectedModel) prioritySelectedModel.textContent = selectedModel;
    if (priorityActualRoute) priorityActualRoute.textContent = noActiveRoute;
    if (modelPillTrigger) {
      modelPillTrigger.title = `선택 모델: ${selectedModel} · ${noActiveRoute}`;
      modelPillTrigger.setAttribute('aria-label', `선택 모델 ${selectedModel}; ${noActiveRoute}`);
    }
    if (effortPopupModel) effortPopupModel.textContent = selectedModel;
    const modelCaption = document.querySelector('.model-pill-caption');
    if (modelCaption) modelCaption.textContent = selectedModelId === 'auto' ? `${routingMode} · 현재 모델` : '현재 선택 모델';
    return;
  }
  const actualModel = displayPriorityModel(routeTier.model);
  const modelCaption = document.querySelector('.model-pill-caption');
  if (modelCaption) modelCaption.textContent = selectedModelId === 'auto' ? `${routingMode} · 실제 모델` : '현재 선택 모델';
  const account = routeTier.email || routeTier.account || '계정 정보 없음';
  if (activeModelLabel) activeModelLabel.textContent = selectedModel;
  const isCodex = String(routeTier.provider || '').toLowerCase().includes('codex');
  const tierIdentity = /secondary/i.test(`${routeTier.id} ${routeTier.name}`) ? '보조 계정' : /primary/i.test(`${routeTier.id} ${routeTier.name}`) ? '주 계정' : '계정';
  const routeIdentity = isCodex ? `Codex ${tierIdentity}` : String(routeTier.name || routeTier.provider || '계정');
  const routeReady = routeTier.providerReady?.connected === true;
  const routeHealth = priorityRouteHealth(routeTier);
  const routeState = isCodex ? (routeReady ? '연결됨' : routeTier.providerReady?.message || '로그인 필요') : routeHealth.label;
  if (activeModelAccount) activeModelAccount.textContent = `실제 요청 계정: ${routeTier.tier || '-'}순위 · ${routeIdentity} · ${account} · ${routeState}`;
  const prioritySelectedModel = document.getElementById('prioritySelectedModel');
  const priorityActualRoute = document.getElementById('priorityActualRoute');
  if (prioritySelectedModel) prioritySelectedModel.textContent = selectedModel;
  if (priorityActualRoute) {
    const connection = isCodex ? (routeReady ? '실행 연결됨' : '로그인 필요') : routeHealth.label;
    const rank = Number(routeTier.tier) || 0;
    priorityActualRoute.innerHTML = `
      <span class="priority-current-route-label">실제 다음 요청에 사용할 경로</span>
      <span class="priority-route-model">${escapeHtml(actualModel)}</span>
      <span class="priority-route-rank rank-tier-${rank}">${rank || '-'}순위 · ${escapeHtml(routeIdentity)} · 현재 선택/라우팅</span>
      <span class="priority-route-account"><small>이번 요청 계정</small><strong>${escapeHtml(account)}</strong></span>
      <span class="priority-route-state ${isCodex ? (routeReady ? 'connected' : 'disconnected') : routeHealth.className}">${escapeHtml(connection)}</span>
    `;
  }
  if (modelPillTrigger) {
    modelPillTrigger.title = `현재 선택 모델: ${selectedModel} · 실제 요청 대상: ${actualModel}, ${routeTier.tier || '-'}순위 ${routeIdentity}, ${account} · ${routeState}`;
    modelPillTrigger.setAttribute('aria-label', `현재 선택 모델 ${selectedModel}; 실제 다음 요청 ${actualModel}; ${routeTier.tier || '-'}순위 ${routeIdentity}; 계정 ${account}; ${routeState}`);
  }
  if (effortPopupModel) effortPopupModel.textContent = selectedModel;
}

function syncAvailableModelOptions() {
  const container = document.getElementById('availableModelOptions');
  const tiers = priorityStatus?.tiers;
  if (!container || !Array.isArray(tiers)) return;
  const manualTier = priorityStatus.enabled === false ? priorityStatus.activeTier : null;
  const localModels = [...new Set((manualTier ? [manualTier] : tiers)
    .filter(tier => tier.enabled !== false && typeof tier.model === 'string' && tier.model.trim() && tier.model.trim().toLowerCase() !== 'auto')
    .map(tier => tier.model.trim()))];
  const routerModels = [...new Set((priorityStatus.routerModels || []).filter(model => typeof model === 'string' && model.trim())
    .map(model => `account-router:${model.trim().toLowerCase()}`))];
  const models = [...localModels, ...routerModels];
  const modelSignature = JSON.stringify(models.map(model => model.toLowerCase()));
  const targetSelect = document.getElementById('modelSwitchTarget');
  const localModelSignature = JSON.stringify(localModels.map(model => model.toLowerCase()));
  if (targetSelect && targetSelect.dataset.modelSignature !== localModelSignature) {
    const previousTarget = targetSelect.value;
    targetSelect.replaceChildren(...localModels.map(model => {
      const option = document.createElement('option'); option.value = model.toLowerCase(); option.textContent = displayPriorityModel(model); return option;
    }));
    if (localModels.some(model => model.toLowerCase() === previousTarget)) targetSelect.value = previousTarget;
    else if (localModels.some(model => model.toLowerCase() === 'gpt-6-sol')) targetSelect.value = 'gpt-6-sol';
    targetSelect.dataset.modelSignature = localModelSignature;
  }
  if (container.dataset.modelSignature !== modelSignature) {
    const focusedModel = container.contains(document.activeElement) ? document.activeElement?.dataset?.model : null;
    container.replaceChildren();
    for (const model of models) {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'model-option';
      option.dataset.model = model.toLowerCase();
      option.setAttribute('role', 'option');
      const title = document.createElement('span');
      title.className = 'model-opt-title';
      title.textContent = displaySelectedModel(model);
      const check = document.createElement('span');
      check.className = 'model-check';
      check.textContent = '✓';
      option.append(title, check);
      container.append(option);
    }
    container.dataset.modelSignature = modelSignature;
    if (focusedModel) {
      const replacement = [...container.querySelectorAll('.model-option')].find(option => option.dataset.model === focusedModel);
      (replacement || modelPillTrigger)?.focus();
    }
  }
  if (selectedModelId !== 'auto' && !models.some(model => model.toLowerCase() === selectedModelId)) {
    selectedModelId = 'auto';
    localStorage.setItem(MODEL_SELECTION_KEY, selectedModelId);
  }
  const autoOption = modelSelectorPopup?.querySelector('.model-option[data-model="auto"]');
  const automaticTitle = document.getElementById('automaticModelOptionTitle');
  const automaticDescription = document.getElementById('automaticModelOptionDescription');
  if (automaticTitle) automaticTitle.textContent = priorityStatus.enabled === false ? '현재 선택 계정 모델'
    : priorityStatus.activeTier?.provider === 'account-router' ? 'AI Account Router · 자동 선택' : '자동 우선순위 모델';
  if (automaticDescription) automaticDescription.textContent = priorityStatus.enabled === false
    ? '수동으로 선택한 계정의 모델을 사용합니다'
    : '우선순위 설정에 따라 모델과 계정을 선택합니다';
  autoOption?.classList.toggle('selected', selectedModelId === 'auto');
  autoOption?.setAttribute('aria-selected', String(selectedModelId === 'auto'));
  container.querySelectorAll('.model-option').forEach(option => {
    const selected = option.dataset.model === selectedModelId;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', String(selected));
  });
}

function resolveSelectedModelTier() {
  return resolveModelTierFromStatus(priorityStatus, selectedModelId);
}

function resolveModelTierFromStatus(status, modelSelection) {
  if (!status) return null;
  if (modelSelection === 'auto') {
    const tier = status.activeTier;
    const account = tier?.provider === 'account-router'
      ? status.accountRouter?.accounts?.find(item => item.id === status.accountRouter.activeAccountId) : null;
    return account ? { ...tier, model: account.model, account: `Router 내부 ${account.rank}순위 · ${account.name || account.id}` } : tier || null;
  }
  const routerPrefix = 'account-router:';
  if (modelSelection.startsWith(routerPrefix)) {
    const model = modelSelection.slice(routerPrefix.length).trim().toLowerCase();
    return (status.routerModels || []).some(item => String(item).trim().toLowerCase() === model)
      ? { id: 'account-router-local', name: 'AI Router', provider: 'account-router', model,
        enabled: true, providerReady: status.accountRouterReadiness || { connected: false, message: 'AI Router 실제 요청 확인 필요' }, health: { quotaState: 'unknown', isThrottled: false } }
      : null;
  }
  const tiers = status.tiers;
  if (!Array.isArray(tiers)) return null;
  const threshold = Number(status.thresholds?.totalRemainingPercent ?? 10);
  const matches = tiers.filter(tier => tier.enabled !== false
    && String(tier.model || '').trim().toLowerCase() === modelSelection
    && tier.health?.isThrottled !== true
    && (!Number.isFinite(tier.health?.totalRemainingPercent) || tier.health.totalRemainingPercent > threshold)
    && tier.providerReady?.connected === true)
    .sort((a, b) => (Number(a.tier) || Number.MAX_SAFE_INTEGER) - (Number(b.tier) || Number.MAX_SAFE_INTEGER));
  if (status.enabled === false) return matches.find(tier => tier.id === status.activeTier?.id) || null;
  return matches[0] || null;
}

function fantasyWarriorTierAvailability(status, tier) {
  const threshold = Number.isFinite(status?.thresholds?.totalRemainingPercent)
    ? status.thresholds.totalRemainingPercent
    : 10;
  const health = tier?.health || {};
  const remaining = health.totalRemainingPercent;
  const hasKnownQuota = Number.isFinite(remaining);
  const depleted = health.isThrottled === true || (hasKnownQuota && remaining <= threshold);
  const connected = tier?.providerReady?.connected === true;
  return { remaining, hasKnownQuota, depleted, connected, selectable: tier?.enabled !== false && connected && !depleted };
}

function tierQuotaLabel(tier) {
  const health = tier?.health;
  const remaining = health?.totalRemainingPercent;
  if (health?.quotaState === 'limit-detected') return '한도 초과 응답 감지 · 잔여량 미확인';
  if (health?.quotaState === 'limit-reported') return '사용 한도 소진 보고 · 잔여량 미확인';
  if (health?.quotaState === 'below-threshold' && Number.isFinite(remaining)) {
    const reset = health.nextResetAt ? new Date(health.nextResetAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '기한 미확인';
    return `한도 ${Math.round(remaining)}% · 갱신 예정 ${reset}`;
  }
  if (health?.isThrottled) return '실행 불가 · 일시 제외';
  if (Number.isFinite(remaining)) return `한도 확인 · ${Math.round(remaining)}% 남음`;
  return '한도 수치 미확인';
}

function tierConnectionLabel(tier) {
  const provider = tier?.providerReady;
  const health = priorityRouteHealth(tier);
  if (health.label === '최근 생성 실패') return health.label;
  if (!String(tier?.provider || '').toLowerCase().includes('codex')) return health.label;
  if (provider) return provider.connected ? '계정 연결됨' : provider.available ? '로그인 필요' : '실행 경로 사용 불가';
  return '계정 연결 상태 미확인';
}

function tierQuotaCheckedLabel(tier) {
  const timestamp = tier?.health?.lastQuotaRefreshAt;
  if (tier?.health?.quotaRefreshError) {
    const attempted = Number.isFinite(tier.health.lastQuotaRefreshAttemptAt)
      ? new Date(tier.health.lastQuotaRefreshAttemptAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '';
    return `최근 한도 조회 실패${attempted ? ` · 시도 ${attempted}` : ''} · 기존 상태 유지`;
  }
  return Number.isFinite(timestamp)
    ? `최근 실시간 조회 · ${new Date(timestamp).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
    : '';
}

function tierStatusDetail(tier) {
  const providerMessage = tier?.providerReady?.message;
  if (providerMessage) return providerMessage;
  const health = tier?.health;
  const remaining = health?.totalRemainingPercent;
  if (Number.isFinite(remaining)) {
    const fiveHour = Number(health?.fiveHourRemainingPercent);
    const quota = Number.isFinite(fiveHour) ? ` · 5시간 한도 ${Math.round(fiveHour)}% 남음` : '';
    return `${tier?.model || ''}${quota}`;
  }
  return tier?.model || '연결 상태 정보를 받지 못했습니다.';
}

function renderDrawerTiers() {
  if (!priorityStatus || !priorityStatus.tiers) return;
  drawerTierList.innerHTML = '';
  const selectedRouteTier = resolveSelectedModelTier();

  const codexAccountsByModel = new Map();
  for (const tier of priorityStatus.tiers) {
    if (!String(tier.provider || '').toLowerCase().includes('codex')) continue;
    const model = String(tier.model || '').toLowerCase();
    if (!model) continue;
    const accounts = codexAccountsByModel.get(model) || [];
    accounts.push(tier);
    codexAccountsByModel.set(model, accounts);
  }
  for (const [model, accounts] of codexAccountsByModel) {
    const distinctAccounts = accounts.filter((tier, index) => accounts.findIndex(other =>
      `${String(other.email || '').toLowerCase()}|${String(other.account || other.id || '').toLowerCase()}`
      === `${String(tier.email || '').toLowerCase()}|${String(tier.account || tier.id || '').toLowerCase()}`
    ) === index);
    if (distinctAccounts.length < 2) continue;

    const comparison = document.createElement('section');
    comparison.className = 'priority-account-pair';
    comparison.setAttribute('aria-label', `${displayPriorityModel(model)}를 사용하는 별도 Codex 계정 비교`);
    comparison.innerHTML = `
      <strong class="priority-account-pair-title">같은 모델 · 다른 Codex 계정</strong>
      <span class="priority-account-pair-note">두 계정 모두 ${escapeHtml(displayPriorityModel(model))}를 사용하지만 로그인과 연결 상태는 각각 다릅니다.</span>
      <div class="priority-account-pair-list">
        ${distinctAccounts.sort((a, b) => a.tier - b.tier).map(tier => {
          const tierIdentity = /secondary/i.test(`${tier.id} ${tier.name}`) ? '보조 계정' : /primary/i.test(`${tier.id} ${tier.name}`) ? '주 계정' : '계정';
          const isActive = tier.id === selectedRouteTier?.id;
          const rankLabel = `${tier.tier}순위 · Codex ${tierIdentity}`;
          return `<div class="priority-account-pair-row tier-${escapeHtml(tier.tier)} ${isActive ? 'active' : ''}" aria-label="${escapeHtml(rankLabel)} · ${escapeHtml(tier.email || '이메일 정보 없음')} · 계정 ID ${escapeHtml(tier.account || tier.id || 'ID 정보 없음')} · ${isActive ? '현재 선택/라우팅' : '폴백'}">
            <span class="priority-account-pair-rank"><strong>${escapeHtml(tier.tier)}순위</strong><small>${isActive ? '현재 라우팅' : '폴백 계정'}</small></span>
            <span class="priority-account-pair-identity"><strong>${escapeHtml(rankLabel)} · ${escapeHtml(displayPriorityModel(tier.model))}</strong><span>로그인 이메일 · ${escapeHtml(tier.email || '이메일 정보 없음')}</span><span>계정 ID · ${escapeHtml(tier.account || tier.id || 'ID 정보 없음')}</span></span>
            <span class="priority-account-pair-state ${isActive ? 'active' : ''}">${isActive ? '현재 선택/라우팅' : `${tier.tier}순위 · 폴백`}</span>
          </div>`;
        }).join('')}
      </div>
    `;
    drawerTierList.appendChild(comparison);
  }

  for (const tier of priorityStatus.tiers) {
    const isActive = tier.id === selectedRouteTier?.id;
    const isCodex = String(tier.provider || '').toLowerCase().includes('codex');
    const tierIdentity = /secondary/i.test(`${tier.id} ${tier.name}`) ? '보조 계정' : /primary/i.test(`${tier.id} ${tier.name}`) ? '주 계정' : '계정';
    const readiness = tier.providerReady;
    const accountEmail = tier.email || '이메일 정보 없음';
    const accountId = tier.account || tier.id || 'ID 정보 없음';
    const card = document.createElement('div');
    if (fantasyWarriorMode) {
      const warrior = fantasyWarriorProfile(tier);
      const health = tier.health || {};
      const { remaining, hasKnownQuota, depleted, connected, selectable } = fantasyWarriorTierAvailability(priorityStatus, tier);
      const hp = hasKnownQuota ? Math.max(0, Math.min(100, remaining)) : depleted ? 0 : null;
      const nextReset = health.nextResetAt
        ? new Date(health.nextResetAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
        : null;
      const state = tier.enabled === false ? '명단에서 비활성'
        : !connected ? '잠김 · 계정 연결 필요'
          : depleted ? `${health.quotaState === 'provider-unavailable' ? '상태 회복 대기' : '회복 대기'}${hasKnownQuota ? ` · 체력 ${Math.round(hp)}%` : ' · 한도 재확인 필요'}${nextReset ? ` · ${nextReset} 갱신` : ''}`
            : hasKnownQuota ? `출전 가능 · 체력 ${Math.round(hp)}%`
              : '출전 가능 · 한도 수치 미확인';
      card.className = `tier-list-card priority-account-card fantasy-warrior-card ${isActive ? 'active' : ''} ${selectable ? 'selectable' : 'unavailable'} ${isCodex ? 'codex-account' : 'google-account'} tier-${tier.tier}`;
      card.innerHTML = `
        <div class="fantasy-warrior-topline">
          <span class="priority-account-rank">${escapeHtml(tier.tier)}순위</span>
          <span class="fantasy-warrior-class">${escapeHtml(warrior.role)}</span>
          ${isActive ? `<span class="priority-account-active">${priorityStatus?.enabled === false ? '직접 선택됨' : '현재 출전 중'}</span>` : ''}
        </div>
        <div class="fantasy-warrior-identity">
          <div class="fantasy-warrior-avatar" aria-hidden="true">${warrior.icon}</div>
          <div class="fantasy-warrior-copy">
            <strong>${escapeHtml(isCodex ? tierIdentity : tier.name || tier.provider || warrior.role)}</strong>
            <span>${escapeHtml(displayPriorityModel(tier.model))} · ${escapeHtml(accountEmail)}</span>
          </div>
        </div>
        <div class="fantasy-warrior-health" role="img" aria-label="${escapeHtml(state)}">
          <div class="fantasy-warrior-health-track"><span style="width:${hp === null ? 0 : hp}%"></span></div>
          <strong>${escapeHtml(state)}</strong>
        </div>
        <div class="priority-account-id">길드 계정 · ${escapeHtml(accountId)}</div>
      `;
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'fantasy-warrior-select';
      select.textContent = isActive && priorityStatus?.enabled === false ? '선택 완료 · 수동 고정' : '전사 선택';
      select.disabled = !selectable || (isActive && priorityStatus?.enabled === false);
      select.setAttribute('aria-label', `${warrior.role} ${selectable ? '선택 가능' : state}`);
      select.addEventListener('click', () => switchTier(tier.id));
      card.appendChild(select);
      drawerTierList.appendChild(card);
      continue;
    }
    card.className = `tier-list-card priority-account-card ${isActive ? 'active' : ''} ${isCodex ? 'codex-account' : 'google-account'} tier-${tier.tier}`;
    const explicitRankLabel = `${tier.tier}순위 · ${isCodex ? `Codex ${tierIdentity}` : tier.name || tier.provider}`;
    card.setAttribute('aria-label', `${explicitRankLabel} · ${tier.email || '이메일 정보 없음'} · 계정 ID ${tier.account || tier.id || 'ID 정보 없음'} · ${isActive ? '현재 선택/라우팅' : '폴백'}`);
    card.innerHTML = `
      <div class="priority-account-heading">
        <span class="priority-account-rank">${escapeHtml(explicitRankLabel)}</span>
        <span class="priority-account-provider">${isCodex ? 'OpenAI Codex' : escapeHtml(tier.name || tier.provider || '계정')}</span>
        <span class="priority-account-active ${isActive ? '' : 'fallback'}">${isActive ? (priorityStatus?.enabled === false ? '현재 선택 · 수동 라우팅' : '현재 선택 · 자동 라우팅') : '폴백 계정'}</span>
      </div>
      <div class="priority-account-model"><span>${isActive ? '다음 요청 모델' : '이 계정의 모델'}</span><strong>${escapeHtml(displayPriorityModel(tier.model))}</strong></div>
      <div class="priority-account-identity"><div class="priority-account-email"><span>로그인 이메일</span><strong>${escapeHtml(accountEmail)}</strong></div><div class="priority-account-id"><span>계정 ID</span><strong>${escapeHtml(accountId)}</strong></div></div>
      <div class="priority-account-ready ${readiness && !readiness.connected ? 'not-ready' : ''}">${escapeHtml(tierConnectionLabel(tier))}</div>
      ${isCodex && readiness?.authenticationRequired ? `<div class="priority-account-auth-warning" role="status">${escapeHtml(readiness.message || 'Codex 로그인이 필요합니다.')}</div>` : ''}
      <div class="priority-account-quota">${escapeHtml(tierQuotaLabel(tier))}</div>
      ${tierQuotaCheckedLabel(tier) ? `<div class="priority-account-quota">${escapeHtml(tierQuotaCheckedLabel(tier))}</div>` : ''}
    `;

    if (isCodex && readiness?.authenticationRequired) {
      const reauthButton = document.createElement('button');
      reauthButton.type = 'button';
      reauthButton.className = 'codex-reauth-inline';
      reauthButton.textContent = '이 계정 다시 로그인';
      reauthButton.setAttribute('aria-label', `${accountEmail} Codex 계정 다시 로그인`);
      reauthButton.addEventListener('click', () => openCodexReauth(tier.id));
      card.appendChild(reauthButton);
    }

    drawerTierList.appendChild(card);
  }
}

function openCodexReauth(preselectedTierId = '') {
  const dialog = document.getElementById('codexReauthDialog');
  const list = document.getElementById('codexReauthAccounts');
  if (!priorityStatus) {
    void refreshPriorityStatus().then(() => openCodexReauth(preselectedTierId));
    return;
  }
  const accounts = (priorityStatus?.tiers || []).filter(tier => String(tier.provider || '').toLowerCase() === 'codex');
  if (!dialog || !list) return;
  list.replaceChildren();
  const ordered = [...accounts].sort((a, b) => (Number(a.tier) || 99) - (Number(b.tier) || 99));
  for (const tier of ordered) {
    const row = document.createElement('section');
    row.className = 'codex-reauth-account';
    const readiness = tier.providerReady || {};
    const title = document.createElement('strong');
    title.textContent = `${Number(tier.tier) || '?'}순위 · ${tier.email || '이메일 정보 없음'}`;
    const detail = document.createElement('div');
    detail.className = `codex-reauth-state ${readiness.connected ? 'connected' : 'required'}`;
    detail.textContent = readiness.message || (readiness.connected ? '연결됨' : '다시 로그인해야 사용할 수 있습니다.');
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'codex-reauth-start';
    action.textContent = readiness.connected ? '세션 갱신' : '다시 로그인';
    action.disabled = !readiness.available || (preselectedTierId && preselectedTierId !== tier.id);
    action.addEventListener('click', () => { void startCodexReauth(tier, row, action, detail); });
    row.append(title, detail, action);
    const progress = document.createElement('div');
    progress.className = 'codex-reauth-progress';
    progress.setAttribute('role', 'status');
    progress.setAttribute('aria-live', 'polite');
    row.appendChild(progress);
    list.appendChild(row);
  }
  if (!ordered.length) {
    const empty = document.createElement('p');
    empty.textContent = '등록된 Codex 계정이 없습니다.';
    list.appendChild(empty);
  }
  if (!dialog.open) dialog.showModal();
}

async function startCodexReauth(tier, row, button, stateLabel) {
  const progress = row.querySelector('.codex-reauth-progress');
  button.disabled = true;
  progress.textContent = '기기 로그인 시작 중…';
  try {
    const response = await fetch('/api/codex/reauth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: tier.id })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || `재인증 시작 실패 (${response.status})`);
    let state = result.status || { state: 'starting' };
    const startedAt = Date.now();
    while (Date.now() - startedAt < 10 * 60 * 1000 && ['starting', 'waiting'].includes(state.state)) {
      renderCodexReauthProgress(progress, state);
      await new Promise(resolve => setTimeout(resolve, 1000));
      const statusResponse = await fetch(`/api/codex/reauth/status?tierId=${encodeURIComponent(tier.id)}`, { cache: 'no-store' });
      state = await statusResponse.json();
      if (!statusResponse.ok) throw new Error(state.error || `로그인 상태 확인 실패 (${statusResponse.status})`);
    }
    renderCodexReauthProgress(progress, state);
    stateLabel.textContent = state.message || state.state;
    stateLabel.classList.toggle('connected', state.state === 'connected');
    stateLabel.classList.toggle('required', state.state !== 'connected');
    await refreshPriorityStatus();
    if (state.state === 'connected') {
      const updated = priorityStatus?.tiers?.find(item => item.id === tier.id);
      stateLabel.textContent = updated?.providerReady?.message || state.message;
      button.textContent = '연결됨';
    } else button.disabled = false;
  } catch (error) {
    progress.textContent = error.message || 'Codex 재인증을 시작하지 못했습니다.';
    button.disabled = false;
  }
}

function renderCodexReauthProgress(container, status) {
  container.replaceChildren();
  const message = document.createElement('span');
  message.textContent = status.message || 'Codex 인증을 기다리고 있습니다.';
  container.appendChild(message);
  if (status.userCode) {
    const code = document.createElement('strong');
    code.className = 'codex-reauth-code';
    code.textContent = status.userCode;
    container.appendChild(code);
  }
  if (status.verificationUrl) {
    try {
      const url = new URL(status.verificationUrl);
      if (url.protocol === 'https:' && url.hostname === 'auth.openai.com') {
        const link = document.createElement('a');
        link.href = url.toString();
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'OpenAI 로그인 페이지 열기';
        container.appendChild(link);
      }
    } catch (_) {}
  }
}

function fantasyWarriorProfile(tier) {
  const identity = `${tier?.id || ''} ${tier?.name || ''}`.toLowerCase();
  const provider = String(tier?.provider || '').toLowerCase();
  if (provider.includes('antigravity') || provider === 'google') return { role: '별빛 마도사', icon: '🧙' };
  if (identity.includes('secondary')) return { role: '그림자 검사', icon: '⚔️' };
  if (identity.includes('primary')) return { role: '수호 기사', icon: '🛡️' };
  const roles = [
    { role: '왕국 수호자', icon: '🛡️' },
    { role: '황혼의 검사', icon: '⚔️' },
    { role: '룬 마도사', icon: '🧙' }
  ];
  return roles[(Math.max(1, Number(tier?.tier) || 1) - 1) % roles.length];
}

async function switchTier(tierId) {
  try {
    const res = await fetch('/api/priority/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId })
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || `계정 전환 실패 (${res.status})`);
    setPriorityStatusSnapshot(result.status);
    activeTier = result.status?.activeTier || result.tier;
    renderPriorityMode();
    renderActiveModelSelection();
    renderDrawerTiers();
    showMorphToast(`수동 계정 선택 · ${activeTier?.email || activeTier?.name || tierId}`);
  } catch (err) {
    const failedTier = priorityStatus?.tiers?.find(tier => tier.id === tierId);
    if (String(failedTier?.provider || '').toLowerCase() === 'codex'
      && /로그인|인증|unauthori[sz]ed|not logged in|authentication required/i.test(String(err.message || ''))) {
      await refreshPriorityStatus();
      openCodexReauth(tierId);
      return;
    }
    alert('티어 전환 실패: ' + err.message);
  }
}

// ============================================================================
// Reference 3: Microphone Voice Dictation
// ============================================================================

function toggleSpeechInput() {
  if (speechTranscribing) {
    showMorphToast('음성 전사가 끝난 뒤 다시 녹음할 수 있습니다.');
    return;
  }
  if (isRecording) {
    stopSpeechMemo();
    return;
  }
  void startSpeechMemo();
}

async function startSpeechMemo() {
  if (speechStarting) return;
  speechStarting = true;
  updateVoiceCaptureUI();
  const status = document.getElementById('voiceCaptureStatus');
  status.textContent = '마이크를 연결하고 있습니다…';
  status.hidden = false;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    speechStarting = false;
    status.textContent = '이 앱 런타임에서 오디오 녹음을 사용할 수 없습니다.';
    updateVoiceCaptureUI();
    setVoiceFeedbackError(status.textContent);
    showMorphToast('이 앱 런타임에서 오디오 녹음을 사용할 수 없습니다.');
    return;
  }
  try {
    speechMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    speechRecorder = new MediaRecorder(speechMediaStream, mimeType ? { mimeType } : undefined);
    speechChunks = [];
    pendingSpeechMemoBlob = null;
    document.getElementById('btnVoiceRetry').hidden = true;
    document.getElementById('btnVoiceFeedback').hidden = true;
    speechRecorder.addEventListener('dataavailable', event => { if (event.data?.size) speechChunks.push(event.data); });
    speechRecorder.addEventListener('stop', () => {
      const blob = new Blob(speechChunks, { type: speechRecorder?.mimeType || mimeType || 'audio/webm' });
      speechRecorder = null;
      speechChunks = [];
      stopSpeechWaveform();
      speechMediaStream?.getTracks().forEach(track => track.stop());
      speechMediaStream = null;
      setSpeechRecording(false);
      if (blob.size) {
        pendingSpeechMemoBlob = blob;
        void transcribeSpeechMemo(blob, true);
      }
      else {
        speechTranscribing = false;
        composerInput.readOnly = false;
        speechDraftPrefix = null;
        speechDraftSuffix = '';
        const status = document.getElementById('voiceCaptureStatus');
        status.textContent = '녹음된 음성이 없습니다. 다시 말해 주세요.';
        status.hidden = false;
        setVoiceFeedbackError(status.textContent);
        updateVoiceCaptureUI();
      }
    }, { once: true });
    speechRecorder.start();
    setSpeechRecording(true);
    document.getElementById('voiceCaptureStatus').textContent = '듣고 있습니다 · Enter를 누르면 전사 후 전송합니다';
    document.getElementById('voiceCaptureStatus').hidden = false;
    startSpeechWaveform(speechMediaStream);
  } catch (error) {
    speechMediaStream?.getTracks().forEach(track => track.stop());
    speechMediaStream = null;
    speechRecorder = null;
    setSpeechRecording(false);
    const status = document.getElementById('voiceCaptureStatus');
    status.textContent = `녹음을 시작하지 못했습니다: ${error.message}`;
    status.hidden = false;
    setVoiceFeedbackError(status.textContent);
    showMorphToast(`녹음 시작 실패: ${error.message}`);
  } finally {
    speechStarting = false;
    updateVoiceCaptureUI();
  }
}

function stopSpeechMemo() {
  if (speechRecorder?.state === 'recording') {
    speechTranscribing = true;
    const status = document.getElementById('voiceCaptureStatus');
    status.textContent = '녹음을 마무리하고 전사합니다…';
    status.hidden = false;
    updateVoiceCaptureUI();
    speechRecorder.stop();
  }
}

function isUsableSpeechTranscript(value) {
  const text = String(value || '').trim();
  return Boolean(text) && !/<\|[^|]{1,40}\|>/.test(text);
}

async function transcribeSpeechMemo(blob = pendingSpeechMemoBlob, autoSend = true) {
  if (speechTranscriptionRunning || !blob) return;
  speechTranscriptionRunning = true;
  const status = document.getElementById('voiceCaptureStatus');
  const retryButton = document.getElementById('btnVoiceRetry');
  speechTranscribing = true;
  retryButton.hidden = true;
  const startedAt = Date.now();
  const updateElapsed = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    status.textContent = `로컬 Whisper 전사 중 · ${seconds}초 · ${(blob.size / (1024 * 1024)).toFixed(1)} MB${seconds < 15 ? ' · 첫 실행은 모델 준비로 더 걸릴 수 있습니다' : ''}`;
  };
  updateElapsed();
  const elapsedTimer = window.setInterval(updateElapsed, 1000);
  status.hidden = false;
  updateVoiceCaptureUI();
  try {
    if (blob.size > 20 * 1024 * 1024) throw new Error('녹음은 20 MB 이하로 나누어 주세요.');
    const response = await fetch('/api/audio/transcribe', {
      method: 'POST', headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `전사 실패 (${response.status})`);
    const transcript = String(result.transcript || '').trim();
    if (!isUsableSpeechTranscript(transcript)) {
      status.textContent = '음성을 글자로 인식하지 못했습니다. 녹음은 보존했습니다. 더 선명하게 말하거나 짧게 녹음한 뒤 다시 전사해 주세요.';
      retryButton.hidden = blob.size > 20 * 1024 * 1024;
      setVoiceFeedbackError(status.textContent);
      return;
    }
    // The recognized text is now preserved in the composer; retrying the same
    // recording could insert and send it twice.
    pendingSpeechMemoBlob = null;
    document.getElementById('btnVoiceFeedback').hidden = true;
    applySpeechTranscript(transcript);
    if (autoSend) {
      if (isGenerating) {
        pendingSpeechAutoSendPrompt = composerInput.value.trim();
        status.textContent = '전사 완료 · 현재 응답이 끝나면 자동 전송합니다';
      } else {
        status.textContent = '전사 완료 · 채팅으로 전송합니다';
        const accepted = await handleSend();
        if (accepted) {
          status.textContent = '';
          status.hidden = true;
        } else {
          status.textContent = '전사는 완료했지만 전송 대기열에 넣지 못했습니다. 작성된 문장을 확인한 뒤 Enter로 보내 주세요.';
          status.hidden = false;
        }
      }
    } else {
      status.textContent = `${result.language || '언어 자동 감지'} · 전사 완료`;
    }
  } catch (error) {
    status.textContent = `전사하지 못했습니다: ${error.message}`;
    retryButton.hidden = blob.size > 20 * 1024 * 1024;
    setVoiceFeedbackError(status.textContent);
  } finally {
    window.clearInterval(elapsedTimer);
    speechTranscriptionRunning = false;
    speechTranscribing = false;
    composerInput.readOnly = false;
    updateVoiceCaptureUI();
    if (!isGenerating) flushPendingSpeechAutoSend();
  }
}

function setSpeechRecording(recording) {
  recording = Boolean(recording);
  if (recording && !isRecording) {
    const value = String(composerInput.value || '');
    const offset = Number.isInteger(composerInput.selectionStart) ? composerInput.selectionStart : value.length;
    speechDraftPrefix = value.slice(0, offset);
    speechDraftSuffix = value.slice(offset);
    composerInput.readOnly = true;
  } else if (!recording && isRecording) {
    composerInput.readOnly = speechTranscribing;
  }
  isRecording = recording;
  updateVoiceCaptureUI();
  if (!recording) composerInput.placeholder = 'Work with Only Chat...';
}

function updateVoiceCaptureUI() {
  const active = isRecording || speechTranscribing || speechStarting;
  const icon = document.getElementById('voiceMicIcon');
  const indicator = document.getElementById('voiceCaptureIndicator');
  icon.hidden = active;
  indicator.hidden = !active;
  btnMicrophone.classList.toggle('recording', isRecording);
  btnMicrophone.classList.toggle('transcribing', (speechTranscribing || speechStarting) && !isRecording);
  btnMicrophone.setAttribute('aria-pressed', String(isRecording));
  btnMicrophone.setAttribute('aria-label', isRecording ? '녹음을 마치고 전사 후 전송' : '음성 입력 시작');
  btnMicrophone.title = isRecording ? '듣고 있습니다 · Enter를 누르면 전사 후 전송' : speechStarting ? '마이크를 연결하고 있습니다' : speechTranscribing ? '전사 중입니다' : '음성 입력 시작';
}

function startSpeechWaveform(stream) {
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) {
    btnMicrophone.classList.add('waveform-fallback');
    return;
  }
  try {
    speechAudioContext = new AudioContextType();
    speechAnalyser = speechAudioContext.createAnalyser();
    speechAnalyser.fftSize = 256;
    speechAudioContext.createMediaStreamSource(stream).connect(speechAnalyser);
    void speechAudioContext.resume().catch(() => {});
    const bars = [...document.querySelectorAll('#voiceWaveform i')];
    const samples = new Uint8Array(speechAnalyser.fftSize);
    const draw = () => {
      if (!speechAnalyser) return;
      speechAnalyser.getByteTimeDomainData(samples);
      bars.forEach((bar, index) => {
        const sample = samples[Math.floor(index * samples.length / Math.max(1, bars.length))] || 128;
        const scale = Math.min(1.45, 0.22 + Math.abs(sample - 128) / 35);
        bar.style.setProperty('--wave-scale', String(scale));
      });
      speechAnimationFrame = requestAnimationFrame(draw);
    };
    draw();
  } catch (_) {
    speechAnalyser = null;
    btnMicrophone.classList.add('waveform-fallback');
  }
}

function stopSpeechWaveform() {
  btnMicrophone.classList.remove('waveform-fallback');
  if (speechAnimationFrame !== null) cancelAnimationFrame(speechAnimationFrame);
  speechAnimationFrame = null;
  speechAnalyser = null;
  if (speechAudioContext && speechAudioContext.state !== 'closed') void speechAudioContext.close().catch(() => {});
  speechAudioContext = null;
}

function applySpeechTranscript(value) {
  if (speechDraftPrefix === null) return;
  const transcript = String(value || '');
  const prefix = speechDraftPrefix;
  const suffix = speechDraftSuffix;
  const separator = transcript && prefix && !/\s$/.test(prefix) ? ' ' : '';
  const trailing = transcript && suffix && !/\s$/.test(transcript) && !/^\s/.test(suffix) ? ' ' : '';
  composerInput.value = `${prefix}${separator}${transcript}${trailing}${suffix}`;
  const cursor = prefix.length + separator.length + transcript.length;
  composerInput.setSelectionRange?.(cursor, cursor);
  composerInput.dispatchEvent(new Event('input'));
  speechDraftPrefix = null;
  speechDraftSuffix = '';
}

window.onlyChatSpeechState = recording => setSpeechRecording(Boolean(recording));
window.onlyChatSpeechResult = text => applySpeechTranscript(text);
window.onlyChatSpeechError = message => { setSpeechRecording(false); showMorphToast(message); };

// ============================================================================
// Turn Execution & Streaming (With Reference 3 Stop / Send Button)
// ============================================================================

let adminManagerStatusInFlight = false;
let adminManagerStatusLastRequestAt = 0;

async function refreshAdminManagerStatus() {
  if (!managerModeToggle) return;
  const now = Date.now();
  if (adminManagerStatusInFlight || now - adminManagerStatusLastRequestAt < 3000) return;
  adminManagerStatusInFlight = true;
  adminManagerStatusLastRequestAt = now;
  const label = document.getElementById('managerModeLabel');
  const labelContainer = label?.parentElement;
  managerModeToggle.disabled = true;
  try {
    const response = await fetch('/api/admin-manager/status');
    if (!response.ok) throw new Error('backend unavailable');
    const status = await response.json();
    const manager = status.modules?.find(module => module.id === 'admin-manager');
    const coreModules = ['agent-engine', 'tool-registry'];
    const staleCore = status.modules?.filter(module => coreModules.includes(module.id) && module.state !== 'loaded') || [];
    if (status.apiVersion !== 1 || manager?.state !== 'loaded' || !status.capabilities?.length) {
      throw new Error('capability registry unavailable');
    }
    if (staleCore.length) {
      managerModeToggle.checked = false;
      managerModeToggle.disabled = true;
      const reason = `Only Chat 서버를 새로고침해야 합니다: ${staleCore.map(module => module.id).join(', ')}`;
      managerModeToggle.title = reason;
      if (labelContainer) labelContainer.title = reason;
      if (label) label.textContent = '관리자 AI · 서버 업데이트 필요';
      return;
    }
    const availableCount = status.capabilities.filter(capability => ['executable', 'settings-only'].includes(capability.state)).length;
    if (!availableCount) throw new Error('no actionable capabilities');
    managerModeToggle.disabled = false;
    const delegation = status.capabilities.some(capability => capability.id === 'work.delegate' && capability.state === 'executable');
    const noVerifiedDispatcher = status.dispatcher?.blockedReason === 'no_verified_dispatch_provider';
    managerModeToggle.title = delegation
      ? '관리자가 계획을 만들고 별도 실행자 세션에 작업을 맡겨 상태와 결과를 보여줍니다. 승인 필요 작업은 기존 승인 정책에 따릅니다.'
      : noVerifiedDispatcher
        ? '검증된 AI Account Router 계정·모델이나 설치 확인된 Ollama 모델이 없어 실행자 위임을 시작할 수 없습니다.'
      : `사용 가능한 Mac 기능 ${availableCount}/${status.capabilities.length}개를 확인합니다. 실행자 위임이 활성화되지 않았습니다.`;
    if (labelContainer) labelContainer.title = managerModeToggle.title;
    if (label) label.textContent = delegation ? '관리자 AI · 실행자 위임'
      : noVerifiedDispatcher ? '관리자 AI · 실행자 모델 확인 필요'
      : `관리자 AI · 제안 (${availableCount}/${status.capabilities.length})`;
  } catch (_) {
    managerModeToggle.checked = false;
    managerModeToggle.title = 'Manager 백엔드를 사용할 수 없습니다. Only Chat 서버 업데이트 후 다시 확인하세요.';
    if (labelContainer) labelContainer.title = managerModeToggle.title;
    if (label) label.textContent = '관리자 AI · 서버 업데이트 필요';
  } finally {
    adminManagerStatusInFlight = false;
  }
}

async function handleSend() {
  const prompt = composerInput.value.trim();
  if (!prompt || isGenerating) return false;
  activeSendInFlight = true;
  const fullAccessForTurn = fullAccessEnabled;

  const composerStatus = document.getElementById('composerStatus');
  const submittedFromCodexQueue = isCodexQueueComposerNotice(composerStatus?.textContent);
  const codexQueueFingerprint = submittedFromCodexQueue ? composerStatus.dataset?.codexQueueFingerprint || '' : '';
  if (submittedFromCodexQueue) {
    composerStatus.textContent = '';
    if (composerStatus.dataset) delete composerStatus.dataset.codexQueueFingerprint;
  }
  if (codexQueueFingerprint) {
    setCodexQueueItemSendState(codexQueueFingerprint, 'inflight');
    renderCodexQueueInbox(codexQueueInboxItems);
  }

  // Clear input & reset height
  composerInput.value = '';
  composerInput.style.height = 'auto';

  if (emptyState) emptyState.style.display = 'none';

  // Set generating state & update Orange Button (Ref 3)
  setGeneratingState(true);

  // Update Titlebar
  titlebarThreadTitle.textContent = prompt.length > 35 ? prompt.slice(0, 35) + '...' : prompt;

  // Append User message
  appendUserMessage(prompt);

  // Create Assistant Message container (Warm Peach Card - Ref 1 & 2)
  const assistantCard = createAssistantContainer({ timing: true });
  timeline.appendChild(assistantCard.row);
  const assistantTimer = startAssistantTimer(assistantCard);
  timeline.scrollTop = timeline.scrollHeight;

  if (activeGoal && !prompt.trim().startsWith('/goal')) {
    cancelActiveGoal('새로운 메시지를 입력하여 이전 목표 추구를 중단했습니다.');
  }

  const goalMatch = prompt.trim().match(/^\/goal(?:\s+((?:--fixed-duration\s+)?(?:\d{1,3}(?:m|h)\s+)?.*))?$/is);
  if (goalMatch) {
    const rawArgs = (goalMatch[1] || '').trim();
    if (!rawArgs) {
      const usageNotice = document.createElement('div');
      usageNotice.className = 'text-body';
      usageNotice.style.whiteSpace = 'pre-wrap';
      usageNotice.textContent = [
        '🎯 [Goal Mode (목표 추구 모드)]',
        '목표가 완전히 달성될 때까지 자율적으로 여러 턴을 연속 실행합니다.',
        '',
        '사용법:',
        '  /goal [시간] <목표 내용>',
        '  /goal --fixed-duration [시간] <목표 내용>',
        '  /goal stop (진행 중인 목표 중단)',
        '',
        '예시:',
        '  /goal 30m TODO 항목 검증 및 리팩토링',
        '  /goal 1h 시스템 오류 해결 및 테스트 통과',
        '  /goal 이번 대화의 모든 작업 마무리 (기본 30분)'
      ].join('\n');
      assistantCard.content.appendChild(usageNotice);
      assistantTimer.finish();
      finishAssistantWork(assistantCard, 'complete');
      activeSendInFlight = false;
      setGeneratingState(false);
      return true;
    }

    if (rawArgs.toLowerCase() === 'stop' || rawArgs.toLowerCase() === 'cancel') {
      cancelActiveGoal('명령어(/goal stop)로 목표 추구를 중단했습니다.');
      assistantTimer.finish();
      finishAssistantWork(assistantCard, 'complete');
      activeSendInFlight = false;
      setGeneratingState(false);
      return true;
    }

    const fixedDuration = /--fixed-duration/i.test(rawArgs);
    let rest = rawArgs.replace(/--fixed-duration/gi, '').trim();
    const durMatch = /^(\d{1,3}(?:m|h))\s+(.+)$/is.exec(rest);
    let durationMs = 30 * 60_000;
    let goalObjective = rest;
    if (durMatch) {
      durationMs = parseClientGoalDuration(durMatch[1]);
      goalObjective = durMatch[2].trim();
    }
    const introMsg = document.createElement('div');
    introMsg.className = 'text-body';
    introMsg.textContent = `🎯 [Goal 시작] 목표 추구를 시작합니다 (시간: 약 ${Math.round(durationMs / 60000)}분 · 1회차)`;
    assistantCard.content.appendChild(introMsg);
    assistantTimer.finish();
    finishAssistantWork(assistantCard, 'complete');
    activeSendInFlight = false;
    setGeneratingState(false);
    void startGoalMode(goalObjective, durationMs, fixedDuration);
    return true;
  }

  if (goalModeEnabled && !prompt.startsWith('/')) {
    const introMsg = document.createElement('div');
    introMsg.className = 'text-body';
    introMsg.textContent = `🎯 [Goal 시작] 목표 추구 모드로 실행합니다 (시간: 약 30분 · 1회차)`;
    assistantCard.content.appendChild(introMsg);
    assistantTimer.finish();
    finishAssistantWork(assistantCard, 'complete');
    activeSendInFlight = false;
    setGeneratingState(false);
    void startGoalMode(prompt, 30 * 60_000, false);
    return true;
  }

  const sessionStorageMatch = prompt.trim().match(/^\/session-storage(?:\s+(\d{1,2}))?$/);
  if (sessionStorageMatch) {
    try {
      const days = Math.max(1, Math.min(90, Number(sessionStorageMatch[1]) || 7));
      const response = await fetch(`/api/sessions/storage-report?days=${days}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `세션 저장량 조회 실패 (${response.status})`);
      const gib = bytes => `${(Number(bytes || 0) / (1024 ** 3)).toFixed(4)} GiB`;
      const report = document.createElement('pre');
      report.className = 'text-body';
      report.style.whiteSpace = 'pre-wrap';
      report.textContent = [
        `Only Chat 내부 대화 기록 · ${payload.windowDays}일 분석`,
        `현재 기록 ${gib(payload.totalBytes)} · ${payload.totalRecords}개 항목`,
        `최근 ${payload.windowDays}일에 추가된 기록 ${gib(payload.recentBytes)} · ${payload.recentRecords}개 항목`,
        `추적 경로: ${payload.storageDir}`,
        '기록 종류별 현재 용량 (최근 기간 추가량)',
        ...(payload.byRecordType || []).map(item => `  ${item.type}: ${gib(item.bytes)} (${item.records}개) · 최근 ${gib(item.recentBytes)}`),
        '큰 대화 기록 상위 10개 (기록 종류별 상세)',
        ...(payload.largestSessions || []).map(item => `  ${item.title} [${item.sessionId}]: ${gib(item.bytes)} · 최근 ${gib(item.recentBytes)}\n${item.types.map(type => `    ${type.type}: ${gib(type.bytes)} (${type.records}개) · 최근 ${gib(type.recentBytes)}`).join('\n')}`),
        payload.incomplete ? `일부 기록은 손상 또는 4MiB 초과라 증가 날짜/종류 귀속이 일부 미완전합니다` : '기록 분석 완료',
        payload.unattributedBytes ? `기록 종류에 귀속되지 않은 바이트 ${gib(payload.unattributedBytes)} · 손상/비표준 줄을 확인하세요` : '종류 미확인 바이트: 없음',
        payload.malformedBytes ? `분석할 수 없는 JSON 줄: ${gib(payload.malformedBytes)}` : '손상된 JSON 기록 줄: 없음',
        `측정: ${new Date(payload.measuredAt).toLocaleString()} · 내부 JSONL만 포함; Codex 외부 대화/기타 앱 파일 제외`
      ].join('\n');
      assistantCard.content.appendChild(report);
    } catch (err) {
      const message = document.createElement('div');
      message.className = 'text-body';
      message.textContent = `Only Chat 세션 저장량 조회 오류: ${err.message}`;
      assistantCard.content.appendChild(message);
    } finally {
      assistantTimer.finish();
      finishAssistantWork(assistantCard, assistantCard.workOutcome || 'complete');
      activeSendInFlight = false;
      setGeneratingState(false);
      applyPendingUiMorphReloadWhenSafe();
    }
    return true;
  }

  if (prompt.trim() === '/capacity') {
    try {
      const response = await fetch('/api/spacekeeper/capacity', { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `용량 조회 실패 (${response.status})`);
      const report = document.createElement('div');
      report.className = 'text-body';
      const reserveGiB = Number(payload.reserveGiB) || 20;
      report.textContent = `Space Keeper · ${payload.severity || 'unknown'}\n현재 여유 공간 ${Number(payload.freeGiB).toFixed(2)} GiB · 보호 여유 ${reserveGiB} GiB\n${Array.isArray(payload.issues) && payload.issues.length ? payload.issues.join('\n') : '저장공간 가드에서 확인된 문제가 없습니다.'}\n확인 시각 ${new Date().toLocaleTimeString()}`;
      assistantCard.content.appendChild(report);
    } catch (err) {
      const message = document.createElement('div');
      message.className = 'text-body';
      message.textContent = `Space Keeper 용량 조회 오류: ${err.message}`;
      assistantCard.content.appendChild(message);
    } finally {
      assistantTimer.finish();
      finishAssistantWork(assistantCard, assistantCard.workOutcome || 'complete');
      activeSendInFlight = false;
      setGeneratingState(false);
      applyPendingUiMorphReloadWhenSafe();
    }
    return true;
  }

  if (prompt.startsWith('/spacekeeper')) {
    try {
      const match = prompt.match(/^\/spacekeeper\s+([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/);
      if (!match) throw new Error('사용법: /spacekeeper task-key');
      const response = await fetch('/api/spacekeeper/session-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskKey: match[1] })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `보고서 조회 실패 (${response.status})`);
      const report = document.createElement('pre');
      report.className = 'text-body';
      report.style.whiteSpace = 'pre-wrap';
      report.textContent = JSON.stringify(payload, null, 2);
      assistantCard.content.appendChild(report);
    } catch (err) {
      const message = document.createElement('div');
      message.className = 'text-body';
      message.textContent = `Space Keeper 보고서 오류: ${err.message}`;
      assistantCard.content.appendChild(message);
    } finally {
      assistantTimer.finish();
      activeSendInFlight = false;
      setGeneratingState(false);
      applyPendingUiMorphReloadWhenSafe();
    }
    return true;
  }

  const turnResult = await executeTurnCore({
    prompt,
    assistantCard,
    assistantTimer,
    submittedFromCodexQueue,
    codexQueueFingerprint,
    fullAccessForTurn
  });
  return turnResult.ok;
}

let activeGoal = null;
let goalModeEnabled = false;
let goalCircuitAbortController = null;
const GOAL_STALL_LIMIT_MS = 60 * 60_000;

function goalBlockerFingerprint(value) {
  return String(value || '').toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, '<id>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[t ]\S+)?/g, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:bytes?|b|kib|mib|gib|kb|mb|gb)\b/g, '<size>')
    .replace(/(?:\/users\/|\/private\/|\/tmp\/|[a-z]:\\)[^\s,;)]+/ig, '<path>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 400);
}

function recordGoalBlocker(goal, reason, nowMs = Date.now()) {
  if (!goal || typeof reason !== 'string' || !reason.trim()) return { repeated: false, fingerprint: '' };
  goal.blockerProgress ||= Object.create(null);
  const fingerprint = goalBlockerFingerprint(reason);
  const progress = Number(goal.substantiveProgress || 0);
  if (Object.prototype.hasOwnProperty.call(goal.blockerProgress, fingerprint)
    && goal.blockerProgress[fingerprint] === progress) {
    return { repeated: true, fingerprint };
  }
  goal.blockerProgress[fingerprint] = progress;
  if (goal.blockerFingerprint !== fingerprint || goal.stalledSince == null) {
    goal.stalledSince = nowMs;
    goal.lastSubstantiveProgressAt = nowMs;
  }
  goal.blockerFingerprint = fingerprint;
  goal.lastBlockerReason = reason.trim();
  return { repeated: false, fingerprint };
}

function recordGoalProgress(goal, nowMs = Date.now()) {
  if (!goal) return;
  goal.substantiveProgress = Number(goal.substantiveProgress || 0) + 1;
  goal.lastSubstantiveProgressAt = nowMs;
  goal.blockerProgress = Object.create(null);
  goal.blockerFingerprint = '';
  goal.stalledSince = null;
  goal.lastBlockerReason = '';
}

function goalStallExpired(goal, nowMs = Date.now()) {
  return Boolean(goal && goal.stalledSince != null && nowMs - goal.stalledSince >= GOAL_STALL_LIMIT_MS);
}

function goalStallCheckpoint(goal, nextAction) {
  return {
    blockerFingerprint: goal?.blockerFingerprint || null,
    blockerReason: goal?.lastBlockerReason || null,
    blockerFirstSeenAt: goal?.stalledSince == null ? null : new Date(goal.stalledSince).toISOString(),
    lastSubstantiveProgressAt: goal?.lastSubstantiveProgressAt == null ? null : new Date(goal.lastSubstantiveProgressAt).toISOString(),
    nextAction
  };
}

function scheduleGoalStallDeadline(goal) {
  if (!goal) return;
  if (goal.stallTimer) clearTimeout(goal.stallTimer);
  goal.stallTimer = null;
  if (goal.stalledSince == null) return;
  const remaining = Math.max(1, GOAL_STALL_LIMIT_MS - (Date.now() - goal.stalledSince));
  goal.stallTimer = setTimeout(() => {
    if (activeGoal !== goal) return;
    if (!goalStallExpired(goal)) return scheduleGoalStallDeadline(goal);
    reportIncompleteActiveGoal(`같은 근본 원인에서 60분 동안 검증된 진전이 없습니다: ${goal.lastBlockerReason || '원인 미기록'}`, '60분 정체');
  }, remaining);
}

function parseClientGoalDuration(val) {
  const match = /^(\d{1,3})(m|h)$/.exec(String(val || '').trim());
  if (!match) return 30 * 60_000;
  const minutes = Number(match[1]) * (match[2] === 'h' ? 60 : 1);
  return Math.max(1, Math.min(180, minutes)) * 60_000;
}

function cancelActiveGoal(reason = '사용자가 목표 추구를 중단했습니다.') {
  if (!activeGoal) return;
  const goalObj = activeGoal;
  activeGoal = null;
  if (goalObj.timer) { clearTimeout(goalObj.timer); goalObj.timer = null; }
  if (goalObj.stallTimer) { clearTimeout(goalObj.stallTimer); goalObj.stallTimer = null; }
  const goalBanner = document.getElementById('goalModeBanner');
  if (goalBanner) goalBanner.hidden = true;
  const goalPill = document.getElementById('btnGoalToggle');
  if (goalPill && !goalModeEnabled) goalPill.classList.remove('active');
  const card = createAssistantContainer({ timing: false });
  timeline.appendChild(card.row);
  const msg = document.createElement('div');
  msg.className = 'text-body';
  msg.textContent = `🎯 [Goal 중단] ${reason} (총 ${goalObj.iteration}회차 수행)`;
  card.content.appendChild(msg);
  timeline.scrollTop = timeline.scrollHeight;
  setGeneratingState(false);
}

function finishActiveGoal(summary = '목표가 완료되었습니다.') {
  if (!activeGoal) return;
  const goalObj = activeGoal;
  activeGoal = null;
  if (goalObj.timer) { clearTimeout(goalObj.timer); goalObj.timer = null; }
  if (goalObj.stallTimer) { clearTimeout(goalObj.stallTimer); goalObj.stallTimer = null; }
  const goalBanner = document.getElementById('goalModeBanner');
  if (goalBanner) goalBanner.hidden = true;
  const goalPill = document.getElementById('btnGoalToggle');
  if (goalPill && !goalModeEnabled) goalPill.classList.remove('active');
  const card = createAssistantContainer({ timing: false });
  timeline.appendChild(card.row);
  const msg = document.createElement('div');
  msg.className = 'text-body';
  msg.textContent = `🎯 [Goal 완료] ${summary} (총 ${goalObj.iteration}회차 수행 완료)`;
  card.content.appendChild(msg);
  timeline.scrollTop = timeline.scrollHeight;
  setGeneratingState(false);
}

function reportIncompleteActiveGoal(reason, status = '차단') {
  if (!activeGoal) return;
  const goalObj = activeGoal;
  activeGoal = null;
  if (goalObj.timer) { clearTimeout(goalObj.timer); goalObj.timer = null; }
  if (goalObj.stallTimer) { clearTimeout(goalObj.stallTimer); goalObj.stallTimer = null; }
  if (currentAbortController) {
    goalCircuitAbortController = currentAbortController;
    currentAbortController.abort();
  }
  const nextAction = '중단 지점과 완료된 변경을 확인한 뒤, 같은 차단 경로를 반복하지 말고 다른 근거 있는 방법을 선택하세요.';
  const checkpoint = goalStallCheckpoint(goalObj, nextAction);
  const goalBanner = document.getElementById('goalModeBanner');
  if (goalBanner) goalBanner.hidden = true;
  const goalPill = document.getElementById('btnGoalToggle');
  if (goalPill && !goalModeEnabled) goalPill.classList.remove('active');
  const card = createAssistantContainer({ timing: false });
  timeline.appendChild(card.row);
  const msg = document.createElement('div');
  msg.className = 'text-body';
  const firstSeen = checkpoint.blockerFirstSeenAt ? `최초 차단 ${checkpoint.blockerFirstSeenAt}` : '차단 시각 미기록';
  const lastProgress = checkpoint.lastSubstantiveProgressAt ? `마지막 진전 ${checkpoint.lastSubstantiveProgressAt}` : '진전 시각 미기록';
  msg.textContent = `🎯 [Goal 미완료 · ${status}] ${reason} · ${firstSeen} · ${lastProgress} · 다음 조치: ${nextAction}`;
  card.content.appendChild(msg);
  timeline.scrollTop = timeline.scrollHeight;
  setGeneratingState(false);
}

async function startGoalMode(goalPrompt, durationMs, fixedDuration = false) {
  if (activeGoal) {
    cancelActiveGoal('새로운 목표가 시작되어 이전 목표를 종료합니다.');
  }
  const deadline = Date.now() + durationMs;
  activeGoal = {
    goalPrompt,
    durationMs,
    deadline,
    fixedDuration,
    iteration: 1,
    timer: null,
    stallTimer: null,
    sessionId: currentSessionId,
    substantiveProgress: 0,
    lastSubstantiveProgressAt: Date.now(),
    blockerProgress: Object.create(null),
    blockedSteps: [],
    previousNoToolAnswer: ''
  };

  const goalBanner = document.getElementById('goalModeBanner');
  const goalModeText = document.getElementById('goalModeText');
  if (goalBanner) goalBanner.hidden = false;
  if (goalModeText) {
    const min = Math.max(1, Math.ceil(durationMs / 60_000));
    goalModeText.textContent = `🎯 Pursuing Goal · 목표 추구 중 (1회차 · 남은 시간 약 ${min}분)`;
  }
  const goalPill = document.getElementById('btnGoalToggle');
  if (goalPill) goalPill.classList.add('active');

  const fixedRules = fixedDuration
    ? ' 사용자가 지정한 전체 시간이 끝나기 전에는 GOAL_COMPLETE를 출력하거나 완료를 선언하지 마세요. 한 하위 작업이 막히면 GOAL_STEP_BLOCKED: <짧은 사유>를 출력하고 다음 반복에서 다른 안전한 하위 작업을 선택하세요. Goal 전체에 남은 안전한 작업이 없거나 전체 범위가 막혔을 때만 GOAL_BLOCKED: <짧은 사유와 다음 조치>로 종료하세요.'
    : ' 목표가 완전히 달성되면 마지막 줄에 GOAL_COMPLETE를 출력하세요. 더 이상 진행할 수 없거나 막히면 GOAL_BLOCKED: <사유>를 출력하세요.';

  const firstTurnPrompt = `[Goal 목표: ${goalPrompt}]\n${fixedRules}\n\n${goalPrompt}`;
  await runGoalIterationTurn(firstTurnPrompt);
}

async function runGoalIterationTurn(turnPrompt) {
  if (!activeGoal) return;
  if (goalStallExpired(activeGoal)) {
    reportIncompleteActiveGoal(`같은 근본 원인에서 60분 동안 검증된 진전이 없습니다: ${activeGoal.lastBlockerReason || '원인 미기록'}`, '60분 정체');
    return;
  }
  const currentIteration = activeGoal.iteration;

  if (currentIteration > 1) {
    appendUserMessage(`🎯 [Goal 반복 ${currentIteration}회차] 남은 시간 약 ${Math.max(1, Math.ceil((activeGoal.deadline - Date.now()) / 60000))}분`);
  }

  setGeneratingState(true);
  const assistantCard = createAssistantContainer({ timing: true });
  timeline.appendChild(assistantCard.row);
  const assistantTimer = startAssistantTimer(assistantCard);
  timeline.scrollTop = timeline.scrollHeight;

  const turnResult = await executeTurnCore({
    prompt: turnPrompt,
    assistantCard,
    assistantTimer,
    isGoalTurn: true
  });

  if (!activeGoal) return;

  if (turnResult.execution?.successfulMutatingTools > 0) {
    recordGoalProgress(activeGoal);
    scheduleGoalStallDeadline(activeGoal);
  }

  const responseText = turnResult.fullResponse || '';
  const isCompleted = !activeGoal.fixedDuration && (
    /^\s*GOAL_COMPLETE\s*$/m.test(responseText) ||
    /(?:goal\s+complete|all\s+(?:tasks|work)\s+(?:are\s+)?complete|목표.{0,12}완료|남은\s*작업.{0,12}없|모두\s*완료)/i.test(responseText)
  );

  const blockedMatch = /^\s*GOAL_BLOCKED(?:\s*:\s*(.+?))?\s*$/m.exec(responseText);
  const stepBlockedMatch = /^\s*GOAL_STEP_BLOCKED\s*:\s*(.+?)\s*$/m.exec(responseText);
  const noToolTurn = Number(turnResult.execution?.toolCalls || 0) === 0;
  const normalizedAnswer = responseText.trim().replace(/\s+/g, ' ').toLowerCase();

  if (isCompleted) {
    finishActiveGoal('목표가 완전히 달성되었습니다.');
  } else if (stepBlockedMatch) {
    const reason = stepBlockedMatch[1].trim() || '하위 작업이 진행 불가 상태입니다.';
    const recorded = recordGoalBlocker(activeGoal, reason);
    if (recorded.repeated) {
      reportIncompleteActiveGoal(`한 번의 변경된 재시도 뒤 같은 근본 원인이 다시 발생했습니다: ${reason}`, '차단 원인 재발');
    } else {
      scheduleGoalStallDeadline(activeGoal);
      activeGoal.blockedSteps.push(reason);
      appendTurnNotice(assistantCard, `하위 작업 보류 · ${reason}. 같은 경로를 반복하지 않고 다른 근거 있는 작업으로 이동합니다.`, 'warning');
      if (activeGoal.blockedSteps.length >= 5) {
        reportIncompleteActiveGoal(`서로 다른 하위 작업 5개가 막혔습니다. 최근 차단: ${reason}`, '진전 없음');
      } else {
        activeGoal.iteration++;
        const remainingMin = Math.max(1, Math.ceil((activeGoal.deadline - Date.now()) / 60000));
        const nextPrompt = `계속 같은 Goal을 진행하세요. 남은 시간 약 ${remainingMin}분입니다. 이미 막힌 하위 작업은 반복하지 마세요: ${activeGoal.blockedSteps.slice(-8).join(' | ')}. 같은 근본 원인이 다시 나오면 즉시 중단하고 원인과 다른 근거 있는 다음 조치를 기록하세요. 목표: ${activeGoal.goalPrompt}`;
        const goalModeText = document.getElementById('goalModeText');
        if (goalModeText) goalModeText.textContent = `🎯 목표 추구 중 (${activeGoal.iteration}회차) · 차단 경로 제외: ${reason}`;
        activeGoal.timer = setTimeout(() => { if (activeGoal) void runGoalIterationTurn(nextPrompt); }, 1500);
      }
    }
  } else if (blockedMatch) {
    const reason = (blockedMatch[1] || '사유 미제시').trim();
    recordGoalBlocker(activeGoal, reason);
    reportIncompleteActiveGoal(`목표 진행이 차단되었습니다: ${reason}`, '차단');
  } else if (Date.now() >= activeGoal.deadline) {
    reportIncompleteActiveGoal(`지정된 시간(${Math.round(activeGoal.durationMs / 60000)}분)이 만료됐지만 Goal 완료가 확인되지 않았습니다.`, '시간 제한');
  } else if (noToolTurn && normalizedAnswer && normalizedAnswer === activeGoal.previousNoToolAnswer) {
    const reason = '도구 실행이나 검증된 변경 없이 같은 응답이 반복되었습니다.';
    recordGoalBlocker(activeGoal, reason);
    reportIncompleteActiveGoal(reason, '진전 없음');
  } else if (!turnResult.ok) {
    if (turnResult.error && turnResult.error.name === 'AbortError') {
      cancelActiveGoal('사용자가 작업을 중단했습니다.');
    } else {
      activeGoal.consecutiveErrors = (activeGoal.consecutiveErrors || 0) + 1;
      const errorReason = turnResult.error?.message || '실행 오류';
      const recorded = recordGoalBlocker(activeGoal, errorReason);
      if (recorded.repeated || activeGoal.consecutiveErrors >= 2) {
        reportIncompleteActiveGoal(`변경된 재시도 후에도 오류가 반복됐습니다: ${errorReason}`, '오류 반복');
      } else {
        scheduleGoalStallDeadline(activeGoal);
        const retryDelay = activeGoal.consecutiveErrors * 4000;
        appendTurnNotice(assistantCard, `⚠️ 실행 오류 발생. 같은 명령을 그대로 반복하지 않고 원인을 확인하는 다른 경로로 한 번 재시도합니다. ${retryDelay / 1000}초 후 재개합니다.`, 'warning');
        activeGoal.timer = setTimeout(() => {
          if (activeGoal) void runGoalIterationTurn(`${turnPrompt}\n\n직전 오류: ${errorReason}. 같은 명령이나 경로를 그대로 반복하지 말고, 먼저 원인을 확인한 뒤 다른 근거 있는 안전한 조치를 선택하세요.`);
        }, retryDelay);
      }
    }
  } else {
    activeGoal.consecutiveErrors = 0;
    activeGoal.previousNoToolAnswer = noToolTurn ? normalizedAnswer : '';
    activeGoal.iteration++;
    const remainingMin = Math.max(1, Math.ceil((activeGoal.deadline - Date.now()) / 60000));
    const goalModeText = document.getElementById('goalModeText');
    if (goalModeText) {
      goalModeText.textContent = `🎯 Pursuing Goal · 목표 추구 중 (${activeGoal.iteration}회차 · 남은 시간 약 ${remainingMin}분)`;
    }
    const blockedContext = activeGoal.blockedSteps.length ? ` 이미 막힌 하위 작업(반복 금지): ${activeGoal.blockedSteps.slice(-8).join(' | ')}.` : '';
    const nextPrompt = `계속 같은 Goal을 진행하세요. 남은 시간은 약 ${remainingMin}분입니다. 직전 결과와 남은 작업을 확인하고, 이미 끝난 일을 반복하지 말고 다음의 가장 작은 안전한 단계를 실행하세요.${blockedContext} 목표: ${activeGoal.goalPrompt}`;
    activeGoal.timer = setTimeout(() => {
      if (activeGoal) void runGoalIterationTurn(nextPrompt);
    }, 1500);
  }
}

async function executeTurnCore({
  prompt,
  assistantCard,
  assistantTimer,
  submittedFromCodexQueue = false,
  codexQueueFingerprint = '',
  fullAccessForTurn = fullAccessEnabled,
  isGoalTurn = false
}) {
  const turnAbortController = new AbortController();
  currentAbortController = turnAbortController;
  activeAssistantCard = assistantCard;
  let fullResponse = '';
  let turnOk = false;
  let turnError = null;
  let toolCalls = 0;
  let successfulMutatingTools = 0;
  const mutatingGoalTools = new Set(['edit_file', 'write_file', 'file_change', 'create_file', 'delete_file', 'workspace_file_edit', 'workspace_file_create']);

  try {
    const isTurbo = activeApprovalPolicy === 'never';
    const effectiveFullAccess = isTurbo || fullAccessForTurn === true;
    const res = await fetch('/api/turn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: currentSessionId,
        prompt,
        reasoningEffort: selectedReasoningEffort,
        modelSelection: selectedModelId,
        overrideTierId: activeTier?.id,
        managerMode: managerModeToggle?.checked === true,
        sandboxPolicy: 'workspace-write',
        fullAccess: effectiveFullAccess
      }),
      signal: turnAbortController.signal
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      if (error.schedule) renderModelSwitchSchedule(error.schedule);
      throw new Error(error.error || `요청 실패 (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.replace('data: ', '').trim();
        if (jsonStr === '[DONE]') break;

        try {
          const event = JSON.parse(jsonStr);
          if (event.type === 'message_delta' && typeof event.delta === 'string') {
            fullResponse += event.delta;
          } else if (event.type === 'turn_complete' && event.summary?.response?.content) {
            fullResponse = event.summary.response.content;
          } else if (event.type === 'turn_error') {
            turnError = new Error(event.message || event.error || event.category || '턴 실행 중 오류가 발생했습니다.');
            if (assistantCard) assistantCard.workOutcome = 'error';
          } else if (event.type === 'tool_start') {
            toolCalls++;
          } else if (event.type === 'tool_end') {
            const detail = event.result || {};
            const toolResult = detail.result || {};
            const call = detail.call || event.call || {};
            const commandResultUnknown = call.name === 'exec_command' && !Number.isInteger(toolResult.exitCode);
            const failed = Boolean(toolResult.error) || toolResult.ok === false || toolResult.blocked === true
              || commandResultUnknown || (Number.isInteger(toolResult.exitCode) && toolResult.exitCode !== 0);
            if (!failed && mutatingGoalTools.has(call.name)) successfulMutatingTools++;
          }
          handleStreamEvent(event, assistantCard);
        } catch (_) {}
      }
    }

    await refreshPriorityStatus();
    await loadSessions();
    if (!turnError) {
      turnOk = true;
    }

  } catch (err) {
    turnError = err;
    const goalCircuitAbort = err.name === 'AbortError' && turnAbortController === goalCircuitAbortController;
    if (goalCircuitAbort) goalCircuitAbortController = null;
    assistantCard.workOutcome = goalCircuitAbort ? 'stopped' : err.name === 'AbortError' ? 'aborted' : 'error';
    if (!goalCircuitAbort) {
      appendTurnNotice(assistantCard, err.name === 'AbortError'
        ? '⏹ 사용자에 의해 작업이 중단되었습니다.'
        : `❌ 요청 실패: ${err.message}`, err.name === 'AbortError' ? 'warning' : 'error');
    }
    const queueFailureNotice = getCodexQueueSendFailureNotice(submittedFromCodexQueue);
    const composerStatus = document.getElementById('composerStatus');
    if (queueFailureNotice && composerStatus) composerStatus.textContent = queueFailureNotice;
  } finally {
    clearCurrentAbortControllerIfSame(turnAbortController);
    if (codexQueueFingerprint) {
      setCodexQueueItemSendState(codexQueueFingerprint, getCodexQueueSendStateAfterTurn(assistantCard.workOutcome));
      renderCodexQueueInbox(codexQueueInboxItems);
    }
    activeAssistantCard = null;
    finishAssistantMessage(assistantCard);
    assistantTimer.finish();
    finishAssistantWork(assistantCard, assistantCard.workOutcome || 'complete');
    activeSendInFlight = false;
    if (!activeGoal) setGeneratingState(false);
    applyPendingUiMorphReloadWhenSafe();
  }
  return { ok: turnOk, fullResponse, error: turnError, execution: { toolCalls, successfulMutatingTools } };
}

function clearCurrentAbortControllerIfSame(turnAbortController) {
  if (currentAbortController === turnAbortController) currentAbortController = null;
}

function abortActiveTurn() {
  if (activeGoal) {
    cancelActiveGoal('사용자가 작업을 중단했습니다.');
  }
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  setGeneratingState(false);
  applyPendingUiMorphReloadWhenSafe();
}

function handleComposerKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  if (isRecording) { stopSpeechMemo(); return; }
  if (speechTranscribing) return;
  if (!isGenerating) handleSend();
}

function setGeneratingState(generating) {
  isGenerating = generating;
  const iconSend = btnSend.querySelector('.icon-send');
  const iconStop = btnSend.querySelector('.icon-stop');

  if (generating) {
    iconSend.style.display = 'none';
    iconStop.style.display = 'block';
    btnSend.title = '작업 중단 (Stop)';
  } else {
    iconSend.style.display = 'block';
    iconStop.style.display = 'none';
    btnSend.title = '채팅 전송 (Send)';
  }

  if (!generating && !activeSendInFlight && pendingSpeechAutoSendPrompt && !speechTranscribing) {
    queueMicrotask(flushPendingSpeechAutoSend);
  }
}

function flushPendingSpeechAutoSend() {
  const expectedPrompt = pendingSpeechAutoSendPrompt;
  if (!expectedPrompt || speechTranscribing || isGenerating || activeSendInFlight) return;
  if (composerInput.value.trim() !== expectedPrompt) {
    pendingSpeechAutoSendPrompt = null;
    const status = document.getElementById('voiceCaptureStatus');
    status.textContent = '작성 내용이 바뀌어 음성 자동 전송을 취소했습니다. 전사 문장은 작성창에 남아 있습니다.';
    status.hidden = false;
    return;
  }
  pendingSpeechAutoSendPrompt = null;
  void handleSend().then(accepted => {
    if (accepted) {
      const status = document.getElementById('voiceCaptureStatus');
      status.textContent = '';
      status.hidden = true;
    }
  });
}

function appendUserMessage(text) {
  const row = document.createElement('div');
  row.className = 'message-row user';
  row.innerHTML = `
    <div class="bubble">${escapeHtml(text)}</div>
  `;
  timeline.appendChild(row);
  timeline.scrollTop = timeline.scrollHeight;
}

// Assistant Peach Card (Ref 1)
function createAssistantContainer(options = {}) {
  const row = document.createElement('div');
  row.className = 'message-row assistant';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = `
    ${options.timing ? '<details class="assistant-work-details assistant-turn-progress" open><summary class="assistant-work-summary"><span class="assistant-turn-meta" role="timer" aria-label="응답 경과 시간" aria-live="off">작업 중 · 0초</span><span class="assistant-work-summary-label">요청 준비 중</span></summary><div class="assistant-work-panel"><div class="assistant-work-status" role="status" aria-live="polite">요청을 분석하고 있습니다…</div><div class="assistant-work-steps"></div></div></details>' : ''}
    <div class="assistant-content"></div>
    <div class="assistant-actions-bar">
      <button class="show-more-btn" onclick="toggleAssistantMore(this)">Show more <span>⌄</span></button>
      <button class="copy-btn" title="복사" onclick="copyAssistantText(this)">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      </button>
    </div>
  `;

  row.appendChild(bubble);
  return {
    row,
    bubble,
    content: bubble.querySelector('.assistant-content'),
    timerNode: bubble.querySelector('.assistant-turn-meta'),
    workStatusNode: bubble.querySelector('.assistant-work-status'),
    workDetails: bubble.querySelector('.assistant-work-details'),
    workSummaryNode: bubble.querySelector('.assistant-work-summary'),
    workSummaryLabelNode: bubble.querySelector('.assistant-work-summary-label'),
    workStepsNode: bubble.querySelector('.assistant-work-steps'),
    workStepCount: 0,
    currentWorkStep: null,
    workOutcome: 'complete',
    messageNode: null,
    messageText: ''
  };
}

function startAssistantTimer(card) {
  const startedAt = performance.now();
  let intervalId = null;
  const elapsed = () => window.OnlyChatPresentation?.formatElapsed
    ? window.OnlyChatPresentation.formatElapsed(performance.now() - startedAt)
    : `${Math.max(0, Math.ceil((performance.now() - startedAt) / 1000))}초`;
  const update = () => {
    if (card.timerNode) card.timerNode.textContent = `작업 중 · ${elapsed()}`;
  };
  update();
  if (card.timerNode) intervalId = window.setInterval(update, 1000);
  let finished = false;
  return {
    finish() {
      if (finished) return;
      finished = true;
      if (intervalId !== null) window.clearInterval(intervalId);
      if (card.timerNode) {
        card.timerNode.textContent = `작업 시간 · ${elapsed()}`;
        card.timerNode.dataset.state = 'complete';
        card.timerNode.setAttribute('aria-label', `응답 완료, 작업 시간 ${card.timerNode.textContent.replace('작업 시간 · ', '')}`);
        card.timerNode.setAttribute('aria-live', 'polite');
      }
    }
  };
}

function finishAssistantMessage(card) {
  if (!card?.messageNode) return;
  if (!window.OnlyChatPresentation?.renderMarkdown) {
    card.messageNode.textContent = card.messageText;
    card.messageNode.classList.add('assistant-answer');
    return;
  }
  card.messageNode.innerHTML = window.OnlyChatPresentation.renderMarkdown(card.messageText);
  card.messageNode.classList.add('assistant-answer');
}

function watchDelegatedTasks(delegation, card) {
  const tasks = Array.isArray(delegation?.tasks) ? delegation.tasks.filter(task => task && typeof task.id === 'string') : [];
  if (!tasks.length || !card?.content) return;
  const panel = document.createElement('section');
  panel.className = 'assistant-turn-notice';
  const heading = document.createElement('strong');
  heading.textContent = `실행자 작업 · ${tasks.length}건`;
  const list = document.createElement('div');
  list.setAttribute('aria-live', 'polite');
  panel.append(heading, list);
  card.content.appendChild(panel);
  const terminal = new Set(['completed', 'blocked', 'failed']);
  let attempts = 0;
  let timer = null;
  let refreshInFlight = false;
  const refresh = async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    attempts += 1;
    try {
      let known = [];
      if (typeof delegation.registryTaskKey === 'string') {
        const response = await fetch(`/api/task-registry/tasks/${encodeURIComponent(delegation.registryTaskKey)}`);
        if (response.ok) {
          const saved = await response.json();
          known = Array.isArray(saved.task?.executionProgress) ? saved.task.executionProgress : [];
        }
      }
      if (!known.length) {
        const response = await fetch('/api/dispatcher');
        if (!response.ok) throw new Error('작업 상태를 읽지 못했습니다.');
        const snapshot = await response.json();
        known = [...(snapshot.queue || []), ...(snapshot.activeWorkers || []).map(worker => worker.task).filter(Boolean), ...(snapshot.completedTasks || []), ...(snapshot.terminalTasks || [])];
      }
      const rows = tasks.map(original => known.find(item => item?.id === original.id) || original);
      const contentSignature = JSON.stringify(rows.map(task => [task.id, task.title, task.status, task.blockReason, task.reason, task.error, task.executionEvidence, task.pendingApproval, task.result]));
      if (list.dataset.contentSignature !== contentSignature) {
        list.dataset.contentSignature = contentSignature;
        list.replaceChildren(...rows.map(task => {
        const row = document.createElement('div');
        const status = task.status || 'queued';
        row.textContent = `${task.title || originalTitle(task.id)} · ${status}${task.blockReason || task.reason ? ` · ${task.blockReason || task.reason}` : ''}${task.error ? ` · ${task.error}` : ''}`;
        const executionEvidence = formatExecutionEvidence(task.executionEvidence, task.requireToolExecution !== false);
        if (executionEvidence) {
          const evidenceNode = document.createElement('small');
          evidenceNode.className = 'assistant-task-execution-evidence';
          evidenceNode.textContent = executionEvidence;
          row.appendChild(evidenceNode);
        }
        if (task.pendingApproval?.requestId) {
          const approval = task.pendingApproval;
          const panel = document.createElement('section');
          panel.className = 'assistant-tool-approval';
          const title = document.createElement('strong');
          title.textContent = `도구 실행 승인 필요 · ${approval.name || '도구'}`;
          const args = document.createElement('pre');
          args.textContent = JSON.stringify(approval.args || {}, null, 2);
          const statusMessage = document.createElement('small');
          statusMessage.setAttribute('aria-live', 'polite');
          const controls = document.createElement('div');
          for (const decision of ['approve', 'reject']) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = decision === 'approve' ? '승인하고 실행' : '거절';
            button.setAttribute('aria-label', `${task.title || '실행자 작업'} 도구 ${decision === 'approve' ? '승인하고 실행' : '거절'}`);
            button.addEventListener('click', async () => {
              button.disabled = true;
              statusMessage.textContent = '응답 전송 중…';
              try {
                const response = await fetch('/api/dispatcher/approval', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ taskId: task.id, requestId: approval.requestId, sessionId: approval.sessionId, decision })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || '승인 응답을 저장하지 못했습니다.');
                statusMessage.textContent = decision === 'approve' ? '승인됨 · 도구를 실행합니다.' : '거절됨 · 도구를 실행하지 않았습니다.';
              } catch (error) {
                statusMessage.textContent = error.message;
                button.disabled = false;
              }
            });
            controls.appendChild(button);
          }
          panel.append(title, args, controls, statusMessage);
          row.appendChild(panel);
        }
        if (typeof task.result === 'string' && task.result) {
          const result = document.createElement('pre');
          result.textContent = task.result.slice(0, 1600);
          row.appendChild(result);
        }
          return row;
        }));
      }
      if (rows.every(task => terminal.has(task.status)) || attempts >= 600) {
        if (timer) clearInterval(timer);
        timer = null;
        if (attempts >= 600 && !rows.every(task => terminal.has(task.status))) {
          const notice = document.createElement('div');
          notice.textContent = '상태 확인을 멈췄습니다. Only Chat 작업 대기열에서 이어서 확인할 수 있습니다.';
          list.appendChild(notice);
        }
      }
    } catch (error) {
      if (attempts === 1 || attempts >= 600) {
        const notice = document.createElement('div');
        notice.textContent = attempts >= 600
          ? '작업 상태를 600회 확인했지만 완료 상태를 확인하지 못해 자동 확인을 멈췄습니다. Only Chat 작업 대기열을 열어 직접 확인해 주세요.'
          : `${error.message} · 잠시 후 다시 확인합니다.`;
        list.appendChild(notice);
      }
      if (attempts >= 600 && timer) { clearInterval(timer); timer = null; }
    } finally {
      refreshInFlight = false;
    }
  };
  void refresh();
  timer = setInterval(() => void refresh(), 1500);
}

function formatExecutionEvidence(evidence, required = true) {
  if (!evidence || typeof evidence !== 'object') return required ? '도구 실행 증거 없음' : '';
  const count = value => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  const safe = value => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80)
    : '';
  const route = [evidence.provider, evidence.model, evidence.tierId].map(safe).filter(Boolean).join(' / ');
  const tools = Array.isArray(evidence.toolNames)
    ? [...new Set(evidence.toolNames.map(safe).filter(Boolean))].slice(0, 5)
    : [];
  const inspectionOnly = tools.length > 0 && tools.every(name => ['read_file', 'list_files', 'search_files'].includes(name));
  const scope = inspectionOnly ? ' · 파일 열람만 확인됨 (테스트/설치 UI 검증 아님)' : '';
  return `도구 ${count(evidence.attemptedCount)}회 · 성공 ${count(evidence.successfulCount)} · 실패 ${count(evidence.failedCount)}${route ? ` · ${route}` : ''}${tools.length ? ` · 사용 도구: ${tools.join(', ')}` : ''}${scope}`;
}

function originalTitle(id) {
  return `실행자 작업 ${String(id || '').slice(0, 20)}`;
}

function appendTurnNotice(card, text, kind) {
  const notice = document.createElement('div');
  notice.className = `assistant-turn-notice ${kind || ''}`;
  notice.textContent = text;
  card.content.appendChild(notice);
  if (kind === 'error') card.content.appendChild(createDeveloperFeedbackButton('채팅 요청', text));
}

function safeFeedbackError(value) {
  return String(value || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, '[인증 정보 숨김]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, '[토큰 숨김]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 숨김]')
    .replace(/(?:\/Users\/|[A-Z]:\\Users\\)[^/\\\s]+/g, '~')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim().slice(0, 500);
}

function createDeveloperFeedbackButton(source, errorText) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'developer-feedback-btn';
  button.textContent = '개발자에게 피드백 보내기';
  button.title = '대화·첨부·음성은 포함하지 않습니다. 오류 정보가 담긴 메일 초안을 열어 직접 확인 후 보냅니다.';
  button.addEventListener('click', () => { void openDeveloperFeedback(button, source, errorText); });
  return button;
}

function setVoiceFeedbackError(errorText) {
  const button = document.getElementById('btnVoiceFeedback');
  button.dataset.error = errorText;
  button.disabled = false;
  button.textContent = '개발자에게 피드백 보내기';
  button.hidden = false;
}

async function openDeveloperFeedback(button, source, errorText) {
  if (button.disabled) return;
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = '메일 초안 여는 중…';
  try {
    const response = await fetch('/api/feedback/developer-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, error: safeFeedbackError(errorText) })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw new Error(result.error || `메일 초안을 열지 못했습니다 (${response.status})`);
    button.textContent = '메일 초안을 열었습니다 · 확인 후 보내기';
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    showMorphToast(`피드백 메일 초안을 열지 못했습니다: ${error.message}`);
  }
}

function setAssistantWorkStatus(card, text) {
  if (card?.workStatusNode && text) card.workStatusNode.textContent = text;
}

function ensureAssistantWorkDetails(card) {
  if (card.workDetails) return card.workDetails;
  const details = document.createElement('details');
  details.className = 'assistant-work-details';
  details.open = true;
  const summary = document.createElement('summary');
  summary.className = 'assistant-work-summary';
  summary.textContent = '작업 과정 · 0단계 · 진행 중';
  const steps = document.createElement('div');
  steps.className = 'assistant-work-steps';
  details.appendChild(summary);
  details.appendChild(steps);
  card.content.insertBefore(details, card.content.firstChild);
  card.workDetails = details;
  card.workSummaryNode = summary;
  card.workSummaryLabelNode = null;
  card.workStepsNode = steps;
  return details;
}

function setAssistantWorkSummary(card, text) {
  if (card?.workSummaryLabelNode) card.workSummaryLabelNode.textContent = text;
  else if (card?.workSummaryNode) card.workSummaryNode.textContent = text;
}

function toolDisplayName(name) {
  const labels = {
    exec_command: '명령 실행', file_change: '파일 변경', read_file: '파일 읽기',
    list_files: '파일 목록 확인', search_files: '코드 검색', codex_cli_workspace_write_scope: 'Codex 요청 실행 범위 승인', browser_open: '브라우저 열기',
    browser_read: '브라우저 내용 읽기', browser_act: '브라우저 조작'
  };
  return labels[name] || String(name || '도구 실행');
}

function finishAssistantWork(card, outcome = 'complete') {
  if (!card) return;
  const labels = { complete: '완료', error: '오류', aborted: '중단' };
  const label = labels[outcome] || labels.complete;
  if (card.workSummaryNode) {
    setAssistantWorkSummary(card, `작업 과정 · ${card.workStepCount}단계 · ${label}`);
    card.workDetails.open = false;
  }
  setAssistantWorkStatus(card, outcome === 'complete' ? '응답 완료' : outcome === 'aborted' ? '작업이 중단되었습니다' : '작업 중 오류가 발생했습니다');
}

function handleStreamEvent(event, card) {
  switch (event.type) {
    case 'session_started': {
      if (event.clientSessionId === currentSessionId
        && typeof event.sessionId === 'string' && /^ses_[a-f0-9]{16}$/.test(event.sessionId)) {
        const clientSessionId = currentSessionId;
        currentSessionId = event.sessionId;
        const inheritedMode = typeof fullAccessSessionModes !== 'undefined' ? fullAccessSessionModes[clientSessionId] : undefined;
        if (typeof inheritedMode === 'boolean') {
          if (typeof fullAccessEnabled !== 'undefined') fullAccessEnabled = inheritedMode;
          if (typeof fullAccessSessionModes !== 'undefined') delete fullAccessSessionModes[clientSessionId];
          if (typeof persistFullAccessSessionMode === 'function') persistFullAccessSessionMode(event.sessionId);
          if (typeof renderFullAccessToggle === 'function') renderFullAccessToggle();
        }
        currentCodexThreadId = null;
        void refreshModelSwitchSchedule();
      }
      break;
    }
    case 'model_switch_schedule_applied':
      if (event.schedule?.targetModel) {
        selectedModelId = event.schedule.targetModel;
        selectedReasoningEffort = normalizeUiReasoningEffort(event.schedule.targetEffort);
        localStorage.setItem(MODEL_SELECTION_KEY, selectedModelId);
        localStorage.setItem(REASONING_EFFORT_KEY, selectedReasoningEffort);
        renderActiveModelSelection();
        selectReasoningEffort(selectedReasoningEffort);
      }
      renderModelSwitchSchedule(event.schedule);
      break;
    case 'manager_delegated':
      watchDelegatedTasks(event.delegation, card);
      break;
    case 'tier_resolved': {
      activeTier = event.tier || null;
      setAssistantWorkStatus(card, '실행 계정을 확인하고 있습니다…');
      renderActiveModelSelection();
      void refreshPriorityStatus();
      break;
    }
    case 'error': {
      card.workOutcome = 'error';
      setAssistantWorkStatus(card, '응답을 완료하지 못했습니다');
      const failure = document.createElement('div');
      failure.className = 'text-body';
      const categories = {
        quota_rate_limit: '사용 한도 또는 요청 속도 제한',
        authentication: '계정 인증 필요',
        model_unavailable: '모델을 사용할 수 없음',
        sandbox_permission_blocked: '샌드박스 또는 권한 차단',
        approval_required: '추가 작업 경로 승인 필요',
        approval_denied: '추가 작업 경로 승인 거부됨',
        network_unavailable: '네트워크 연결 불가',
        provider_failure: '제공자 오류'
      };
      const nextSteps = {
        quota_rate_limit: '한도 상태를 확인한 뒤 다시 시도하거나 다른 연결 계정을 선택해 주세요.',
        authentication: '계정 인증이 풀렸습니다. 설정의 계정 목록에서 해당 Codex 계정을 선택하고 “다시 로그인”을 눌러 인증한 뒤 재시도해 주세요.',
        model_unavailable: '현재 연결된 계정에서 사용할 수 있는 모델을 선택해 주세요.',
        sandbox_permission_blocked: '작업공간 경로와 실행 권한을 확인하고, 필요한 권한만 승인해 주세요.',
        approval_required: '표시된 도구 승인 요청을 확인해 주세요.',
        approval_denied: '도구 승인 상태를 확인한 뒤 필요한 경우 요청을 다시 시작해 주세요.',
        network_unavailable: '네트워크 연결을 확인한 뒤 다시 시도해 주세요.',
        provider_failure: '잠시 후 다시 시도하거나 다른 연결 계정을 선택해 주세요.'
      };
      const category = categories[event.category];
      const model = typeof event.model === 'string' && /^[A-Za-z0-9._+:/ -]{1,80}$/.test(event.model) ? event.model : '';
      const rank = Number.isSafeInteger(event.rank) && event.rank > 0 ? event.rank : null;
      const attempt = [rank ? `시도한 순위: ${rank}순위` : '', model ? `시도한 모델: ${model}` : ''].filter(Boolean).join(' · ');
      const detail = category ? `실패 유형: ${category}${attempt ? ` · ${attempt}` : ''}\n${nextSteps[event.category]}` : '서버에서 안전한 오류 분류를 전달하지 않았습니다.';
      failure.textContent = `❌ AI 응답을 받지 못했습니다.\n${detail}\n응답이 없었으므로 작업이 완료된 것으로 간주하지 마세요.`;
      card.content.appendChild(failure);
      if (event.category === 'authentication') {
        const reauthButton = document.createElement('button');
        reauthButton.type = 'button';
        reauthButton.className = 'codex-reauth-inline';
        reauthButton.textContent = 'Codex 계정 다시 로그인';
        reauthButton.addEventListener('click', async () => {
          await refreshPriorityStatus();
          openCodexReauth();
        });
        card.content.appendChild(reauthButton);
        void refreshPriorityStatus();
      }
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    case 'reasoning_delta': {
      // Keep private model reasoning out of the transcript; show only a user-facing stage.
      setAssistantWorkStatus(card, '요청을 분석하고 있습니다…');
      break;
    }

    case 'message_delta': {
      setAssistantWorkStatus(card, '응답을 작성하고 있습니다…');
      let msg = card.content.querySelector('.text-body');
      if (!msg) {
        msg = document.createElement('div');
        msg.className = 'text-body';
        card.content.appendChild(msg);
      }
      if (!card.messageNode) {
        card.messageNode = document.createElement('div');
        card.messageNode.style.cssText = 'margin-top: 4px; white-space: pre-wrap;';
        msg.appendChild(card.messageNode);
      }
      card.messageText += String(event.delta || '');
      card.messageNode.textContent = card.messageText;
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    case 'tool_start': {
      const details = ensureAssistantWorkDetails(card);
      const call = event.call || {};
      const args = call.args || {};
      const detail = call.name === 'exec_command' ? String(args.command || '')
        : call.name === 'file_change' ? `${args.change || 'updated'} · ${args.path || ''}` : '';
      const step = document.createElement('div');
      step.className = 'assistant-work-step';
      if (call.id) step.dataset.toolCallId = String(call.id);
      const heading = document.createElement('div');
      heading.className = 'assistant-work-step-heading';
      const name = document.createElement('strong');
      name.textContent = toolDisplayName(call.name);
      const state = document.createElement('span');
      state.className = 'assistant-work-step-state';
      state.textContent = '실행 중';
      heading.append(name, state);
      step.appendChild(heading);
      if (detail) {
        const code = document.createElement('code');
        code.textContent = detail.slice(0, 240);
        step.appendChild(code);
      }
      const output = document.createElement('div');
      output.className = 'assistant-work-step-output';
      step.appendChild(output);
      details.open = true;
      card.workStepsNode.appendChild(step);
      card.currentWorkStep = step;
      card.workStepCount += 1;
      setAssistantWorkSummary(card, `작업 과정 · ${card.workStepCount}단계 · 진행 중`);
      setAssistantWorkStatus(card, `${toolDisplayName(call.name)} 중…`);
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    case 'tool_approval_required': {
      const panel = document.createElement('section');
      panel.className = 'assistant-tool-approval';
      panel.setAttribute('role', 'group');
      panel.setAttribute('aria-label', `승인 요청 · ${toolDisplayName(event.name)}`);
      const heading = document.createElement('strong');
      heading.setAttribute('role', 'status');
      heading.setAttribute('aria-live', 'polite');
      heading.tabIndex = -1;
      heading.textContent = `실행 허용 여부 · ${toolDisplayName(event.name)}`;
      const summary = document.createElement('pre');
      summary.textContent = JSON.stringify(event.args || {}, null, 2).slice(0, 4000);
      const scopeNote = document.createElement('small');
      scopeNote.textContent = event.scopeRequiresExplicit
        ? 'Full access는 이 요청에서만 적용되며 매번 별도로 확인합니다.'
        : '항상 허용은 이 대화가 끝날 때까지 유지됩니다. 터보는 이 대화의 모든 도구 승인 질문을 건너뜁니다.';
      const approve = document.createElement('button');
      approve.type = 'button'; approve.textContent = '이번 요청 허용';
      approve.setAttribute('aria-label', `${toolDisplayName(event.name)} 이번 요청만 허용`);
      const allowTool = document.createElement('button');
      allowTool.type = 'button'; allowTool.textContent = '이 도구 항상 허용';
      allowTool.disabled = event.scopeRequiresExplicit === true;
      allowTool.title = allowTool.disabled ? 'Full access 요청은 매번 별도로 확인합니다.' : '현재 대화가 끝날 때까지 이 도구를 허용합니다.';
      const turbo = document.createElement('button');
      turbo.type = 'button'; turbo.textContent = '터보 · 이 대화에서 항상 허용';
      turbo.disabled = event.scopeRequiresExplicit === true;
      turbo.title = '현재 대화가 끝날 때까지 모든 앱 도구 승인 질문을 건너뜁니다.';
      const reject = document.createElement('button');
      reject.type = 'button'; reject.textContent = '거절';
      reject.setAttribute('aria-label', `${toolDisplayName(event.name)} 거절`);
      const decide = async decision => {
        if (decision === 'turbo' && !window.confirm('이 대화가 끝날 때까지 모든 앱 도구 승인 질문을 건너뜁니다. 35Closer와 macOS 보안 확인은 별도로 유지됩니다. 계속할까요?')) return;
        approve.disabled = allowTool.disabled = turbo.disabled = reject.disabled = true;
        try {
          const response = await fetch('/api/tool-approval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: event.requestId, sessionId: event.sessionId, decision }) });
          if (!response.ok) throw new Error('승인 요청이 만료되었거나 세션이 변경되었습니다.');
          heading.textContent = decision === 'approve' ? '허용됨 · 이번 요청만 실행합니다'
            : decision === 'allow_tool' ? '항상 허용됨 · 이 대화에서 이 도구만 허용합니다'
              : decision === 'turbo' ? '터보 허용됨 · 이 대화의 앱 도구 질문을 건너뜁니다'
                : '거절됨 · 호출을 건너뜁니다';
        } catch (error) { heading.textContent = error.message; }
        approve.remove(); allowTool.remove(); turbo.remove(); reject.remove(); scopeNote.remove();
        heading.focus();
      };
      approve.addEventListener('click', () => void decide('approve'));
      allowTool.addEventListener('click', () => void decide('allow_tool'));
      turbo.addEventListener('click', () => void decide('turbo'));
      reject.addEventListener('click', () => void decide('reject'));
      panel.append(heading, summary, scopeNote, approve, allowTool, turbo, reject);
      card.content.appendChild(panel);
      setAssistantWorkStatus(card, '도구 실행 전 사용자 승인을 기다리고 있습니다…');
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    case 'tool_output': {
      const output = String(event.text || '').trim();
      if (!output) break;
      const step = card.currentWorkStep;
      const outputNode = step?.querySelector('.assistant-work-step-output');
      if (outputNode) {
        const block = document.createElement('pre');
        block.textContent = output.slice(-4000);
        outputNode.appendChild(block);
      }
      setAssistantWorkStatus(card, '작업 결과를 확인하고 있습니다…');
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    case 'tool_end': {
      const detail = event.result || {};
      const result = detail.result || {};
      const call = detail.call || {};
      const commandResultUnknown = call.name === 'exec_command' && !Number.isInteger(result.exitCode);
      const failed = Boolean(result.error) || result.ok === false || result.blocked === true || commandResultUnknown || (Number.isInteger(result.exitCode) && result.exitCode !== 0);
      const step = call.id
        ? Array.from(card.workStepsNode?.querySelectorAll('[data-tool-call-id]') || []).find(node => node.dataset.toolCallId === String(call.id))
        : card.currentWorkStep;
      const state = step?.querySelector('.assistant-work-step-state');
      if (state) {
        state.textContent = commandResultUnknown ? '결과 확인 불가' : failed ? `실패${result.exitCode === undefined || result.exitCode === null ? '' : ` · 종료 코드 ${result.exitCode}`}` : '완료';
        state.dataset.state = failed ? 'error' : 'complete';
      }
      if (failed) card.workOutcome = 'error';
      card.currentWorkStep = null;
      setAssistantWorkStatus(card, failed ? '단계 실패 · 다음 결과를 확인 중입니다' : '다음 작업 단계를 준비하고 있습니다…');
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }
  }
}

window.toggleAssistantMore = function(btn) {
  const content = btn.closest('.bubble').querySelector('.assistant-content');
  if (content.style.maxHeight) {
    content.style.maxHeight = null;
    btn.innerHTML = 'Show more <span>⌄</span>';
  } else {
    content.style.maxHeight = 'none';
    btn.innerHTML = 'Show less <span>▴</span>';
  }
};

window.copyAssistantText = function(btn) {
  const text = btn.closest('.bubble').querySelector('.assistant-content').innerText;
  navigator.clipboard.writeText(text);
  btn.style.color = 'var(--accent-orange)';
  setTimeout(() => { btn.style.color = ''; }, 1200);
};

// ============================================================================
// Sessions & Navigation
// ============================================================================

function startNewSession() {
  if (activeGoal) {
    cancelActiveGoal('새 대화를 시작하여 이전 목표 추구를 중단했습니다.');
  }
  currentSessionId = `session_${Date.now()}`;
  if (typeof applyFullAccessModeForSession === 'function') applyFullAccessModeForSession(currentSessionId, true);
  currentCodexThreadId = null;
  void refreshPriorityStatus();
  timeline.innerHTML = '';
  if (emptyState) {
    timeline.appendChild(emptyState);
    emptyState.style.display = 'flex';
  }
  titlebarThreadTitle.textContent = 'Only Chat · 연결되는 작업실';
  composerInput.value = '';
  const composerStatus = document.getElementById('composerStatus');
  if (composerStatus) {
    composerStatus.textContent = '';
    if (composerStatus.dataset) delete composerStatus.dataset.codexQueueFingerprint;
  }
  composerInput.focus();
  applyPendingUiMorphReloadWhenSafe();
}

let currentFilter = 'all'; // 'all', 'codex', 'antigravity', 'internal'
let cachedUnifiedData = null;
let sessionSearchQuery = '';
let sessionSearchResults = null;
let sessionSearchRequestId = 0;
let sessionSearchTimer = null;
let sessionSearchAbortController = null;
let sessionsLoadRequestId = 0;
let sessionLoadRequestId = 0;
let sessionResumeQueue = Promise.resolve();
let sessionResumePendingCount = 0;
let sessionResumeOriginalComposerReadOnly = false;
let sessionResumeOriginalMicrophoneDisabled = false;
let sessionContextActionPending = false;
let codexQueueLoadInFlight = false;
const CODEX_QUEUE_SEND_STATES_KEY = 'onlychat.codexQueueSendStates.v1';
let codexQueueSendStatesMemory = {};
let codexQueueInboxItems = [];
const sessionContextMenu = document.getElementById('sessionContextMenu');
let sessionContextTarget = null;

function codexQueueItemFingerprint(item) {
  const value = `${item?.threadId || ''}\0${item?.id || ''}`;
  let first = 2166136261;
  let second = 2246822519;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 3266489917);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function getCodexQueueSendStates() {
  let persisted = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(CODEX_QUEUE_SEND_STATES_KEY) || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) persisted = parsed;
  } catch (_) {}
  return { ...persisted, ...codexQueueSendStatesMemory };
}

function getCodexQueueItemSendState(fingerprint) {
  const entry = getCodexQueueSendStates()[fingerprint];
  return entry && ['inflight', 'submitted', 'uncertain'].includes(entry.state) ? entry.state : '';
}

function isCodexQueueComposerProtected() {
  return Boolean(String(composerInput.value || '').trim() || currentAbortController || isRecording);
}

function getCodexQueueSendStateAfterTurn(workOutcome) {
  return workOutcome && workOutcome !== 'complete' ? 'uncertain' : 'submitted';
}

function setCodexQueueItemSendState(fingerprint, state) {
  if (typeof fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(fingerprint)
    || !['inflight', 'submitted', 'uncertain'].includes(state)) return;
  codexQueueSendStatesMemory[fingerprint] = { state, updatedAt: Date.now() };
  const entries = Object.entries(getCodexQueueSendStates()).sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0)).slice(0, 250);
  codexQueueSendStatesMemory = Object.fromEntries(entries);
  try { localStorage.setItem(CODEX_QUEUE_SEND_STATES_KEY, JSON.stringify(codexQueueSendStatesMemory)); } catch (_) {}
}

function clearCodexQueueItemSendState(fingerprint) {
  const states = getCodexQueueSendStates();
  delete states[fingerprint];
  codexQueueSendStatesMemory = states;
  try { localStorage.setItem(CODEX_QUEUE_SEND_STATES_KEY, JSON.stringify(states)); } catch (_) {}
}

function setDropTargetFeedback(target, active) {
  target.classList.toggle('drop-target-active', active);
  target.setAttribute('aria-dragover', String(active));
}

function attachSessionDropTarget(target, destination) {
  if (!target || !target.dataset || target.dataset.sessionDropReady === 'true') return;
  target.dataset.sessionDropReady = 'true';
  target.classList.add('session-drop-target');
  target.setAttribute('aria-label', destination.type === 'section'
    ? `${destination.section} 섹션에 내부 세션 놓기`
    : destination.type === 'pinned' ? 'Pinned에 내부 세션 놓기' : 'Recents에 내부 세션 놓기');
  target.setAttribute('aria-dropeffect', 'move');
  target.tabIndex = 0;
  target.addEventListener('dragover', event => {
    // dragover runs in DataTransfer's protected mode: only the type list is available.
    if (!hasInternalSessionDragTypeModel(event.dataTransfer)) {
      setDropTargetFeedback(target, false);
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    setDropTargetFeedback(target, true);
  });
  target.addEventListener('dragleave', event => {
    if (!target.contains(event.relatedTarget)) setDropTargetFeedback(target, false);
  });
  target.addEventListener('drop', async event => {
    event.preventDefault();
    setDropTargetFeedback(target, false);
    if (!hasInternalSessionDragTypeModel(event.dataTransfer)) return;
    const sessionId = event.dataTransfer?.getData('application/x-only-chat-session') || '';
    const session = cachedUnifiedData?.internal?.find(item => item.sessionId === sessionId && item.source === 'internal');
    if (!/^ses_[a-f0-9]{16}$/.test(sessionId) || !session || session.archived) return;
    const mapped = mapSessionDropDestinationModel(destination);
    if (!mapped) return;
    const status = document.getElementById('sessionDropStatus');
    if (!sessionMetadataGuard.begin(sessionId)) {
      if (status) status.textContent = '이 세션은 다른 그룹으로 이동 중입니다. 완료 후 다시 시도해 주세요.';
      return;
    }
    try {
      let response;
      try {
        response = await fetch('/api/sessions/metadata', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId, action: mapped.action, payload: mapped.payload })
        });
      } catch (_) {
        if (status) status.textContent = '연결 실패로 세션을 이동하지 못했습니다. 잠시 후 다시 시도해 주세요.';
        return;
      }
      if (!response.ok) {
        if (status) status.textContent = '세션을 해당 그룹으로 이동하지 못했습니다.';
        return;
      }
      if (status) status.textContent = `${session.title || '내부 세션'}을(를) ${target.getAttribute('aria-label')}에 이동했습니다.`;
      await loadSessions();
    } finally {
      sessionMetadataGuard.end(sessionId);
    }
  });
}

const initialPinnedGroup = document.getElementById('pinnedSessionGroup');
if (initialPinnedGroup) attachSessionDropTarget(initialPinnedGroup, { type: 'pinned' });
const initialRecentsGroup = document.querySelector('[data-drop-type="recents"]');
if (initialRecentsGroup) attachSessionDropTarget(initialRecentsGroup, { type: 'recents' });

function hideSessionContextMenu({ restoreFocus = false } = {}) {
  const trigger = sessionContextTarget?.trigger;
  if (sessionContextMenu) sessionContextMenu.hidden = true;
  sessionContextTarget = null;
  if (trigger?.getAttribute?.('aria-haspopup') === 'menu') trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function openSessionContextMenu(session, x, y, trigger) {
  if (sessionContextActionPending || !sessionContextMenu || session.source !== 'internal' || !/^ses_[a-f0-9]{16}$/.test(session.sessionId || session.id || '')) return;
  const focusTarget = trigger?.getAttribute?.('aria-haspopup') === 'menu'
    ? trigger
    : trigger?.querySelector?.('.session-menu-button') || trigger;
  sessionContextTarget = { session, trigger: focusTarget };
  if (focusTarget?.getAttribute?.('aria-haspopup') === 'menu') focusTarget.setAttribute('aria-expanded', 'true');
  sessionContextMenu.setAttribute('aria-label', `${session.title || '내부 세션'} 작업 메뉴`);
  sessionContextMenu.replaceChildren();
  const addAction = (label, action, payload) => {
    const button = document.createElement('button');
    button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = label;
    button.addEventListener('click', async () => {
      if (sessionContextActionPending) return;
      sessionContextActionPending = true;
      const menuItems = [...sessionContextMenu.querySelectorAll('[role="menuitem"]')];
      menuItems.forEach(item => { item.disabled = true; });
      if (action === 'delete' && !window.confirm('이 내부 세션을 영구 삭제할까요?')) {
        sessionContextActionPending = false;
        return hideSessionContextMenu({ restoreFocus: true });
      }
      if (action === 'rename') { const title = window.prompt('새 세션 이름', session.title || ''); if (title === null) { sessionContextActionPending = false; return hideSessionContextMenu({ restoreFocus: true }); } payload = { title }; }
      if (action === 'move') { const section = window.prompt('세션 섹션 이름 (최대 32자)', session.section === 'recents' ? '' : session.section); if (section === null) { sessionContextActionPending = false; return hideSessionContextMenu({ restoreFocus: true }); } payload = { section: section.trim() || 'recents' }; }
      const returnTarget = sessionContextTarget?.trigger;
      const sessionId = session.sessionId || session.id;
      if (!sessionMetadataGuard.begin(sessionId)) {
        sessionContextActionPending = false;
        hideSessionContextMenu();
        window.alert('이 세션은 다른 변경을 처리 중입니다. 완료 후 다시 시도해 주세요.');
        if (returnTarget?.isConnected) returnTarget.focus();
        return;
      }
      try {
        let response;
        try {
          response = await fetch('/api/sessions/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId, action, payload }) });
        } catch (_) {
          sessionContextActionPending = false;
          hideSessionContextMenu();
          window.alert('세션을 변경하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.');
          if (returnTarget?.isConnected) returnTarget.focus();
          return;
        }
        sessionContextActionPending = false;
        hideSessionContextMenu();
        if (response.ok) {
          await loadSessions();
          const refreshedItem = [...document.querySelectorAll('[data-session-id]')].find(item => item.dataset.sessionId === sessionId);
          (refreshedItem?.querySelector('.session-menu-button') || document.querySelector('.session-menu-button'))?.focus();
        } else {
          window.alert('세션을 변경하지 못했습니다.');
          if (returnTarget?.isConnected) returnTarget.focus();
        }
      } finally {
        sessionMetadataGuard.end(sessionId);
      }
    });
    sessionContextMenu.appendChild(button);
  };
  addAction('이름 변경', 'rename', {});
  addAction(session.pinned ? '고정 해제' : '고정', 'pin', { pinned: !session.pinned });
  addAction('섹션 이동…', 'move', {});
  addAction(session.archived ? '보관 해제' : '보관', 'archive', { archived: !session.archived });
  addAction('삭제…', 'delete', { confirm: true });
  sessionContextMenu.hidden = false;
  const rect = trigger?.getBoundingClientRect();
  sessionContextMenu.style.left = `${Math.max(4, Math.min(x ?? rect?.right ?? 4, window.innerWidth - 205))}px`;
  sessionContextMenu.style.top = `${Math.max(4, Math.min(y ?? rect?.bottom ?? 4, window.innerHeight - 220))}px`;
  sessionContextMenu.querySelector('button')?.focus();
}
document.addEventListener('click', event => { if (!sessionContextMenu?.contains(event.target)) hideSessionContextMenu(); });
document.addEventListener('keydown', event => {
  if (sessionContextMenu?.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    hideSessionContextMenu({ restoreFocus: true });
    return;
  }
  if (event.key === 'Tab' && sessionContextMenu.contains(document.activeElement)) {
    // Restore the trigger before the browser's default Tab step continues.
    hideSessionContextMenu({ restoreFocus: true });
    return;
  }
  if (!sessionContextMenu.contains(document.activeElement)) return;
  const items = [...sessionContextMenu.querySelectorAll('[role="menuitem"]')];
  if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
        : (current - 1 + items.length) % items.length;
  items[next].focus();
});

async function loadSessions() {
  const requestId = ++sessionsLoadRequestId;
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Session list request failed (${res.status}).`);
    const data = await res.json();
    if (requestId !== sessionsLoadRequestId) return;
    if (!isValidSessionListData(data)) {
      throw new Error('Invalid session list response.');
    }
    cachedUnifiedData = data;
    const status = document.getElementById('sessionListStatus');
    if (status) status.textContent = '';
    renderFilteredSessions();
    if (typeof workbenchSnapshot !== 'undefined' && workbenchSnapshot && typeof renderWorkbenchTasks === 'function') renderWorkbenchTasks();
  } catch (err) {
    if (requestId === sessionsLoadRequestId) {
      console.warn('Failed to load sessions:', err);
      const message = '세션 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
      const status = document.getElementById('sessionListStatus');
      if (status) status.textContent = message;
      if (!cachedUnifiedData) {
        const list = document.getElementById('sessionList');
        if (list) {
          const row = document.createElement('div');
          row.className = 'nav-item';
          const error = document.createElement('span');
          error.className = 'nav-item-text';
          error.textContent = message;
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.className = 'session-open-button';
          retry.textContent = '다시 시도';
          retry.setAttribute('aria-label', '세션 목록 다시 시도');
          retry.addEventListener('click', () => {
            retry.disabled = true;
            return loadSessions();
          });
          row.append(error, retry);
          list.replaceChildren(row);
        }
      }
    }
  }
}

async function loadCodexQueueInbox() {
  const list = document.getElementById('codexQueueList');
  const count = document.getElementById('codexQueueCount');
  const status = document.getElementById('codexQueueStatus');
  if (!list || !count || codexQueueLoadInFlight) return;
  codexQueueLoadInFlight = true;
  try {
    const response = await fetch('/api/codex-queue', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Codex queue request failed (${response.status}).`);
    const data = await response.json();
    if (!data || typeof data.available !== 'boolean' || !Array.isArray(data.items) || data.items.some(item => !item || typeof item.id !== 'string'
      || typeof item.threadId !== 'string' || typeof item.title !== 'string' || typeof item.prompt !== 'string'
      || (item.threadTitle !== undefined && typeof item.threadTitle !== 'string')
      || (item.threadArchived !== undefined && typeof item.threadArchived !== 'boolean')
      || (item.threadVerified !== undefined && typeof item.threadVerified !== 'boolean')
      || (item.hasImageAttachment !== undefined && typeof item.hasImageAttachment !== 'boolean')
      || (item.hasUnsupportedContent !== undefined && typeof item.hasUnsupportedContent !== 'boolean')
      || (item.promptTruncated !== undefined && typeof item.promptTruncated !== 'boolean'))) {
      throw new Error('Invalid Codex queue response.');
    }
    if (!data.available) {
      codexQueueInboxItems = [];
      count.textContent = '—';
      list.textContent = data.error === 'database_missing' ? 'Codex 대기열 저장소를 찾지 못했습니다.' : 'Codex 대기열을 읽지 못했습니다.';
      if (status) status.textContent = 'Codex 대기열을 확인할 수 없습니다. 비어 있는 상태와 연결 실패를 구분했습니다.';
      return;
    }
    codexQueueInboxItems = data.items;
    renderCodexQueueInbox(data.items);
    const actionableCount = data.items.filter(item => item.threadVerified === true && item.threadArchived !== true
      && item.hasUnsupportedContent !== true && item.promptTruncated !== true).length;
    count.textContent = String(actionableCount);
    count.setAttribute('aria-label', `실행 준비 가능한 활성 대기 작업 ${actionableCount}개 · 전체 ${data.items.length}개`);
    if (status) status.textContent = data.items.length
      ? `실행 준비 가능한 활성 항목 ${actionableCount}개, 전체 ${data.items.length}개(보관·출처 미확인·미지원 첨부·잘린 요청 포함)를 읽었습니다. 원본 큐는 변경하지 않았습니다.`
      : 'Codex 대기 작업이 없습니다.';
  } catch (error) {
    codexQueueInboxItems = [];
    count.textContent = '—';
    if (status) status.textContent = 'Codex 대기열을 읽지 못했습니다. 원본 Codex 대기열은 변경되지 않았습니다.';
    const errorState = document.createElement('div');
    errorState.className = 'nav-item';
    errorState.textContent = 'Codex 대기열을 읽지 못했습니다.';
    list.replaceChildren(errorState);
    console.warn('Failed to load Codex queue inbox:', error);
  } finally {
    codexQueueLoadInFlight = false;
  }
}

function refreshCodexQueueWhenVisible() {
  if (!document.hidden) void loadCodexQueueInbox();
}

function renderCodexQueueInbox(items) {
  const list = document.getElementById('codexQueueList');
  if (!list) return;
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'nav-item';
    empty.textContent = '대기 작업 없음';
    list.appendChild(empty);
    return;
  }
  const rank = item => item.threadVerified === true ? (item.threadArchived === true ? 2 : 0) : 1;
  const displayItems = [...items].sort((a, b) => rank(a) - rank(b));
  for (const item of displayItems) {
    const sendState = getCodexQueueItemSendState(codexQueueItemFingerprint(item));
    const row = document.createElement('div');
    row.className = 'nav-item codex-queue-item';
    const labels = document.createElement('div');
    labels.className = 'codex-queue-labels';
    const title = document.createElement('span');
    title.className = 'nav-item-text';
    title.textContent = item.title;
    const origin = document.createElement('span');
    origin.className = 'codex-queue-origin';
    origin.textContent = `${item.threadTitle || 'Codex 대화'}${item.threadArchived ? ' · 보관된 대화' : item.threadVerified === true ? '' : ' · 출처 확인 안 됨'}${item.hasUnsupportedContent === true ? ' · 첨부 콘텐츠 미지원' : ''}${item.promptTruncated === true ? ' · 요청 내용 잘림' : ''}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nav-item-action';
    button.disabled = sendState === 'inflight' || item.threadArchived === true || item.threadVerified !== true || item.hasUnsupportedContent === true || item.promptTruncated === true;
    button.textContent = sendState === 'inflight' ? '전송 중' : sendState === 'submitted' ? '다시 준비' : sendState === 'uncertain' ? '상태 확인 후 재시도' : item.threadArchived === true ? '보관된 대화' : item.threadVerified !== true ? '출처 확인 필요' : item.hasUnsupportedContent === true ? '첨부 미지원' : item.promptTruncated === true ? '내용 잘림' : '요청 준비';
    if (sendState) button.title = sendState === 'inflight'
      ? '현재 Only Chat에서 이 큐 요청을 처리 중입니다.'
      : sendState === 'submitted'
        ? '같은 요청을 다시 준비합니다. 이미 보낸 요청을 확인한 뒤 계속을 선택하세요.'
        : '전송 결과가 불확실합니다. 대화 상태를 확인한 뒤 재시도 여부를 결정하세요.';
    button.setAttribute('aria-label', `Codex 대기 요청 Only Chat에 준비: ${item.title}`);
    if (button.disabled && sendState !== 'inflight') button.title = item.threadArchived === true
      ? '보관된 Codex 대화의 대기 항목은 실행할 수 없습니다.'
      : item.hasUnsupportedContent === true
        ? '이미지 또는 다른 첨부 콘텐츠는 Only Chat에 전달되지 않아 요청 준비를 차단했습니다.'
        : item.promptTruncated === true
          ? 'Only Chat에서 요청 본문이 잘렸으므로 원본 Codex 대화에서 확인하세요.'
        : '원래 Codex 대화 상태를 확인할 수 없어 실행 준비를 차단했습니다.';
    let preparationInProgress = false;
    button.addEventListener('click', async () => {
      if (preparationInProgress || sendState === 'inflight' || item.threadArchived === true || item.threadVerified !== true || item.hasUnsupportedContent === true || item.promptTruncated === true) return;
      if (sendState) {
        const message = sendState === 'submitted'
          ? '이 Codex 큐 요청은 이미 Only Chat에 전송된 기록이 있습니다. 기존 대화 상태를 확인했으며 같은 요청을 다시 입력창에 준비할까요? 실제 전송은 별도로 해야 합니다.'
          : '이 Codex 큐 요청은 전송 결과가 불확실합니다. 기존 대화 상태를 확인한 뒤에도 다시 준비할까요? 실제 전송은 별도로 해야 합니다.';
        if (!window.confirm(message)) return;
      }
      const hasConversation = [...timeline.children].some(child => child !== emptyState);
      const isMatchingCodexConversation = currentCodexThreadId === item.threadId;
      if (isCodexQueueComposerProtected()) {
        const status = document.getElementById('codexQueueStatus');
        if (status) status.textContent = '현재 채팅·작성 중인 초안·음성 입력·진행 중인 작업을 보존했습니다. 안전한 빈 채팅에서 다시 요청 준비를 눌러 주세요.';
        return;
      }
      if (!isMatchingCodexConversation && hasConversation) {
        const status = document.getElementById('codexQueueStatus');
        if (status) status.textContent = '다른 대화를 보존했습니다. 빈 새 채팅에서 다시 누르면 이 요청의 Codex 맥락을 열 수 있습니다.';
        return;
      }
      if (!isMatchingCodexConversation) {
        preparationInProgress = true;
        button.disabled = true;
        const status = document.getElementById('codexQueueStatus');
        if (status) status.textContent = '원본 Codex 대화를 Only Chat으로 여는 중입니다. 초안이나 진행 중인 작업이 생기면 보존하고 요청 준비를 중단합니다.';
        const composerWasReadOnly = composerInput.readOnly;
        const microphoneWasDisabled = btnMicrophone.disabled;
        composerInput.readOnly = true;
        btnMicrophone.disabled = true;
        void Promise.resolve().then(() => loadSession(`codex_${item.threadId}`, item.threadTitle || item.title, 'codex')).then(async opened => {
          if (!opened) {
            if (status) status.textContent = 'Codex 원본 맥락을 열지 못해 요청을 준비하지 않았습니다. 현재 대화와 초안은 보존했습니다.';
            return;
          }
          if (currentCodexThreadId !== item.threadId) {
            if (status) status.textContent = 'Codex 대화가 현재 세션으로 연결되지 않아 요청을 준비하지 않았습니다.';
            return;
          }
          if (!await isCurrentCodexQueueItem(item)) {
            if (status) status.textContent = '원본 Codex 큐 항목이 변경·삭제되었거나 확인할 수 없어 요청을 준비하지 않았습니다.';
            return;
          }
          if (isCodexQueueComposerProtected()) {
            if (status) status.textContent = 'Codex 맥락은 열었지만 작성 중인 초안·음성 입력·작업을 보존해 요청을 입력하지 않았습니다.';
            return;
          }
          if (sendState) clearCodexQueueItemSendState(codexQueueItemFingerprint(item));
          composerInput.value = item.prompt;
          composerInput.dispatchEvent(new Event('input', { bubbles: true }));
          composerInput.focus();
          setCodexQueueComposerNotice(item);
          if (status) status.textContent = '원본 Codex 대화 맥락을 불러온 Only Chat 세션에 요청을 준비했습니다. 전송 전 내용을 확인하세요. 원본 대기 항목은 그대로 남아 있습니다.';
        }).catch(() => {
          if (status) status.textContent = 'Codex 맥락이나 원본 큐 상태를 확인하지 못해 요청은 준비하지 않았습니다. 현재 초안과 대화는 보존했습니다.';
        }).finally(() => {
          preparationInProgress = false;
          button.disabled = getCodexQueueItemSendState(codexQueueItemFingerprint(item)) === 'inflight';
          composerInput.readOnly = isRecording || composerWasReadOnly;
          btnMicrophone.disabled = microphoneWasDisabled;
        });
        return;
      }
      const status = document.getElementById('codexQueueStatus');
      const composerWasReadOnly = composerInput.readOnly;
      const microphoneWasDisabled = btnMicrophone.disabled;
      preparationInProgress = true;
      button.disabled = true;
      composerInput.readOnly = true;
      btnMicrophone.disabled = true;
      try {
        if (!await isCurrentCodexQueueItem(item)) {
          if (status) status.textContent = '원본 Codex 큐 항목이 변경·삭제되었거나 확인할 수 없어 요청을 준비하지 않았습니다.';
          return;
        }
        if (isCodexQueueComposerProtected()) {
          if (status) status.textContent = '큐 확인 중 작성된 초안·음성 입력·작업을 보존하고 요청 준비를 중단했습니다.';
          return;
        }
        if (sendState) clearCodexQueueItemSendState(codexQueueItemFingerprint(item));
        composerInput.value = item.prompt;
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
        composerInput.focus();
        setCodexQueueComposerNotice(item);
        if (status) status.textContent = isMatchingCodexConversation
          ? '원본 Codex 대화 맥락을 불러온 Only Chat 세션에 요청을 준비했습니다. 전송 전 내용을 확인하세요. 원본 대기 항목은 그대로 남아 있습니다.'
          : '요청을 Only Chat 입력창에 준비했습니다. Codex 원본 대기 항목은 그대로 남아 있습니다.';
      } catch (_) {
        if (status) status.textContent = '원본 Codex 큐 상태를 확인하지 못해 요청을 준비하지 않았습니다.';
      } finally {
        preparationInProgress = false;
        button.disabled = getCodexQueueItemSendState(codexQueueItemFingerprint(item)) === 'inflight';
        composerInput.readOnly = isRecording || composerWasReadOnly;
        btnMicrophone.disabled = microphoneWasDisabled;
      }
    });
    labels.append(title, origin);
    row.append(labels, button);
    list.appendChild(row);
  }
}

function setCodexQueueComposerNotice(item) {
  const notice = document.getElementById('composerStatus');
  if (notice) {
    notice.textContent = `Codex 대기열 · ${item.threadTitle || 'Codex 대화'} · 원본 항목은 유지됩니다. 전송 전 요청을 검토하세요.`;
    if (notice.dataset) notice.dataset.codexQueueFingerprint = codexQueueItemFingerprint(item);
  }
}

function isCodexQueueComposerNotice(text) {
  return typeof text === 'string' && text.startsWith('Codex 대기열 ·');
}

function getCodexQueueSendFailureNotice(submittedFromQueue) {
  return submittedFromQueue
    ? 'Codex 대기 요청 전송 결과를 확인할 수 없습니다. 요청은 현재 Only Chat 화면에 남아 있고 원본 Codex 큐도 유지됩니다. 대화와 큐 상태를 확인한 뒤 재시도하세요.'
    : '';
}

async function isCurrentCodexQueueItem(item) {
  const response = await fetch('/api/codex-queue', { cache: 'no-store' });
  if (!response.ok) return false;
  const data = await response.json();
  if (!data || data.available !== true || !Array.isArray(data.items)) return false;
  return data.items.some(current => current && current.id === item.id && current.threadId === item.threadId
    && current.prompt === item.prompt && current.threadVerified === true
    && current.threadArchived !== true && current.hasUnsupportedContent !== true && current.promptTruncated !== true);
}

function isValidSessionListData(data) {
  const isSession = session => session && typeof session === 'object'
    && typeof (session.id || session.sessionId) === 'string'
    && typeof session.title === 'string'
    && ['internal', 'codex', 'antigravity'].includes(session.source);
  const isGroup = group => group && typeof group === 'object'
    && typeof group.id === 'string' && Array.isArray(group.items) && group.items.every(isSession);
  const isProject = project => project && typeof project === 'object'
    && typeof project.name === 'string' && Array.isArray(project.items) && project.items.every(isSession);
  return !!data && Array.isArray(data.internal) && data.internal.every(isSession)
    && !!data.unified && Array.isArray(data.unified.sections) && data.unified.sections.every(isGroup)
    && Array.isArray(data.unified.projects) && data.unified.projects.every(isProject)
    && (data.unified.pinned === undefined || (Array.isArray(data.unified.pinned) && data.unified.pinned.every(isSession)));
}

function renderFilteredSessions({ forceSearch = false } = {}) {
  if (!cachedUnifiedData) return;
  const unified = cachedUnifiedData.unified || { sections: [] };
  const internal = cachedUnifiedData.internal || [];

  let recentsList = document.getElementById('sessionList');
  if (!recentsList) return;

  const query = sessionTitleSearch?.value.trim() || '';
  if (query) {
    if (pinnedSessionGroup) pinnedSessionGroup.hidden = true;
    if (codexProjectGroup) codexProjectGroup.hidden = true;
    const normalizedQuery = query.toLocaleLowerCase();
    if (currentFilter === 'internal') {
      sessionSearchQuery = normalizedQuery;
      sessionSearchRequestId++;
      clearTimeout(sessionSearchTimer);
      sessionSearchAbortController?.abort();
      sessionSearchAbortController = null;
      sessionSearchResults = filterInternalSessionTitles(internal, normalizedQuery);
      renderSessionSearchResults();
      return;
    }
    if (forceSearch || normalizedQuery !== sessionSearchQuery) {
      sessionSearchQuery = normalizedQuery;
      sessionSearchResults = null;
      const requestId = ++sessionSearchRequestId;
      clearTimeout(sessionSearchTimer);
      sessionSearchAbortController?.abort();
      const controller = new AbortController();
      sessionSearchAbortController = controller;
      recentsList.textContent = '세션 검색 중…';
      if (sessionSearchStatus) sessionSearchStatus.textContent = '세션 검색 중입니다.';
      sessionSearchTimer = setTimeout(async () => {
        try {
          const response = await fetch('/api/sessions/search/stream', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/x-ndjson' },
            body: JSON.stringify({ query }),
            signal: controller.signal
          });
          if (!response.ok) {
            if (requestId !== sessionSearchRequestId) return;
            const message = sessionSearchFailureMessage(response.status);
            renderSessionSearchFailure(message, () => renderFilteredSessions({ forceSearch: true }));
            return;
          }
          if (!response.body?.getReader) {
            renderSessionSearchFailure('이 환경에서는 점진 검색을 사용할 수 없습니다. 다시 시도해 주세요.', () => renderFilteredSessions({ forceSearch: true }));
            return;
          }
          sessionSearchResults = [];
          let terminal = null;
          const handleEvent = event => {
            if (requestId !== sessionSearchRequestId) return;
            if (event.type === 'result') {
              if (!isValidSessionSearchResults([event.item])) {
                throw new Error('invalid search result');
              }
              sessionSearchResults.push(event.item);
              renderSessionSearchResults();
              if (sessionSearchStatus) sessionSearchStatus.textContent = `전체 기록 검색 중 · 결과 ${sessionSearchResults.length}개`;
            } else if (event.type === 'progress') {
              const source = event.source === 'codex' ? 'Codex' : event.source === 'antigravity' ? 'Antigravity' : '세션';
              const fileProgress = Number.isFinite(event.fileBytesScanned) && Number.isFinite(event.fileBytesTotal) && event.fileBytesTotal > 0
                ? ` · 파일 ${Math.round(event.fileBytesScanned / 1048576)}/${Math.ceil(event.fileBytesTotal / 1048576)}MB` : '';
              if (sessionSearchStatus) sessionSearchStatus.textContent = `전체 기록 검색 중 · ${source} ${event.scanned}/${event.total}${fileProgress} · 결과 ${sessionSearchResults.length}개`;
            } else if (event.type === 'complete') {
              terminal = 'complete';
            } else if (event.type === 'incomplete') {
              terminal = 'incomplete';
              renderSessionSearchPartial('시간 제한으로 전체 검색을 마치지 못했습니다. 표시된 결과는 일부입니다.', () => renderFilteredSessions({ forceSearch: true }));
            } else if (event.type === 'error') {
              terminal = 'error';
              if (sessionSearchResults.length) {
                renderSessionSearchPartial('세션 검색을 완료하지 못했습니다. 표시된 결과는 일부입니다.', () => renderFilteredSessions({ forceSearch: true }));
              } else {
                renderSessionSearchFailure('세션 검색을 완료하지 못했습니다.', () => renderFilteredSessions({ forceSearch: true }));
              }
            }
          };
          terminal = await consumeSessionSearchStream(response, handleEvent, () => requestId === sessionSearchRequestId);
          if (requestId !== sessionSearchRequestId) return;
          if (terminal === 'complete') {
            sessionSearchResults.sort((a, b) => b.updatedAt - a.updatedAt);
            renderSessionSearchResults();
            if (sessionSearchStatus) sessionSearchStatus.textContent = `전체 기록 검색 완료 · 결과 ${sessionSearchResults.length}개.`;
          } else if (!terminal) {
            renderSessionSearchPartial('검색 연결이 예기치 않게 끝났습니다. 표시된 결과는 일부입니다.', () => renderFilteredSessions({ forceSearch: true }));
          }
        } catch (error) {
          if (requestId === sessionSearchRequestId && error?.name !== 'AbortError') {
            if (sessionSearchResults?.length) {
              renderSessionSearchPartial('검색 도중 연결이 끊겼습니다. 표시된 결과는 일부입니다.', () => renderFilteredSessions({ forceSearch: true }));
            } else {
              renderSessionSearchFailure(sessionSearchNetworkFailureMessage(error), () => renderFilteredSessions({ forceSearch: true }));
            }
          }
        }
      }, 250);
      return;
    }
    if (sessionSearchResults === null) {
      recentsList.textContent = '세션 검색 중…';
      return;
    }
    renderSessionSearchResults();
    return;
  }

  sessionSearchRequestId++;
  if (sessionSearchStatus) sessionSearchStatus.textContent = '';
  clearTimeout(sessionSearchTimer);
  sessionSearchAbortController?.abort();
  sessionSearchAbortController = null;
  sessionSearchQuery = '';
  sessionSearchResults = null;
  const showCodexGroups = currentFilter === 'all' || currentFilter === 'codex';
  const internalGroups = groupInternalSessionsModel(internal, currentFilter);
  const pinnedItems = showCodexGroups ? [...(unified.pinned || []), ...internalGroups.pinned] : internalGroups.pinned;
  if (pinnedSessionGroup) pinnedSessionGroup.hidden = false;
  if (codexProjectGroup) codexProjectGroup.hidden = !showCodexGroups || !(unified.projects || []).length;
  renderSessionItems(pinnedSessionList, pinnedItems);
  renderProjectGroups(projectList, showCodexGroups ? (unified.projects || []) : []);
  recentsList.innerHTML = '';

  const recentsSection = unified.sections?.find(s => s.id === 'recents');
  const activeInternal = internal.filter(session => !session.archived);
  let allItems = [...(recentsSection?.items || []), ...internalGroups.recents];

  // Apply Filter
  if (currentFilter === 'codex') {
    allItems = allItems.filter(s => s.source === 'codex');
  } else if (currentFilter === 'antigravity') {
    allItems = allItems.filter(s => s.source === 'antigravity');
  } else if (currentFilter === 'internal') {
    allItems = allItems.filter(s => s.source === 'internal' || !s.source);
  }

  if (allItems.length === 0) {
    recentsList.textContent = cachedUnifiedData?.isolated
      ? 'SpaceO 격리 세션 모드 · 아직 기록된 세션이 없습니다.'
      : '해당 필터에 세션이 없습니다.';
  } else {
    renderSessionItems(recentsList, allItems);
  }
  const archived = currentFilter === 'all' || currentFilter === 'internal' ? internal.filter(session => session.archived) : [];
  const archiveGroup = document.getElementById('archivedSessionGroup');
  const archiveList = document.getElementById('archivedSessionList');
  if (archiveGroup && archiveList) { archiveGroup.hidden = archived.length === 0; renderSessionItems(archiveList, archived); }
  recentsList.parentElement.querySelectorAll('[data-internal-session-section]').forEach(group => group.remove());
  for (const { section, sessions } of internalGroups.customSections) {
    const group = document.createElement('div'); group.className = 'sidebar-nav-group';
    group.dataset.internalSessionSection = 'true';
    attachSessionDropTarget(group, { type: 'section', section });
    const heading = document.createElement('div'); heading.className = 'nav-group-title'; heading.textContent = section; group.appendChild(heading);
    const list = document.createElement('div'); list.className = 'session-list'; group.appendChild(list);
    renderSessionItems(list, sessions);
    recentsList.parentElement.appendChild(group);
  }
}

function sessionSearchNetworkFailureMessage(error) {
  if (error?.name === 'AbortError') return '세션 검색이 취소되었습니다.';
  if (error instanceof TypeError) return '세션 검색 서버에 연결할 수 없습니다. Only Chat이 실행 중인지 확인한 뒤 다시 시도해 주세요.';
  return '세션 검색 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

async function consumeSessionSearchStream(response, onEvent, shouldContinue = () => true) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error('search stream reader unavailable');
  const decoder = new TextDecoder();
  let pending = '';
  let terminal = null;
  const consumeLine = line => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    onEvent(event);
    if (['complete', 'incomplete', 'error'].includes(event?.type)) terminal = event.type;
  };
  while (shouldContinue() && !terminal) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newline;
    while (!terminal && (newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      consumeLine(line);
    }
  }
  pending += decoder.decode();
  if (pending.trim() && shouldContinue() && !terminal) consumeLine(pending);
  return terminal;
}

function sessionSearchFailureMessage(status) {
  if (status === 504) return '전체 기록 검색이 시간 제한에 도달했습니다. 내부 세션 제목만 찾으려면 Only 필터를 선택하거나 잠시 후 다시 시도해 주세요.';
  return '세션 검색 요청이 실패했습니다.';
}

function isValidSessionSearchResults(results) {
  return Array.isArray(results) && results.every(result => result && typeof result === 'object'
    && typeof result.id === 'string' && result.id.length > 0
    && (result.source === 'codex' || result.source === 'antigravity')
    && typeof result.title === 'string' && typeof result.snippet === 'string'
    && Number.isFinite(result.updatedAt));
}

function renderSessionSearchFailure(message, onRetry = null) {
  const recentsList = document.getElementById('sessionList');
  if (!recentsList) return;
  if (sessionSearchStatus) sessionSearchStatus.textContent = message;
  const error = document.createElement('span');
  error.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn-change-outline';
  retry.textContent = '다시 시도';
  retry.addEventListener('click', () => {
    sessionSearchQuery = '';
    sessionSearchResults = null;
    sessionTitleSearch?.focus();
    if (onRetry) onRetry();
    else renderFilteredSessions();
  });
  recentsList.replaceChildren(error, retry);
}

function renderSessionSearchPartial(message, onRetry) {
  const recentsList = document.getElementById('sessionList');
  if (!recentsList) return;
  if (sessionSearchStatus) sessionSearchStatus.textContent = message;
  if (!sessionSearchResults?.length) recentsList.textContent = '검색 결과가 없습니다.';
  const notice = document.createElement('span');
  notice.textContent = message;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn-change-outline';
  retry.textContent = '전체 다시 검색';
  retry.addEventListener('click', () => {
    sessionSearchQuery = '';
    sessionTitleSearch?.focus();
    onRetry();
  });
  recentsList.append(notice, retry);
}

function filterInternalSessionTitles(sessions, query) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
  if (!normalizedQuery || !Array.isArray(sessions)) return [];
  const terms = normalizedQuery.split(/\s+/);
  return sessions.filter(session => {
    if (session?.source !== 'internal') return false;
    const title = String(session.title || '').toLocaleLowerCase();
    return terms.every(term => title.includes(term));
  });
}

function updateSessionSearchScope() {
  if (!sessionTitleSearch) return;
  const internalOnly = currentFilter === 'internal';
  sessionTitleSearch.placeholder = internalOnly ? 'Only Chat 제목 검색' : '세션 전문 검색';
  sessionTitleSearch.setAttribute('aria-label', internalOnly
    ? 'Only Chat 세션 제목 검색'
    : '과거 Codex·Antigravity 세션 전문 검색');
}

function renderSessionSearchResults() {
  const recentsList = document.getElementById('sessionList');
  if (!recentsList) return;
  let results = sessionSearchResults || [];
  if (currentFilter === 'codex' || currentFilter === 'antigravity') {
    results = results.filter(session => session.source === currentFilter);
  } else if (currentFilter === 'internal') {
    results = results.filter(session => session.source === 'internal');
  }
  if (results.length === 0) {
    const message = currentFilter === 'internal' ? '일치하는 Only Chat 세션 제목이 없습니다.' : '검색 결과가 없습니다.';
    recentsList.textContent = message;
    if (sessionSearchStatus) sessionSearchStatus.textContent = message;
    return;
  }
  if (sessionSearchStatus) sessionSearchStatus.textContent = currentFilter === 'internal'
    ? `Only Chat 제목 검색 결과 ${results.length}개.`
    : `검색 결과 ${results.length}개.`;
  renderSessionItems(recentsList, results, currentFilter !== 'internal');
}

function renderSessionItems(recentsList, sessions, withSnippets = false) {
  if (!recentsList) return;
  recentsList.innerHTML = '';
  for (const ses of sessions) {
    const item = document.createElement('div');
    const sessionId = ses.id || ses.sessionId;
    item.dataset.sessionId = sessionId;
    item.className = `nav-item ${sessionId === currentSessionId ? 'active' : ''}`;
    const internalDraggable = ses.source === 'internal' && !ses.archived && /^ses_[a-f0-9]{16}$/.test(sessionId || '');
    if (internalDraggable && !withSnippets) {
      item.draggable = true;
      item.addEventListener('dragstart', event => {
        if (!event.dataTransfer) return;
        event.dataTransfer.setData('application/x-only-chat-session', sessionId);
        event.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => document.querySelectorAll('.session-drop-target.drop-target-active').forEach(target => setDropTargetFeedback(target, false)));
    }
    if (withSnippets) item.classList.add('session-search-result');
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'session-open-button';
    openButton.setAttribute('aria-label', `${ses.title || '대화 세션'} 열기`);
    if (sessionId === currentSessionId) openButton.setAttribute('aria-current', 'page');
    const title = document.createElement('span');
    title.className = 'nav-item-text';
    title.title = ses.title || '대화 세션';
    title.textContent = ses.title || '대화 세션';
    openButton.appendChild(title);
    if (withSnippets && ses.snippet) {
      const snippet = document.createElement('span');
      snippet.className = 'session-search-snippet';
      snippet.textContent = ses.snippet;
      openButton.appendChild(snippet);
    }
    openButton.addEventListener('click', () => loadSession(sessionId, ses.title, ses.source));
    item.appendChild(openButton);
    if (ses.source === 'internal') {
      item.addEventListener('contextmenu', event => { event.preventDefault(); openSessionContextMenu(ses, event.clientX, event.clientY, item); });
      const menuButton = document.createElement('button'); menuButton.type = 'button'; menuButton.className = 'session-menu-button'; menuButton.setAttribute('aria-label', `${ses.title || '세션'} 메뉴`); menuButton.setAttribute('aria-haspopup', 'menu'); menuButton.setAttribute('aria-expanded', 'false'); menuButton.textContent = '⋯';
      menuButton.addEventListener('click', event => { event.stopPropagation(); openSessionContextMenu(ses, null, null, menuButton); });
      item.appendChild(menuButton);
    }
    recentsList.appendChild(item);
  }
}

function renderProjectGroups(container, projects) {
  if (!container) return;
  container.innerHTML = '';
  for (const project of projects) {
    const group = document.createElement('details');
    group.className = 'sidebar-project-group';
    const title = document.createElement('summary');
    title.className = 'nav-item nav-item-text';
    title.textContent = project.name || 'Project';
    group.appendChild(title);
    const items = document.createElement('div');
    items.className = 'session-list';
    group.appendChild(items);
    let rendered = false;
    group.addEventListener('toggle', () => {
      if (group.open && !rendered) {
        renderSessionItems(items, project.items || []);
        rendered = true;
      }
    });
    container.appendChild(group);
  }
}

async function loadSession(sessionId, title, source = null) {
  if (activeGoal) {
    cancelActiveGoal('다른 대화로 전환하여 이전 목표 추구를 중단했습니다.');
  }
  const hasComposerDraft = String(composerInput.value || '').trim().length > 0;
  if (sessionResumePendingCount === 0 && (hasComposerDraft || currentAbortController || isGenerating || isRecording)) {
    const status = document.getElementById('sessionListStatus');
    if (status) status.textContent = '초안·음성 입력·진행 중인 응답을 보존하려고 세션을 전환하지 않았습니다. 현재 작업을 마친 뒤 다시 열어 주세요.';
    return false;
  }
  const requestId = ++sessionLoadRequestId;
  let resumedSession = null;
  // Resume internal and external sessions through the same API, preserving source routing.
  if (source === 'internal' || sessionId.startsWith('ses_') || sessionId.startsWith('codex_') || sessionId.startsWith('agy_')) {
    if (sessionResumePendingCount === 0) {
      sessionResumeOriginalComposerReadOnly = composerInput.readOnly;
      sessionResumeOriginalMicrophoneDisabled = btnMicrophone.disabled;
      composerInput.readOnly = true;
      btnMicrophone.disabled = true;
    }
    sessionResumePendingCount++;
    const resumeRequest = sessionResumeQueue.then(async () => {
      const res = await fetch('/api/sessions/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.ok || !data.session || !Array.isArray(data.session.turns)) throw new Error('Invalid resume response');
      return data.session;
    });
    sessionResumeQueue = resumeRequest.then(() => undefined, () => undefined);
    try {
      resumedSession = await resumeRequest;
    } catch (err) {
      console.warn('Failed to resume session:', err);
      if (requestId === sessionLoadRequestId) {
        const status = document.getElementById('sessionListStatus');
        if (status) status.textContent = '세션을 열지 못했습니다. 현재 대화는 유지됩니다. 다시 시도해 주세요.';
      }
      return false;
    } finally {
      sessionResumePendingCount = Math.max(0, sessionResumePendingCount - 1);
      if (sessionResumePendingCount === 0) {
        composerInput.readOnly = sessionResumeOriginalComposerReadOnly;
        btnMicrophone.disabled = sessionResumeOriginalMicrophoneDisabled;
      }
    }
  }

  if (requestId !== sessionLoadRequestId) return false;
  currentSessionId = resumedSession?.sessionId || sessionId;
  if (typeof applyFullAccessModeForSession === 'function') applyFullAccessModeForSession(currentSessionId, false);
  currentCodexThreadId = resumedSession?.source === 'codex' && sessionId.startsWith('codex_')
    ? sessionId.slice('codex_'.length)
    : null;
  titlebarThreadTitle.textContent = title || 'Only Chat 세션';
  if (emptyState) emptyState.style.display = 'none';
  timeline.replaceChildren();
  if (resumedSession) {
    titlebarThreadTitle.textContent = resumedSession.source === 'internal'
      ? (resumedSession.title || title || 'Only Chat 세션')
      : `${resumedSession.title} (${resumedSession.source === 'codex' ? 'Codex' : 'Antigravity'} 재개됨)`;

    for (const t of resumedSession.turns) {
      if (t.role === 'user') {
        appendUserMessage(t.content);
      } else if (t.role === 'assistant') {
        const card = createAssistantContainer();
        if (t.outcome === 'error') {
          card.workOutcome = 'error';
          setAssistantWorkStatus(card, '응답을 완료하지 못했습니다');
          handleStreamEvent({ type: 'error', ...(t.error || {}) }, card);
          timeline.appendChild(card.row);
          continue;
        }
        const msg = document.createElement('div');
        msg.className = 'text-body';
        const answer = document.createElement('div');
        answer.className = 'assistant-answer';
        const renderMarkdown = window.OnlyChatPresentation?.renderMarkdown;
        if (typeof renderMarkdown === 'function') answer.innerHTML = renderMarkdown(t.content);
        else answer.textContent = t.content;
        msg.appendChild(answer);
        card.content.appendChild(msg);
        timeline.appendChild(card.row);
      }
    }
    timeline.scrollTop = timeline.scrollHeight;
  }
  await loadSessions();
  await refreshPriorityStatus();
  return true;
}

// ============================================================================
// Metamorphic Hub & Connectors & Browser & Vault
// ============================================================================

function initMetamorphicLiveStream() {
  try {
    const morphSource = new EventSource('/api/morph/stream');
    morphSource.onmessage = e => {
      try {
        const event = JSON.parse(e.data);
        if (event.type === 'morph_connected') {
          renderMorphSlots(event.status.slots);
        } else if (event.type === 'system_morph') {
          handleLiveMorphUpdate(event);
        }
      } catch (_) {}
    };
  } catch (err) {
    console.warn('Metamorphic stream deferred:', err);
  }
}

/**
 * 핫리로드 _ 신체 변형 시스템: 실시간 무중단 신체 부위 핫스왑 처리
 */
function handleLiveMorphUpdate(event) {
  const { organ, payload } = event;
  if (organ === 'ui' && typeof payload?.file === 'string' && /\.(?:html|js)$/i.test(payload.file)) {
    requestSafeUiMorphReload();
    return;
  }
  showMorphToast(`⚡️ 신체 변형 적용됨: [${organ}] (v${event.slot?.version || 'new'})`);

  if (organ === 'theme') {
    // 1. Hot-reload CSS stylesheet live without touching conversation or input!
    const links = document.querySelectorAll('link[rel="stylesheet"]');
    links.forEach(link => {
      const href = link.getAttribute('href').split('?')[0];
      link.setAttribute('href', `${href}?v=${Date.now()}`);
    });
    // If specific color payload is provided, apply custom property instantly
    if (payload && payload.accentOrange) {
      document.documentElement.style.setProperty('--accent-orange', payload.accentOrange);
    }
  } else if (organ === 'font') {
    // 2. Hot-swap font family live
    if (payload && payload.fontSans) {
      document.documentElement.style.setProperty('--font-sans', payload.fontSans);
    }
  } else if (organ === 'ui') {
    console.log('[MetamorphicHub] UI metadata refreshed.');
  }

  refreshMorphStatus();
}

function canReloadRendererNow({ inFlight, hasDraft, hasAttachments, hasConversation }) {
  return !inFlight && !hasDraft && !hasAttachments && !hasConversation;
}

function requestSafeUiMorphReload() {
  const attachmentInputs = ['attachmentPicker', 'folderPicker']
    .map(id => document.getElementById(id))
    .filter(Boolean);
  const safe = canReloadRendererNow({
    inFlight: isGenerating,
    hasDraft: Boolean(composerInput?.value.trim()),
    hasAttachments: attachmentInputs.some(input => input.files && input.files.length > 0),
    hasConversation: Boolean(timeline?.querySelector('.message-row'))
  });
  if (!safe) {
    pendingUiMorphReload = true;
    showMorphToast('UI 변경 감지됨 · 대화, 작성 내용, 첨부를 보존하려고 새 세션에서 적용합니다.');
    return;
  }
  clearTimeout(uiMorphReloadTimer);
  uiMorphReloadTimer = setTimeout(() => {
    uiMorphReloadTimer = null;
    if (!canReloadRendererNow({
      inFlight: isGenerating,
      hasDraft: Boolean(composerInput?.value.trim()),
      hasAttachments: attachmentInputs.some(input => input.files && input.files.length > 0),
      hasConversation: Boolean(timeline?.querySelector('.message-row'))
    })) {
      pendingUiMorphReload = true;
      showMorphToast('UI 변경 감지됨 · 현재 대화를 마치고 새 세션에서 적용합니다.');
      return;
    }
    pendingUiMorphReload = false;
    window.location.reload();
  }, 350);
}

function applyPendingUiMorphReloadWhenSafe() {
  if (pendingUiMorphReload) requestSafeUiMorphReload();
}

function showMorphToast(text) {
  let toast = document.getElementById('morphToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'morphToast';
    toast.style.cssText = `
      position: fixed;
      top: 54px;
      right: 20px;
      background: #18181b;
      color: #ffffff;
      border: 1px solid rgba(240, 106, 53, 0.4);
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 500;
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 6px;
      animation: fadeIn 0.2s ease-out;
    `;
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.style.display = 'flex';
  clearTimeout(window._morphToastTimer);
  window._morphToastTimer = setTimeout(() => {
    if (toast) toast.style.display = 'none';
  }, 2400);
}

async function refreshMorphStatus() {
  try {
    const status = await readWorkbenchSnapshot('/api/morph/status');
    renderMorphSlots(status.slots);
    renderWorkbenchModules(status.slots);
  } catch (_) {
    renderWorkbenchModules(null);
  }
}

function renderMorphSlots(slots) {
  if (!slots || !morphSlotsList) return;
  morphSlotsList.replaceChildren();
  for (const [key, slot] of Object.entries(slots)) {
    const organ = slot.organ || key;
    const changedAt = Number.isFinite(Number(slot.lastModified))
      ? new Date(Number(slot.lastModified)).toLocaleString()
      : '정보 없음';
    const card = document.createElement('div');
    card.className = 'tier-list-card';
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
    const title = document.createElement('span');
    title.style.cssText = 'font-weight:700;font-size:12px;';
    title.textContent = `${slot.name || ''} (${organ})`;
    const version = document.createElement('span');
    version.style.cssText = 'font-size:10px;background:rgba(0,0,0,0.06);padding:2px 6px;border-radius:4px;';
    version.textContent = `v${slot.version || ''}`;
    header.append(title, version);
    const timestamp = document.createElement('div');
    timestamp.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:2px;';
    timestamp.textContent = `마지막 변경: ${changedAt}`;
    card.append(header, timestamp);
    morphSlotsList.appendChild(card);
  }
}

async function refreshConnectorsStatus() {
  try {
    const res = await fetch('/api/connectors/status');
    const status = await res.json();
    const googleBadge = document.getElementById('badgeGoogleStatus');
    const notionBadge = document.getElementById('badgeNotionStatus');

    if (status.google.connected) {
      googleBadge.textContent = '● 연결됨 · Drive/Gmail MCP';
      googleBadge.style.color = '#10b981';
    } else {
      googleBadge.textContent = '○ Google 연결 필요';
    }

    if (status.notion.connected) {
      notionBadge.textContent = '● 연결됨 (Active)';
      notionBadge.style.color = '#10b981';
    } else {
      notionBadge.textContent = '○ 미연동';
    }
  } catch (_) {}
}

function showUrlCopyFallback(url, anchor, message) {
  document.getElementById('googleLoginUrlFallback')?.remove();
  const panel = document.createElement('div');
  panel.id = 'googleLoginUrlFallback';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.style.cssText = 'display:grid;gap:8px;margin-top:8px;padding:10px;border:1px solid var(--border-color,#555);border-radius:8px;';

  const note = document.createElement('p');
  note.textContent = message;
  note.style.margin = '0';
  const input = document.createElement('input');
  input.type = 'url';
  input.readOnly = true;
  input.value = url;
  input.setAttribute('aria-label', 'Google 로그인 URL');
  input.style.width = '100%';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-primary';
  copy.textContent = "If it didn't open, click to copy URL";
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(url);
      copy.textContent = 'The link has been copied. Go to a browser and then paste it.';
    } catch {
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      copy.textContent = copied ? 'The link has been copied. Go to a browser and then paste it.' : '주소가 선택됐습니다. 직접 복사해 주세요';
    }
  });
  panel.append(note, input, copy);
  (anchor?.parentElement || document.body).append(panel);
}

async function handleGoogleLogin() {
  let loginUrl = '';
  let loginButton = null;
  try {
    const res = await fetch('/api/connectors/google/auth-url');
    const data = await res.json();
    if (data.url) {
      loginUrl = data.url;
      loginButton = document.getElementById('btnLoginGoogleWorkspace');
      document.getElementById('googleLoginUrlFallback')?.remove();
      let popup = null;
      try { popup = window.open(data.url, '_blank', 'width=600,height=700'); } catch (_) {}
      showUrlCopyFallback(data.url, loginButton, 'If it didn\'t open, click to copy URL. You can then go to a browser and paste it.');
      if (!popup) return;
      const refreshTimer = setInterval(() => {
        if (popup.closed) {
          clearInterval(refreshTimer);
          void refreshConnectorsStatus();
        }
      }, 500);
    }
  } catch (err) {
    if (loginUrl) showUrlCopyFallback(loginUrl, loginButton, `Google 로그인 창을 열지 못했습니다. If it didn't open, click to copy URL, then go to a browser and paste it. (${err.message})`);
    else alert('구글 로그인 오류: ' + err.message);
  }
}

async function handleNotionConnect() {
  const token = document.getElementById('inputNotionToken').value.trim();
  if (!token) return alert('Notion 토큰을 입력해주세요.');
  try {
    const res = await fetch('/api/connectors/notion/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json();
    if (data.ok) {
      alert('✓ Notion 연동 성공!');
      document.getElementById('inputNotionToken').value = '';
      await refreshConnectorsStatus();
    }
  } catch (err) {
    alert('Notion 오류: ' + err.message);
  }
}

async function refreshVaultList() {
  const container = document.getElementById('vaultList');
  if (!container) return;
  try {
    const res = await fetch('/api/vault/list');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = await res.json();
    if (!Array.isArray(items)) throw new Error('보관함 응답 형식이 올바르지 않습니다.');
    container.querySelector('[data-vault-refresh-error]')?.remove();
    container.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:11px; color:var(--text-dim); padding:4px;';
      empty.textContent = '저장된 패스키가 없습니다.';
      container.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.style.cssText = 'background:var(--bg-card-hover); border-radius:6px; padding:6px 10px; display:flex; justify-content:space-between; align-items:center;';
      const details = document.createElement('div');
      const service = document.createElement('div');
      service.style.cssText = 'font-size:12px; font-weight:600; color:var(--text-main);';
      service.textContent = `🔑 ${String(item.service || '')}`;
      const account = document.createElement('div');
      account.style.cssText = 'font-size:10px; color:var(--text-dim);';
      account.textContent = `${item.username || '(계정 미지정)'} · ${item.allowAiUse ? 'AI 승인됨' : 'AI 차단됨'}`;
      details.append(service, account);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.style.cssText = 'border:none; background:transparent; color:var(--accent-red); cursor:pointer;';
      remove.textContent = '✕';
      remove.setAttribute('aria-label', `${item.service || '자격증명'} 삭제`);
      remove.addEventListener('click', () => { void window.handleVaultDelete(item.id); });
      row.append(details, remove);
      container.appendChild(row);
    }
  } catch (err) {
    let error = container.querySelector('[data-vault-refresh-error]');
    if (!error) {
      error = document.createElement('div');
      error.dataset.vaultRefreshError = 'true';
      error.setAttribute('role', 'status');
      error.setAttribute('aria-live', 'polite');
      error.style.cssText = 'font-size:11px;color:var(--accent-red);padding:4px;';
      container.appendChild(error);
    }
    error.textContent = `보관함 새로고침 오류: ${err.message}`;
  }
}

async function handleVaultSave() {
  const service = document.getElementById('inputVaultService').value.trim();
  const username = document.getElementById('inputVaultUsername').value.trim();
  const secret = document.getElementById('inputVaultSecret').value.trim();
  const allowAiUse = document.getElementById('checkVaultAllowAi').checked;

  if (!service || !secret) return alert('서비스명과 패스키를 입력해주세요.');

  try {
    const res = await fetch('/api/vault/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, username, secret, allowAiUse })
    });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error(result.error || `HTTP ${res.status}`);
    alert(`✓ [${service}] 패스키가 AES-GCM 보관함에 안전하게 저장되었습니다.`);
    document.getElementById('inputVaultService').value = '';
    document.getElementById('inputVaultUsername').value = '';
    document.getElementById('inputVaultSecret').value = '';
    await Promise.all([refreshVaultList(), refreshStageVault()]);
  } catch (err) {
    alert('보관함 오류: ' + err.message);
  }
}

window.handleVaultDelete = async function(id) {
  if (!confirm('이 패스키를 삭제하시겠습니까?')) return;
  try {
    const response = await fetch('/api/vault/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    if (!result.ok) throw new Error('자격증명이 없거나 삭제되지 않았습니다.');
    await Promise.all([refreshVaultList(), refreshStageVault()]);
  } catch (err) {
    window.alert(`패스키를 삭제하지 못했습니다: ${err.message}`);
  }
};

async function navBrowser(url) {
  const consoleEl = document.getElementById('browserAriaConsole');
  url = window.onlyChatResolveBrowserInput?.(url) || null;
  if (!url) {
    consoleEl.textContent = '[주소 오류] HTTP/HTTPS 주소를 확인해 주세요.';
    return;
  }
  document.getElementById('browserUrlInput').value = url;
  const currentNavTab = typeof browserTabs !== 'undefined' ? browserTabs.find(t => t.id === activeBrowserTabId) : null;
  if (currentNavTab) {
    currentNavTab.url = url;
    try { currentNavTab.title = new URL(url).hostname || url; } catch (_) { currentNavTab.title = url; }
    if (typeof renderBrowserTabs === 'function') renderBrowserTabs();
  }
  if (postNativeBrowserPanelAction('navigate', { url })) {
    consoleEl.textContent = `[3F Browser 이동 요청] ${url}`;
    return;
  }
  if (!(await threefControlEnabled())) { consoleEl.textContent = '[3F Browser 제어가 꺼져 있습니다.]'; return; }
  try {
    const response = await fetch('/api/browser/threef/open', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url}) });
    const result = await response.json();
    consoleEl.textContent = response.ok ? '[3F Browser에서 열기 요청을 보냈습니다.]' : `[3F Browser 오류] ${result.error || result.stderr || '요청 실패'}`;
  } catch (error) {
    consoleEl.textContent = `[3F Browser 오류] ${error.message}`;
  } finally {
    await refreshThreefControlStatus();
  }
}

async function threefControlEnabled() {
  return threefControlAllowed;
}
function setThreefControlUi(enabled) {
  const toggle = document.getElementById('threefControlEnabled');
  if (toggle) toggle.checked = enabled;
  const openInThreef = document.getElementById('btnBrowserThreef');
  if (openInThreef) openInThreef.disabled = !enabled;
}
async function refreshThreefControlStatus() {
  try {
    const settingsResponse = await fetch('/api/browser/threef/settings', {cache:'no-store'});
    const settings = await settingsResponse.json();
    if (!settingsResponse.ok) throw new Error(settings.error || '3F Browser 설정을 읽지 못했습니다.');
    threefControlAllowed = settings.enabled === true;
    setThreefControlUi(threefControlAllowed);
    const statusElement = document.getElementById('threefControlStatus');
    if (!threefControlAllowed) {
      statusElement.textContent = '3F Browser 제어 꺼짐';
      const surface = document.getElementById('browserNativeSurface');
      if (surface) surface.textContent = '3F Browser 제어가 꺼져 있습니다. 켜면 Only Chat의 브라우저 작업이 독립 실행 중인 3F Browser 앱으로 전달됩니다.';
      return;
    }
    const response = await fetch('/api/browser/status', {cache:'no-store'});
    const status = await response.json();
    statusElement.textContent = status.statusText || '3F Browser 상태를 알 수 없습니다.';
    const surface = document.getElementById('browserNativeSurface');
    if (surface) surface.textContent = status.controlAvailable
      ? `독립 3F Browser 연결됨${status.title ? ` · ${status.title}` : ''}${status.activeUrl ? `\n${status.activeUrl}` : ''}`
      : `${status.statusText || '3F Browser 연결 상태를 알 수 없습니다.'}\n이동·읽기·페이지 조작은 연결이 확인된 뒤 사용할 수 있습니다.`;
    window.setTimeout(pollEmbeddedThreefCommands, 0);
  } catch (error) {
    threefControlAllowed = false;
    setThreefControlUi(false);
    document.getElementById('threefControlStatus').textContent = error.message || '3F Browser 상태를 확인할 수 없습니다.';
  }
}

async function handleBrowserOpenInThreef() {
  const consoleEl = document.getElementById('browserAriaConsole');
  const url = window.onlyChatResolveBrowserInput?.(document.getElementById('browserUrlInput').value) || null;
  if (!url) { consoleEl.textContent = '[주소 오류] HTTP/HTTPS 주소를 확인해 주세요.'; return; }
  if (!(await threefControlEnabled())) { consoleEl.textContent = '[3F Browser 제어가 꺼져 있습니다.]'; return; }
  try {
    const response = await fetch('/api/browser/threef/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url })
    });
    const result = await response.json();
    consoleEl.textContent = response.ok ? '[독립 3F Browser에 열기 요청을 보냈습니다.]' : `[3F Browser 오류] ${result.error || '요청 실패'}`;
  } catch (error) { consoleEl.textContent = `[3F Browser 오류] ${error.message}`; }
}

async function handleBrowserAria() {
  const consoleEl = document.getElementById('browserAriaConsole');
  consoleEl.textContent = `[3F Browser 페이지 연결 확인 중...]`;
  if (postNativeBrowserPanelAction('aria')) return;
  if (!(await threefControlEnabled())) { consoleEl.textContent = '[3F Browser 제어가 꺼져 있습니다.]'; return; }
  try {
    const res = await fetch('/api/browser/aria', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!res.ok || data.ok === false || data.blocked === true) {
      consoleEl.textContent = `[3F Browser 오류 · 접근성 정보] ${data.ariaTree || data.error || `HTTP ${res.status}`}`;
      return;
    }
    consoleEl.textContent = `[3F Browser 페이지 접근성 정보]\n\n` + (data.ariaTree || data.error || '정보 없음');
  } catch (err) {
    consoleEl.textContent = `[오류]: ${err.message}`;
  }
}

async function handleBrowserRead() {
  const consoleEl = document.getElementById('browserAriaConsole');
  if (postNativeBrowserPanelAction('read')) return;
  if (!(await threefControlEnabled())) { consoleEl.textContent = '[3F Browser 제어가 꺼져 있습니다.]'; return; }
  try {
    const res = await fetch('/api/browser/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    consoleEl.textContent = `[3F Browser 페이지 텍스트]\n\n` + (data.stdout || data.stderr || '텍스트 없음');
  } catch (err) {
    consoleEl.textContent = `[오류]: ${err.message}`;
  }
}

function sendBrowserPanelAction(action) {
  if (postNativeBrowserPanelAction(action)) return;
  if (!threefControlAllowed) { document.getElementById('browserAriaConsole').textContent = '[3F Browser 제어가 꺼져 있습니다.]'; return; }
  fetch('/api/browser/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action })
  }).then(async response => {
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(result.stderr || result.error || '3F Browser 동작 실패');
    if (result.url) document.getElementById('browserUrlInput').value = result.url;
    document.getElementById('browserAriaConsole').textContent = `[3F Browser ${action}] ${result.stdout || result.url || '완료'}`;
  }).catch(error => { document.getElementById('browserAriaConsole').textContent = `[3F Browser 오류] ${error.message}`; });
}

function postNativeBrowserPanelAction(action, payload = {}) {
  const handler = window.webkit?.messageHandlers?.browserPanel;
  if (!handler) return false;
  handler.postMessage({ action, ...payload });
  return true;
}

// The native surface is transport-only; these callbacks are also available to its adapter.
window.onlyChatEmbeddedThreefCommand = async command => {
  if (!(await threefControlEnabled())) return { error: '3F Browser 제어가 꺼져 있습니다.' };
  const action = command?.action;
  const routes = { navigate: ['/api/browser/threef/open', 'POST', { url: command.url }], aria: ['/api/browser/aria', 'POST', {}], read: ['/api/browser/read', 'POST', {}], back: ['/api/browser/history', 'POST', { action }], forward: ['/api/browser/history', 'POST', { action }], reload: ['/api/browser/history', 'POST', { action }], status: ['/api/browser/status', 'GET'], act: ['/api/browser/act', 'POST', { action: command.value }] };
  const request = routes[action];
  if (!request) return { error: '지원하지 않는 3F Browser 명령입니다.' };
  try {
    const [url, method, body] = request;
    const response = await fetch(url, { method, cache:'no-store', ...(body ? { headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}) });
    const result = await response.json();
    return response.ok ? result : { ...result, error: result.error || result.stderr || `3F Browser 요청 실패 (${response.status})` };
  } catch (error) { return { error: error.message || '3F Browser에 연결할 수 없습니다.' }; }
};

function syncNativeBrowserPanel() {
  const surface = document.getElementById('browserNativeSurface');
  if (!surface) return;
  const rect = surface.getBoundingClientRect();
  window.webkit?.messageHandlers?.browserPanel?.postMessage({
    action: 'layout',
    visible: drawerBrowser.classList.contains('open'),
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  });
  btnToggleBrowser?.setAttribute('aria-expanded', String(drawerBrowser.classList.contains('open')));
  btnToggleBrowser?.setAttribute('aria-label', drawerBrowser.classList.contains('open') ? '3F Browser 닫기' : '3F Browser 열기');
  surface.setAttribute('aria-label', drawerBrowser.classList.contains('open')
    ? 'Only Chat 안에 표시된 3F Browser. 탐색과 페이지 읽기는 현재 화면과 같은 세션을 사용합니다.'
    : '3F Browser 패널');
}

function initializeBrowserSplitLayout() {
  const layout = document.querySelector('.app-layout');
  const chat = document.querySelector('.chat-stage');
  if (!layout || !chat || !drawerBrowser) return;
  // Keep the native WKWebView aligned to a true layout sibling, not an overlay.
  layout.insertBefore(drawerBrowser, chat.nextSibling);
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'browser-split-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', '채팅과 3F Browser 크기 조절');
  handle.setAttribute('aria-valuemin', '360');
  handle.setAttribute('aria-valuemax', '900');
  handle.setAttribute('aria-valuenow', '520');
  handle.tabIndex = 0;
  layout.insertBefore(handle, drawerBrowser);
  let saved = Number(localStorage.getItem('onlyChat.browserPanelWidth'));
  if (!Number.isFinite(saved) || saved < 300) saved = Math.min(520, Math.round(layout.clientWidth * 0.42));
  const setWidth = width => {
    const max = Math.max(300, Math.min(900, layout.clientWidth - 360));
    const value = Math.round(Math.max(300, Math.min(max, width)));
    layout.style.setProperty('--browser-panel-width', `${value}px`);
    handle.setAttribute('aria-valuenow', String(value));
    try { localStorage.setItem('onlyChat.browserPanelWidth', String(value)); } catch {}
    syncNativeBrowserPanel();
  };
  setWidth(saved);
  let dragStart = null;
  handle.addEventListener('pointerdown', event => {
    event.preventDefault();
    dragStart = { x: event.clientX, width: drawerBrowser.getBoundingClientRect().width };
    drawerBrowser.style.transition = 'none';
    handle.classList.add('dragging');
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!dragStart) return;
    setWidth(dragStart.width - (event.clientX - dragStart.x));
  });
  const stopDrag = () => {
    dragStart = null;
    drawerBrowser.style.removeProperty('transition');
    handle.classList.remove('dragging');
  };
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
  handle.addEventListener('keydown', event => {
    const delta = event.shiftKey ? 64 : 24;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const current = drawerBrowser.getBoundingClientRect().width;
      setWidth(current + (event.key === 'ArrowLeft' ? delta : -delta));
    }
  });
  window.addEventListener('resize', () => setWidth(drawerBrowser.getBoundingClientRect().width || saved));
}

function setBrowserPanelOpen(open) {
  setExclusiveDrawerOpen(drawerBrowser, open);
}

function setExclusiveDrawerOpen(activeDrawer, open) {
  const drawers = [drawerSettings, drawerPriority, drawerMorph, drawerBrowser];
  const focusDrawer = activeDrawer || (!open ? drawers.find(drawer => drawer.contains(document.activeElement)) : null);
  const restoreFocus = !open && focusDrawer?.contains(document.activeElement);
  drawers.forEach(drawer => {
    const isOpen = Boolean(open && drawer === activeDrawer);
    drawer.classList.toggle('open', isOpen);
    drawer.inert = !isOpen;
    drawer.setAttribute('aria-hidden', String(!isOpen));
  });
  document.querySelector('.app-layout')?.classList.toggle('browser-split', Boolean(open && activeDrawer === drawerBrowser));
  if (open) {
    usageQuotaPopup.classList.remove('open');
    modelSelectorPopup.classList.remove('open');
    effortSelectorPopup?.classList.remove('open');
    modelPillTrigger.setAttribute('aria-expanded', 'false');
    effortPillTrigger?.setAttribute('aria-expanded', 'false');
    const workbenchPanel = document.getElementById('workbenchPanel');
    const workbenchToggle = document.getElementById('btnToggleWorkbench');
    if (workbenchPanel) workbenchPanel.hidden = true;
    workbenchToggle?.setAttribute('aria-expanded', 'false');
  }
  syncNativeBrowserPanel();
  if (restoreFocus) {
    const trigger = focusDrawer === drawerPriority ? btnTogglePriority
      : focusDrawer === drawerMorph ? btnToggleMorph
        : focusDrawer === drawerBrowser ? btnToggleBrowser : btnToggleSettings;
    trigger?.focus();
  }
}

let embeddedThreefPollRunning = false;
async function pollEmbeddedThreefCommands() {
  if (embeddedThreefPollRunning || !window.webkit?.messageHandlers?.browserPanel || !threefControlAllowed) return;
  embeddedThreefPollRunning = true;
  try {
    const response = await fetch('/api/browser/panel/next', { cache: 'no-store' });
    if (response.status === 200) {
      const command = await response.json();
      if (!threefControlAllowed) return;
      setBrowserPanelOpen(true);
      window.setTimeout(() => window.webkit.messageHandlers.browserPanel.postMessage({ action: 'agent', command }), 80);
    }
  } catch (_) {
    // The native bridge starts after the local server and the panel can reopen later.
  } finally {
    embeddedThreefPollRunning = false;
    if (threefControlAllowed) window.setTimeout(pollEmbeddedThreefCommands, 300);
  }
}

const macScreenUiRequests = new Map();
function callNativeMacScreen(action, input = {}) {
  const handler = window.webkit?.messageHandlers?.macScreen;
  if (!handler) return Promise.reject(new Error('Mac 화면 제어는 Only Chat 네이티브 macOS 앱에서 사용할 수 있습니다.'));
  const id = `ui-mac-screen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => { macScreenUiRequests.delete(id); reject(new Error('macOS 권한 확인 응답이 없습니다.')); }, 60000);
    macScreenUiRequests.set(id, { resolve, reject, timer });
    handler.postMessage({ id, action, input });
  });
}

function showMacScreenPermissionStatus(status) {
  const element = document.getElementById('macScreenControlStatus');
  if (!status || status.error) { element.textContent = status?.error || '권한 상태를 읽지 못했습니다.'; return; }
  const screen = status.screenRecording === true ? '화면 기록 허용' : '화면 기록 필요';
  const input = status.accessibility === true ? '입력 제어 허용' : '손쉬운 사용 권한 필요';
  element.textContent = `${macScreenControlAllowed ? 'AI 화면 제어 켜짐' : 'AI 화면 제어 꺼짐'} · ${screen} · ${input} · ${status.width || '?'}×${status.height || '?'}`;
}

async function loadMacScreenControlSetting() {
  const toggle = document.getElementById('macScreenControlEnabled');
  const status = document.getElementById('macScreenControlStatus');
  if (!toggle || !status) return;
  try {
    const response = await fetch('/api/mac-screen/settings', { cache: 'no-store' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '설정을 읽지 못했습니다.');
    toggle.disabled = result.nativeAvailable !== true;
    macScreenControlAllowed = result.nativeAvailable === true && result.enabled === true;
    toggle.checked = macScreenControlAllowed;
    status.textContent = result.nativeAvailable !== true ? 'Only Chat 네이티브 macOS 앱에서 사용할 수 있습니다.'
      : macScreenControlAllowed ? '켜짐 · 화면 내용이 AI 대화에 공유될 수 있습니다.' : '꺼짐 · 기본 설정';
    if (macScreenControlAllowed) window.setTimeout(pollMacScreenCommands, 0);
  } catch (error) { status.textContent = error.message; }
}

let macScreenPollRunning = false;
async function pollMacScreenCommands() {
  if (macScreenPollRunning || !macScreenControlAllowed || !window.webkit?.messageHandlers?.macScreen) return;
  macScreenPollRunning = true;
  try {
    const response = await fetch('/api/mac-screen/panel/next', { cache: 'no-store' });
    if (response.status === 200) {
      const command = await response.json();
      if (macScreenControlAllowed) {
        const actionLabels = { status: '권한 상태 확인', capture: '화면 캡처', click: '마우스 클릭', type: '키보드 입력', key: '키 입력', scroll: '화면 스크롤' };
        document.getElementById('macScreenControlStatus').textContent = `AI 작업 중 · ${actionLabels[command.action] || 'Mac 화면 제어'}`;
        window.webkit.messageHandlers.macScreen.postMessage(command);
      }
    }
  } catch (_) {
    // A transient local-server restart can recover on the next poll.
  } finally {
    macScreenPollRunning = false;
    if (macScreenControlAllowed) window.setTimeout(pollMacScreenCommands, 700);
  }
}

window.onlyChatMacScreenCommandComplete = async (id, result) => {
  const uiRequest = macScreenUiRequests.get(id);
  if (uiRequest) {
    window.clearTimeout(uiRequest.timer);
    macScreenUiRequests.delete(id);
    if (result?.error) uiRequest.reject(new Error(result.error));
    else { showMacScreenPermissionStatus(result); uiRequest.resolve(result); }
    return;
  }
  if (result?.image && result.mimeType === 'image/jpeg' && macScreenControlAllowed) {
    const preview = document.getElementById('macScreenPreview');
    preview.src = `data:${result.mimeType};base64,${result.image}`;
    preview.hidden = false;
    document.getElementById('macScreenControlStatus').textContent = `AI가 현재 화면을 확인했습니다 · ${result.width}×${result.height}`;
  } else if (result?.error && macScreenControlAllowed) {
    document.getElementById('macScreenControlStatus').textContent = result.error;
  } else if (result?.ok && macScreenControlAllowed) {
    document.getElementById('macScreenControlStatus').textContent = `AI 화면 조작 완료 · ${result.text || '완료'}`;
  }
  try {
    await fetch('/api/mac-screen/panel/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, result })
    });
  } catch (_) {}
};

const currentWindowPreviewRequests = new Map();
let currentWindowPreviewRefreshInFlight = false;
function callNativeWindowPreview(action, input = {}) {
  const handler = window.webkit?.messageHandlers?.windowPreview;
  if (!handler) return Promise.reject(new Error('현재 창 미리보기는 Only Chat macOS 앱에서 사용할 수 있습니다.'));
  const id = `ui-window-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      currentWindowPreviewRequests.delete(id);
      reject(new Error('창 미리보기 응답 시간이 초과되었습니다.'));
    }, 10000);
    currentWindowPreviewRequests.set(id, { resolve, reject, timer });
    handler.postMessage({ id, action, input });
  });
}

window.onlyChatWindowPreviewComplete = (id, result) => {
  const request = currentWindowPreviewRequests.get(id);
  if (request) {
    window.clearTimeout(request.timer);
    currentWindowPreviewRequests.delete(id);
    if (result?.error) request.reject(Object.assign(new Error(result.error), { permissionRequired: result.permissionRequired === true }));
    else request.resolve(result || {});
    return;
  }

  const button = document.getElementById('btnCurrentWindowPreview');
  const image = document.getElementById('currentWindowPreviewImage');
  const placeholder = document.getElementById('currentWindowPreviewPlaceholder');
  if (!button || !image || !placeholder) return;
  if (result?.image && result.mimeType === 'image/jpeg' && result.targetToken) {
    image.src = `data:${result.mimeType};base64,${result.image}`;
    image.hidden = false;
    placeholder.hidden = true;
    button.dataset.targetToken = result.targetToken;
    button.title = `${result.windowTitle || result.appName || '현재 창'} · 클릭하면 이 창을 앞으로 가져옵니다.`;
    button.setAttribute('aria-label', `${result.appName || '앱'} · ${result.windowTitle || '현재 창'} 미리보기. 클릭하면 앞으로 가져옵니다.`);
  } else if (result?.error) {
    image.removeAttribute('src');
    image.hidden = true;
    placeholder.hidden = false;
    placeholder.textContent = result.permissionRequired ? '화면 권한 필요' : '창 미리보기 없음';
    delete button.dataset.targetToken;
    button.title = result.error;
    button.setAttribute('aria-label', result.permissionRequired ? '화면 기록 권한을 요청하려면 클릭' : result.error);
  } else if (result?.focused) {
    button.setAttribute('aria-label', `${result.windowTitle || result.appName || '선택한 창'}을 앞으로 가져왔습니다.`);
  } else if (result?.permissionRequestIssued) {
    placeholder.textContent = result.screenRecording ? '미리보기 준비 중' : '시스템 설정에서 허용';
    button.title = result.screenRecording ? '화면 기록 권한이 확인되었습니다.' : '시스템 설정에서 Only Chat의 화면 기록을 허용한 뒤 다시 실행해 주세요.';
    button.setAttribute('aria-label', button.title);
  }
};

async function refreshCurrentWindowPreview() {
  if (currentWindowPreviewRefreshInFlight || document.visibilityState !== 'visible') return;
  currentWindowPreviewRefreshInFlight = true;
  try {
    const result = await callNativeWindowPreview('preview');
    window.onlyChatWindowPreviewComplete(`preview-${Date.now()}`, result);
  } catch (error) {
    window.onlyChatWindowPreviewComplete(`preview-${Date.now()}`, { error: error.message, permissionRequired: error.permissionRequired });
  } finally {
    currentWindowPreviewRefreshInFlight = false;
  }
}

function installCurrentWindowPreviewControl() {
  const titlebar = document.querySelector('.titlebar-right');
  if (!titlebar || document.getElementById('btnCurrentWindowPreview')) return;
  const style = document.createElement('style');
  style.textContent = `
    .current-window-preview{position:relative;width:112px;height:40px;margin-right:4px;padding:2px;overflow:hidden;border:1px solid var(--border-subtle);border-radius:7px;background:var(--bg-card);color:var(--text-muted);cursor:pointer;-webkit-app-region:no-drag}
    .current-window-preview:hover{border-color:var(--accent-orange)}
    .current-window-preview:focus-visible{outline:2px solid var(--border-focus);outline-offset:1px}
    .current-window-preview img{display:block;width:100%;height:100%;border-radius:4px;object-fit:cover}
    .current-window-preview img[hidden],.current-window-preview span[hidden]{display:none}
    .current-window-preview span{display:grid;width:100%;height:100%;place-items:center;font-size:10px}
  `;
  document.head.appendChild(style);
  const button = document.createElement('button');
  button.className = 'current-window-preview';
  button.id = 'btnCurrentWindowPreview';
  button.type = 'button';
  button.title = '화면 미리보기. 클릭하면 해당 창을 앞으로 가져옵니다.';
  button.setAttribute('aria-label', '화면 미리보기 권한 확인 중');
  const image = document.createElement('img');
  image.id = 'currentWindowPreviewImage';
  image.alt = '현재 Only Chat이 보고 있는 창 미리보기';
  image.hidden = true;
  const placeholder = document.createElement('span');
  placeholder.id = 'currentWindowPreviewPlaceholder';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.textContent = '화면 미리보기';
  button.append(image, placeholder);
  titlebar.prepend(button);
  button.addEventListener('click', async event => {
    const control = event.currentTarget;
    control.disabled = true;
    try {
      const token = control.dataset.targetToken;
      const result = token
        ? await callNativeWindowPreview('focus', { targetToken: token })
        : await callNativeWindowPreview('requestPermission');
      if (result?.error) throw new Error(result.error);
      window.onlyChatWindowPreviewComplete('', token
        ? { ...result, focused: true }
        : { ...result, permissionRequestIssued: true });
      if (!token && result?.screenRecording) window.setTimeout(refreshCurrentWindowPreview, 800);
    } catch (error) {
      window.onlyChatWindowPreviewComplete('', { error: error.message, permissionRequired: error.permissionRequired });
    } finally {
      control.disabled = false;
    }
  });
  window.setTimeout(refreshCurrentWindowPreview, 400);
  window.setInterval(refreshCurrentWindowPreview, 3000);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installCurrentWindowPreviewControl, { once: true });
else installCurrentWindowPreviewControl();

void loadMacScreenControlSetting();

window.onlyChatBrowserCommandComplete = async (id, result) => {
  try {
    await fetch('/api/browser/panel/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, result })
    });
  } catch (_) {}
};

setThreefControlUi(false);
window.setTimeout(() => { void refreshThreefControlStatus(); }, 300);

window.onlyChatBrowserResult = ({ action, text, error }) => {
  document.getElementById('browserAriaConsole').textContent = error
    ? `[브라우저 오류] ${error}`
    : action === 'aria' ? `[3F Browser 접근성 정보]\n\n${text}` : `[3F Browser 페이지 텍스트]\n\n${text}`;
};

let browserTabs = [{ id: 'tab-1', title: '새 탭', url: '' }];
let activeBrowserTabId = 'tab-1';

function renderBrowserTabs() {
  const container = document.getElementById('browserTabStrip');
  if (!container) return;
  const newTabBtn = document.getElementById('btnBrowserNewTab');
  container.querySelectorAll('.browser-tab-item').forEach(el => el.remove());
  browserTabs.forEach(tab => {
    const isActive = tab.id === activeBrowserTabId;
    const tabEl = document.createElement('div');
    tabEl.className = `browser-tab-item${isActive ? ' active' : ''}`;
    tabEl.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 8px;border-radius:6px;font-size:11px;cursor:pointer;background:${isActive ? 'var(--bg-card, #e2e8f0)' : 'var(--bg-subtle, #f1f5f9)'};border:1px solid ${isActive ? 'var(--border-main, #94a3b8)' : 'var(--border-subtle, #cbd5e1)'};font-weight:${isActive ? '600' : '400'};max-width:140px;`;
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', String(isActive));
    tabEl.setAttribute('aria-label', `${tab.title || '탭'}${isActive ? ' (현재 활성 탭)' : ''}`);
    tabEl.title = tab.url || tab.title || '새 탭';
    tabEl.tabIndex = isActive ? 0 : -1;
    tabEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        switchBrowserTab(tab.id);
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const tabs = [...container.querySelectorAll('.browser-tab-item')];
        const idx = tabs.indexOf(tabEl);
        const nextIdx = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
        tabs[nextIdx]?.focus();
      }
    });
    const titleSpan = document.createElement('span');
    titleSpan.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;';
    titleSpan.textContent = tab.title || '새 탭';
    tabEl.appendChild(titleSpan);
    tabEl.addEventListener('click', e => {
      if (e.target.closest('.browser-tab-close')) return;
      switchBrowserTab(tab.id);
    });
    if (browserTabs.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'browser-tab-close';
      closeBtn.setAttribute('aria-label', `${tab.title || '탭'} 닫기`);
      closeBtn.style.cssText = 'border:none;background:transparent;cursor:pointer;padding:0 2px;font-size:10px;line-height:1;color:var(--text-dim,#64748b);';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        closeBrowserTab(tab.id);
      });
      tabEl.appendChild(closeBtn);
    }
    if (newTabBtn) container.insertBefore(tabEl, newTabBtn);
    else container.appendChild(tabEl);
  });
}

function switchBrowserTab(tabId) {
  const target = browserTabs.find(t => t.id === tabId);
  if (!target) return;
  activeBrowserTabId = tabId;
  renderBrowserTabs();
  const url = target.url || '';
  document.getElementById('browserUrlInput').value = url;
  document.getElementById('browserAriaConsole').textContent = url ? `[3F Browser 세션] ${url}` : '[3F Browser 새 탭]';
  postNativeBrowserPanelAction('navigate', { url: url || 'about:blank' });
}

function addBrowserTab(url = '') {
  const newId = `tab-${Date.now()}`;
  browserTabs.push({ id: newId, title: url ? '새 페이지' : '새 탭', url });
  switchBrowserTab(newId);
}

function closeBrowserTab(tabId) {
  const index = browserTabs.findIndex(t => t.id === tabId);
  if (index < 0) return;
  browserTabs.splice(index, 1);
  if (browserTabs.length === 0) {
    browserTabs.push({ id: `tab-${Date.now()}`, title: '새 탭', url: '' });
  }
  if (activeBrowserTabId === tabId) {
    const nextTab = browserTabs[Math.max(0, index - 1)];
    switchBrowserTab(nextTab.id);
  } else {
    renderBrowserTabs();
  }
}

window.onlyChatBrowserNavigateResult = ({ url }) => {
  if (typeof url !== 'string') return;
  const activeTab = browserTabs.find(t => t.id === activeBrowserTabId);
  if (activeTab) {
    activeTab.url = url;
    try {
      activeTab.title = url ? (new URL(url).hostname || url) : '새 탭';
    } catch (_) { activeTab.title = url || '새 탭'; }
    renderBrowserTabs();
  }
  document.getElementById('browserUrlInput').value = url;
  document.getElementById('browserAriaConsole').textContent = url ? `[3F Browser 세션] ${url}` : '[3F Browser 새 탭]';
};

async function loadReaApps() {
  const container = document.getElementById('reaAppList');
  if (!container) return;
  try {
    const res = await fetch('/api/rea/apps');
    const apps = await res.json();
    container.innerHTML = apps.slice(0, 6).map(app => `
      <div style="background:#f4f4f5; padding:6px 10px; border-radius:6px; font-size:11px; display:flex; justify-content:space-between; align-items:center;">
        <span>${escapeHtml(app.name)}</span>
        <span style="color:var(--text-dim);">${escapeHtml(app.framework)}</span>
      </div>
    `).join('');
  } catch (_) {}
}

async function handleRegisterAccount() {
  const provider = document.getElementById('newAccProvider').value;
  const email = document.getElementById('newAccEmail').value.trim();
  const token = document.getElementById('newAccToken').value.trim();
  if (!email) return alert('이메일을 입력하세요.');
  try {
    await fetch('/api/accounts/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, email, token })
    });
    alert('현재는 설치된 Codex CLI 계정만 지원합니다. 계정/토큰은 등록되지 않았습니다.');
    document.getElementById('newAccEmail').value = '';
    document.getElementById('newAccToken').value = '';
    await refreshPriorityStatus();
  } catch (err) {
    alert('계정 등록 실패: ' + err.message);
  }
}

function escapeHtml(text) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return String(text).replace(/[&<>"']/g, m => map[m]);
}

// ==========================================================================
// Full-Stage Settings View Helpers
// ==========================================================================
function isSettingsStageOpen() {
  const stage = document.getElementById('settingsStage');
  return stage && stage.style.display !== 'none';
}

function openSettingsStage(targetTab = 'general') {
  setExclusiveDrawerOpen(null, false);
  usageQuotaPopup.classList.remove('open');
  modelSelectorPopup.classList.remove('open');
  effortSelectorPopup?.classList.remove('open');
  modelPillTrigger.setAttribute('aria-expanded', 'false');
  effortPillTrigger?.setAttribute('aria-expanded', 'false');
  const workbenchPanel = document.getElementById('workbenchPanel');
  const workbenchToggle = document.getElementById('btnToggleWorkbench');
  if (workbenchPanel) workbenchPanel.hidden = true;
  workbenchToggle?.setAttribute('aria-expanded', 'false');

  const chatStage = document.querySelector('.chat-stage');
  const settingsStage = document.getElementById('settingsStage');
  if (chatStage) chatStage.style.display = 'none';
  if (settingsStage) settingsStage.style.display = 'flex';

  // Titlebar indicator
  if (titlebarThreadTitle) {
    titlebarThreadTitle.setAttribute('data-prev', titlebarThreadTitle.innerText);
    titlebarThreadTitle.innerText = 'Only Chat · Settings';
  }

  // Switch to requested tab
  switchSettingsTab(targetTab);
  if (targetTab === 'general') void refreshWorkspaceOwnership();
  refreshStageVault();
}

// The work map reads shared records; opening it never claims or starts a task.
let workbenchSnapshot = null;
let workbenchReadAt = null;
let workbenchFilter = 'open';
let workbenchRefreshing = false;
let taskMailboxStatusSnapshot = null;
let jointDevLocalPlatform = 'mac';

function workbenchText(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function initWorkbench() {
  const panel = document.getElementById('workbenchPanel');
  const toggle = document.getElementById('btnToggleWorkbench');
  if (!panel || !toggle) return;
  const setOpen = open => {
    if (open) {
      setExclusiveDrawerOpen(null, false);
      usageQuotaPopup.classList.remove('open');
      modelSelectorPopup.classList.remove('open');
      effortSelectorPopup?.classList.remove('open');
    }
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  };
  setOpen(false);
  toggle.addEventListener('click', () => setOpen(panel.hidden));
  panel.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    toggle.focus();
  });
  document.getElementById('btnRefreshWorkbench')?.addEventListener('click', () => { void refreshWorkbench(); });
  initJointDevelopment();
  document.getElementById('btnWorkbenchSource')?.addEventListener('click', () => openSettingsStage('general'));
  document.getElementById('btnWorkbenchModules')?.addEventListener('click', () => document.getElementById('railGridBtn')?.click());
  document.querySelectorAll('[data-workbench-filter]').forEach(button => button.addEventListener('click', () => {
    workbenchFilter = button.dataset.workbenchFilter;
    document.querySelectorAll('[data-workbench-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    renderWorkbenchTasks();
  }));
  window.addEventListener('focus', () => {
    if (!document.hidden && !panel.hidden && !panel.contains(document.activeElement)) void refreshWorkbench();
  });
}

function initJointDevelopment() {
  const list = document.getElementById('jointDevTasks');
  const form = document.getElementById('jointDevForm');
  if (!list || !form) return;
  document.getElementById('btnRefreshJointDev')?.addEventListener('click', () => { void refreshJointDevelopment(); });
  document.getElementById('btnJointDevDriveInbox')?.addEventListener('click', () => { void refreshJointDevelopmentDriveInbox(); });
  document.getElementById('btnRefreshTaskMailbox')?.addEventListener('click', () => { void refreshTaskMailboxStatus(); });
  document.getElementById('btnSyncTaskMailbox')?.addEventListener('click', () => { void syncTaskMailbox(); });
  document.getElementById('taskMailboxConfigForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById('taskMailboxConfigStatus');
    const values = Object.fromEntries(new FormData(form).entries());
    status.textContent = '현재 연결된 Google 계정과 폴더의 읽기·쓰기 권한을 확인하는 중';
    try {
      const response = await fetch('/api/task-registry/mailbox/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId: values.folderId.trim(), peerHostId: values.peerHostId.trim() })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Drive 폴더를 연결하지 못했습니다.');
      status.textContent = '폴더 권한 확인 완료 · 작업이나 메시지를 보낼 때만 게시됩니다.';
      await refreshTaskMailboxStatus();
    } catch (error) { status.textContent = error.message || 'Drive 연결 실패'; }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const status = document.getElementById('jointDevFormStatus');
    const values = Object.fromEntries(new FormData(form).entries());
    const lines = value => value.split(/\r?\n/u).map(item => item.trim()).filter(Boolean);
    const body = {
      contractVersion: 2, taskKey: values.taskKey, app: values.app, title: values.title, goal: values.goal,
      sharedContract: values.sharedContract,
      acceptanceCriteria: lines(values.acceptanceCriteria),
      integrationBase: values.integrationBase,
      mac: { owner: values.macOwner, source: values.macSource, baseCommit: values.macBase, paths: lines(values.macPaths) },
      windows: { owner: values.windowsOwner, source: values.windowsSource, baseCommit: values.windowsBase, paths: lines(values.windowsPaths) }
    };
    status.textContent = '소유 경로 겹침과 기준 커밋을 확인하는 중';
    try {
      const response = await fetch('/api/joint-development/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '공동 작업 등록 실패');
      status.textContent = result.created ? '등록됨 · 양쪽 작업은 아직 시작되지 않았습니다.' : '같은 공동 작업이 이미 등록되어 있습니다.';
      await refreshJointDevelopment();
    } catch (error) { status.textContent = error.message || '공동 작업을 등록할 수 없습니다.'; }
  });
  void refreshTaskMailboxStatus();
  void refreshJointDevelopment();
}

async function refreshTaskMailboxStatus() {
  const status = document.getElementById('taskMailboxStatus');
  if (!status) return;
  try {
    const response = await fetch('/api/task-registry/mailbox', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '메일박스 상태를 읽지 못했습니다.');
    taskMailboxStatusSnapshot = data;
    status.textContent = data.configured
      ? `상대 호스트 ${data.peerHostId} · ${data.connected ? 'Google Drive 연결됨' : 'Google Drive 로그인 필요'} · 폴더 ${data.folderId}`
      : `이 기기 호스트 ID ${data.localHostId || '확인 불가'} · Drive 연결과 상대 호스트 ID 설정 필요`;
    const form = document.getElementById('taskMailboxConfigForm');
    if (form && data.configured) {
      form.elements.folderId.value = data.folderId || '';
      form.elements.peerHostId.value = data.peerHostId || '';
    }
  } catch (error) {
    taskMailboxStatusSnapshot = null;
    status.textContent = error.message || '메일박스 상태를 읽지 못했습니다.';
  }
}

async function publishTaskMailboxConversation(taskKey, viewerChatId) {
  let afterMessageId;
  const receipts = [];
  let taskReceipt = null;
  for (;;) {
    const response = await fetch(`/api/task-registry/tasks/${encodeURIComponent(taskKey)}/mailbox-publish`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewerChatId, afterMessageId, limit: 100 })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Drive 게시 실패');
    taskReceipt ||= result.task;
    receipts.push(...result.messages);
    if (!result.nextAfterMessageId || result.nextAfterMessageId === afterMessageId || result.messages.length < 100) break;
    afterMessageId = result.nextAfterMessageId;
  }
  return { task: taskReceipt, messages: receipts };
}

async function syncTaskMailbox() {
  const button = document.getElementById('btnSyncTaskMailbox');
  const status = document.getElementById('taskMailboxStatus');
  if (!button || !status) return;
  button.disabled = true;
  status.textContent = 'Drive에서 상대 호스트의 작업과 메시지를 확인하는 중';
  try {
    const response = await fetch('/api/task-registry/mailbox/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Drive 동기화 실패');
    const result = payload.sync;
    status.textContent = `수신 완료 · 작업 ${result.tasksImported}개 · 메시지 ${result.messagesImported}개 · 중복 ${result.replayed}개 · 제외 ${result.ignored}개`;
    await refreshWorkbench();
  } catch (error) { status.textContent = error.message || 'Drive 동기화 실패'; }
  finally { button.disabled = false; }
}

function createTaskMailboxConversation(row, card) {
  if (!row.creatorChatId) return null;
  const section = workbenchText('section', 'joint-dev-report', '');
  const title = workbenchText('strong', '', '작업 대화');
  const messageList = workbenchText('div', 'joint-dev-list', '대화를 열면 동기화된 메시지를 불러옵니다.');
  const status = workbenchText('small', 'workbench-resume-status', '');
  const publish = document.createElement('button');
  publish.type = 'button'; publish.textContent = '저장된 대화 Drive에 보내기';
  publish.addEventListener('click', async event => {
    event.preventDefault(); event.stopPropagation(); publish.disabled = true;
    status.textContent = '작업과 상대 호스트용 메시지를 Drive에 게시하고 읽기 확인 중';
    try {
      const result = await publishTaskMailboxConversation(row.key, row.creatorChatId);
      status.textContent = `게시 확인 · 새 메시지 ${result.messages.filter(item => item.created).length}개 · 이미 게시 ${result.messages.filter(item => item.replayed).length}개`;
    } catch (error) { status.textContent = error.message || 'Drive 게시 실패'; }
    finally { publish.disabled = false; }
  });
  const form = document.createElement('form');
  const input = document.createElement('textarea'); input.name = 'text'; input.required = true; input.maxLength = 4000; input.rows = 2; input.placeholder = '이 작업의 상대 Only Chat에 보낼 메시지';
  const send = document.createElement('button'); send.type = 'submit'; send.textContent = '메시지 저장 후 보내기';
  form.append(input, send);
  form.addEventListener('submit', async event => {
    event.preventDefault(); event.stopPropagation(); send.disabled = true;
    if (!taskMailboxStatusSnapshot?.configured || !taskMailboxStatusSnapshot.connected) {
      status.textContent = '메시지 보낼 수 없음 · 먼저 Google Drive와 상대 호스트를 연결하세요.';
      send.disabled = false;
      return;
    }
    const idempotencyKey = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    status.textContent = '작업 대화에 저장하는 중';
    try {
      const response = await fetch(`/api/task-registry/tasks/${encodeURIComponent(row.key)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderChatId: row.creatorChatId, recipientHostId: taskMailboxStatusSnapshot?.peerHostId, text: input.value, idempotencyKey: `ui-${idempotencyKey}` })
      });
      const result = await response.json();
      if (!response.ok || !result.sent) throw new Error(result.error || result.reason || '메시지를 저장하지 못했습니다.');
      input.value = '';
      try {
        await publishTaskMailboxConversation(row.key, row.creatorChatId);
        status.textContent = '메시지 Drive 게시·readback 확인 완료';
      } catch (error) { status.textContent = `메시지는 이 기기에 저장됨 · Drive 게시 실패: ${error.message}`; }
      await loadMessages();
    } catch (error) { status.textContent = error.message || '메시지 전송 실패'; }
    finally { send.disabled = false; }
  });
  section.append(title, messageList, form, publish, status);

  let loaded = false;
  async function loadMessages() {
    try {
      const query = new URLSearchParams({ viewerChatId: row.creatorChatId, limit: '100' });
      const response = await fetch(`/api/task-registry/tasks/${encodeURIComponent(row.key)}/messages?${query}`, { cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '메시지를 읽지 못했습니다.');
      messageList.replaceChildren();
      if (!result.messages.length) { messageList.textContent = '아직 동기화된 메시지가 없습니다.'; return; }
      for (const message of result.messages) {
        const line = workbenchText('p', 'joint-dev-drive', `${message.senderHostId === taskMailboxStatusSnapshot?.localHostId ? '이 기기' : '상대 기기'} · ${new Date(message.createdAt).toLocaleString('ko-KR')}`);
        line.append(workbenchText('span', '', ` ${message.text}`)); messageList.append(line);
      }
    } catch (error) { messageList.textContent = error.message || '메시지를 읽지 못했습니다.'; }
  }
  card.addEventListener('toggle', () => { if (!loaded && card.open) { loaded = true; void loadMessages(); } });
  if (card.open) { loaded = true; void loadMessages(); }
  return section;
}

async function refreshJointDevelopmentDriveInbox() {
  const inbox = document.getElementById('jointDevDriveInbox');
  if (!inbox) return;
  inbox.textContent = 'Google Drive 패킷 목록을 요청하는 중';
  try {
    const response = await fetch('/api/joint-development/drive-inbox', { cache: 'no-store' });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Drive 목록을 읽지 못했습니다.');
    inbox.replaceChildren();
    if (!data.files.length) { inbox.textContent = '새 공동 개발 패킷 없음'; return; }
    for (const file of data.files) {
      const row = document.createElement('div'); row.className = 'joint-dev-task';
      const name = document.createElement('span'); name.textContent = file.name; row.append(name);
      const receive = document.createElement('button'); receive.type = 'button'; receive.textContent = '읽고 Only Chat에 등록';
      receive.addEventListener('click', async () => {
        receive.disabled = true; receive.textContent = '패킷 검증 중';
        try {
          const result = await fetch('/api/joint-development/receive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: file.id }) });
          const data = await result.json(); if (!result.ok) throw new Error(data.error || '수신에 실패했습니다.');
          receive.textContent = '패킷 읽기 확인됨'; await refreshJointDevelopment();
        } catch (error) { receive.disabled = false; receive.textContent = error.message || '수신 실패'; }
      }); row.append(receive); inbox.append(row);
    }
  } catch (error) { inbox.textContent = error.message || 'Drive 연결 상태를 확인하세요.'; }
}

async function refreshJointDevelopment() {
  const list = document.getElementById('jointDevTasks');
  if (!list) return;
  try {
    const response = await fetch('/api/joint-development/tasks?limit=50', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error('공동 작업 기록을 읽을 수 없습니다.');
    jointDevLocalPlatform = data.localPlatform === 'windows' ? 'windows' : 'mac';
    list.replaceChildren();
    if (!data.tasks.length) { list.textContent = '등록된 공동 개발 작업 없음'; return; }
    for (const task of data.tasks) {
      const card = document.createElement('article'); card.className = 'joint-dev-task';
      const title = document.createElement('strong'); title.textContent = `${task.app} · ${task.title}`; card.append(title);
      const goal = document.createElement('p'); goal.textContent = task.goal; card.append(goal);
      if (task.sharedContract) {
        const contract = document.createElement('p'); contract.className = 'joint-dev-contract';
        contract.textContent = `공통 동작/API 계약 · ${task.sharedContract}`; card.append(contract);
      }
      if (task.acceptanceCriteria?.length) {
        const criteria = document.createElement('ul'); criteria.className = 'joint-dev-criteria';
        for (const item of task.acceptanceCriteria) { const entry = document.createElement('li'); entry.textContent = item; criteria.append(entry); }
        card.append(criteria);
      }
      const base = document.createElement('small'); base.textContent = `공통 기준 ${task.integrationBase.slice(0, 12)} · ${task.policy}`; card.append(base);
      for (const platform of ['mac', 'windows']) {
        const side = task[platform]; const row = document.createElement('p'); row.className = 'joint-dev-side';
        row.textContent = `${platform === 'mac' ? 'Mac' : 'Windows'} · ${side.owner} · ${side.state} · ${side.paths.join(', ')}`; card.append(row);
        const report = document.createElement('details'); report.className = 'joint-dev-report';
        const summary = document.createElement('summary'); summary.textContent = `${platform === 'mac' ? 'Mac' : 'Windows'} 담당 진행 기록`; report.append(summary);
        const form = document.createElement('form');
        const select = document.createElement('select'); select.name = 'state';
        for (const state of ['active', 'ready-to-share', 'drive-readback', 'receiver-read', 'applied', 'tested', 'integrated', 'blocked']) {
          const option = document.createElement('option'); option.value = state; option.textContent = state; select.append(option);
        }
        const evidence = document.createElement('input'); evidence.name = 'evidence'; evidence.placeholder = '증거 참조 (경로, 로그, 결과)'; evidence.maxLength = 1000;
        const commit = document.createElement('input'); commit.name = 'commit'; commit.placeholder = '통합 시 canonical main 커밋'; commit.maxLength = 64;
        const submit = document.createElement('button'); submit.type = 'submit'; submit.textContent = '진행 상태 기록';
        form.append(select, evidence, commit, submit);
        form.addEventListener('submit', async event => {
          event.preventDefault(); submit.disabled = true;
          try {
            const result = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/${platform}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: select.value, evidence: evidence.value, commit: commit.value }) });
            const payload = await result.json(); if (!result.ok) throw new Error(payload.error || '상태를 기록하지 못했습니다.');
            await refreshJointDevelopment();
          } catch (error) { submit.disabled = false; submit.textContent = error.message || '기록 실패'; }
        });
        report.append(form); card.append(report);
      }
      const drive = document.createElement('p'); drive.className = 'joint-dev-drive';
      drive.textContent = `Drive: ${task.drive.state} · readback ${task.drive.readback} · receiver read ${task.drive.receiverRead || 'not-checked'} · 적용·상대 확인 별도`; card.append(drive);
      for (const receipt of task.remoteReceipts || []) {
        const remote = document.createElement('p'); remote.className = 'joint-dev-drive';
        remote.textContent = `${receipt.fromPlatform} ACK · ${receipt.state} · packet ${receipt.patchFileId} · 받은 시각 ${new Date(receipt.receivedAt).toLocaleString('ko-KR')}`; card.append(remote);
      }
      for (const receipt of task.publishedReceipts || []) {
        const published = document.createElement('p'); published.className = 'joint-dev-drive';
        published.textContent = `내 ACK · ${receipt.state} · Drive readback ${receipt.readback}`; card.append(published);
      }
      const localSide = task[jointDevLocalPlatform];
      if (localSide.state === 'active' && !localSide.patch?.fileId) {
        const exportButton = document.createElement('button'); exportButton.type = 'button'; exportButton.textContent = '내 담당 파일 변경을 패킷으로 Drive에 게시';
        exportButton.addEventListener('click', async () => {
          exportButton.disabled = true; exportButton.textContent = '정본 main·기준 커밋·파일 범위 확인 중';
          try {
            const response = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '변경 패킷 생성 실패');
            await refreshJointDevelopment();
          } catch (error) { exportButton.disabled = false; exportButton.textContent = error.message || '변경 패킷 생성 실패'; }
        }); card.append(exportButton);
      }
      for (const patch of task.incomingPatches || []) {
        const incoming = document.createElement('p'); incoming.className = 'joint-dev-side';
        incoming.textContent = `${patch.sender} 패치 · ${patch.filePaths.join(', ')} · SHA-256 ${patch.patchSha256.slice(0, 12)} · ${patch.state}`; card.append(incoming);
        const preview = document.createElement('details'); preview.className = 'joint-dev-patch-preview';
        const previewSummary = document.createElement('summary'); previewSummary.textContent = '변경 diff 검토'; preview.append(previewSummary);
        const code = document.createElement('pre'); code.textContent = '열어서 정확한 변경 내용을 읽습니다.'; preview.append(code);
        preview.addEventListener('toggle', async () => {
          if (!preview.open || preview.dataset.loaded) return;
          try {
            const response = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/patches/${encodeURIComponent(patch.fileId)}`, { cache: 'no-store' });
            const data = await response.json(); if (!response.ok) throw new Error(data.error || 'diff를 읽지 못했습니다.');
            code.textContent = data.patch; preview.dataset.loaded = 'true';
          } catch (error) { code.textContent = error.message || 'diff를 읽지 못했습니다.'; }
        });
        card.append(preview);
        if (patch.state === 'receiver-read') {
          const applyButton = document.createElement('button'); applyButton.type = 'button'; applyButton.textContent = '확인 후 지정 파일을 canonical main에 적용';
          applyButton.addEventListener('click', async () => {
            applyButton.disabled = true; applyButton.textContent = 'main·기준 커밋·충돌·patch 검사 중';
            try {
              const response = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: patch.fileId }) });
              const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '안전 적용을 거부했습니다.');
              applyButton.textContent = '적용됨 · 커밋과 통합 검증은 별도'; await refreshJointDevelopment();
            } catch (error) { applyButton.disabled = false; applyButton.textContent = error.message || '적용 거부'; }
          }); card.append(applyButton);
        }
        if (patch.state === 'applied' && !(task.publishedReceipts || []).some(item => item.patchFileId === patch.fileId)) {
          const ackButton = document.createElement('button'); ackButton.type = 'button'; ackButton.textContent = '상대 기기에 적용 ACK를 Drive로 전송';
          ackButton.addEventListener('click', async () => {
            ackButton.disabled = true; ackButton.textContent = 'ACK 게시·readback 확인 중';
            try {
              const response = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileId: patch.fileId }) });
              const data = await response.json(); if (!response.ok) throw new Error(data.error || 'ACK 게시 실패');
              ackButton.textContent = `적용 ACK 완료 · ${data.receipt.readback}`; await refreshJointDevelopment();
            } catch (error) { ackButton.disabled = false; ackButton.textContent = error.message || 'ACK 게시 실패'; }
          }); card.append(ackButton);
        }
      }
      if (!task.drive.fileId) {
        const publish = document.createElement('button'); publish.type = 'button'; publish.textContent = '공동 작업 패킷을 Drive에 게시';
        publish.addEventListener('click', async () => {
          publish.disabled = true; publish.textContent = '게시·읽기 확인 중';
          try {
            const result = await fetch(`/api/joint-development/tasks/${encodeURIComponent(task.taskKey)}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
            const payload = await result.json(); if (!result.ok) throw new Error(payload.error || 'Drive 게시 실패');
            publish.textContent = payload.drive.readback === 'verified' ? 'Drive 업로드·읽기 확인 완료' : '읽기 확인 불일치';
            await refreshJointDevelopment();
          } catch (error) { publish.disabled = false; publish.textContent = error.message || 'Drive 게시 실패'; }
        }); card.append(publish);
      }
      list.append(card);
    }
  } catch (error) { list.textContent = error.message || '공동 작업 기록 연결 실패'; }
}

async function readWorkbenchSnapshot(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('snapshot_unavailable');
    return await response.json();
  } finally { clearTimeout(timeout); }
}

async function refreshWorkbench() {
  if (workbenchRefreshing || !document.getElementById('workbenchTasks')) return;
  workbenchRefreshing = true;
  const button = document.getElementById('btnRefreshWorkbench');
  button.disabled = true;
  document.getElementById('workbenchPanel').setAttribute('aria-busy', 'true');
  try {
    await Promise.allSettled([
      (async () => {
        try {
          const data = await readWorkbenchSnapshot('/api/task-registry/tasks?limit=200');
          workbenchSnapshot = window.workspaceOwnershipPresentation.presentWorkbenchTasks(data.tasks);
          workbenchReadAt = Date.now();
          renderWorkbenchTasks();
        } catch (_) {
          workbenchSnapshot = null;
          renderWorkbenchTasks();
        }
      })(),
      (async () => {
        const state = document.getElementById('workbenchSourceState');
        const detail = document.getElementById('workbenchSourceDetail');
        try {
          const data = await readWorkbenchSnapshot('/api/ownership');
          const presented = presentWorkspaceOwnershipModel(data);
          state.textContent = presented.gitText;
          detail.textContent = [priorityStatus?.sessionWorkspaceDir || priorityStatus?.workspaceDir, presented.pathLockText, presented.leaseText, presented.leaseDetail].filter(Boolean).join(' · ');
        } catch (_) {
          state.textContent = '작업공간 상태를 확인할 수 없습니다.';
          detail.textContent = '새로고침하거나 원본·변경 화면에서 확인하세요.';
        }
      })(),
      refreshMorphStatus()
    ]);
  } finally {
    workbenchRefreshing = false;
    button.disabled = false;
    document.getElementById('workbenchPanel').setAttribute('aria-busy', 'false');
  }
}

function workbenchChatLabel(chatId) {
  if (typeof chatId !== 'string' || !chatId.trim()) return '채팅 출처 미확인';
  const data = cachedUnifiedData;
  const sessions = [
    ...(Array.isArray(data?.internal) ? data.internal : []),
    ...(Array.isArray(data?.unified?.pinned) ? data.unified.pinned : []),
    ...(Array.isArray(data?.unified?.sections) ? data.unified.sections.flatMap(group => group.items || []) : []),
    ...(Array.isArray(data?.unified?.projects) ? data.unified.projects.flatMap(group => group.items || []) : [])
  ];
  const session = sessions.find(item => (item.id || item.sessionId) === chatId);
  return session?.title ? `${session.title} (${chatId})` : `제목 확인 불가 (${chatId})`;
}

function renderWorkbenchTasks() {
  const list = document.getElementById('workbenchTasks');
  if (!list) return;
  const snapshot = workbenchSnapshot;
  for (const [id, value] of [['workbenchAppCount', snapshot?.apps], ['workbenchActiveCount', snapshot?.active], ['workbenchAttentionCount', snapshot?.attention]]) {
    document.getElementById(id).textContent = value == null ? '—' : String(value);
  }
  const rows = snapshot?.rows.filter(row => workbenchFilter === 'all' || row.status !== 'completed' || row.tone === 'attention') || [];
  const expanded = new Set([...list.querySelectorAll('details[open]')].map(item => item.dataset.taskKey));
  list.replaceChildren();
  const status = document.getElementById('workbenchReadStatus');
  status.textContent = snapshot
    ? `최근 등록 최대 200건 중 ${rows.length}건 · ${new Date(workbenchReadAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 확인`
    : '작업 기록 연결을 확인해 주세요. 새로고침으로 다시 확인할 수 있습니다.';
  if (!rows.length) {
    const empty = workbenchText('div', 'workbench-empty', '');
    empty.append(workbenchText('strong', '', snapshot ? '다음 변화가 시작될 자리' : '연결을 기다리는 작업 지도'));
    empty.append(workbenchText('p', '', snapshot ? '이 필터에 해당하는 등록 작업이 없습니다. 목표와 앱별 범위를 먼저 정리해 보세요.' : '작업 상태를 읽을 수 없어 수치를 표시하지 않았습니다. 대화와 작업공간은 계속 사용할 수 있습니다.'));
    list.append(empty);
    return;
  }
  for (const row of rows.slice(0, 8)) {
    const card = document.createElement('details');
    card.className = 'workbench-task';
    card.dataset.taskKey = row.key;
    card.dataset.tone = row.tone;
    card.open = expanded.has(row.key);
    const summary = document.createElement('summary');
    const meta = workbenchText('span', 'workbench-task-meta', '');
    meta.append(workbenchText('span', 'workbench-app-name', row.app), workbenchText('span', 'workbench-task-state', row.label));
    summary.append(meta, workbenchText('strong', 'workbench-task-title', row.title));
    const flow = workbenchText('span', 'workbench-flow', '');
    flow.setAttribute('role', 'list');
    flow.setAttribute('aria-label', '등록된 작업 단계');
    ['범위', '변경', '검토', '통합'].forEach((label, index) => {
      const step = workbenchText('span', '', label);
      step.setAttribute('role', 'listitem');
      if (index === row.phase) step.setAttribute('aria-current', 'step');
      flow.append(step);
    });
    summary.append(flow);
    summary.append(workbenchText('span', 'workbench-next', `다음 · ${row.next || '다음 단계 기록 필요'}`));
    if (row.blocker) summary.append(workbenchText('span', 'workbench-blocker workbench-next', `막힘 · ${row.blocker}`));
    summary.append(workbenchText('span', 'workbench-next', `요청 채팅 ${workbenchChatLabel(row.sourceChatId)} · 담당 채팅 ${row.owner ? workbenchChatLabel(row.owner) : '미배정'} · 마지막 기록 채팅 ${row.lastUpdatedByChatId ? workbenchChatLabel(row.lastUpdatedByChatId) : '미기록'} · 임대 ${row.leaseExpiresAt ? `만료 ${new Date(row.leaseExpiresAt).toLocaleString()}` : row.owner ? '만료 시각 미확인' : '현재 임대 없음'}`));
    summary.append(workbenchText('span', 'workbench-proof-count', `검토 근거 ${row.evidence.length}개`));
    const detail = workbenchText('div', 'workbench-task-detail', '');
    detail.append(workbenchText('p', '', `요청 출처 · ${workbenchChatLabel(row.sourceChatId)} · 기기 ${row.sourceHostId || '확인 필요'} · 등록 ${row.createdAt ? new Date(row.createdAt).toLocaleString() : '시각 미확인'}`));
    detail.append(workbenchText('p', '', `마지막 기록 · ${row.lastUpdatedByChatId ? workbenchChatLabel(row.lastUpdatedByChatId) : '채팅 ID 미기록'} · 기록 기기 ${row.lastUpdatedByHostId || '기기 ID 미기록'} · ${row.lastUpdatedAt ? new Date(row.lastUpdatedAt).toLocaleString() : '시각 미확인'}`));
    if (row.owner) {
      detail.append(workbenchText('p', '', `현재 담당 채팅 · ${workbenchChatLabel(row.owner)} · 임대 만료 ${row.leaseExpiresAt ? new Date(row.leaseExpiresAt).toLocaleString() : '만료 시각 확인 필요'}`));
    } else {
      detail.append(workbenchText('p', '', `현재 담당 채팅 · 없음 · ${row.leaseExpiresAt ? `마지막 임대 만료 ${new Date(row.leaseExpiresAt).toLocaleString()}` : '현재 실행 임대 없음'}`));
    }
    detail.append(workbenchText('p', '', `원본 · ${row.repository || '기록 없음'}`));
    if (row.paths.length) detail.append(workbenchText('p', '', `변경 범위 · ${row.paths.join(', ')}`));
    if (row.owner && row.leasePaths.length) detail.append(workbenchText('p', '', `현재 임대 경로 · ${row.leasePaths.join(', ')}`));
    detail.append(workbenchText('p', '', `검토 근거 · ${row.evidence.length}개`));
    for (const ref of row.evidence) detail.append(workbenchText('p', 'workbench-evidence', ref));
    const resumerChatId = typeof currentSessionId === 'string' && currentSessionId
      && !currentSessionId.startsWith('session_') ? currentSessionId : '';
    if (row.canResume && resumerChatId) {
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.textContent = '이 채팅이 이어받아 미완료 작업 재개';
      const resumeStatus = workbenchText('small', 'workbench-resume-status', '');
      resume.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        resume.disabled = true;
        resumeStatus.textContent = '저장된 범위와 lease를 확인하고 있습니다.';
        try {
          const key = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          const response = await fetch(`/api/task-registry/tasks/${encodeURIComponent(row.key)}/resume`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerChatId: resumerChatId, idempotencyKey: `ui-resume-${key}` })
          });
          const result = await response.json();
          if (!response.ok || !result.accepted) throw new Error(presentTaskResumeFailureModel(result));
          const queuedCount = Number.isSafeInteger(result.queuedCount) ? result.queuedCount : 0;
          await refreshWorkbench();
          const refreshed = workbenchSnapshot?.rows.find(item => item.key === row.key);
          const waitingOnOtherChat = refreshed?.executionProgress.filter(item => item.status === 'blocked'
            && /작업 .+채팅 .+만료 /u.test(item.reason)) || [];
          resumeStatus.textContent = result.replayed ? '이 요청은 이미 접수된 재개입니다.'
            : `잠금 없는 미완료 작업 ${queuedCount}개를 재개했습니다.${waitingOnOtherChat.length
              ? ` 겹치는 경로의 ${waitingOnOtherChat.length}개는 담당 채팅과 만료 시각을 기록해 대기 중이며, 나머지는 계속 실행합니다.` : ''}`;
        } catch (error) {
          resumeStatus.textContent = error.message;
          resume.disabled = false;
        }
      });
      detail.append(resume, resumeStatus);
    }
    for (const executor of row.executionProgress) {
      const worker = workbenchText('section', 'workbench-executor-result', '');
      worker.append(workbenchText('strong', '', `${executor.title} · ${executor.status} · 시도 ${executor.attempt}회 · ${executor.sessionId ? workbenchChatLabel(executor.sessionId) : '출처 미확인'} · 기록 ${executor.updatedAt ? new Date(executor.updatedAt).toLocaleString() : '시각 미확인'}`));
      for (const previous of executor.history) {
        const prior = workbenchText('div', 'workbench-executor-attempt', '');
        prior.append(workbenchText('strong', '', `이전 시도 ${previous.attempt} · ${previous.status} · ${previous.sessionId ? workbenchChatLabel(previous.sessionId) : '출처 미확인'} · 기록 ${previous.updatedAt ? new Date(previous.updatedAt).toLocaleString() : '시각 미확인'}`));
        if (previous.reason) prior.append(workbenchText('p', '', `차단 사유 · ${previous.reason}`));
        if (previous.error) prior.append(workbenchText('p', '', `오류 · ${previous.error}`));
        if (previous.result) prior.append(workbenchText('pre', '', previous.result));
        worker.append(prior);
      }
      if (executor.reason) worker.append(workbenchText('p', '', `차단 사유 · ${executor.reason}`));
      if (executor.error) worker.append(workbenchText('p', '', `오류 · ${executor.error}`));
      if (executor.result) worker.append(workbenchText('pre', '', executor.result));
      detail.append(worker);
    }
    const mailboxConversation = createTaskMailboxConversation(row, card);
    if (mailboxConversation) detail.append(mailboxConversation);
    card.append(summary, detail);
    list.append(card);
  }
  if (rows.length > 8) list.append(workbenchText('p', 'workbench-footnote', `우선 확인할 8건 표시 · 해당 필터 ${rows.length}건`));
}

function renderWorkbenchModules(slots) {
  const list = document.getElementById('workbenchModules');
  if (!list) return;
  list.replaceChildren();
  if (!slots || typeof slots !== 'object' || !Object.keys(slots).length) {
    list.textContent = '모듈 상태 확인 필요';
    return;
  }
  for (const [key, slot] of Object.entries(slots)) {
    if (!slot || typeof slot !== 'object') continue;
    const item = workbenchText('span', 'workbench-module', '');
    item.append(workbenchText('span', '', ({ theme: '디자인', font: '서체', ui: '화면', features: '기능' })[key] || slot.name || key), workbenchText('small', '', `v${slot.version ?? '?'}`));
    list.append(item);
  }
}

async function refreshWorkspaceOwnership() {
  const liveStatus = document.getElementById('workspaceOwnershipLiveStatus');
  const pathLockStatus = document.getElementById('workspacePathLockStatus');
  const leaseStatus = document.getElementById('workspaceLeaseStatus');
  const leaseDetail = document.getElementById('workspaceLeaseDetail');
  const gitStatus = document.getElementById('workspaceGitStatus');
  if (!leaseStatus || !gitStatus) return;
  if (liveStatus) liveStatus.textContent = '작업 상태를 확인하고 있습니다.';
  try {
    const response = await fetch('/api/ownership');
    if (!response.ok) throw new Error('status_unavailable');
    const presented = presentWorkspaceOwnershipModel(await response.json());
    if (pathLockStatus) pathLockStatus.textContent = presented.pathLockText;
    leaseStatus.textContent = presented.leaseText;
    leaseDetail.textContent = presented.leaseDetail;
    gitStatus.textContent = presented.gitText;
    if (liveStatus) liveStatus.textContent = `${presented.pathLockText} ${presented.leaseText} ${presented.gitText}`;
  } catch (_) {
    if (pathLockStatus) pathLockStatus.textContent = '개별 파일 잠금 상태를 확인할 수 없습니다.';
    leaseStatus.textContent = '작업 상태를 알 수 없습니다.';
    leaseDetail.textContent = '';
    gitStatus.textContent = 'Git 상태를 확인할 수 없습니다.';
    if (liveStatus) liveStatus.textContent = '작업 상태와 Git 상태를 확인할 수 없습니다.';
  }
}

function closeSettingsStage() {
  const chatStage = document.querySelector('.chat-stage');
  const settingsStage = document.getElementById('settingsStage');
  if (settingsStage) settingsStage.style.display = 'none';
  if (chatStage) chatStage.style.display = 'flex';

  if (titlebarThreadTitle) {
    const prev = titlebarThreadTitle.getAttribute('data-prev');
    if (prev) titlebarThreadTitle.innerText = prev;
    else titlebarThreadTitle.innerText = 'Only Chat · 연결되는 작업실';
  }

  if (composerInput) composerInput.focus();
}

function toggleSettingsStage() {
  if (isSettingsStageOpen()) {
    closeSettingsStage();
  } else {
    openSettingsStage();
  }
}

function switchSettingsTab(tabId) {
  document.querySelector(`.settings-nav-item[data-tab="${tabId}"]`)?.closest('.settings-menu-group')?.setAttribute('open', '');
  // Hide all panels
  document.querySelectorAll('.settings-panel-view').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.settings-nav-item').forEach(i => {
    if (i.getAttribute('data-tab') === tabId) {
      i.classList.add('active');
    } else {
      i.classList.remove('active');
    }
  });

  if (tabId === 'general') {
    const p = document.getElementById('panelTabGeneral');
    if (p) p.classList.add('active');
  } else if (tabId === 'models') {
    const p = document.getElementById('panelTabModels');
    if (p) p.classList.add('active');
  } else if (tabId === 'providers') {
    const p = document.getElementById('panelTabProviders');
    if (p) p.classList.add('active');
  } else if (tabId === 'windows-sync') {
    const p = document.getElementById('panelTabWindowsSync');
    if (p) p.classList.add('active');
    void refreshWindowsInbox();
  } else if (tabId === 'passwords') {
    const p = document.getElementById('panelTabPasswords');
    if (p) p.classList.add('active');
    refreshStageVault();
  } else if (tabId === 'plugins') {
    const p = document.getElementById('panelTabPlugins');
    if (p) p.classList.add('active');
  } else if (tabId === 'threef-browser') {
    const p = document.getElementById('panelTabThreefBrowser');
    if (p) p.classList.add('active');
    void refreshThreefControlStatus();
    void loadMacScreenControlSetting();
  } else if (tabId === 'security') {
    const p = document.getElementById('panelTabSecurity');
    if (p) p.classList.add('active');
  } else if (tabId === 'appearance') {
    const p = document.getElementById('panelTabAppearance');
    if (p) p.classList.add('active');
    const toggle = document.getElementById('fantasyWarriorModeToggle');
    if (toggle) toggle.checked = fantasyWarriorMode;
  } else {
    const p = document.getElementById('panelTabGeneric');
    if (p) {
      p.classList.add('active');
      const title = document.getElementById('genericPanelTitle');
      if (title) title.innerText = tabId.charAt(0).toUpperCase() + tabId.slice(1);
    }
  }
}

async function refreshWindowsInbox() {
  try {
    const response = await fetch('/api/evolution/inbox', { cache: 'no-store' });
    const status = await response.json();
    renderWindowsInbox(status);
  } catch (error) {
    const target = document.getElementById('windowsEvolutionStatus');
    if (target) target.textContent = `수신함 조회 실패: ${error.message}`;
  }
}

function renderWindowsInbox(status) {
  if (!status) return;
  const pathInput = document.getElementById('windowsEvolutionPath');
  const statusNode = document.getElementById('windowsEvolutionStatus');
  const list = document.getElementById('windowsEvolutionPending');
  const badge = document.getElementById('windowsChangesBadge');
  const pending = Array.isArray(status.pending) ? status.pending : [];
  if (pathInput && status.relayFolder && document.activeElement !== pathInput) pathInput.value = status.relayFolder;
  if (statusNode) statusNode.textContent = status.enabled
    ? `연결됨 · ${status.deviceId} · 대기 ${pending.length}건 · Drive 클라우드 수신은 미확인${status.error ? ` · 오류: ${status.error}` : ''}`
    : status.configured ? '연결 해제됨 · 공유 폴더 경로는 저장됨' : '미연결 · 공유 폴더를 한 번 선택해 주세요';
  if (badge) { badge.hidden = pending.length === 0; badge.textContent = String(pending.length); }
  if (!list) return;
  list.replaceChildren();
  if (!pending.length) {
    const empty = document.createElement('div'); empty.style.cssText = 'color:var(--text-dim);font-size:13px;';
    empty.textContent = status.enabled ? '반영 대기 중인 새 Windows 변경이 없습니다.' : '연결 후 새 변경 사항이 여기에 기록됩니다.';
    list.appendChild(empty); return;
  }
  for (const item of pending) {
    const card = document.createElement('article'); card.style.cssText = 'border:1px solid var(--border-color);border-radius:10px;padding:12px;margin-bottom:8px;';
    const title = document.createElement('strong'); title.textContent = item.summary || item.task || item.packetId;
    const state = document.createElement('div'); state.style.cssText = 'color:var(--text-dim);font-size:12px;margin-top:5px;'; state.textContent = `상태: ${item.state || 'pending'} · Windows 장치: ${item.authorDeviceId || '확인 불가'}`;
    const files = document.createElement('div'); files.style.cssText = 'color:var(--text-dim);font-size:12px;margin-top:5px;';
    files.textContent = (item.files || []).map(file => `${file.path} (${file.newHash?.slice(0, 12) || '해시 없음'})`).join(' · ') || item.error || '파일 메타데이터 없음';
    card.append(title, state, files); list.appendChild(card);
  }
}

async function refreshStageVault() {
  const stageList = document.getElementById('stageVaultList');
  if (!stageList) return;
  try {
    const res = await fetch('/api/vault/list');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('보관함 응답 형식이 올바르지 않습니다.');
    stageList.querySelector('[data-vault-refresh-error]')?.remove();
    stageList.replaceChildren();
    if (data.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size: 13px; color: var(--text-dim); padding: 12px 0;';
      empty.textContent = '등록된 자격증명이 없습니다.';
      stageList.appendChild(empty);
      return;
    }
    for (const credential of data) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 14px;border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:6px;background:var(--bg-subtle);';
      const details = document.createElement('div');
      const service = document.createElement('span');
      service.style.cssText = 'font-weight:600;font-size:13px;color:var(--text-main);';
      service.textContent = String(credential.service || '');
      const username = document.createElement('span');
      username.style.cssText = 'font-size:12px;color:var(--text-muted);margin-left:8px;';
      username.textContent = credential.username || 'No user';
      details.append(service, username);
      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;align-items:center;gap:8px;';
      const permission = document.createElement('span');
      permission.style.cssText = credential.allowAiUse
        ? 'font-size:11px;color:var(--vault-allow-text);background:var(--vault-allow-bg);padding:2px 6px;border-radius:4px;'
        : 'font-size:11px;color:var(--vault-block-text);background:var(--vault-block-bg);padding:2px 6px;border-radius:4px;';
      permission.textContent = credential.allowAiUse ? 'AI 승인됨' : 'AI 차단됨';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-change-outline';
      remove.style.cssText = 'padding:2px 8px;font-size:11px;';
      remove.textContent = '삭제';
      remove.setAttribute('aria-label', `${credential.service || '자격증명'} 삭제`);
      remove.addEventListener('click', () => { void window.handleVaultDelete(credential.id); });
      controls.append(permission, remove);
      row.append(details, controls);
      stageList.appendChild(row);
    }
  } catch (err) {
    let errorMessage = stageList.querySelector('[data-vault-refresh-error]');
    if (!errorMessage) {
      errorMessage = document.createElement('div');
      errorMessage.dataset.vaultRefreshError = 'true';
      errorMessage.setAttribute('role', 'status');
      errorMessage.setAttribute('aria-live', 'polite');
      errorMessage.style.cssText = 'color:#ef4444;font-size:12px;';
      stageList.appendChild(errorMessage);
    }
    errorMessage.textContent = `보관함 조회 오류: ${err.message}`;
  }
}

async function handleStageVaultSave() {
  const service = document.getElementById('stageVaultService').value.trim();
  const username = document.getElementById('stageVaultUsername').value.trim();
  const secret = document.getElementById('stageVaultSecret').value.trim();
  const allowAi = document.getElementById('stageVaultAllowAi').checked;

  if (!service || !secret) {
    alert('서비스 이름과 패스키/비밀번호를 입력하세요.');
    return;
  }

  try {
    const res = await fetch('/api/vault/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service, username, secret, allowAiUse: allowAi })
    });
    const d = await res.json();
    if (!res.ok || !d.ok) throw new Error(d.error || `HTTP ${res.status}`);
    alert(`[보관함 저장 완료] ${service} 패스키가 안전하게 암호화 보관되었습니다.`);
    document.getElementById('stageVaultService').value = '';
    document.getElementById('stageVaultUsername').value = '';
    document.getElementById('stageVaultSecret').value = '';
    await Promise.all([refreshVaultList(), refreshStageVault()]);
  } catch (err) {
    alert('저장 실패: ' + err.message);
  }
}

// ==========================================================================
// Aside Models & M-Oasis 1, 2, 3 Tier Priority Selection Logic
// ==========================================================================
function providerAccountRows(providerId, status) {
  const routerProviders = providerId === 'chatgpt' ? ['chatgpt-plan']
    : providerId === 'google' ? ['antigravity-cli'] : [providerId];
  return (status?.accountRouter?.accounts || [])
    .filter(account => routerProviders.includes(account.provider) && account.provider !== 'demo');
}

function showRouterLoginUrlFallback(url, message) {
  document.getElementById('routerLoginUrlFallback')?.remove();
  const panel = document.createElement('section');
  panel.id = 'routerLoginUrlFallback';
  panel.setAttribute('role', 'status');
  panel.setAttribute('aria-live', 'polite');
  panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:10050;display:grid;gap:9px;width:min(520px,calc(100vw - 40px));padding:16px;background:var(--panel-bg,#242424);color:var(--text-color,#fff);border:1px solid var(--border-color,#666);border-radius:12px;box-shadow:0 10px 40px #0008;';
  const note = document.createElement('p');
  note.textContent = message;
  note.style.margin = '0';
  const input = document.createElement('input');
  input.type = 'url';
  input.readOnly = true;
  input.value = url;
  input.setAttribute('aria-label', 'ChatGPT 로그인 URL');
  input.style.cssText = 'width:100%;box-sizing:border-box;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-primary';
  copy.textContent = "If it didn't open, click to copy URL";
  copy.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await navigator.clipboard.writeText(url);
      copy.textContent = 'The link has been copied. Go to a browser and then paste it.';
    } catch {
      input.focus();
      input.select();
      const copied = document.execCommand('copy');
      copy.textContent = copied ? 'The link has been copied. Go to a browser and then paste it.' : '주소가 선택됐습니다. 직접 복사해 주세요';
    }
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn-secondary';
  close.textContent = '닫기';
  close.addEventListener('click', () => panel.remove());
  actions.append(copy, close);
  panel.append(note, input, actions);
  document.body.append(panel);
}

async function providerAccountAction(action, accountId) {
  if (action === 'remove' && !confirm('선택한 계정을 삭제하시겠습니까?')) return;
  try {
    const response = await fetch('/api/account-router/account', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, accountId })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '계정 작업 실패');
    if (result.pending && result.authorizationUrl) {
      showRouterLoginUrlFallback(result.authorizationUrl, result.opened === false
        ? `AI Account Router에서 로그인 창을 열지 못했습니다${result.openError ? `: ${result.openError}` : ''}. 아래 주소를 복사해 브라우저에서 계속하세요.`
        : '로그인 창이 보이지 않으면 아래 주소를 복사해 브라우저에서 계속하세요.');
    } else if (result.pending) alert('로그인 완료 후 계정 목록이 자동 갱신됩니다.');
    await refreshPriorityStatus();
    await loadStagePriorityTiers();
  } catch (error) { alert(error.message); }
}

function toggleKebabMenu(event, providerId) {
  event.stopPropagation();
  const trigger = event.currentTarget;
  document.querySelectorAll('.kebab-popover').forEach(p => {
    if (p.id !== `kebab-${providerId}`) p.classList.remove('open');
  });
  const popover = document.getElementById(`kebab-${providerId}`);
  if (!popover) return;
  const opening = !popover.classList.contains('open');
  popover.replaceChildren();
  popover.setAttribute('role', 'group');
  popover.setAttribute('aria-label', '연결된 계정');
  for (const account of providerAccountRows(providerId, priorityStatus)) {
    const row = document.createElement('div');
    row.className = 'kebab-item';
    const label = document.createElement('span');
    label.textContent = account.name || account.id;
    row.append(label);
    for (const [action, symbol, title] of [[account.provider === 'antigravity-cli' ? 'refresh-antigravity' : 'reauth', '⟳', account.provider === 'antigravity-cli' ? '현재 로그인 새로고침' : '다시 인증'], ['remove', '🗑', '계정 삭제']]) {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = symbol;
      button.setAttribute('aria-label', `${label.textContent} ${title}`);
      button.addEventListener('click', () => { void providerAccountAction(action, account.id); });
      row.append(button);
    }
    popover.append(row);
  }
  const add = document.createElement('button');
  add.type = 'button'; add.className = 'kebab-item'; add.textContent = providerId === 'google' ? '+ 현재 Antigravity 로그인 연결' : '+ 계정 추가';
  add.addEventListener('click', () => {
    if (providerId === 'chatgpt') void providerAccountAction('add-chatgpt');
    else if (providerId === 'google') void providerAccountAction('refresh-antigravity');
    else openConnectModal(providerId);
  });
  popover.append(add);
  popover.classList.toggle('open', opening);
  trigger?.setAttribute('aria-expanded', String(opening));
  popover.onkeydown = key => {
    if (key.key === 'Escape') {
      popover.classList.remove('open');
      trigger?.setAttribute('aria-expanded', 'false');
      trigger?.focus();
    }
  };
}

// Close kebabs on click outside
document.addEventListener('click', e => {
  if (!e.target.closest('.kebab-menu-wrapper')) {
    document.querySelectorAll('.kebab-popover').forEach(p => p.classList.remove('open'));
  }
});

async function setAsRank(tierOrProviderId, rank) {
  const providerProfile = priorityStatus?.tiers?.find(tier => tier.id === tierOrProviderId);
  if (!providerProfile || !Number.isInteger(rank) || rank < 1 || rank > priorityStatus.tiers.length) return;
  // Close kebab
  document.querySelectorAll('.kebab-popover').forEach(p => p.classList.remove('open'));
  
  try {
    const res = await fetch('/api/priority/set-rank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: tierOrProviderId, rank })
    });
    const d = await res.json();
    if (d.ok) {
      alert(`[M-Oasis] ${tierOrProviderId} 모델이 ${rank}순위로 성공적으로 지정되었습니다.`);
      refreshPriorityStatus();
      loadStagePriorityTiers();
    } else {
      alert('순위 지정 실패: 등록되지 않은 체인 ID입니다. "+ Connect"로 먼저 추가하세요.');
    }
  } catch (err) {
    alert('요청 오류: ' + err.message);
  }
}

function reauthProvider(providerId) {
  document.querySelectorAll('.kebab-popover').forEach(p => p.classList.remove('open'));
  if (providerId === 'chatgpt' || providerId === 'codex') {
    openCodexReauth();
    return;
  }
  // For other providers (google, claude, openrouter, etc.), prompt or open connect modal for re-authentication
  if (['claude', 'openrouter', 'ollama', 'copilot', 'gemini-fence', 'litellm'].includes(providerId)) {
    openConnectModal(providerId);
    return;
  }
  if (providerId === 'google') {
    openConnectModal('google');
    return;
  }
  openConnectModal(providerId);
}

async function disconnectProvider(providerOrTierId) {
  document.querySelectorAll('.kebab-popover').forEach(p => p.classList.remove('open'));
  const isTier = priorityStatus?.tiers?.some(t => t.id === providerOrTierId);
  const targetLabel = isTier ? (priorityStatus?.tiers?.find(t => t.id === providerOrTierId)?.name || providerOrTierId) : providerOrTierId;

  if (!confirm(`[${targetLabel}] 계정을 정말로 삭제하시겠습니까?`)) {
    return;
  }

  try {
    const payload = isTier ? { tierId: providerOrTierId } : { providerId: providerOrTierId };
    const res = await fetch('/api/priority/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await res.json();
    if (d.ok) {
      alert(`[계정 삭제 완료] ${targetLabel} 계정이 제거되었습니다.`);
      await refreshPriorityStatus();
      await loadStagePriorityTiers();
    } else {
      alert('계정 삭제에 실패했습니다: ' + (d.error || '알 수 없는 오류'));
    }
  } catch (err) {
    alert('계정 삭제 오류: ' + err.message);
  }
}

function openConnectModal(preselectProvider = 'google') {
  const modal = document.getElementById('connectModal');
  if (modal) {
    modal.style.display = 'flex';
    if (preselectProvider) {
      document.getElementById('modalProviderSelect').value = ['google', 'chatgpt', 'account-router'].includes(preselectProvider) ? preselectProvider : 'account-router';
    }
    document.getElementById('modalAccountName').focus();
  }
}

function closeConnectModal() {
  const modal = document.getElementById('connectModal');
  if (modal) modal.style.display = 'none';
}

async function handleConnectSubmit() {
  const provider = document.getElementById('modalProviderSelect').value;
  const name = document.getElementById('modalAccountName').value.trim();
  if (provider === 'account-router') {
    closeConnectModal();
    setBrowserPanelOpen(true);
    await navBrowser('http://127.0.0.1:18880/');
    return;
  }
  const button = document.getElementById('btnSubmitConnectModal');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const response = await fetch('/api/priority/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, name })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error || '계정 연결을 시작하지 못했습니다.');
    closeConnectModal();
    if (result.pending && result.authorizationUrl) {
      showRouterLoginUrlFallback(result.authorizationUrl, result.opened === false
        ? `AI Account Router에서 로그인 창을 열지 못했습니다${result.openError ? `: ${result.openError}` : ''}. 아래 주소를 복사해 브라우저에서 계속하세요.`
        : '로그인 창이 보이지 않으면 아래 주소를 복사해 브라우저에서 계속하세요.');
    } else if (result.pending) alert('로그인 완료 후 계정 목록이 갱신됩니다.');
    await refreshPriorityStatus();
    await loadStagePriorityTiers();
  } catch (error) { alert(error.message); }
  finally { button.disabled = false; }
}

// Hook connect submit
const btnSubmitConnectModal = document.getElementById('btnSubmitConnectModal');
if (btnSubmitConnectModal) {
  btnSubmitConnectModal.addEventListener('click', handleConnectSubmit);
}

let selectedScheduleId = null;
let scheduleListRequestId = 0;
let scheduleDetailRequestId = 0;
let retainedScheduleAttachments = [];
let addedScheduleAttachments = [];
const SCHEDULE_ATTACHMENT_BYTES = 64 * 1024;
const SCHEDULE_TOTAL_ATTACHMENT_BYTES = 128 * 1024;
const SCHEDULE_ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.sh', '.sql']);

function closeSchedules() {
  const modal = document.getElementById('scheduleModal');
  if (modal) modal.style.display = 'none';
  railSchedulesBtn?.classList.remove('active');
}

async function openSchedules() {
  const modal = document.getElementById('scheduleModal');
  if (!modal) return;
  modal.style.display = 'flex';
  railSchedulesBtn?.classList.add('active');
  beginScheduleEdit();
  await refreshScheduleList();
}

function scheduleFormStatus(message, isError = false) {
  const target = document.getElementById('scheduleFormStatus');
  if (!target) return;
  target.textContent = message;
  target.dataset.error = String(isError);
}

function beginScheduleEdit(schedule = null) {
  const form = document.getElementById('scheduleForm');
  if (!form) return;
  form.reset();
  selectedScheduleId = schedule?.id || null;
  retainedScheduleAttachments = (schedule?.attachments || []).map(({ id, name, size }) => ({ id, name, size }));
  addedScheduleAttachments = [];
  document.getElementById('scheduleId').value = selectedScheduleId || '';
  document.getElementById('scheduleResumeSessionId').value = schedule?.resumeSessionId || '';
  document.getElementById('scheduleTitle').value = schedule?.title || '';
  document.getElementById('schedulePrompt').value = schedule?.prompt || '';
  document.getElementById('scheduleAllowedTools').value = schedule
    ? (Array.isArray(schedule.allowedTools) ? schedule.allowedTools.join(', ') : '')
    : 'read_file';
  document.getElementById('scheduleFrequency').value = schedule?.frequency || 'once';
  const defaultRunAt = new Date(Date.now() + 30 * 60 * 1000);
  const onceAt = schedule?.runAt ? new Date(schedule.runAt) : defaultRunAt;
  const minRunAt = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  document.getElementById('scheduleOnceAt').min = minRunAt;
  document.getElementById('scheduleOnceAt').value = Number.isFinite(onceAt.getTime())
    ? new Date(onceAt.getTime() - onceAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  document.getElementById('scheduleMonthDay').value = String(schedule?.monthDay || 1);
  document.getElementById('scheduleWeekday').value = String(schedule?.weekday ?? 1);
  document.getElementById('scheduleLocalTime').value = schedule?.localTime || '09:00';
  document.getElementById('scheduleEnabled').checked = schedule?.enabled !== false;
  document.getElementById('btnDeleteSchedule').hidden = !selectedScheduleId;
  document.getElementById('btnRunSchedule').hidden = !selectedScheduleId;
  renderScheduleRecurrenceFields();
  renderScheduleAttachments();
  renderScheduleLastRun(schedule);
  scheduleFormStatus(schedule ? '수정 중' : '새 예약 작업을 입력하세요.');
}

function renderScheduleRecurrenceFields() {
  const frequency = document.getElementById('scheduleFrequency')?.value;
  const once = frequency === 'once';
  if (!once) document.getElementById('scheduleResumeSessionId').value = '';
  document.getElementById('scheduleOnceAtWrap').hidden = !once;
  document.getElementById('btnScheduleIn30').hidden = !once;
  document.getElementById('btnScheduleResumeIn30').hidden = !once;
  document.getElementById('scheduleOnceAt').required = once;
  document.getElementById('scheduleMonthDayWrap').hidden = frequency !== 'monthly';
  document.getElementById('scheduleWeekdayWrap').hidden = frequency !== 'weekly';
  document.getElementById('scheduleLocalTimeWrap').hidden = once;
  document.getElementById('scheduleLocalTime').required = !once;
}

function setScheduleRunIn30Minutes() {
  document.getElementById('scheduleResumeSessionId').value = '';
  const frequency = document.getElementById('scheduleFrequency');
  frequency.value = 'once';
  renderScheduleRecurrenceFields();
  const runAt = new Date(Date.now() + 30 * 60 * 1000);
  document.getElementById('scheduleOnceAt').value = new Date(runAt.getTime() - runAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  scheduleFormStatus('지금부터 30분 뒤 한 번 실행하도록 설정했습니다. 요청 내용과 허용 도구를 확인하고 저장하세요.');
}

function setScheduleResumeCurrentChatIn30Minutes() {
  if (!/^ses_[a-f0-9]{16}$/.test(currentSessionId || '')) {
    scheduleFormStatus('먼저 메시지를 한 번 보내 저장된 Only Chat 대화를 만든 뒤 예약해 주세요.', true);
    return;
  }
  beginScheduleEdit();
  document.getElementById('scheduleTitle').value = '현재 대화 이어서 확인';
  document.getElementById('schedulePrompt').value = '이 대화의 마지막 작업 상태를 다시 확인하고 사용자가 요청한 범위에서 계속 진행하세요. 기존 요청과 이미 완료한 내용을 먼저 확인하고, 새 승인이나 권한이 필요한 조치는 멈춰서 보고하세요.';
  document.getElementById('scheduleAllowedTools').value = 'read_file';
  document.getElementById('scheduleResumeSessionId').value = currentSessionId;
  const frequency = document.getElementById('scheduleFrequency');
  frequency.value = 'once';
  renderScheduleRecurrenceFields();
  const runAt = new Date(Date.now() + 30 * 60 * 1000);
  document.getElementById('scheduleOnceAt').value = new Date(runAt.getTime() - runAt.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  scheduleFormStatus('현재 대화를 30분 뒤 한 번 재개하도록 준비했습니다. 요청 내용과 읽기 전용 도구를 확인한 뒤 저장하세요.');
}

function renderScheduleLastRun(schedule) {
  const target = document.getElementById('scheduleLastRun');
  if (!target) return;
  if (!schedule) { target.textContent = '마지막 실행 기록 없음'; return; }
  const next = schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : '미정';
  const status = schedule.lastStatus || schedule.status || 'scheduled';
  const result = schedule.lastResult ? `\n${String(schedule.lastResult).slice(0, 800)}` : '';
  target.textContent = `상태: ${status} · 다음 실행: ${next}${result}`;
}

function renderScheduleAttachments() {
  const container = document.getElementById('scheduleAttachments');
  if (!container) return;
  container.replaceChildren();
  const items = [...retainedScheduleAttachments.map(item => ({ ...item, existing: true })), ...addedScheduleAttachments];
  for (const item of items) {
    const chip = document.createElement('span');
    chip.className = 'schedule-attachment-chip';
    const label = document.createElement('span');
    label.textContent = `${item.name} · ${formatBytes(item.size || item.bytes || 0)}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.setAttribute('aria-label', `${item.name} 첨부 제거`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      if (item.existing) retainedScheduleAttachments = retainedScheduleAttachments.filter(value => value.id !== item.id);
      else addedScheduleAttachments = addedScheduleAttachments.filter(value => value !== item);
      renderScheduleAttachments();
    });
    chip.append(label, remove);
    container.append(chip);
  }
}

function formatBytes(value) {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
}

function encodeBase64(bytes) {
  let binary = '';
  const chunk = 0x4000;
  for (let offset = 0; offset < bytes.length; offset += chunk) binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  return btoa(binary);
}

async function addScheduleFiles(fileList) {
  const files = [...(fileList || [])];
  for (const file of files) {
    const extension = `.${file.name.split('.').pop()}`.toLowerCase();
    if (!SCHEDULE_ALLOWED_EXTENSIONS.has(extension)) { scheduleFormStatus(`${file.name}: 허용되지 않는 텍스트/소스 파일 형식입니다.`, true); continue; }
    if (file.size > SCHEDULE_ATTACHMENT_BYTES) { scheduleFormStatus(`${file.name}: 파일은 64 KiB 이하여야 합니다.`, true); continue; }
    if (retainedScheduleAttachments.length + addedScheduleAttachments.length >= 5) { scheduleFormStatus('첨부 파일은 최대 5개까지 등록할 수 있습니다.', true); break; }
    const total = [...retainedScheduleAttachments.map(item => item.size), ...addedScheduleAttachments.map(item => item.size)].reduce((sum, size) => sum + size, 0);
    if (total + file.size > SCHEDULE_TOTAL_ATTACHMENT_BYTES) { scheduleFormStatus('첨부 파일 합계는 128 KiB 이하여야 합니다.', true); continue; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      addedScheduleAttachments.push({ name: file.name, size: bytes.length, contentBase64: encodeBase64(bytes) });
      scheduleFormStatus(`${file.name} 첨부 준비 완료`);
    } catch (error) { scheduleFormStatus(`${file.name}을 읽지 못했습니다: ${error.message}`, true); }
  }
  renderScheduleAttachments();
}

async function refreshScheduleList() {
  const requestId = ++scheduleListRequestId;
  const list = document.getElementById('scheduleList');
  const empty = document.getElementById('scheduleListEmpty');
  if (!list) return;
  try {
    const response = await fetch('/api/schedules');
    const data = await response.json();
    if (requestId !== scheduleListRequestId) return;
    if (!response.ok) throw new Error('schedule list request failed');
    const schedules = data?.schedules;
    if (!isValidScheduleSummaries(schedules)) throw new Error('invalid schedule list response');
    const items = schedules.map(schedule => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `schedule-list-item${schedule.id === selectedScheduleId ? ' selected' : ''}`;
      button.setAttribute('role', 'listitem');
      const title = document.createElement('strong'); title.textContent = schedule.title;
      const recurrence = schedule.frequency === 'once' ? `한 번 · ${new Date(schedule.runAt).toLocaleString()}`
        : `${schedule.frequency === 'monthly' ? `매월 ${schedule.monthDay}일` : schedule.frequency === 'weekly' ? `매주 ${['일','월','화','수','목','금','토'][schedule.weekday]}요일` : '매일'} ${schedule.localTime}`;
      const detail = document.createElement('small'); detail.textContent = `${schedule.resumeSessionId ? '현재 대화 재개 · ' : ''}${schedule.enabled ? '사용 중' : '꺼짐'} · ${recurrence}`;
      button.append(title, detail);
      button.addEventListener('click', () => { void loadSchedule(schedule.id); });
      return button;
    });
    if (selectedScheduleId && !schedules.some(schedule => schedule.id === selectedScheduleId)) {
      beginScheduleEdit();
    }
    list.replaceChildren(...items);
    if (empty) empty.hidden = schedules.length > 0;
    if (empty) empty.textContent = '등록된 반복 일정이 없습니다.';
  } catch (error) {
    if (requestId !== scheduleListRequestId) return;
    if (empty) { empty.hidden = false; empty.textContent = '스케줄 목록을 새로 고치지 못했습니다. 기존 표시를 유지합니다.'; }
  }
}

function isValidScheduleSummaries(schedules) {
  if (!Array.isArray(schedules)) return false;
  const ids = new Set();
  return schedules.every(schedule => {
    if (!schedule || typeof schedule.id !== 'string' || !schedule.id.trim() || ids.has(schedule.id)
        || typeof schedule.title !== 'string' || typeof schedule.enabled !== 'boolean'
        || !Array.isArray(schedule.allowedTools) || schedule.allowedTools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name))
        || !['daily', 'weekly', 'monthly', 'once'].includes(schedule.frequency)
        || (schedule.frequency === 'once'
          ? typeof schedule.runAt !== 'string' || !Number.isFinite(Date.parse(schedule.runAt))
          : !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.localTime || ''))) return false;
    if (schedule.frequency === 'weekly' && (!Number.isInteger(Number(schedule.weekday)) || Number(schedule.weekday) < 0 || Number(schedule.weekday) > 6)) return false;
    if (schedule.frequency === 'monthly' && (!Number.isInteger(Number(schedule.monthDay)) || Number(schedule.monthDay) < 1 || Number(schedule.monthDay) > 31)) return false;
    ids.add(schedule.id);
    return true;
  });
}

async function loadSchedule(id) {
  const requestId = ++scheduleDetailRequestId;
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(id)}`);
    const data = await response.json();
    if (requestId !== scheduleDetailRequestId) return;
    if (!response.ok) throw new Error(data.error || '일정을 읽지 못했습니다.');
    if (!isValidScheduleDetail(data?.schedule, id)) throw new Error('일정 상세 응답 형식이 올바르지 않습니다. 기존 입력을 유지합니다.');
    beginScheduleEdit(data.schedule);
    await refreshScheduleList();
  } catch (error) {
    if (requestId === scheduleDetailRequestId) scheduleFormStatus(error.message, true);
  }
}

function isValidScheduleDetail(schedule, expectedId) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return false;
  if (schedule.id !== expectedId || !isValidScheduleSummaries([schedule])) return false;
  if (typeof schedule.prompt !== 'string' || typeof schedule.nextRunAt !== 'string' || !Number.isFinite(Date.parse(schedule.nextRunAt))) return false;
  if (schedule.frequency === 'weekly' && !Number.isInteger(Number(schedule.weekday))) return false;
  if (schedule.frequency === 'monthly' && !Number.isInteger(Number(schedule.monthDay))) return false;
  if (schedule.attachments !== undefined && (!Array.isArray(schedule.attachments) || !schedule.attachments.every(item => {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.name !== 'string'
        || !Number.isInteger(item.size) || item.size < 0) return false;
    if (item.content === undefined) return true;
    if (typeof item.content !== 'string' || item.size > 64 * 1024) return false;
    return new TextEncoder().encode(item.content).byteLength === item.size;
  }))) return false;
  for (const field of ['lastStatus', 'lastResult', 'lastSessionId', 'taskId']) {
    if (schedule[field] !== undefined && schedule[field] !== null && typeof schedule[field] !== 'string') return false;
  }
  return true;
}

function schedulePayload() {
  const frequency = document.getElementById('scheduleFrequency').value;
  const payload = {
    title: document.getElementById('scheduleTitle').value,
    prompt: document.getElementById('schedulePrompt').value,
    allowedTools: document.getElementById('scheduleAllowedTools').value.split(',').map(name => name.trim()).filter(Boolean),
    resumeSessionId: document.getElementById('scheduleResumeSessionId').value || null,
    frequency,
    enabled: document.getElementById('scheduleEnabled').checked,
    attachments: [...retainedScheduleAttachments.map(({ id }) => ({ id })), ...addedScheduleAttachments.map(({ name, contentBase64 }) => ({ name, contentBase64 }))]
  };
  if (frequency === 'once') {
    const runAt = new Date(document.getElementById('scheduleOnceAt').value);
    if (!Number.isFinite(runAt.getTime()) || runAt.getTime() <= Date.now()) throw new Error('실행 시각은 현재보다 뒤로 지정해 주세요.');
    payload.runAt = runAt.toISOString();
  } else payload.localTime = document.getElementById('scheduleLocalTime').value;
  if (payload.frequency === 'monthly') payload.monthDay = Number(document.getElementById('scheduleMonthDay').value);
  if (payload.frequency === 'weekly') payload.weekday = Number(document.getElementById('scheduleWeekday').value);
  return payload;
}

async function saveSchedule() {
  const id = selectedScheduleId;
  const url = id ? `/api/schedules/${encodeURIComponent(id)}` : '/api/schedules';
  try {
    const response = await fetch(url, { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedulePayload()) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '저장하지 못했습니다.');
    beginScheduleEdit(data.schedule);
    await refreshScheduleList();
    scheduleFormStatus('스케줄을 저장했습니다.');
  } catch (error) { scheduleFormStatus(error.message, true); }
}

async function deleteSchedule() {
  if (!selectedScheduleId || !window.confirm('이 반복 스케줄과 첨부 파일을 삭제할까요?')) return;
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(selectedScheduleId)}`, { method: 'DELETE' });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '삭제하지 못했습니다.');
    beginScheduleEdit();
    await refreshScheduleList();
    scheduleFormStatus('스케줄과 첨부 파일을 삭제했습니다.');
  } catch (error) { scheduleFormStatus(error.message, true); }
}

async function runScheduleNow() {
  if (!selectedScheduleId) return;
  try {
    const response = await fetch(`/api/schedules/${encodeURIComponent(selectedScheduleId)}/run`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok || !data.accepted) throw new Error(data.reason || data.error || '이미 실행 중이거나 예약이 대기 중입니다.');
    scheduleFormStatus('작업을 실행 대기열에 넣었습니다. 완료와 승인 필요 여부는 마지막 실행 기록에 표시됩니다.');
    window.setTimeout(() => { void loadSchedule(selectedScheduleId); }, 1200);
  } catch (error) { scheduleFormStatus(error.message, true); }
}

function renderRouterAccountControls(router) {
  if (!router) return '<p>계정·모델 변경 기능을 적용하려면 Only Chat을 한 번 다시 열어주세요.</p>';
  if (!router.accounts?.length) return '<p>AI Account Router에 등록된 계정이 없습니다. Router 메뉴에서 계정을 추가하면 자동으로 연결됩니다.</p>';
  return `<section aria-label="AI Account Router 계정과 모델">
    <h4>AI Account Router · 자동 연결됨</h4>
    <p>Router 내부 계정 순서 · 잔여 한도 ${escapeHtml(router.thresholdPercent ?? 10)}% 이하이면 다음 계정으로 전환합니다.</p>
    <p data-router-save-status role="status" aria-live="polite"></p>
    <ol>${router.accounts.map((account, index) => {
      const models = account.models?.length ? account.models : [{ id: account.model, name: account.model }];
      const state = account.availability === 'available' ? '실제 요청 확인됨'
        : account.availability === 'authentication_required' ? '자격 증명 복구 필요' : '응답 미검증';
      return `<li><strong>Router 내부 ${index + 1}순위 · ${escapeHtml(account.name || account.id)}</strong>
        <span>${escapeHtml(state)} · 잔여 ${Number.isFinite(account.remainingPercent) ? `${Math.round(account.remainingPercent)}%` : '미확인'}</span>
        <label>사용 모델 <select data-router-model="${index}" aria-label="Router ${index + 1}순위 모델">${models.map(model => `<option value="${escapeHtml(model.id)}" ${model.id === account.model ? 'selected' : ''}>${escapeHtml(model.name || model.id)}</option>`).join('')}</select></label>
        <button type="button" class="btn-rank-action" data-router-move="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Router ${index + 1}순위 계정을 위로 이동">위로</button>
        <button type="button" class="btn-rank-action" data-router-move="${index}" data-direction="1" ${index === router.accounts.length - 1 ? 'disabled' : ''} aria-label="Router ${index + 1}순위 계정을 아래로 이동">아래로</button></li>`;
    }).join('')}</ol></section>`;
}

function bindRouterAccountControls(container, router) {
  if (!router?.accounts?.length) return;
  const save = async (endpoint, body) => {
    const controls = [...container.querySelectorAll('[data-router-model], [data-router-move]')];
    const disabled = controls.map(control => control.disabled);
    let saved = false;
    controls.forEach(control => { control.disabled = true; });
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Router 설정 저장 실패');
      saved = true;
      await refreshPriorityStatus();
    } catch (error) {
      const status = container.querySelector('[data-router-save-status]');
      if (status) status.textContent = error.message;
    } finally {
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      if (saved) await loadStagePriorityTiers();
    }
  };
  container.querySelectorAll('[data-router-model]').forEach(select => select.addEventListener('change', () => {
    const account = router.accounts[Number(select.dataset.routerModel)];
    if (account) void save('/api/account-router/model', { accountId: account.id, model: select.value });
  }));
  container.querySelectorAll('[data-router-move]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.routerMove);
    const next = index + Number(button.dataset.direction);
    if (!Number.isInteger(index) || next < 0 || next >= router.accounts.length) return;
    const accountIds = router.accounts.map(account => account.id);
    [accountIds[index], accountIds[next]] = [accountIds[next], accountIds[index]];
    void save('/api/account-router/reorder', { accountIds, expectedRevision: router.revision });
  }));
}

// Load Priority Tiers into Settings > Models Stage
async function loadStagePriorityTiers() {
  const container = document.getElementById('stagePriorityTiersGrid');
  if (!container) return;
  const requestId = ++stagePriorityLoadRequestId;

  try {
    const res = await fetch('/api/status');
    if (requestId !== stagePriorityLoadRequestId) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (requestId !== stagePriorityLoadRequestId) return;
    if (!Array.isArray(data?.tiers)) throw new Error('우선순위 응답 형식이 올바르지 않습니다.');
    const tiers = data.tiers;
    if (data.providers?.length) {
      const connected = data.providers.find(item => item.connected);
      const popupUsageSource = document.getElementById('popupUsageSource');
      const popupWeeklyLimit = document.getElementById('popupWeeklyLimit');
      const popupCredits = document.getElementById('popupCredits');
      if (popupUsageSource) popupUsageSource.textContent = 'Codex CLI';
      if (popupWeeklyLimit) popupWeeklyLimit.textContent = connected ? 'Connected' : data.providers[0].available ? 'Sign-in required' : 'Unavailable';
      if (popupCredits) popupCredits.textContent = 'Usage not reported';
    }
    const activeTierId = resolveModelTierFromStatus(data, selectedModelId)?.id;

    container.querySelector('[data-priority-refresh-error]')?.remove();
    container.innerHTML = tiers.map((tier, idx) => {
      const isActive = tier.id === activeTierId;
      const requestedRank = Number(tier.tier);
      const rankNum = Number.isInteger(requestedRank) && requestedRank >= 1 ? requestedRank : idx + 1;
      const isCodex = String(tier.provider || '').toLowerCase().includes('codex');
      const tierIdentity = /secondary/i.test(`${tier.id} ${tier.name}`) ? '보조 계정' : /primary/i.test(`${tier.id} ${tier.name}`) ? '주 계정' : '계정';
      const accountId = tier.account || tier.id || 'ID 정보 없음';
      const readiness = tier.providerReady;
      return `
        <div class="priority-rank-card rank-tier-${rankNum} ${isActive ? 'active-tier' : ''} ${isCodex ? 'codex-account' : 'google-account'}">
          <div class="priority-rank-badge">
            <span>${rankNum}순위</span>
            ${isActive ? `<span style="font-size: 11px; font-weight: 700; background: #f06a35; color: #fff; padding: 3px 8px; border-radius: 6px;">${data.enabled === false ? '수동 고정 계정' : '현재 자동 라우팅 계정'}</span>` : ''}
          </div>
          <div class="priority-rank-name">${rankNum}순위 · ${isCodex ? `OpenAI Codex ${tierIdentity}` : escapeHtml(tier.name || tier.provider || '계정')}</div>
          <div class="priority-rank-model"><strong>${isActive ? '현재 선택/라우팅 모델' : '폴백 모델'}</strong><span>${escapeHtml(displayPriorityModel(tier.model))}</span></div>
          <div class="priority-rank-account"><strong>${isCodex ? `이 순위의 Codex 로그인 계정 (${tierIdentity})` : '이 순위의 로그인 계정'}</strong><span>${escapeHtml(tier.email || '이메일 정보 없음')}</span></div>
          <div class="priority-rank-account-id">계정 식별자 · ${escapeHtml(accountId)}</div>
          ${isCodex ? `<div class="priority-rank-ready ${readiness?.connected ? '' : 'not-ready'}">${escapeHtml(readiness?.connected ? 'Codex 계정 확인됨 · 요청 가능' : readiness?.message || 'Codex 로그인 상태 확인 불가')}</div>` : `<div class="priority-rank-ready ${priorityRouteHealth(tier).className === 'disconnected' ? 'not-ready' : ''}">${escapeHtml(priorityRouteHealth(tier).label)}</div>`}
          <div class="priority-rank-health">${escapeHtml(tierQuotaLabel(tier))}</div>
          <div class="priority-rank-actions">
            ${tiers.map((_, rank) => `<button class="btn-rank-action" data-priority-rank="${rank + 1}" title="이 경로를 ${rank + 1}순위로 설정">${rank + 1}순위</button>`).join('')}
            <button class="btn-rank-action" data-priority-switch ${isActive && data.enabled === false ? 'disabled' : ''} title="자동 우선순위를 끄고 이 계정을 수동 선택">${isActive && data.enabled === false ? '수동 선택됨' : '수동 선택'}</button>
          </div>
          ${tier.provider === 'account-router' ? renderRouterAccountControls(data.accountRouter) : ''}
        </div>
      `;
    }).join('');
    [...container.querySelectorAll('.priority-rank-card')].forEach((card, idx) => {
      const tierId = typeof tiers[idx]?.id === 'string' ? tiers[idx].id : '';
      const rankButtons = card.querySelectorAll('[data-priority-rank]');
      rankButtons.forEach(button => {
        button.disabled = !tierId;
        button.addEventListener('click', () => { if (tierId) void setAsRank(tierId, Number(button.dataset.priorityRank)); });
      });
      const switchButton = card.querySelector('[data-priority-switch]');
      if (switchButton) {
        switchButton.disabled = switchButton.disabled || !tierId;
        switchButton.addEventListener('click', () => { if (tierId) void switchTier(tierId); });
      }
    });
    bindRouterAccountControls(container, data.accountRouter);
  } catch (err) {
    if (requestId !== stagePriorityLoadRequestId) return;
    let error = container.querySelector('[data-priority-refresh-error]');
    if (!error) {
      error = document.createElement('div');
      error.dataset.priorityRefreshError = 'true';
      error.setAttribute('role', 'status');
      error.setAttribute('aria-live', 'polite');
      error.style.cssText = 'color:#ef4444;font-size:12px;';
      container.appendChild(error);
    }
    error.textContent = `우선순위 체인 로드 오류: ${err.message}`;
  }
}

// Ensure loadStagePriorityTiers runs on page load and settings open
window.addEventListener('load', () => {
  loadStagePriorityTiers();
});

// Patch openSettingsStage to always refresh stage priority tiers
const origOpenSettingsStage = openSettingsStage;
openSettingsStage = function(targetTab = 'models') {
  origOpenSettingsStage(targetTab);
  loadStagePriorityTiers();
};
