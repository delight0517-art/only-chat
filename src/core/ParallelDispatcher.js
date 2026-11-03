/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Adaptive Memory-governed Parallel Work Dispatcher.
 * Automatically distributes queued tasks across independent workers based on real-time OS RAM headroom.
 */
'use strict';

const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const DARWIN_MEMORY_SAMPLE_INTERVAL_MS = 15_000;
const DARWIN_MEMORY_SAMPLE_TIMEOUT_MS = 1_500;

function readDarwinAvailablePercent() {
  try {
    const output = execFileSync('/usr/bin/memory_pressure', ['-Q'], {
      encoding: 'utf8',
      timeout: DARWIN_MEMORY_SAMPLE_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return parseDarwinAvailablePercent(output);
  } catch (_) {
    return null;
  }
}

function parseDarwinAvailablePercent(output) {
  const match = String(output).match(/system-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/i);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
}

function hasSuccessfulToolExecutionEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  const attemptedCount = Number(evidence.attemptedCount);
  const successfulCount = Number(evidence.successfulCount);
  const failedCount = evidence.failedCount == null
    ? attemptedCount - successfulCount
    : Number(evidence.failedCount);
  const allowedToolViolationCount = evidence.allowedToolViolationCount;
  return Number.isInteger(attemptedCount)
    && Number.isInteger(successfulCount)
    && Number.isInteger(failedCount)
    && successfulCount > 0
    && attemptedCount === successfulCount
    && failedCount === 0
    && Number.isInteger(allowedToolViolationCount)
    && allowedToolViolationCount === 0
    && Array.isArray(evidence.disallowedToolNames)
    && evidence.disallowedToolNames.length === 0
    && Array.isArray(evidence.toolNames)
    && evidence.toolNames.length > 0
    && evidence.toolNames.length <= attemptedCount
    && evidence.toolNames.every(name => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/i.test(name))
    && ['provider', 'model', 'tierId'].every(key => typeof evidence[key] === 'string' && evidence[key].trim().length > 0);
}

class ParallelDispatcher extends EventEmitter {
  constructor(options = {}) {
    super();
    this.maxGlobalConcurrency = options.maxGlobalConcurrency || 3;
    this.minHostReserveBytes = 4 * 1024 * 1024 * 1024; // 4 GiB reserve
    this.platform = options.platform || process.platform;
    this.getTotalMemory = options.getTotalMemory || os.totalmem;
    this.getFreeMemory = options.getFreeMemory || os.freemem;
    this.readAvailablePercent = options.readAvailablePercent || readDarwinAvailablePercent;
    this.now = options.now || Date.now;
    this.memorySampleIntervalMs = options.memorySampleIntervalMs || DARWIN_MEMORY_SAMPLE_INTERVAL_MS;
    this.executeTask = options.executeTask || null;
    this.canStartTask = options.canStartTask || (() => true);
    this.lastMemorySampleAt = 0;
    this.lastAvailablePercent = null;
    this.queue = []; // Array of { id, title, prompt, files, status, priority, addedAt }
    this.activeWorkers = new Map(); // id -> { id, task, startedAt, process }
    this.completedTasks = [];
    this.terminalTasks = [];
    this.isTicking = false;

    // Start periodic dispatcher loop (checks queue every 2 seconds)
    this.timer = options.autoStart === false ? null : setInterval(() => this.tick(), 2000);
    this.timer?.unref?.();
  }

  /**
   * Measure current physical RAM headroom and calculate maximum safe concurrent workers
   */
  getMemoryMetrics() {
    const totalBytes = this.getTotalMemory();
    const freeBytes = this.getFreeMemory();
    const freePercent = Math.round((freeBytes / totalBytes) * 100);
    const sampledAt = this.now();
    if (this.platform === 'darwin' && sampledAt - this.lastMemorySampleAt >= this.memorySampleIntervalMs) {
      this.lastMemorySampleAt = sampledAt;
      const percent = this.readAvailablePercent();
      this.lastAvailablePercent = Number.isFinite(percent) && percent >= 0 && percent <= 100
        ? Math.round(percent)
        : null;
    }
    const availablePercent = this.platform === 'darwin' && this.lastAvailablePercent !== null
      ? this.lastAvailablePercent
      : freePercent;
    const availableBytes = Math.floor((totalBytes * availablePercent) / 100);
    const memorySource = this.platform === 'darwin' && this.lastAvailablePercent !== null
      ? 'memory_pressure'
      : 'os.freemem';
    const totalGb = (totalBytes / (1024 ** 3)).toFixed(1);
    const freeGb = (freeBytes / (1024 ** 3)).toFixed(1);
    const availableGb = (availableBytes / (1024 ** 3)).toFixed(1);

    let allowedWorkers = 0;
    let pressureLevel = 'normal';

    if (availablePercent >= 35 && availableBytes >= this.minHostReserveBytes) {
      allowedWorkers = Math.min(3, this.maxGlobalConcurrency);
      pressureLevel = 'low (쾌적)';
    } else if (availablePercent >= 25 && availableBytes >= this.minHostReserveBytes) {
      allowedWorkers = Math.min(2, this.maxGlobalConcurrency);
      pressureLevel = 'moderate (적정)';
    } else if (availablePercent >= 15) {
      allowedWorkers = 1;
      pressureLevel = 'elevated (가벼운 작업 1개)';
    } else {
      allowedWorkers = 0;
      pressureLevel = 'critical (대기/스로틀링)';
    }

    return {
      totalBytes,
      freeBytes,
      totalGb,
      freeGb,
      freePercent,
      availableBytes,
      availableGb,
      availablePercent,
      memorySource,
      allowedWorkers,
      pressureLevel,
      activeWorkerCount: this.activeWorkers.size
    };
  }

  /**
   * Enqueue a batch of requests (e.g. Rogan's 10 candidate requests)
   */
  enqueueTasks(tasks) {
    if (!Array.isArray(tasks) || tasks.some(task => !Array.isArray(task?.allowedTools)
      || task.allowedTools.length < 1 || task.allowedTools.length > 32
      || task.allowedTools.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/i.test(name)))) {
      throw new TypeError('Each queued task requires 1–32 valid allowedTools names.');
    }
    const enqueued = [];
    for (const t of tasks) {
      const taskObj = {
        id: t.id || `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        title: t.title || t.prompt?.substring(0, 40) || '무제 작업',
        prompt: t.prompt || t.title,
        targetFiles: Array.isArray(t.files) ? t.files : [],
        allowedTools: [...new Set(t.allowedTools)],
        requireToolExecution: t.requireToolExecution !== false,
        status: 'queued', // 'queued' | 'running' | 'completed' | 'blocked'
        blockReason: null,
        addedAt: Date.now()
      };
      this.queue.push(taskObj);
      enqueued.push(taskObj);
    }
    this.emit('queue_updated', { queueLength: this.queue.length });
    this.tick();
    return enqueued;
  }

  /**
   * Dispatcher loop: matches queued tasks to available concurrency slots
   */
  async tick() {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const mem = this.getMemoryMetrics();
      const availableSlots = Math.max(0, mem.allowedWorkers - this.activeWorkers.size);

      if (availableSlots <= 0 || this.queue.length === 0) {
        return;
      }

      // Find ready tasks from queue
      const pendingTasks = this.queue.filter(t => t.status === 'queued' && this.canStartTask(t));
      const tasksToStart = pendingTasks.slice(0, availableSlots);

      for (const task of tasksToStart) {
        await this._startWorker(task);
      }
    } finally {
      this.isTicking = false;
    }
  }

  async _startWorker(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    this.activeWorkers.set(task.id, {
      id: task.id,
      task,
      startedAt: task.startedAt
    });

    this.emit('worker_started', { task, activeCount: this.activeWorkers.size });

    void this._runWorker(task);
  }

  async _runWorker(task) {
    try {
      if (typeof this.executeTask !== 'function') {
        task.status = 'blocked';
        task.blockReason = '작업 실행기가 연결되지 않았습니다.';
        this.emit('worker_blocked', { task, reason: task.blockReason });
        this.terminalTasks.push(task);
      } else {
        const result = await this.executeTask(task);
        const reportedStatus = typeof result === 'string' ? result : result?.status;
        if (result && typeof result === 'object') {
          task.executionEvidence = result.executionEvidence || null;
          task.sessionId = result.sessionId || task.sessionId || null;
          if (typeof result.result === 'string') task.result = result.result;
        }
        if (reportedStatus === 'completed') {
          if (task.requireToolExecution !== false && !hasSuccessfulToolExecutionEvidence(result?.executionEvidence)) {
            task.status = 'blocked';
            task.blockReason = Number(result?.executionEvidence?.allowedToolViolationCount || 0) > 0
              ? '작업 허용 목록 밖 도구 이벤트가 있어 완료로 표시하지 않았습니다.'
              : '성공한 도구 실행 증거나 실행 계정 메타데이터가 부족해 완료로 표시하지 않았습니다.';
            task.executionEvidence = result?.executionEvidence || null;
            task.completedAt = undefined;
            this.emit('worker_blocked', { task, reason: task.blockReason, result });
            this.terminalTasks.push(task);
            return;
          }
          task.status = 'completed';
          task.completedAt = Date.now();
          task.result = result?.result;
          this.completedTasks.push(task);
          this.emit('worker_completed', { task, result });
        } else if (reportedStatus === 'blocked') {
          task.status = 'blocked';
          task.blockReason = result?.reason || result?.error || 'AgentEngine이 작업을 차단했습니다.';
          this.emit('worker_blocked', { task, reason: task.blockReason, result });
          this.terminalTasks.push(task);
        } else {
          const error = result?.error || `AgentEngine이 완료를 보고하지 않았습니다${reportedStatus ? ` (status: ${reportedStatus})` : ''}.`;
          task.status = 'failed';
          task.error = error;
          this.emit('worker_failed', { task, error, result });
          this.terminalTasks.push(task);
        }
      }
    } catch (err) {
      task.status = 'failed';
      task.error = err?.message || String(err);
      this.emit('worker_failed', { task, error: err });
      this.terminalTasks.push(task);
    } finally {
      this.activeWorkers.delete(task.id);
      this.queue = this.queue.filter(q => q.id !== task.id);
      this.emit('queue_updated', { queueLength: this.queue.length });
      this.tick();
    }
  }

  getSnapshot() {
    const mem = this.getMemoryMetrics();
    return {
      memory: mem,
      queue: this.queue,
      activeWorkers: Array.from(this.activeWorkers.values()),
      completedCount: this.completedTasks.length,
      completedTasks: this.completedTasks,
      terminalTasks: this.terminalTasks
    };
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}

module.exports = { ParallelDispatcher, parseDarwinAvailablePercent, readDarwinAvailablePercent, hasSuccessfulToolExecutionEvidence };
