'use strict';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function safeLink(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? url : null;
  } catch (_) {
    return null;
  }
}

function renderInline(value) {
  const tokens = [];
  const protect = html => `\u0000${tokens.push(html) - 1}\u0000`;
  let source = String(value);
  source = source.replace(/`([^`\n]+)`/g, (_, code) => protect(`<code>${escapeHtml(code)}</code>`));
  source = source.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
    const href = safeLink(url);
    if (!href) return `${label} (${url})`;
    return protect(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${renderInline(label)}</a>`);
  });

  let html = escapeHtml(source)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>');
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)] || '');
}

function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  let paragraph = [];
  let quote = [];
  let listType = null;
  let listItems = [];
  let code = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushQuote = () => {
    if (!quote.length) return;
    output.push(`<blockquote>${quote.map(renderInline).join('<br>')}</blockquote>`);
    quote = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    output.push(`<${listType}>${listItems.map(item => `<li>${renderInline(item)}</li>`).join('')}</${listType}>`);
    listItems = [];
    listType = null;
  };
  const flushTextBlocks = () => { flushParagraph(); flushQuote(); flushList(); };

  for (const line of lines) {
    if (code) {
      if (/^\s*```\s*$/.test(line)) {
        const languageClass = code.language ? ` class="language-${escapeHtml(code.language)}"` : '';
        output.push(`<pre><code${languageClass}>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else code.lines.push(line);
      continue;
    }

    const fence = line.match(/^\s*```\s*([a-z0-9_-]*)\s*$/i);
    if (fence) { flushTextBlocks(); code = { language: fence[1], lines: [] }; continue; }
    if (!line.trim()) { flushTextBlocks(); continue; }

    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      output.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { flushTextBlocks(); output.push('<hr>'); continue; }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const item = unordered || ordered;
    if (item) {
      flushParagraph(); flushQuote();
      const nextType = unordered ? 'ul' : 'ol';
      if (listType && listType !== nextType) flushList();
      listType = nextType;
      listItems.push(item[1]);
      continue;
    }

    const quoted = line.match(/^\s*>\s?(.*)$/);
    if (quoted) { flushParagraph(); flushList(); quote.push(quoted[1]); continue; }
    flushQuote(); flushList();
    paragraph.push(line);
  }

  if (code) output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  flushTextBlocks();
  return output.join('\n');
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.ceil(Number(milliseconds) / 1000 || 0));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}분 ${remainder}초` : `${minutes}분`;
}

const api = { renderMarkdown, formatElapsed };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.OnlyChatPresentation = api;
