/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description 3-Tier Priority Chain Engine ported directly from Rogan's M-Oasis architecture.
 * Manages autonomous fallback between Antigravity (Google) and ChatGPT/Codex accounts.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

/**
 * Rogan's Default 3-Tier Priority Chain preset from M-Oasis:
 */
const DEFAULT_PRESET_TIERS = [
  {
    tier: 1,
    id: 'antigravity-flash-med',
    name: '1순위: Antigravity (Google)',
    provider: 'antigravity-cli',
    model: 'gemini-3.8-flash-medium',
    account: '',
    email: 'rogan2534@gmail.com',
    enabled: true,
    description: 'Antigravity CLI (Google rogan2534@gmail.com) - Gemini 3.8 Flash Medium (초고속/무제한)'
  },
  {
    tier: 2,
    id: 'codex-secondary',
    name: '2순위: Codex (Secondary)',
    provider: 'codex',
    model: 'gpt-6-luna',
    account: 'b10000024d37',
    email: 'f123123ff@gmail.com',
    enabled: true,
    description: 'Codex Secondary Account (f123123ff@gmail.com) - GPT-6 Luna'
  },
  {
    tier: 3,
    id: 'codex-primary',
    name: '3순위: Codex (Primary)',
    provider: 'codex',
    model: 'gpt-6-luna',
    account: '',
    email: 'rogan2534@gmail.com',
    enabled: true,
    description: 'Codex Primary Subscription (rogan2534@gmail.com) - GPT-6 Luna (최종 방어선)'
  }
];

function notifyMac(title, body) {
  if (process.platform !== 'darwin') return;
  const escape = val => String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('/usr/bin/osascript', [
    '-e',
    `display notification "${escape(body)}" with title "${escape(title)}"`
  ], { timeout: 5000 }, () => {});
}

class PriorityChainEngine {
  constructor(options = {}) {
    this.configDir = options.configDir || options.dataDir || path.join(os.homedir(), '.my-codex');
    this.seedDefaults = options.seedDefaults !== false;
    this.configFile = path.join(this.configDir, 'priority_chain.json');
    this.thresholdPercent = options.thresholdPercent ?? 10; // Switch when <= 10% quota remaining
    this.notify = options.notify || notifyMac;
    this.isTierReady = options.isTierReady || (() => true);
    this.tierHealth = new Map();
    this.switchHistory = [];
    this.lastActiveTierId = null;

    this.chain = this._load();
    this._normalizeRanks();
    this._initHealthStates();
  }

