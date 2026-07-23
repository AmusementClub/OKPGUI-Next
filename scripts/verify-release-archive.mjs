#!/usr/bin/env node
/**
 * Dependency-free release archive membership verifier.
 *
 * Fail-closed: requires app binary, target-named MediaInfo sidecar, and
 * redistribution notice members inside a .zip or .tar.gz archive.
 * Uses only Node.js built-ins (no npm packages).
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';

const DEFAULT_NOTICE = 'mediainfo/THIRD_PARTY_NOTICES.html';

function usage() {
  console.log(`Usage: node verify-release-archive.mjs --archive <path> --binary <name> --sidecar <name> [options]

Options:
  --archive <path>   Path to .zip or .tar.gz release archive (required)
  --binary <name>    Required app binary member name (e.g. okpgui-next, okpgui-next.exe)
  --sidecar <name>   Required MediaInfo sidecar member name (target-triple staged name)
  --notice <path>    Required notice member path (default: ${DEFAULT_NOTICE})
  --help             Show this help
`);
}

function die(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    archive: '',
    binary: '',
    sidecar: '',
    notice: DEFAULT_NOTICE,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (arg === '--archive') {
      opts.archive = argv[++i] ?? '';
    } else if (arg === '--binary') {
      opts.binary = argv[++i] ?? '';
    } else if (arg === '--sidecar') {
      opts.sidecar = argv[++i] ?? '';
    } else if (arg === '--notice') {
      opts.notice = argv[++i] ?? '';
    } else {
      die(`unknown argument: ${arg}`);
    }
  }
  if (!opts.archive) die('--archive is required');
  if (!opts.binary) die('--binary is required');
  if (!opts.sidecar) die('--sidecar is required');
  if (!opts.notice) die('--notice must be a non-empty member path');
  return opts;
}

/** Normalize archive member paths for comparison (POSIX separators, no leading ./). */
function normalizeMember(name) {
  return String(name)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/**
 * List ZIP local/central directory member names (stored + deflated).
 * Minimal EOCD + central directory parser; no external deps.
 */
function listZipMembers(buffer) {
  // End of central directory signature: 0x06054b50
  const eocdSig = 0x06054b50;
  let eocdOffset = -1;
  // EOCD is at least 22 bytes; comment can extend it — scan from end.
  const minEocd = 22;
  if (buffer.length < minEocd) {
    die('zip archive too small');
  }
  const scanStart = Math.max(0, buffer.length - (minEocd + 0xffff));
  for (let i = buffer.length - minEocd; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    die('zip end-of-central-directory signature not found');
  }
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralSize = buffer.readUInt32LE(eocdOffset + 12);
  const centralOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (centralOffset + centralSize > buffer.length) {
    die('zip central directory is truncated');
  }

  const members = [];
  let offset = centralOffset;
  const centralSig = 0x02014b50;
  for (let entry = 0; entry < totalEntries; entry += 1) {
    if (offset + 46 > buffer.length) {
      die('zip central directory entry truncated');
    }
    if (buffer.readUInt32LE(offset) !== centralSig) {
      die(`zip central directory signature mismatch at entry ${entry}`);
    }
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + nameLen;
    if (nameEnd > buffer.length) {
      die('zip member name truncated');
    }
    const name = buffer.subarray(nameStart, nameEnd).toString('utf8');
    members.push(normalizeMember(name));
    offset = nameEnd + extraLen + commentLen;
  }
  return members;
}

/**
 * List ustar/POSIX tar members from an (optionally gzipped) archive buffer.
 */
function listTarMembers(rawBuffer, gzipped) {
  const buffer = gzipped ? gunzipSync(rawBuffer) : rawBuffer;
  const members = [];
  let offset = 0;
  const block = 512;

  while (offset + block <= buffer.length) {
    const header = buffer.subarray(offset, offset + block);
    // Two zero blocks mark end of archive.
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const nameField = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefixField = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const sizeOctal = header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
    const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
    if (Number.isNaN(size) || size < 0) {
      die(`tar member size is invalid near offset ${offset}`);
    }
    // Skip non-file/directory weirdness but still record names for membership.
    const typeFlag = String.fromCharCode(header[156] || 0);
    let fullName = nameField;
    if (prefixField) {
      fullName = `${prefixField}/${nameField}`;
    }
    // POSIX pax/gnu long-name: treat type 'L' / 'x' / 'g' content as next-name; skip body.
    if (fullName) {
      // Directory entries often end with / — normalize without trailing slash for file checks.
      members.push(normalizeMember(fullName));
    }
    // Ignore typeFlag for membership; size still advances the stream.
    void typeFlag;
    const dataBlocks = Math.ceil(size / block);
    offset += block + dataBlocks * block;
  }
  return members;
}

function listArchiveMembers(archivePath) {
  if (!existsSync(archivePath)) {
    die(`archive not found: ${archivePath}`);
  }
  const st = statSync(archivePath);
  if (!st.isFile() || st.size <= 0) {
    die(`archive is missing or empty: ${archivePath}`);
  }
  const buffer = readFileSync(archivePath);
  const lower = archivePath.toLowerCase();
  if (lower.endsWith('.zip')) {
    return listZipMembers(buffer);
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    return listTarMembers(buffer, true);
  }
  if (lower.endsWith('.tar')) {
    return listTarMembers(buffer, false);
  }
  die(`unsupported archive type (expected .zip or .tar.gz): ${archivePath}`);
}

function memberPresent(members, required) {
  const want = normalizeMember(required);
  return members.some((m) => m === want || m.endsWith(`/${want}`));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const archivePath = path.resolve(opts.archive);
  const members = listArchiveMembers(archivePath);

  const required = [
    { label: 'app binary', name: opts.binary },
    { label: 'MediaInfo sidecar', name: opts.sidecar },
    { label: 'redistribution notice', name: opts.notice },
  ];

  const missing = [];
  for (const item of required) {
    if (!memberPresent(members, item.name)) {
      missing.push(`${item.label}: ${item.name}`);
    }
  }

  if (missing.length > 0) {
    console.error('error: release archive is missing required members:');
    for (const entry of missing) {
      console.error(`  - ${entry}`);
    }
    console.error(`archive: ${archivePath}`);
    console.error(`members (${members.length}):`);
    for (const name of members.slice(0, 50)) {
      console.error(`  ${name}`);
    }
    if (members.length > 50) {
      console.error(`  ... and ${members.length - 50} more`);
    }
    process.exit(1);
  }

  console.log(`OK: release archive members present in ${path.basename(archivePath)}`);
  console.log(`  binary:  ${opts.binary}`);
  console.log(`  sidecar: ${opts.sidecar}`);
  console.log(`  notice:  ${opts.notice}`);
}

main();
