'use strict';

function buildFocusFenceContentScript(input = {}) {
  const rules = {
    protectionEnabled: input.protectionEnabled === true,
    blockedDomains: Array.isArray(input.blockedDomains) ? input.blockedDomains : [],
    blockedUrlParts: Array.isArray(input.blockedUrlParts) ? input.blockedUrlParts : [],
    blockedYoutubeHandles: Array.isArray(input.blockedYoutubeHandles) ? input.blockedYoutubeHandles : [],
    blockedYoutubeChannelIds: Array.isArray(input.blockedYoutubeChannelIds) ? input.blockedYoutubeChannelIds : [],
    blockedYoutubeVideoIds: Array.isArray(input.blockedYoutubeVideoIds) ? input.blockedYoutubeVideoIds : [],
    keywords: Array.isArray(input.keywords) ? input.keywords : [],
    hideSerp: input.hideSerp === true,
    hideYoutubeResults: input.hideYoutubeResults === true,
    hideImages: input.hideImages === true,
    hideImagesOnYoutube: input.hideImagesOnYoutube === true,
    hideYtHomeFeed: input.hideYtHomeFeed === true,
    forceSafeSearch: input.forceSafeSearch === true,
    focusLocked: input.focusLocked === true
  };
  const encoded = JSON.stringify(rules).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `(() => {
    const next = ${encoded};
    if (globalThis.__onlyChatFocusFence?.rulesKey === JSON.stringify(next)) return;
    const state = globalThis.__onlyChatFocusFence || (globalThis.__onlyChatFocusFence = {});
    state.overlay?.remove(); state.overlay = null; state.style?.remove(); state.observer?.disconnect();
    document.querySelectorAll('[data-only-chat-focus-fence-hidden="1"]').forEach(node => {
      node.style.display = node.dataset.onlyChatFocusFenceDisplay || '';
      delete node.dataset.onlyChatFocusFenceDisplay;
      delete node.dataset.onlyChatFocusFenceHidden;
    });
    state.rules = next;
    state.rulesKey = JSON.stringify(next);
    if (!next.protectionEnabled) { state.overlay?.remove(); state.style?.remove(); state.observer?.disconnect(); return; }
    const host = location.hostname.toLowerCase().replace(/^www\\./, '').replace(/\\.$/, '');
    const youtube = /(^|\\.)youtube\\.com$|(^|\\.)youtu\\.be$/.test(host);
    const handle = location.pathname.match(/^\\/@([^/?#]+)/)?.[1]?.toLowerCase();
    const channelId = location.pathname.match(/^\\/channel\\/(UC[\\w-]+)/i)?.[1]?.toLowerCase();
    const videoId = new URL(location.href).searchParams.get('v') || location.pathname.match(/^\\/(?:shorts\\/)?([\\w-]{6,})/)?.[1];
    const blockedChannels = [...next.blockedYoutubeHandles, ...next.blockedYoutubeChannelIds].map(x => String(x).replace(/^@/, '').toLowerCase());
    const blockedVideo = youtube && videoId && next.blockedYoutubeVideoIds.some(x => String(x).toLowerCase() === videoId.toLowerCase());
    const blockedChannel = youtube && ((handle && blockedChannels.includes(handle)) || (channelId && blockedChannels.includes(channelId)));
    const blockedDomain = next.blockedDomains.some(raw => { const d = String(raw || '').toLowerCase().replace(/^www\\./, '').replace(/^\\*\\./, '').replace(/\\.$/, ''); return d && (host === d || host.endsWith('.' + d)); });
    const blockedPart = (host + location.pathname).includes(next.blockedUrlParts.map(x => String(x).toLowerCase()).find(x => x && (host + location.pathname).includes(x)) || '\\u0000');
    const blockedKeyword = next.keywords.some(raw => { const key = String(raw || '').trim().toLowerCase(); return key && (location.href.toLowerCase().includes(key) || document.title.toLowerCase().includes(key)); });
    function showBlock(reason) {
      if (!document.documentElement || state.overlay?.isConnected) return;
      document.querySelectorAll('video,audio').forEach(media => { try { media.pause(); } catch (_) {} });
      const overlay = document.createElement('div'); overlay.setAttribute('role', 'alert'); overlay.dataset.onlyChatFocusFence = 'blocked';
      Object.assign(overlay.style, { position:'fixed', inset:'0', zIndex:'2147483647', display:'grid', placeContent:'center', padding:'28px', background:'#111827', color:'#f9fafb', font:'16px system-ui', textAlign:'center' });
      const title = document.createElement('h1'); title.textContent = 'Focus Fence가 차단했습니다';
      const detail = document.createElement('p'); detail.textContent = reason;
      overlay.append(title, detail); (document.body || document.documentElement).appendChild(overlay); state.overlay = overlay;
    }
    function hide(node) { if (!node || node.dataset.onlyChatFocusFenceHidden) return; node.dataset.onlyChatFocusFenceHidden='1'; node.dataset.onlyChatFocusFenceDisplay=node.style.display; node.style.setProperty('display','none','important'); }
    function matchCards() {
      if (!youtube && !next.hideSerp) return;
      const google = /(^|\\.)google\\./.test(host), bing = /(^|\\.)bing\\.com$/.test(host), ddg = /(^|\\.)duckduckgo\\.com$/.test(host), naver = /(^|\\.)naver\\.com$/.test(host);
      const selectors = youtube ? 'ytd-rich-item-renderer,ytd-video-renderer,ytd-compact-video-renderer,ytd-grid-video-renderer,ytd-reel-item-renderer' : google ? 'div.g,div[data-hveid],div[data-sokoban-container]' : bing ? 'li.b_algo' : ddg ? 'article[data-testid="result"],.result' : naver ? '.news_area,.total_wrap,.api_txt_lines,.lst_total > li' : '';
      if (!selectors) return;
      document.querySelectorAll(selectors).forEach(node => {
        const text = (node.innerText || '').toLowerCase();
        const hrefs = [...node.querySelectorAll('a[href]')].map(a => a.href.toLowerCase());
        const hasBlockedVideo = next.blockedYoutubeVideoIds.some(id => hrefs.some(href => href.includes(id.toLowerCase())));
        const hasBlockedChannel = blockedChannels.some(value => hrefs.some(href => href.includes('/@' + value) || href.includes('/channel/' + value)));
        const hasKeyword = next.keywords.some(value => String(value).trim() && (text.includes(String(value).toLowerCase()) || hrefs.some(href => href.includes(String(value).toLowerCase()))));
        if (hasBlockedVideo || hasBlockedChannel || hasKeyword) hide(node);
      });
    }
    if (blockedDomain || blockedPart || blockedVideo || blockedChannel || blockedKeyword) {
      showBlock(blockedDomain ? '차단된 도메인' : blockedPart ? '차단된 주소 규칙' : blockedVideo ? '차단된 YouTube 영상' : blockedChannel ? '차단된 YouTube 채널' : '차단 키워드');
      return;
    }
    if (next.hideImages && (!youtube || next.hideImagesOnYoutube)) {
      state.style ||= document.createElement('style');
      state.style.textContent = 'img, picture, source { visibility:hidden !important; }';
      (document.head || document.documentElement).appendChild(state.style);
    } else if (state.style) state.style.remove();
    if (next.hideYoutubeResults && youtube && next.hideYtHomeFeed && location.pathname === '/') {
      document.querySelectorAll('ytd-rich-grid-renderer,ytd-browse[page-subtype="home"]').forEach(hide);
    }
    if (next.forceSafeSearch && /(^|\\.)google\\./.test(host) && location.pathname === '/search') {
      const url = new URL(location.href); if (url.searchParams.get('safe') !== 'active') { url.searchParams.set('safe','active'); location.replace(url.href); return; }
    }
    matchCards();
    state.observer?.disconnect();
    state.observer = new MutationObserver(() => { if (!state.scanQueued) { state.scanQueued = true; requestAnimationFrame(() => { state.scanQueued = false; matchCards(); }); } });
    state.observer.observe(document.documentElement, { childList:true, subtree:true });
  })();`;
}

module.exports = { buildFocusFenceContentScript };
