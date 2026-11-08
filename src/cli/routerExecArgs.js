'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROUTER_MODEL_PATTERN = /^(?:chatgpt-plan\/)?gpt-[a-z0-9_.-]+(?::[a-z0-9_.-]+)?$/i;
const TOOL_PROFILES = new Set(['file-read', 'file-search', 'file-edit', 'file-write']);
const APPROVABLE_TOOLS = new Set(['edit_file', 'write_file']);

function normalizeWorkspaceRelativePath(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('--approve-write-path에는 비어 있지 않은 workspace 상대 경로를 입력하세요.');
  }
  const candidate = value.trim().replace(/\\/g, '/');
  if (path.posix.isAbsolute(candidate)) {
    throw new Error('--approve-write-path는 절대 경로를 허용하지 않습니다.');
  }
  const normalized = path.posix.normalize(candidate);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('--approve-write-path는 workspace 내부 경로만 허용합니다.');
  }
  return normalized;
}

function normalizeWorkspaceRoot(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !path.isAbsolute(value.trim())) {
    throw new Error('--workspace-root에는 기존 저장소의 절대 경로를 입력하세요.');
  }
  let resolved;
  try {
    resolved = fs.realpathSync(value.trim());
  } catch (_) {
    throw new Error('--workspace-root 경로를 찾을 수 없습니다.');
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) throw new Error();
  } catch (_) {
    throw new Error('--workspace-root는 기존 디렉터리여야 합니다.');
  }
  return resolved;
}

function isApprovedNewFileWrite(request, {
  workspaceDir,
  approvedWritePaths = [],
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync
} = {}) {
  if (request?.name !== 'write_file' || !workspaceDir || !approvedWritePaths.length) return false;
  let relativePath;
  try {
    relativePath = normalizeWorkspaceRelativePath(request.args?.path || request.args?.file_path);
  } catch (_) {
    return false;
  }
  if (!approvedWritePaths.includes(relativePath)) return false;

  try {
    const workspace = path.resolve(workspaceDir);
    const target = path.resolve(workspace, relativePath);
    const lexicalRelative = path.relative(workspace, target);
    if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRelative)) return false;
    if (existsSync(target)) return false;
    const parent = path.dirname(target);
    if (!existsSync(parent)) return false;
    const realWorkspace = realpathSync(workspace);
    const realParent = realpathSync(parent);
    const realRelative = path.relative(realWorkspace, realParent);
    return realRelative !== '..' && !realRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(realRelative);
  } catch (_) {
    return false;
  }
}

function parseRouterExecArgs(args = []) {
  const options = { routerModel: null, toolProfile: null, workspaceRoot: null, approvedTools: [], approvedWritePaths: [], prompt: '' };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--router-model') options.routerModel = args[++i] || '';
    else if (arg === '--tool-profile') options.toolProfile = args[++i] || '';
    else if (arg === '--workspace-root') options.workspaceRoot = normalizeWorkspaceRoot(args[++i] || '');
    else if (arg === '--approve-tool') options.approvedTools.push(args[++i] || '');
    else if (arg === '--approve-write-path') options.approvedWritePaths.push(normalizeWorkspaceRelativePath(args[++i] || ''));
    else if (arg === '--') positional.push(...args.slice(i + 1));
    else positional.push(arg);
    if (arg === '--') break;
  }
  options.prompt = positional.join(' ').trim();
  if (options.routerModel && !ROUTER_MODEL_PATTERN.test(options.routerModel)) {
    throw new Error('--router-model에는 AI Account Router에서 제공한 모델 ID를 입력하세요.');
  }
  if (options.workspaceRoot && !options.routerModel) {
    throw new Error('--workspace-root는 --router-model과 함께 사용해야 합니다.');
  }
  if (options.toolProfile && !TOOL_PROFILES.has(options.toolProfile)) {
    throw new Error('--tool-profile은 file-read, file-search, file-edit 또는 file-write만 지원합니다.');
  }
  if (options.approvedTools.some(name => !APPROVABLE_TOOLS.has(name))) {
    throw new Error('--approve-tool은 edit_file 또는 write_file만 지원합니다.');
  }
  if (options.approvedTools.includes('edit_file') && options.toolProfile !== 'file-edit') {
    throw new Error('edit_file 승인에는 --tool-profile file-edit가 필요합니다.');
  }
  if (options.approvedTools.includes('write_file')
    && (options.toolProfile !== 'file-write' || options.approvedWritePaths.length === 0)) {
    throw new Error('write_file 승인에는 --tool-profile file-write와 정확한 --approve-write-path가 필요합니다.');
  }
  if (options.approvedWritePaths.length && !options.approvedTools.includes('write_file')) {
    throw new Error('--approve-write-path는 --approve-tool write_file과 함께 사용해야 합니다.');
  }
  if (options.approvedTools.length > 1 || (options.approvedTools.includes('edit_file') && options.approvedWritePaths.length)) {
    throw new Error('한 번의 실행에서는 edit_file 또는 write_file 중 하나의 쓰기 권한만 승인할 수 있습니다.');
  }
  if (options.toolProfile === 'file-write' && !options.approvedTools.includes('write_file')) {
    throw new Error('file-write 프로필에는 --approve-tool write_file과 정확한 --approve-write-path가 필요합니다.');
  }
  if (options.routerModel && !options.toolProfile) options.toolProfile = 'file-read';
  if (!options.prompt) throw new Error('실행할 프롬프트를 입력하세요.');
  return options;
}

module.exports = { isApprovedNewFileWrite, normalizeWorkspaceRelativePath, normalizeWorkspaceRoot, parseRouterExecArgs };
