'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { renderMarkdown, formatElapsed } = require('../src/ui/desktop/chatPresentation.js');
const { withResponseGuidance } = require('../src/providers/responseGuidance.js');

test('renders common Markdown blocks while escaping HTML and unsafe links', () => {
  const html = renderMarkdown([
    '# 결과',
    '',
    '- **완료**',
    '- `file.js`',
    '',
    '참고: [문서](https://example.com/path?a=1&b=2)',
    '',
    '```js',
    'const ready = 1 < 2;',
    '```',
    '',
    '<script>alert(1)</script>',
    '[위험](javascript:alert(1))'
  ].join('\n'));

  assert.match(html, /<h1>결과<\/h1>/);
  assert.match(html, /<ul><li><strong>완료<\/strong><\/li><li><code>file\.js<\/code><\/li><\/ul>/);
  assert.match(html, /href="https:\/\/example\.com\/path\?a=1&amp;b=2"/);
  assert.match(html, /<pre><code class="language-js">const ready = 1 &lt; 2;<\/code><\/pre>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test('formats elapsed duration in Korean seconds and minutes', () => {
  assert.equal(formatElapsed(0), '0초');
  assert.equal(formatElapsed(39000), '39초');
  assert.equal(formatElapsed(60000), '1분');
  assert.equal(formatElapsed(61000), '1분 1초');
});

test('adds clear, user-language response guidance to provider requests', () => {
  const prompt = withResponseGuidance('USER\nExplain the change');
  assert.match(prompt, /사용자가 쓴 언어로 답하고/);
  assert.match(prompt, /확인하지 않은 일을 완료했다고 말하지 않는다/);
  assert.match(prompt, /USER\nExplain the change/);
});
