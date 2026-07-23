#!/usr/bin/env bash
# Stage official MediaInfo CLI binaries into src-tauri/binaries/ for Tauri externalBin.
# Verifies archive and final executable sha256; fail-closed on unknown targets.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFEST="${SCRIPT_DIR}/mediainfo-manifest.json"
STAGE_DIR="${ROOT_DIR}/src-tauri/binaries"

usage() {
  cat <<'EOF'
Usage: stage-mediainfo.sh <target-triple>

Supported targets (from scripts/mediainfo-manifest.json):
  x86_64-pc-windows-msvc
  x86_64-unknown-linux-gnu
  x86_64-apple-darwin
  aarch64-apple-darwin

Environment:
  MEDIAINFO_MANIFEST  Override manifest path
  MEDIAINFO_STAGE_DIR Override stage directory
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    die "neither sha256sum nor shasum is available"
  fi
}

json_get() {
  # json_get <file> <python-expr-on-data>
  local file="$1"
  local expr="$2"
  python3 - "$file" "$expr" <<'PY'
import json, sys
path, expr = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
# Restricted evaluation over the loaded document only.
result = eval(expr, {"__builtins__": {}}, {"data": data})
if result is None:
    sys.exit(2)
print(result)
PY
}

TARGET="${1:-}"
if [[ -z "${TARGET}" || "${TARGET}" == "-h" || "${TARGET}" == "--help" ]]; then
  usage
  [[ -n "${TARGET}" ]] && exit 0
  exit 1
fi

MANIFEST="${MEDIAINFO_MANIFEST:-$MANIFEST}"
STAGE_DIR="${MEDIAINFO_STAGE_DIR:-$STAGE_DIR}"

[[ -f "${MANIFEST}" ]] || die "manifest not found: ${MANIFEST}"
require_cmd curl
require_cmd python3

# Fail closed: target must exist in the checked-in manifest.
if ! python3 - "$MANIFEST" "$TARGET" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    data = json.load(f)
sys.exit(0 if sys.argv[2] in data.get("targets", {}) else 1)
PY
then
  die "unknown or missing target '${TARGET}' (not listed in manifest)"
fi

URL="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['archive']['url']")"
ARCHIVE_SHA="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['archive']['sha256']")"
ARCHIVE_FORMAT="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['archive']['format']")"
EXTRACTED_PATH="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['extracted']['path']")"
EXTRACTED_SHA="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['extracted']['sha256']")"
STAGED_NAME="$(json_get "${MANIFEST}" "data['targets']['${TARGET}']['staged_name']")"

# Only official MediaArea URLs from the manifest are used (already loaded from it).
case "${URL}" in
  https://mediaarea.net/*) ;;
  *) die "refusing non-official URL from manifest: ${URL}" ;;
esac

mkdir -p "${STAGE_DIR}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/okpgui-mediainfo.XXXXXX")"
MOUNT_POINT=""

# Detach a DMG mount. Prefer quiet detach; one force attempt if still attached.
# Returns 0 only when detach succeeds (or mount is already gone). Fail closed otherwise.
detach_dmg() {
  local mount="$1"
  [[ -n "${mount}" ]] || return 0
  # Already gone: nothing to detach.
  if [[ ! -d "${mount}" ]] && ! mount | grep -F " ${mount} " >/dev/null 2>&1; then
    return 0
  fi
  if hdiutil detach "${mount}" -quiet 2>/dev/null; then
    return 0
  fi
  # Force once so cleanup can remove the work directory without deleting an attached mount.
  if hdiutil detach "${mount}" -force -quiet 2>/dev/null; then
    return 0
  fi
  echo "error: failed to detach DMG mount: ${mount}" >&2
  return 1
}

