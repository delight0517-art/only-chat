/**
 * @project My-Codex
 * @provenance:rogan-core
 * @author Rogan Kim (GeunHu Kim) & AI Architect
 * @license MIT
 * @description Dynamic Live-Reload Skill Engine. Resolves and hot-swaps skills mid-session without restarting chats.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

class SkillManager {
  constructor(options = {}) {
    this.workspaceDir = options.workspaceDir || process.cwd();
    this.globalSkillsDir = options.globalSkillsDir || path.join(os.homedir(), '.my-codex', 'skills');
    this.sharedSkillsDir = options.sharedSkillsDir === false ? null : (options.sharedSkillsDir || process.env.ONLY_CHAT_SHARED_SKILLS_DIR);
    this.pluginCacheDir = options.pluginCacheDir === false ? null : (options.pluginCacheDir || path.join(os.homedir(), '.codex', 'plugins', 'cache'));
    this.skills = new Map(); // name -> { name, path, content, updatedAt }
    this.watchers = [];

    if (options.createGlobalSkillsDir !== false) this._ensureDir(this.globalSkillsDir);
    this.scanAndReload();
    if (options.watchEnabled !== false) this.startWatching();
  }

  _ensureDir(dir) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  scanAndReload() {
    this.skills.clear();

    // 1. Scan default built-in/global skills
    if (this.globalSkillsDir && fs.existsSync(this.globalSkillsDir)) this._scanDir(this.globalSkillsDir, 'global');

    // 2. Scan workspace-local skills
    const localDir = path.join(this.workspaceDir, '.skills');
    if (fs.existsSync(localDir)) {
      this._scanDir(localDir, 'workspace');
    }

    if (this.sharedSkillsDir && fs.existsSync(this.sharedSkillsDir)) {
      this._scanDir(this.sharedSkillsDir, 'shared');
    }

    if (this.pluginCacheDir && fs.existsSync(this.pluginCacheDir)) {
      this._scanDir(this.pluginCacheDir, 'codex-cache');
    }

    // Register built-in parallel-work preset if not already present
    if (!this.skills.has('parallel-work')) {
      this.registerInlineSkill('parallel-work', {
        name: 'parallel-work',
        description: 'Adaptive Memory-governed Parallel Task Dispatcher (Rogan Edition)',
        prompt: `동시 작업 수와 시스템 메모리 여유율을 실시간 감시하며, RAM 35% 이상 시 최대 3개, 25-34% 시 2개, 15-24% 시 1개의 작업을 병렬로 분배하고, 15% 미만 시 대기합니다. 파일별 소유권 잠금을 검사하여 미커밋 변경사항 충돌을 방지합니다.`
      });
    }

    console.log(`[SkillManager] Live skill registry reloaded: ${this.skills.size} skills available.`);
    return this.listSkills();
  }

  _scanDir(dirPath, sourceKind, depth = 0) {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          const skillMd = path.join(fullPath, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            this._loadSkillFile(entry.name, skillMd, sourceKind);
          } else if (depth < 6) this._scanDir(fullPath, sourceKind, depth + 1);
        } else if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.json'))) {
          const skillName = path.basename(entry.name, path.extname(entry.name));
          this._loadSkillFile(skillName, fullPath, sourceKind);
        }
      }
    } catch (_) {}
  }

  _loadSkillFile(name, filePath, sourceKind) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      this.skills.set(name, {
        name,
        path: filePath,
        content,
        sourceKind,
        updatedAt: fs.statSync(filePath).mtimeMs
      });
    } catch (_) {}
  }

  registerInlineSkill(name, data) {
    this.skills.set(name, {
      name,
      path: 'in-memory',
      content: data.prompt || data.description || '',
      sourceKind: 'builtin',
      updatedAt: Date.now()
    });
  }

  startWatching() {
    this.stopWatching();
    const dirsToWatch = [this.globalSkillsDir];
    const localDir = path.join(this.workspaceDir, '.skills');
    if (fs.existsSync(localDir)) dirsToWatch.push(localDir);
    if (this.sharedSkillsDir && fs.existsSync(this.sharedSkillsDir)) dirsToWatch.push(this.sharedSkillsDir);

    for (const dir of dirsToWatch) {
      try {
        const watcher = fs.watch(dir, { recursive: true }, (event, filename) => {
          if (filename && (filename.endsWith('.md') || filename.endsWith('.json'))) {
            console.log(`[SkillManager] Hot-reload triggered by file change: ${filename}`);
            this.scanAndReload();
          }
        });
        this.watchers.push(watcher);
      } catch (_) {}
    }
  }

  stopWatching() {
    for (const w of this.watchers) {
      try { w.close(); } catch (_) {}
    }
    this.watchers = [];
  }

  /**
   * Mid-turn shortcut resolution: checks if user prompt contains `$skill-name`
   * and automatically injects instructions into the turn prompt without restarting.
   */
  resolvePromptShortcuts(promptText) {
    let resolvedText = promptText;
    const matches = promptText.match(/\$([a-zA-Z0-9_-]+)/g);
    const injectedSkills = [];

    if (matches) {
      for (const match of matches) {
        const skillName = match.substring(1);
        const skill = this.skills.get(skillName);
        if (skill) {
          injectedSkills.push(skillName);
          resolvedText = resolvedText.replace(
            match,
            `\n\n[🔥 실시간 핫리로드 스킬 주입: $${skillName}]\n${skill.content}\n`
          );
        }
      }
    }

    return { text: resolvedText, injectedSkills };
  }

  listSkills() {
    return Array.from(this.skills.values()).map(s => ({
      name: s.name,
      sourceKind: s.sourceKind,
      path: s.path,
      updatedAt: s.updatedAt
    }));
  }
}

module.exports = { SkillManager };
