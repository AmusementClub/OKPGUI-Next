#!/usr/bin/env node
/**
 * Offline MediaInfo package inventory / checksum verifier.
 * Validates manifest schema, target set, staged file names, executable presence, and hashes.
 * Does not require network access.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');

const REQUIRED_TARGETS = [
  'x86_64-pc-windows-msvc',
  'x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin',
  'aarch64-apple-darwin',
];

const STAGED_NAMES = {
  'x86_64-pc-windows-msvc': 'mediainfo-x86_64-pc-windows-msvc.exe',
  'x86_64-unknown-linux-gnu': 'mediainfo-x86_64-unknown-linux-gnu',
  'x86_64-apple-darwin': 'mediainfo-x86_64-apple-darwin',
  'aarch64-apple-darwin': 'mediainfo-aarch64-apple-darwin',
};

const OFFICIAL_URL_PREFIX = 'https://mediaarea.net/';

/** Checked-in redistribution notice relative to repo root (offline). */
const NOTICE_RELATIVE_PATH = path.join(
  'src-tauri',
  'resources',
  'mediainfo',
  'THIRD_PARTY_NOTICES.html',
);

/**
 * Key attribution / license markers that must appear in the notice file.
 * Offline-only content checks — no network fetches.
 */
const NOTICE_REQUIRED_MARKERS = [
  'MediaArea',
  'MediaInfo',
  'MediaArea.net SARL',
  'Copyright (c) MediaArea.net SARL',
  'Redistribution and use in source and binary forms',
  'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS',
  'https://mediaarea.net/en/MediaInfo',
  'https://raw.githubusercontent.com/MediaArea/MediaInfo/master/License.html',
];

