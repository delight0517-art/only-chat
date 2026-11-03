'use strict';

function resolveBrowserInput(value) {
  const input = String(value || '').trim();
  if (!input) return 'https://www.google.com';

  if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
      return url.href;
    } catch (_) { return null; }
  }

  const hostLike = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|[^/\s.:]+(?:\.[^/\s.:]+)+)(?::\d+)?(?:[/?#].*)?$/i.test(input);
  if (hostLike) {
    try {
      const url = new URL(`https://${input}`);
      if (url.hostname && !url.username && !url.password) return url.href;
    } catch (_) { return null; }
  }

  return `https://www.google.com/search?q=${encodeURIComponent(input)}`;
}

if (typeof module === 'object' && module.exports) module.exports = { resolveBrowserInput };
if (typeof window !== 'undefined') window.onlyChatResolveBrowserInput = resolveBrowserInput;
