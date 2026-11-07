'use strict';

const path = require('node:path');

function parsePatchPaths(patch) {
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('apply_patch requires a non-empty unified Git patch.');
  const blocks = patch.split(/(?=^diff --git )/mu).filter(block => /^diff --git /u.test(block));
  if (!blocks.length) throw new Error('apply_patch target paths could not be verified.');
  const paths = [];
  for (const block of blocks) {
    const header = /^diff --git a\/([^\s]+) b\/([^\s]+)$/mu.exec(block);
    const source = /^--- (?:a\/([^\s]+)|\/dev\/null)$/mu.exec(block);
    const destination = /^\+\+\+ (?:b\/([^\s]+)|\/dev\/null)$/mu.exec(block);
    if (!header || !source || !destination) throw new Error('apply_patch contains an unsupported or unverified path header.');
    const sourcePath = source[1] || null;
    const destinationPath = destination[1] || null;
    if ((sourcePath && sourcePath !== header[1]) || (destinationPath && destinationPath !== header[2])) {
      throw new Error('apply_patch path does not match its Git header.');
    }
    if (sourcePath && destinationPath && sourcePath !== destinationPath) {
      throw new Error('apply_patch rename requires a separately reviewed ownership scope.');
    }
    const target = destinationPath || sourcePath;
    if (!target || target.startsWith('/') || target.split('/').some(part => !part || part === '..' || part === '.')) {
      throw new Error('apply_patch target path escapes its exact ownership scope.');
    }
    paths.push(target);
  }
  return [...new Set(paths)];
}

async function runOwnedFileMutation({ strict, context, store, filePaths, operation }) {
  if (!strict) return operation();
  if (!context || !store) throw new Error('실행자 파일 쓰기는 검증된 Only Chat 작업 소유권 lease가 필요합니다.');
  const before = await store.authorizeFileMutation({ ...context, filePaths });
  if (!before.authorized) throw new Error(`파일 소유권 lease가 쓰기를 거부했습니다: ${before.reason}`);
  const result = await operation();
  const recorded = await store.recordFileMutation({ ...context, filePaths, beforeSnapshots: before.snapshots });
  if (!recorded.updated) throw new Error(`파일 변경 후 소유권 체크포인트를 기록하지 못했습니다: ${recorded.reason}`);
  return result;
}

function absolutePatchPaths(workspaceDir, patch) {
  return parsePatchPaths(patch).map(relative => {
    const absolute = path.resolve(workspaceDir, relative);
    const contained = path.relative(workspaceDir, absolute);
    if (contained === '..' || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained)) {
      throw new Error('apply_patch target escapes its workspace.');
    }
    return absolute;
  });
}

module.exports = { absolutePatchPaths, parsePatchPaths, runOwnedFileMutation };