function usage() {
  console.log(`Usage: node verify-mediainfo-package.mjs [options]

Options:
  --manifest <path>   Manifest path (default: scripts/mediainfo-manifest.json)
  --stage-dir <path>  Stage directory (default: src-tauri/binaries)
  --target <triple>   Verify only this target (repeatable). Default: all targets.
  --manifest-only     Validate manifest schema + notice (skip executable presence/hashes)
  --help              Show this help
`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(readFileSync(filePath));
  return hash.digest('hex');
}

function parseArgs(argv) {
  const opts = {
    manifest: path.join(scriptDir, 'mediainfo-manifest.json'),
    stageDir: path.join(rootDir, 'src-tauri', 'binaries'),
    targets: [],
    manifestOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--manifest-only') {
      opts.manifestOnly = true;
    } else if (arg === '--manifest') {
      opts.manifest = path.resolve(argv[++i] ?? '');
    } else if (arg === '--stage-dir') {
      opts.stageDir = path.resolve(argv[++i] ?? '');
    } else if (arg === '--target') {
      opts.targets.push(argv[++i] ?? '');
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256Hex(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function validateManifestSchema(manifest) {
  const errors = [];

  if (!manifest || typeof manifest !== 'object') {
    return ['manifest root must be an object'];
  }
  if (manifest.version !== '26.05') {
    errors.push(`manifest.version must be "26.05", got ${JSON.stringify(manifest.version)}`);
  }
  if (manifest.tauri_external_bin !== 'binaries/mediainfo') {
    errors.push(
      `manifest.tauri_external_bin must be "binaries/mediainfo", got ${JSON.stringify(manifest.tauri_external_bin)}`,
    );
  }
  if (!manifest.license || !isNonEmptyString(manifest.license.source_url)) {
    errors.push('manifest.license.source_url is required');
  } else if (
    manifest.license.source_url !==
    'https://raw.githubusercontent.com/MediaArea/MediaInfo/master/License.html'
  ) {
    errors.push('manifest.license.source_url must point at the official MediaInfo License.html');
  }
  if (!manifest.targets || typeof manifest.targets !== 'object') {
    errors.push('manifest.targets must be an object');
    return errors;
  }

  const targetKeys = Object.keys(manifest.targets);
  for (const required of REQUIRED_TARGETS) {
    if (!targetKeys.includes(required)) {
      errors.push(`manifest.targets missing required target: ${required}`);
    }
  }
  for (const key of targetKeys) {
    if (!REQUIRED_TARGETS.includes(key)) {
      errors.push(`manifest.targets contains unknown target: ${key}`);
    }
  }

  for (const target of REQUIRED_TARGETS) {
    const entry = manifest.targets[target];
    if (!entry) continue;
    const prefix = `targets.${target}`;
    if (!entry.archive || typeof entry.archive !== 'object') {
      errors.push(`${prefix}.archive is required`);
      continue;
    }
    if (!isNonEmptyString(entry.archive.url)) {
      errors.push(`${prefix}.archive.url is required`);
    } else if (!entry.archive.url.startsWith(OFFICIAL_URL_PREFIX)) {
      errors.push(`${prefix}.archive.url must use official mediaarea.net HTTPS URL`);
    }
    if (!isSha256Hex(entry.archive.sha256)) {
      errors.push(`${prefix}.archive.sha256 must be a 64-char hex digest`);
    }
    if (!isNonEmptyString(entry.archive.format)) {
      errors.push(`${prefix}.archive.format is required`);
    }
    if (!entry.extracted || typeof entry.extracted !== 'object') {
      errors.push(`${prefix}.extracted is required`);
    } else {
      if (!isNonEmptyString(entry.extracted.path)) {
        errors.push(`${prefix}.extracted.path is required`);
      }
      if (!isSha256Hex(entry.extracted.sha256)) {
        errors.push(`${prefix}.extracted.sha256 must be a 64-char hex digest`);
      }
    }
    const expectedName = STAGED_NAMES[target];
    if (entry.staged_name !== expectedName) {
      errors.push(
        `${prefix}.staged_name must be "${expectedName}", got ${JSON.stringify(entry.staged_name)}`,
      );
    }
  }

  return errors;
}

/**
 * Offline notice presence + content gate.
 * Requires the checked-in THIRD_PARTY_NOTICES path and key MediaArea
 * attribution/license markers. No network access.
 */
function validateNoticeFile(rootDir) {
  const errors = [];
  const noticePath = path.join(rootDir, NOTICE_RELATIVE_PATH);
  if (!existsSync(noticePath)) {
    errors.push(`missing redistribution notice: ${noticePath}`);
    return errors;
  }
  const st = statSync(noticePath);
  if (!st.isFile()) {
    errors.push(`redistribution notice is not a file: ${noticePath}`);
    return errors;
  }
  if (st.size <= 0) {
    errors.push(`redistribution notice is empty: ${noticePath}`);
    return errors;
  }
  let body;
  try {
    body = readFileSync(noticePath, 'utf8');
  } catch (error) {
    errors.push(
      `failed to read redistribution notice: ${error instanceof Error ? error.message : String(error)}`,
    );
    return errors;
  }
  for (const marker of NOTICE_REQUIRED_MARKERS) {
    if (!body.includes(marker)) {
      errors.push(
        `redistribution notice missing required MediaArea attribution/license marker: ${JSON.stringify(marker)}`,
      );
    }
  }
  return errors;
}

function verifyStagedExecutable(stageDir, target, entry) {
  const stagedPath = path.join(stageDir, entry.staged_name);
  if (!existsSync(stagedPath)) {
    return [`missing staged executable for ${target}: ${stagedPath}`];
  }
  const st = statSync(stagedPath);
  if (!st.isFile()) {
    return [`staged path is not a file for ${target}: ${stagedPath}`];
  }
  if (st.size <= 0) {
    return [`staged executable is empty for ${target}: ${stagedPath}`];
  }
  const digest = sha256File(stagedPath).toLowerCase();
  const expected = String(entry.extracted.sha256).toLowerCase();
  if (digest !== expected) {
    return [
      `staged executable sha256 mismatch for ${target}: expected ${expected}, got ${digest}`,
    ];
  }
  return [];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(opts.manifest)) {
    die(`manifest not found: ${opts.manifest}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
  } catch (error) {
    die(`failed to parse manifest: ${error instanceof Error ? error.message : String(error)}`);
  }

  const schemaErrors = validateManifestSchema(manifest);
  if (schemaErrors.length > 0) {
    for (const err of schemaErrors) {
      console.error(`error: ${err}`);
    }
    process.exit(1);
  }
  console.log('Manifest schema OK (version 26.05, 4 targets, official URLs + hashes).');

  const noticeErrors = validateNoticeFile(rootDir);
  if (noticeErrors.length > 0) {
    for (const err of noticeErrors) {
      console.error(`error: ${err}`);
    }
    process.exit(1);
  }
  console.log(`Redistribution notice OK (${NOTICE_RELATIVE_PATH}).`);

  const targets =
    opts.targets.length > 0 ? opts.targets : [...REQUIRED_TARGETS];

  for (const target of targets) {
    if (!REQUIRED_TARGETS.includes(target)) {
      die(`unknown target '${target}'`);
    }
    if (!manifest.targets[target]) {
      die(`target '${target}' missing from manifest`);
    }
  }

  if (opts.manifestOnly) {
    console.log('Manifest-only mode: skipped executable presence/hash checks.');
    console.log('OK: MediaInfo package inventory (manifest + notice)');
    return;
  }

  if (!existsSync(opts.stageDir)) {
    die(`stage directory not found: ${opts.stageDir}`);
  }

  const errors = [];
  for (const target of targets) {
    const entry = manifest.targets[target];
    errors.push(...verifyStagedExecutable(opts.stageDir, target, entry));
  }

  if (errors.length > 0) {
    for (const err of errors) {
      console.error(`error: ${err}`);
    }
    process.exit(1);
  }

  for (const target of targets) {
    console.log(`OK: ${target} -> ${manifest.targets[target].staged_name} (sha256 match)`);
  }
  console.log('OK: MediaInfo package inventory (executables + hashes)');
}

main();
