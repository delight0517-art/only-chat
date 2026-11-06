'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const appSource = path.join(__dirname, '..', 'macOS', 'OnlyChatApp.swift');
const source = fs.readFileSync(appSource, 'utf8');

assert.match(source, /CommandLine\.arguments\.contains\("--spaceo-agent-session"\)/,
  'the SpaceO marker must activate the isolated startup path even when LaunchServices drops environment overrides');
assert.match(source, /launchArgument\("--only-chat-data-dir"\) \?\? environment\["ONLY_CHAT_DATA_DIR"\]/,
  'the private data directory must be read from argv before the environment fallback');
assert.match(source, /launchArgument\("--only-chat-port"\) \?\? environment\["ONLY_CHAT_PORT"\]/,
  'the per-instance loopback port must be read from argv before the environment fallback');
assert.match(source, /profile\.hasPrefix\(temporaryRoot\.hasSuffix\("\/"\) \? temporaryRoot : temporaryRoot \+ "\/"\)/,
  'the isolated data directory must remain constrained to /tmp');

execFileSync('swiftc', ['-frontend', '-parse', appSource], { stdio: 'pipe' });
console.log('Only Chat SpaceO launch argument contract passed.');