  _ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true, mode: 0o700 });
    }
  }

  _load() {
    this._ensureDir();
    if (fs.existsSync(this.configFile)) {
      try {
        const raw = fs.readFileSync(this.configFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.tiers) && parsed.tiers.length > 0) {
          return {
            enabled: parsed.enabled !== false,
            mode: parsed.mode || 'priority-first',
            manualTierId: typeof parsed.manualTierId === 'string' ? parsed.manualTierId : null,
            routerAutoLinked: parsed.routerAutoLinked === true,
            thresholds: parsed.thresholds || { totalRemainingPercent: 10, fiveHourRemainingPercent: 10 },
            tiers: parsed.tiers,
            tierHealth: parsed.tierHealth && typeof parsed.tierHealth === 'object' ? parsed.tierHealth : {},
            updatedAt: parsed.updatedAt || Date.now()
          };
        }
      } catch (err) {
        console.warn('[PriorityChain] Failed to load config, using default preset:', err.message);
      }
    }
    const defaultChain = {
      enabled: true,
      mode: 'priority-first',
      manualTierId: null,
      thresholds: { totalRemainingPercent: 10, fiveHourRemainingPercent: 10 },
      tiers: this.seedDefaults ? JSON.parse(JSON.stringify(DEFAULT_PRESET_TIERS)) : [],
      tierHealth: {},
      updatedAt: Date.now()
    };
    this._save(defaultChain);
    return defaultChain;
  }

  _save(data = this.chain) {
    this._ensureDir();
    const persisted = {
      ...data,
      tierHealth: Object.fromEntries([...this.tierHealth.entries()].map(([id, health]) => [id, { ...health }]))
    };
    fs.writeFileSync(this.configFile, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  }

  _normalizeRanks() {
    this.chain.tiers.sort((a, b) => (Number(a.tier) || Infinity) - (Number(b.tier) || Infinity));
    this.chain.tiers.forEach((tier, index) => {
      tier.tier = index + 1;
      if (tier.name) tier.name = tier.name.replace(/^\d+순위:\s*/, '');
    });
  }

  adoptAccountRouter() {
    if (this.chain.routerAutoLinked) return false;
    const router = this.chain.tiers.find(tier => tier.provider === 'account-router');
    if (!router) return false;
    this.setTierRank(router.id, 1);
    this.chain.routerAutoLinked = true;
    this._save();
    return true;
  }

  _initHealthStates() {
    for (const tier of this.chain.tiers) {
      if (!this.tierHealth.has(tier.id)) {
        const saved = this.chain.tierHealth?.[tier.id];
        this.tierHealth.set(tier.id, {
          totalRemainingPercent: null,
          fiveHourRemainingPercent: null,
          isThrottled: false,
          quotaState: 'unknown',
          throttledReason: null,
          cooldownUntil: null,
          nextResetAt: null,
          lastQuotaRefreshAttemptAt: null,
          lastQuotaRefreshAt: null,
          quotaRefreshError: null,
          lastCheckedAt: null,
          ...(saved && typeof saved === 'object' ? saved : {})
        });
      }
    }
  }

  /**
   * Resolve the active tier based on priority and health/quota state
   */
  resolveActiveTier(overrideTierId = null, preferredModel = null, options = {}) {
    const now = Date.now();
    let healthChanged = false;
    const normalizedPreferredModel = typeof preferredModel === 'string' ? preferredModel.trim().toLowerCase() : '';
    const matchesPreferredModel = tier => !normalizedPreferredModel
      || String(tier?.model || '').trim().toLowerCase() === normalizedPreferredModel;
    const allowedProviderIds = Array.isArray(options.allowedProviderIds) ? new Set(options.allowedProviderIds) : null;
    const matchesAllowedProvider = tier => !allowedProviderIds || allowedProviderIds.has(tier?.id);

    // Check for expired cooldowns
    for (const [id, health] of this.tierHealth.entries()) {
      if (health.isThrottled && health.cooldownUntil && now >= health.cooldownUntil) {
        health.isThrottled = false;
        health.totalRemainingPercent = null;
        health.fiveHourRemainingPercent = null;
        health.quotaState = 'unknown';
        health.throttledReason = null;
        health.cooldownUntil = null;
        health.nextResetAt = null;
        healthChanged = true;
        console.log(`[PriorityChain] Cooldown expired for tier '${id}', returning to available pool.`);
      }
    }
    if (healthChanged) this._save();

    if (!this.chain.enabled) {
      const manual = this.chain.tiers.find(t => t.id === (overrideTierId || this.chain.manualTierId) && t.enabled && matchesAllowedProvider(t));
      const health = manual ? this.tierHealth.get(manual.id) : null;
      if (manual && matchesPreferredModel(manual) && health && !health.isThrottled && this.isTierReady(manual)
        && (!Number.isFinite(health.totalRemainingPercent) || health.totalRemainingPercent > this.thresholdPercent)) {
        this.lastActiveTierId = manual.id;
        return manual;
      }
      this.lastActiveTierId = null;
      return null;
    }

    if (overrideTierId && this.chain.enabled) {
      const explicit = this.chain.tiers.find(t => t.id === overrideTierId && t.enabled);
      const health = explicit ? this.tierHealth.get(explicit.id) : null;
      if (explicit && matchesPreferredModel(explicit) && matchesAllowedProvider(explicit) && health && !health.isThrottled && this.isTierReady(explicit)) {
        this.lastActiveTierId = explicit.id;
        return explicit;
      }
    }

    // Traverse sorted tiers by priority (1 -> 2 -> 3)
    const sorted = [...this.chain.tiers]
      .filter(t => t.enabled && matchesAllowedProvider(t))
      .sort((a, b) => a.tier - b.tier);

    for (const tier of sorted) {
      if (!matchesPreferredModel(tier)) continue;
      const health = this.tierHealth.get(tier.id) || { isThrottled: false, totalRemainingPercent: null };
      if (!health.isThrottled && this.isTierReady(tier) && (!Number.isFinite(health.totalRemainingPercent) || health.totalRemainingPercent > this.thresholdPercent)) {
        if (this.lastActiveTierId && this.lastActiveTierId !== tier.id) {
          const oldTier = this.chain.tiers.find(t => t.id === this.lastActiveTierId);
          const msg = `모델 전환: [${oldTier?.name || this.lastActiveTierId}] ➔ [${tier.name}]`;
          console.log(`[PriorityChain] ${msg}`);
          this.notify('Only Chat · 우선순위 체인 전환', msg);
          this.switchHistory.push({ from: this.lastActiveTierId, to: tier.id, at: now });
        }
        this.lastActiveTierId = tier.id;
        return tier;
      }
    }

    // Never report an exhausted or throttled tier as active when the chain is unavailable.
    this.lastActiveTierId = null;
    return null;
  }

  /**
   * Set or reorder tiers explicitly (e.g. from UI settings)
   */
  setTiers(tiers) {
    if (!Array.isArray(tiers) || tiers.length === 0) return false;
    this.chain.tiers = tiers;
    this._normalizeRanks();
    this.chain.updatedAt = Date.now();
    this._save();
    this._initHealthStates();
    return true;
  }

  /**
   * Add or update a provider/model tier
   */
  upsertTier(tierData) {
    const idx = this.chain.tiers.findIndex(t => t.id === tierData.id);
    if (idx >= 0) {
      this.chain.tiers[idx] = { ...this.chain.tiers[idx], ...tierData };
    } else {
      const nextTierNum = this.chain.tiers.length + 1;
      this.chain.tiers.push({
        tier: tierData.tier || nextTierNum,
        id: tierData.id || `tier-${Date.now()}`,
        name: tierData.name || `${nextTierNum}순위: ${tierData.provider || 'Custom'}`,
        provider: tierData.provider || 'custom',
        model: tierData.model || 'auto',
        account: tierData.account || '',
        email: tierData.email || '',
        enabled: tierData.enabled !== false,
        description: tierData.description || ''
      });
    }
    this._normalizeRanks();
    this.chain.updatedAt = Date.now();
    this._save();
    this._initHealthStates();
    return true;
  }

  /**
   * Assign rank (1순위, 2순위, 3순위) to a specific tier
   */
  setTierRank(tierId, rank) {
    if (!Number.isInteger(rank) || rank < 1 || rank > this.chain.tiers.length) return false;
    const targetIdx = this.chain.tiers.findIndex(t => t.id === tierId);
    if (targetIdx < 0) return false;
    const target = this.chain.tiers.splice(targetIdx, 1)[0];
    const newIdx = Math.max(0, Math.min(this.chain.tiers.length, rank - 1));
    this.chain.tiers.splice(newIdx, 0, target);
    // Re-index
    this.chain.tiers.forEach((t, i) => {
      t.tier = i + 1;
      if (t.name) t.name = t.name.replace(/^\d+순위:\s*/, '');
    });
    this.chain.updatedAt = Date.now();
    this._save();
    return true;
  }

  setAutomaticPriority(enabled) {
    if (typeof enabled !== 'boolean') return false;
    if (!enabled) {
      const active = this.resolveActiveTier();
      if (active) this.chain.manualTierId = active.id;
      this.chain.enabled = false;
      this.chain.mode = 'manual';
    } else {
      this.chain.enabled = true;
      this.chain.mode = 'priority-first';
    }
    this.chain.updatedAt = Date.now();
    this._save();
    return true;
  }

  setManualTier(tierId) {
    const tier = this.chain.tiers.find(item => item.id === tierId && item.enabled);
    const health = tier && this.tierHealth.get(tier.id);
    if (!tier || !health || health.isThrottled || (Number.isFinite(health.totalRemainingPercent) && health.totalRemainingPercent <= this.thresholdPercent)
      || !this.isTierReady(tier)) return false;
    this.chain.enabled = false;
    this.chain.mode = 'manual';
    this.chain.manualTierId = tier.id;
    this.chain.updatedAt = Date.now();
    this.lastActiveTierId = tier.id;
    this._save();
    return true;
  }

  /**
   * Report an error or rate limit for a tier to trigger autonomous failover
   */
  reportTierFailure(tierId, error) {
    const health = this.tierHealth.get(tierId);
    if (!health) return;

    const errMsg = String(error?.message || error || '');
    const isRateLimit = /\b429\b|too many requests|quota|rate[\s_-]?limit|resource.?exhausted|token.{0,40}(?:exhaust|deplet|limit)|(?:exhaust|deplet).{0,40}token/i.test(errMsg);
    if (isRateLimit) return this.markTierQuotaExhausted(tierId, 'provider');

    // Brief cooldown for a transient provider or network error.
    const cooldownMs = 2 * 60 * 1000;
    const unconfigured = error?.code === 'provider_unconfigured';
    health.isThrottled = true;
    health.totalRemainingPercent = null;
    health.fiveHourRemainingPercent = null;
    health.quotaState = unconfigured ? 'provider-unconfigured' : 'provider-unavailable';
    health.throttledReason = unconfigured ? 'provider-unconfigured' : 'provider-error';
    health.cooldownUntil = unconfigured ? null : Date.now() + cooldownMs;
    health.lastCheckedAt = Date.now();
    this._save();

    const tier = this.chain.tiers.find(t => t.id === tierId);
    const fallback = this.chain.enabled;
    console.warn(`[PriorityChain] Tier '${tier?.name || tierId}' unavailable (${health.throttledReason}). ${fallback ? 'Triggering auto-fallback.' : 'Automatic failover is disabled.'}`);
    this.notify('Only Chat · 우선순위 전환', fallback
      ? `[${tier?.name || tierId}] 사용 불가. 다음 우선순위 계정으로 전환합니다.`
      : `[${tier?.name || tierId}] 사용 불가. 자동 전환이 꺼져 있어 계정을 직접 선택해야 합니다.`);

    return this.resolveActiveTier();
  }

  markTierQuotaExhausted(tierId, source = 'provider') {
    const health = this.tierHealth.get(tierId);
    if (!health) return null;
    health.isThrottled = true;
    health.totalRemainingPercent = null;
    health.fiveHourRemainingPercent = null;
    health.quotaState = source === 'user-report' ? 'limit-reported' : 'limit-detected';
    health.throttledReason = source === 'user-report' ? 'user-reported-quota-exhaustion' : 'provider-rate-limit';
    health.nextResetAt = null;
    // A user-reported exhausted quota has no known reset time. Keep it out of
    // rotation until a fresh quota snapshot or successful provider response clears it.
    health.cooldownUntil = source === 'user-report' ? null : Date.now() + 15 * 60 * 1000;
    health.lastCheckedAt = Date.now();
    this._save();

    const tier = this.chain.tiers.find(t => t.id === tierId);
    const fallback = this.chain.enabled;
    console.warn(`[PriorityChain] Tier '${tier?.name || tierId}' quota unavailable (${health.throttledReason}). ${fallback ? 'Triggering auto-fallback.' : 'Automatic failover is disabled.'}`);
    this.notify('Only Chat · 우선순위 전환', fallback
      ? `[${tier?.name || tierId}] 사용 한도 소진. 다음 우선순위 계정으로 전환합니다.`
      : `[${tier?.name || tierId}] 사용 한도 소진. 자동 전환이 꺼져 있어 계정을 직접 선택해야 합니다.`);
    return this.resolveActiveTier();
  }

  /**
   * Update known quota for a tier (e.g. from app-server snapshot)
   */
  updateTierQuota(tierId, remainingPercent, details = {}) {
    const health = this.tierHealth.get(tierId);
    if (health && Number.isFinite(remainingPercent)) {
      health.totalRemainingPercent = Math.max(0, Math.min(100, remainingPercent));
      health.fiveHourRemainingPercent = Number.isFinite(details.fiveHourRemainingPercent)
        ? Math.max(0, Math.min(100, details.fiveHourRemainingPercent)) : null;
      health.nextResetAt = typeof details.nextResetAt === 'string' && Number.isFinite(Date.parse(details.nextResetAt))
        ? new Date(details.nextResetAt).toISOString() : null;
      health.lastQuotaRefreshAttemptAt = Date.now();
      health.lastQuotaRefreshAt = Date.now();
      health.quotaRefreshError = null;
      health.lastCheckedAt = Date.now();
      if (health.totalRemainingPercent <= this.thresholdPercent) {
        health.isThrottled = true;
        health.quotaState = 'below-threshold';
        health.throttledReason = `Remaining quota ${health.totalRemainingPercent}% <= threshold ${this.thresholdPercent}%`;
        health.cooldownUntil = null;
      } else if (health.quotaState === 'below-threshold' || health.quotaState === 'limit-detected' || health.quotaState === 'limit-reported') {
        health.isThrottled = false;
        health.quotaState = 'known';
        health.throttledReason = null;
        health.cooldownUntil = null;
      }
      this._save();
    }
  }

  markQuotaRefreshAttempt(tierId) {
    const health = this.tierHealth.get(tierId);
    if (!health) return;
    health.lastQuotaRefreshAttemptAt = Date.now();
  }

  markQuotaRefreshFailure(tierId, reason = 'read-failed') {
    const health = this.tierHealth.get(tierId);
    if (!health) return;
    health.lastQuotaRefreshAttemptAt = Date.now();
    health.quotaRefreshError = reason;
    this._save();
  }

  reportTierSuccess(tierId) {
    const health = this.tierHealth.get(tierId);
    if (!health) return;
    health.isThrottled = false;
    health.totalRemainingPercent = null;
    health.fiveHourRemainingPercent = null;
    health.quotaState = 'unknown';
    health.throttledReason = null;
    health.cooldownUntil = null;
    health.nextResetAt = null;
    health.lastCheckedAt = Date.now();
    this._save();
  }

  getStatus() {
    return {
      enabled: this.chain.enabled,
      mode: this.chain.mode,
      thresholds: {
        ...this.chain.thresholds,
        totalRemainingPercent: this.thresholdPercent
      },
      activeTier: this.resolveActiveTier(),
      tiers: this.chain.tiers.map(tier => ({
        ...tier,
        health: this.tierHealth.get(tier.id)
      })),
      history: this.switchHistory.slice(-10)
    };
  }
}

module.exports = { PriorityChainEngine, DEFAULT_PRESET_TIERS, notifyMac };
