'use strict';

const RULES_PORTS = Array.from({ length: 12 }, (_, index) => 17361 + index);

function normalizeHttpUrl(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('주소를 입력해 주세요.');
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`;
  const url = new URL(candidate);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new Error('내장 브라우저는 HTTP와 HTTPS 주소만 엽니다.');
  }
  return url.href;
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}

function globRegex(pattern) {
  const value = String(pattern || '').trim().toLowerCase();
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '*') { out += '.*'; continue; }
    if (char === '[') {
      const close = value.indexOf(']', i + 1);
      const chars = value.slice(i + 1, close);
      if (close > i + 1 && /^[a-z0-9?&*_\-]+$/i.test(chars)) {
        out += `[${chars}]`; i = close; continue;
      }
    }
    if (char === '(' || char === ')' || char === '|') {
      const open = char === '(' ? i : value.lastIndexOf('(', i - 1);
      const close = open < 0 ? -1 : value.indexOf(')', open + 1);
      const group = open < 0 || close < 0 ? '' : value.slice(open + 1, close);
      const supported = group.includes('|') && !/[()]/.test(group);
      const inGroup = supported && (i === open || i === close || (char === '|' && i > open && i < close));
      out += inGroup ? char : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      continue;
    }
    if (char === '?' && i > 0 && (value[i - 1] === ']' || value[i - 1] === ')')) { out += '?'; continue; }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function hostGlobMatches(host, pattern) {
  const h = normalizeHost(host);
  const pat = String(pattern || '').trim().toLowerCase();
  if (!pat || pat === '*' || pat === '*.*') return true;
  if (pat.endsWith('.*')) {
    const stem = pat.slice(0, -2);
    return h === stem || h.endsWith(`.${stem}`) || h.includes(stem);
  }
  return new RegExp(`^${globRegex(pat)}$`, 'i').test(h);
}

function urlRuleMatches(href, rawPattern) {
  const pattern = String(rawPattern || '').trim().toLowerCase();
  if (!pattern) return false;
  const url = new URL(href);
  const slash = pattern.indexOf('/');
  const hostPattern = slash < 0 ? pattern : pattern.slice(0, slash);
  const pathPattern = slash < 0 ? '' : pattern.slice(slash);
  const host = normalizeHost(url.hostname);
  const hostMatches = /[*[(|]/.test(hostPattern)
    ? hostGlobMatches(host, hostPattern.replace(/^www\./, ''))
    : host === normalizeHost(hostPattern) || host.endsWith(`.${normalizeHost(hostPattern)}`);
  if (!hostMatches) return false;
  if (!pathPattern) return true;
  const encoded = `${url.pathname}${url.search}`.toLowerCase();
  let decoded = encoded;
  try { decoded = decodeURIComponent(encoded.replace(/\+/g, '%20')); } catch (_) {}
  const pathRegex = new RegExp(globRegex(pathPattern), 'i');
  return pathRegex.test(encoded) || pathRegex.test(decoded);
}

function matchPolicy(href, rules) {
  const url = new URL(href);
  const host = normalizeHost(url.hostname);
  const domain = (rules.blockedDomains || []).find(raw => {
    const blocked = normalizeHost(raw);
    return blocked && (host === blocked || host.endsWith(`.${blocked}`));
  });
  if (domain) return domain;

  const address = `${host}${url.pathname}`.toLowerCase();
  const urlPart = (rules.blockedUrlParts || []).find(raw => {
    const part = String(raw || '').trim().toLowerCase();
    return part && address.includes(part);
  });
  if (urlPart) return urlPart;

  const youtube = /(^|\.)youtube\.com$/.test(host) || /(^|\.)youtu\.be$/.test(host);
  if (youtube) {
    const videoId = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts\/)?([\w-]{6,})/)?.[1];
    const blockedVideos = [...(rules.blockedYoutubeVideoIds || []), ...(rules.blockedVideos || [])];
    if (videoId && blockedVideos.some(id => String(id).toLowerCase() === videoId.toLowerCase())) return videoId;
    const handle = url.pathname.match(/^\/@([^/?#]+)/)?.[1];
    const channelId = url.pathname.match(/^\/channel\/(UC[\w-]+)/i)?.[1];
    const channels = [...(rules.blockedYoutubeHandles || []), ...(rules.blockedYoutubeChannelIds || []), ...(rules.blockedChannels || [])]
      .map(value => String(value).replace(/^@/, '').toLowerCase());
    if ((handle && channels.includes(handle.toLowerCase())) || (channelId && channels.includes(channelId.toLowerCase()))) return handle ? `@${handle}` : channelId;
  }
  for (const raw of rules.keywords || []) {
    const key = String(raw || '').trim();
    if (!key) continue;
    if (youtube && !/youtube\.com|youtu\.be|^watch\?v=[\w-]{6,}|^\/(?:@[^/?#\s]+|c\/[^/?#\s]+|channel\/|user\/)|^\/(?!$)[^\s*]+/i.test(key)) continue;
    if (key.includes('*') || key.includes('/')) {
      if (urlRuleMatches(href, key)) return key;
    } else if (href.toLowerCase().includes(key.toLowerCase())) return key;
  }

  const googleSearch = /(^|\.)google\.(?:com|[a-z]{2,3}|(?:co|com)\.[a-z]{2})$/.test(host) && ['/search', '/images'].includes(url.pathname);
  const youtubeSearch = youtube && ['/results', '/feed/trending'].includes(url.pathname);
  if (googleSearch || youtubeSearch) {
    const terms = url.searchParams.getAll(googleSearch ? 'q' : 'search_query');
    for (const rule of rules.searchQueries || []) {
      const term = String(rule?.term || '').toLowerCase();
      if (!term) continue;
      if (terms.some(query => {
        const value = query.toLowerCase();
        const mode = String(rule.match || 'contains').toLowerCase();
        return mode === 'exact' ? value === term
          : mode === 'prefix' || mode === 'starts_with' ? value.startsWith(term)
            : value.includes(term);
      })) return rule.term;
    }
  }
  return null;
}

class FocusFencePolicy {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.ports = options.ports || RULES_PORTS;
    this.timeoutMs = options.timeoutMs || 1800;
    this.cached = null;
    this.cachedAt = 0;
    this.loading = null;
  }

  async getRules(force = false) {
    if (!force && this.cached && Date.now() - this.cachedAt < 4000) return this.cached;
    if (this.loading) return this.loading;
    this.loading = this._fetchRules();
    try { return await this.loading; } finally { this.loading = null; }
  }

  async _fetchRules() {
    const controllers = this.ports.map(() => new AbortController());
    let settled = false;
    const result = await new Promise(resolve => {
      const timers = controllers.map(controller => setTimeout(() => controller.abort(), this.timeoutMs));
      const requests = this.ports.map(async (port, index) => {
        try {
          const response = await this.fetch(`http://127.0.0.1:${port}/rules?browser=onlychat`, {
            cache: 'no-store', signal: controllers[index].signal
          });
          if (!response.ok) return;
          const rules = await response.json();
          if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return;
          const arraysValid = Array.isArray(rules.blockedDomains)
            && Array.isArray(rules.blockedUrlParts)
            && Array.isArray(rules.keywords);
          if (!arraysValid) return;
          if (rules.protectionEnabled !== undefined && typeof rules.protectionEnabled !== 'boolean') return;
          if (!settled) { settled = true; resolve({ rules, port }); }
        } catch (_) {
          // Try the other Focus Fence loopback ports.
        } finally { clearTimeout(timers[index]); }
      });
      Promise.all(requests).then(() => { if (!settled) { settled = true; resolve(null); } });
    });
    for (const controller of controllers) if (!controller.signal.aborted) controller.abort();
    this.cached = result;
    this.cachedAt = result ? Date.now() : 0;
    return result;
  }

  async check(value) {
    const url = normalizeHttpUrl(value);
    const snapshot = await this.getRules();
    if (!snapshot) return { allowed: false, url, reason: 'focus_fence_unavailable' };
    if (snapshot.rules.protectionEnabled === false) return { allowed: true, url, reason: 'protection_disabled' };
    let matched = matchPolicy(url, snapshot.rules);
    if (!matched) {
      const youtube = await this._checkYoutubeUrl(url, snapshot);
      if (!youtube.allowed) return youtube;
    }
    if (!matched) return { allowed: true, url, reason: 'allowed' };
    try {
      await this.fetch(`http://127.0.0.1:${snapshot.port}/block`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rule: String(matched), kind: 'navigation', url, browser: 'onlychat' })
      });
    } catch (_) {}
    return { allowed: false, url, reason: 'blocked', rule: String(matched) };
  }

  async _checkYoutubeUrl(url, snapshot) {
    const parsed = new URL(url);
    const host = normalizeHost(parsed.hostname);
    if (!/(^|\.)youtube\.com$|(^|\.)youtu\.be$/i.test(host)) return { allowed: true, url };
    if (typeof snapshot.rules.youtubeQuotaBlocked !== 'boolean') {
      return { allowed: false, url, reason: 'focus_fence_unavailable' };
    }
    if (host !== 'music.youtube.com' && snapshot.rules.youtubeQuotaBlocked === true) {
      return { allowed: false, url, reason: 'blocked', rule: 'YouTube 사용량 제한' };
    }
    return { allowed: true, url };
  }
}

module.exports = { FocusFencePolicy, normalizeHttpUrl, matchPolicy };
