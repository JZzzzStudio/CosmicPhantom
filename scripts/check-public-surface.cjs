#!/usr/bin/env node
// check-public-surface.cjs — public wording and sensitive-content checks.
// It scans the fixed public entry points plus every tracked/untracked text file
// that would be visible to Git, so legacy archives and plugin files cannot hide
// behind a small allowlist.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_FILES = [
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'docs/README.md',
  'DIRECTORY-MAP.md',
  'HOST-PARADIGM.md',
  'AGENT-BOOTSTRAP.md',
  'AGENT-INSTALL.md',
  'MANUAL.md',
  'docs/ARCHITECTURE.md',
  'docs/AGENT-CONFIG.md',
  'docs/PLUGIN-PACKAGE.md',
  'docs/TERMINOLOGY.md',
  'core/CONTEXT.template.md',
  'sources.example.json',
  'binaries.manifest.json',
  'package.json',
  'package-lock.json',
  'eval/golden-set.json',
  'eval/golden-heldout.json',
  'eval/golden-adversarial.json',
];

const PUBLIC_WORDING_FORBIDDEN = [
  { name: '具体宿主品牌', re: /\b(?:Proma|Hermes|ZCode|WorkBuddy|CodeBuddy|Breezell)\b/i },
  { name: '宿主内部路径', re: /(?:~\/\.|(?:^|[ (])\/(?:Users|home)\/|[A-Z]:[\\/](?:Users|home|cp-lab|Proma)[\\/])/i },
  { name: '凭据或私有数据标记', re: /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|cp-cindy-bridge|\.proma[\\/]/i },
  { name: '署名或品牌注入', re: /Made[- ]with\s*:/i },
];

const SENSITIVE = [
  // Detection regexes and synthetic test fixtures may contain marker strings by design.

  { name: 'credential-format', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,})\b|\bBearer\s+[A-Za-z0-9._-]{20,}/i },
  { name: 'private-machine-path', re: /(?:[A-Z]:[\\/](?:Users|home|AITEAM|AIGC|Proma|cp-lab|CC)[\\/][A-Za-z0-9._-]+|\/(?:Users|home)\/[A-Za-z0-9._-]+)/i },
  { name: 'private-capture', re: /cp-cindy-bridge|raw-pages|host-responses|sessionUrl|capture-manifest/i },
  { name: 'private-source-marker', re: /<PROMA_SESSIONS_DIR>|个人原话|Z:[\\/]/i },
  { name: 'unresolved-asset-placeholder', re: /github\.com\/<OWNER>\/.*releases|sha256[^\n]{0,100}<填写|<填写后由/i },
];

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'tools',
  'embedding-db',
  'delivery',
  'backup',
  'cp-cindy-bridge',
  'memories',
  'candidates',
  'domains',
  'data',
  'daily',
  'distilled',
  'pro',
  'work',
  '.context',
]);
const TEXT_EXTENSIONS = new Set(['.cjs', '.js', '.mjs', '.json', '.md', '.markdown', '.txt', '.yml', '.yaml', '.toml']);

function gitFiles(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\\/g, '/'));
  } catch {
    return [];
  }
}

function ignored(file) {
  const parts = file.split('/');
  return parts.some((part) => IGNORE_DIRS.has(part));
}

function candidate(file) {
  if (ignored(file)) return false;
  if (PUBLIC_FILES.includes(file)) return true;
  return TEXT_EXTENSIONS.has(path.extname(file).toLowerCase());
}

const files = new Set(PUBLIC_FILES);
for (const file of gitFiles(['ls-files'])) if (candidate(file)) files.add(file);
for (const file of gitFiles(['ls-files', '--others', '--exclude-standard'])) if (candidate(file)) files.add(file);

const errors = [];
const read = (file) => {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    errors.push({ file, rule: 'missing-public-file' });
    return '';
  }
  try {
    if (fs.statSync(abs).size > 2 * 1024 * 1024) return '';
    return fs.readFileSync(abs, 'utf8');
  } catch {
    errors.push({ file, rule: 'unreadable-public-file' });
    return '';
  }
};

for (const file of files) {
  const text = read(file);
  const selfScan = file === 'scripts/check-public-surface.cjs' || file === 'scripts/check-sanitize.cjs';
  const wordingChecked = PUBLIC_FILES.includes(file) && !file.startsWith('eval/') && file !== 'package.json' && file !== 'package-lock.json';
  const rules = wordingChecked ? [...PUBLIC_WORDING_FORBIDDEN, ...SENSITIVE] : SENSITIVE;
  for (const rule of rules) {
    if (!selfScan && rule.re.test(text)) errors.push({ file, rule: rule.name });
  }
  if (PUBLIC_FILES.includes(file)) {
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].trim().split('#')[0];
      if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
      const abs = path.resolve(path.dirname(path.join(ROOT, file)), target);
      if (!fs.existsSync(abs)) errors.push({ file, rule: 'broken-link', target });
    }
  }
}

const result = { ok: errors.length === 0, files: files.size, errors };
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