cleanup() {
  # Narrow cleanup: only our work directory. Never rm -rf broad paths.
  # Detach before deleting WORK_DIR so we never remove an attached mountpoint.
  local detach_failed=0
  if [[ -n "${MOUNT_POINT:-}" ]]; then
    if detach_dmg "${MOUNT_POINT}"; then
      MOUNT_POINT=""
    else
      # Do not clear MOUNT_POINT after a failed detach (masks failure / leaves mount).
      # Do not delete WORK_DIR while the mount may still be attached under it.
      detach_failed=1
    fi
  fi
  if [[ "${detach_failed}" -ne 0 ]]; then
    return 1
  fi
  if [[ -n "${WORK_DIR:-}" && -d "${WORK_DIR}" ]]; then
    rm -rf "${WORK_DIR}"
  fi
}
trap cleanup EXIT

ARCHIVE_FILE="${WORK_DIR}/archive"
EXTRACT_DIR="${WORK_DIR}/extract"
mkdir -p "${EXTRACT_DIR}"

echo "Downloading MediaInfo ${TARGET} from official URL..."
curl -fsSL --proto '=https' --tlsv1.2 -o "${ARCHIVE_FILE}" "${URL}"

GOT_ARCHIVE_SHA="$(sha256_file "${ARCHIVE_FILE}")"
if [[ "${GOT_ARCHIVE_SHA}" != "${ARCHIVE_SHA}" ]]; then
  die "archive sha256 mismatch for ${TARGET}: expected ${ARCHIVE_SHA}, got ${GOT_ARCHIVE_SHA}"
fi
echo "Archive sha256 verified."

