'use strict';

const assert = require('node:assert/strict');
const { ToolRegistry } = require('../src/tools/ToolRegistry.js');

async function main() {
  let calls = 0;
  const registry = new ToolRegistry({
    workspaceDir: process.cwd(), approvalPolicy: 'on-request', browserEnabled: false,
    commandRunner: async command => { calls++; return { command }; },
    sandboxRoot: process.cwd()
  });
  for (const command of [
    'pmset sleepnow',
    'pmset -a sleep 5',
    String.raw`\pmset -a sleep 5`,
    './pmset -a sleep 5',
    '../bin/pmset -a sleep 5',
    String.raw`command \pmset -a sleep 5`,
    "'./pmset' -a sleep 5",
    `"pmset" -a sleep 5`,
    `'/usr/bin/pmset' -a sleep 5`,
    `"shutdown" -h now`,
    `sh -c "'pmset' -a sleep 5"`,
    `sh -c 'pmset -a sleep 5'`,
    `sh -c 'bash -c "pmset -a sleep 5"'`,
    `sh -c "echo safe; shutdown -h now"`,
    `bash -lc "shutdown -h now"`,
    `zsh -lc 'echo safe && systemsetup -setcomputersleep never'`,
    'FOO=bar pmset -a sleep 5',
    'PATH=/bin pmset -a sleep 5',
    'FOO="bar baz" pmset -a sleep 5',
    'sudo shutdown -h now',
    'env shutdown -h now',
    'env -i shutdown -h now',
    `env -S 'shutdown -h now'`,
    'nohup shutdown -h now',
    'setsid /sbin/reboot',
    'nice -n 5 poweroff',
    'timeout 5s shutdown -r now',
    'P=pmset; $P -a sleep 5',
    `POWER='shutdown'; "$POWER" -h now`,
    'X="pmset"; command "$X" -a sleep 5',
    'POWER="$(echo shutdown)"; "$POWER" -h now',
    'POWER="$(printf reboot)"; sudo "$POWER" -r now',
    'export POWER=shutdown; eval "$POWER -h now"',
    'P=pmset; eval "$P -a sleep 5"',
    'eval "shutdown -h now"',
    'eval \'pmset -a sleep 5\'',
    'export POWER=shutdown; bash -c "$POWER -h now"',
    'export POWER=pmset; zsh -lc \'$POWER -a sleep 5\'',
    'export POWER="$(echo shutdown)"; sh -c \'$POWER -h now\'',
    'POWER=shutdown; bash -c "$POWER -h now"',
    'echo safe && command reboot',
    'exec /sbin/shutdown -r now',
    'systemsetup -setcomputersleep never',
    'sudo systemsetup -setwakeonnetworkaccess off',
    'systemctl suspend',
    'sudo systemctl suspend',
    'loginctl hibernate',
    `osascript -e 'tell application "System Events" to sleep'`,
    `echo safe && pmset restart 1`
  ]) await assert.rejects(registry.execCommand(command), /Direct power actions are blocked/);
  assert.equal(calls, 0, 'blocked power commands must never reach the shell runner');
  await registry.execCommand('pmset -g custom');
  await registry.execCommand(`"pmset" "-g" custom`);
  await registry.execCommand('echo "the word sleep is documentation"');
  await registry.execCommand('echo "pmset sleep is documentation"');
  await registry.execCommand("printf 'pmset -a sleep 5'");
  await registry.execCommand(`sh -c 'echo "pmset is documentation"'`);
  await registry.execCommand(`sh -c 'bash -c "echo pmset is documentation"'`);
  await registry.execCommand(`eval 'echo pmset is documentation'`);
  await registry.execCommand(`printf 'P=pmset; $P -a sleep 5'`);
  await registry.execCommand('printf "safe; pmset -a sleep 5"');
  await registry.execCommand('echo "words && shutdown -h now"');
  await registry.execCommand(`echo "text; sh -c 'shutdown -h now'"`);
  await registry.execCommand(String.raw`printf safe\; pmset -a sleep 5`);
  await registry.execCommand('echo "systemctl suspend"');
  await registry.execCommand('echo "\\pmset -a sleep 5" is documentation');
  await registry.execCommand('echo "pm\\set -a sleep 5" is documentation');
  await registry.execCommand(`printf "osascript tell application 'System Events' to sleep"`);
  await registry.execCommand('P=pmset; $p -a sleep 5');
  await registry.execCommand('POWER="shutdown is documentation"; echo "$POWER"');
  await registry.execCommand(`echo "'pmset' -a sleep 5 is documentation"`);
  assert.equal(calls, 20, 'read-only status and quoted shell text remain allowed, including nested shell text');
  console.log('powerActionRouting.test.js: PASS (direct power mutations blocked before shell dispatch)');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
