#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = spawnSync('git', ['ls-files', '-z'], {
  cwd: rootDir,
  encoding: 'utf8',
});

if (git.status !== 0) {
  const detail = (git.stderr || git.stdout || 'unknown git error').trim();
  console.error(`[repository-hygiene] unable to inspect tracked files: ${detail}`);
  process.exit(1);
}

const forbiddenDirectories = new Set([
  '.agents',
  '.claude',
  '.codex',
  '.continue',
  '.cursor',
  '.omc',
  '.omx',
  '.roo',
  '.windsurf',
]);
const forbiddenFiles = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.github/copilot-instructions.md',
]);

const trackedFiles = git.stdout.split('\0').filter(Boolean);
const violations = trackedFiles.filter((file) => {
  const segments = file.split('/');
  return forbiddenFiles.has(file)
    || segments.some((segment) => forbiddenDirectories.has(segment))
    || segments.some((segment) => segment.startsWith('.aider'))
    || (segments[0] === '.github' && segments[1] === 'instructions')
    || segments[0] === '.pnpm-store'
    || file.includes('/.pnpm-store/');
});

if (violations.length > 0) {
  console.error('[repository-hygiene] local AI/agent harness control files are tracked:');
  for (const file of violations) console.error(`- ${file}`);
  process.exit(1);
}

console.log(
  `[repository-hygiene] passed: ${trackedFiles.length} tracked files contain no local AI/agent harness controls`,
);