EXTRACTED_BIN=""
case "${ARCHIVE_FORMAT}" in
  zip)
    require_cmd unzip
    unzip -q "${ARCHIVE_FILE}" -d "${EXTRACT_DIR}"
    # extracted.path is relative inside the zip (e.g. MediaInfo.exe or bin/mediainfo)
    if [[ "${EXTRACTED_PATH}" = /* ]]; then
      die "zip extracted path must be relative, got ${EXTRACTED_PATH}"
    fi
    EXTRACTED_BIN="${EXTRACT_DIR}/${EXTRACTED_PATH}"
    ;;
  dmg)
    require_cmd hdiutil
    require_cmd pkgutil
    [[ "$(uname -s)" == "Darwin" ]] || die "dmg targets require macOS (hdiutil/pkgutil)"
    MOUNT_POINT="${WORK_DIR}/mnt"
    mkdir -p "${MOUNT_POINT}"
    hdiutil attach "${ARCHIVE_FILE}" -nobrowse -readonly -mountpoint "${MOUNT_POINT}" >/dev/null

    PKG_PATH="$(find "${MOUNT_POINT}" -name '*.pkg' -type f | head -n 1 || true)"
    [[ -n "${PKG_PATH}" ]] || die "no .pkg found inside MediaInfo DMG"

    PKG_EXPAND="${WORK_DIR}/pkg"
    pkgutil --expand "${PKG_PATH}" "${PKG_EXPAND}"

    # Locate Payload and extract the CLI binary path from the package.
    PAYLOAD="$(find "${PKG_EXPAND}" -name 'Payload' -type f | head -n 1 || true)"
    [[ -n "${PAYLOAD}" ]] || die "no Payload found inside MediaInfo package"

    PAYLOAD_ROOT="${WORK_DIR}/payload"
    mkdir -p "${PAYLOAD_ROOT}"
    # Payload is typically gzip-compressed cpio.
    if gzip -t "${PAYLOAD}" 2>/dev/null; then
      (cd "${PAYLOAD_ROOT}" && gzip -dc "${PAYLOAD}" | cpio -id 2>/dev/null)
    else
      (cd "${PAYLOAD_ROOT}" && cpio -id < "${PAYLOAD}" 2>/dev/null)
    fi

    # Manifest documents install path /usr/local/bin/mediainfo.
    REL_PATH="${EXTRACTED_PATH#/}"
    if [[ -f "${PAYLOAD_ROOT}/${REL_PATH}" ]]; then
      EXTRACTED_BIN="${PAYLOAD_ROOT}/${REL_PATH}"
    else
      EXTRACTED_BIN="$(find "${PAYLOAD_ROOT}" -type f -name 'mediainfo' | head -n 1 || true)"
    fi
    [[ -n "${EXTRACTED_BIN}" && -f "${EXTRACTED_BIN}" ]] || die "mediainfo binary not found in package payload"

    # Detach before continuing; only clear MOUNT_POINT after a successful detach.
    if ! detach_dmg "${MOUNT_POINT}"; then
      die "failed to detach MediaInfo DMG at ${MOUNT_POINT}"
    fi
    MOUNT_POINT=""
    ;;
  *)
    die "unsupported archive format '${ARCHIVE_FORMAT}' for target ${TARGET}"
    ;;
esac

[[ -f "${EXTRACTED_BIN}" ]] || die "extracted binary missing: ${EXTRACTED_BIN}"

GOT_BIN_SHA="$(sha256_file "${EXTRACTED_BIN}")"
if [[ "${GOT_BIN_SHA}" != "${EXTRACTED_SHA}" ]]; then
  die "executable sha256 mismatch for ${TARGET}: expected ${EXTRACTED_SHA}, got ${GOT_BIN_SHA}"
fi
echo "Executable sha256 verified."

STAGED_PATH="${STAGE_DIR}/${STAGED_NAME}"
# Replace only the specific staged file for this target (no broad cleanup).
cp "${EXTRACTED_BIN}" "${STAGED_PATH}"
chmod +x "${STAGED_PATH}"

FINAL_SHA="$(sha256_file "${STAGED_PATH}")"
if [[ "${FINAL_SHA}" != "${EXTRACTED_SHA}" ]]; then
  die "staged executable sha256 mismatch for ${TARGET}: expected ${EXTRACTED_SHA}, got ${FINAL_SHA}"
fi

# Host-appropriate smoke check: prove the pinned official binary actually runs.
# Does not rewrite manifest URL/hash on failure — fail closed instead.
smoke_check_staged() {
  local staged="$1"
  local target="$2"
  local host_os
  host_os="$(uname -s)"
  local host_arch
  host_arch="$(uname -m)"

  local can_exec=0
  case "${target}" in
    x86_64-unknown-linux-gnu)
      if [[ "${host_os}" == "Linux" && ( "${host_arch}" == "x86_64" || "${host_arch}" == "amd64" ) ]]; then
        can_exec=1
      fi
      ;;
    x86_64-apple-darwin|aarch64-apple-darwin)
      # Official Mac CLI is universal (x86_64 + arm64); run smoke check on any Darwin host.
      if [[ "${host_os}" == "Darwin" ]]; then
        can_exec=1
      fi
      ;;
    x86_64-pc-windows-msvc)
      # Unix hosts cannot execute the Windows .exe; Windows uses stage-mediainfo.ps1.
      can_exec=0
      ;;
    *)
      die "smoke check: unhandled target '${target}'"
      ;;
  esac

  if [[ "${can_exec}" -eq 0 ]]; then
    # Host-appropriate skip only. Linux release CI stages on Linux and must not skip.
    if [[ "${target}" == "x86_64-unknown-linux-gnu" && "${host_os}" == "Linux" ]]; then
      die "Linux MediaInfo smoke check required on Linux host but arch ${host_arch} cannot execute x86_64 binary"
    fi
    echo "Smoke check skipped: host ${host_os}/${host_arch} cannot execute ${target}."
    return 0
  fi

  # Prefer --Version; fall back to --Help. Fail closed if neither executes cleanly.
  local smoke_out=""
  if smoke_out="$("${staged}" --Version 2>&1)"; then
    echo "Smoke check OK: ${staged} --Version"
    echo "${smoke_out}" | head -n 3
    return 0
  fi
  if smoke_out="$("${staged}" --Help 2>&1)"; then
    echo "Smoke check OK: ${staged} --Help"
    return 0
  fi
  die "smoke check failed: staged MediaInfo binary for ${target} did not run (${staged}). Manifest URL/hash left unchanged."
}

smoke_check_staged "${STAGED_PATH}" "${TARGET}"

echo "Staged ${STAGED_PATH}"
echo "OK: MediaInfo ${TARGET} ready for Tauri externalBin (binaries/mediainfo)"
