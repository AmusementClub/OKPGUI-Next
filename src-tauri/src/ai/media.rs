use crate::domain::publish_plan::{
    MediaFileIdentity, PlanMediaEvidence, PlanMediaFileResult, PlanMediaStatus, PlanMediaSummary,
    PlanSubtitleTrack,
};
use crate::torrent::project_safe_torrent_context;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
use std::io::Write;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
use std::sync::atomic::AtomicU64;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mp4", "avi", "mov", "webm", "m4v", "ts", "m2ts"];
const MAX_DISCOVERY_DEPTH: usize = 4;
const MAX_DISCOVERY_FILES: usize = 10_000;
/// Hard cap on MediaInfo stdout/stderr retained in memory. Readers keep draining past this
/// limit so a chatty child cannot fill the OS pipe and deadlock the waiter.
const MAX_PIPE_BYTES: usize = 256 * 1024;
const MESSAGE_CHAR_LIMIT: usize = 240;
/// Bytes sampled from each end of a media file for private identity digests.
pub const MEDIA_IDENTITY_SAMPLE_BYTES: usize = 64 * 1024;

/// Default per-file MediaInfo probe timeout (V2 safety constant).
pub const DEFAULT_MEDIA_PROBE_TIMEOUT_MS: u64 = 30_000;
/// Hard upper bound for per-file MediaInfo probe timeout (V2 safety constant).
/// Caller overrides above this value are clamped; never unbounded.
pub const MAX_MEDIA_PROBE_TIMEOUT_MS: u64 = 300_000;
/// Hard cap on explicit IPC `relative_entries` accepted per MediaInfo start.
pub const MAX_MEDIA_RELATIVE_ENTRIES: usize = 256;
/// Concurrent MediaInfo child processes per batch (V2 safety constant).
pub const MEDIA_PROBE_CONCURRENCY: usize = 2;

/// Prevent the console MediaInfo binary from flashing a terminal window on Windows.
pub(crate) fn configure_mediainfo_command(_command: &mut Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
static EMBEDDED_TOOL_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const EMBEDDED_MEDIAINFO: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/binaries/mediainfo-x86_64-pc-windows-msvc.exe"
));

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const EMBEDDED_MEDIAINFO_NOTICE: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/resources/mediainfo/THIRD_PARTY_NOTICES.html"
));

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaCandidate {
    pub relative_name: String,
    pub size: u64,
}

/// Torrent-relative video entry accepted over IPC. Never an absolute probe path authority.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaRelativeEntry {
    pub relative_name: String,
    /// Optional size from the torrent tree for mismatch detection (bytes).
    #[serde(default)]
    pub expected_size: Option<u64>,
}

/// Internal probe request. Absolute `path` is backend-resolved only and never IPC authority.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaProbeRequest {
    pub relative_name: String,
    pub path: PathBuf,
}

/// Public outcome of resolving torrent-relative entries under allowed content roots.
#[derive(Debug, Clone)]
pub struct ResolvedMediaBatch {
    /// Files that exist under exactly one allowed root and are ready to probe.
    pub requests: Vec<MediaProbeRequest>,
    /// Relative-only outcomes that must not spawn MediaInfo (missing / ambiguous / mismatch).
    pub pre_results: Vec<MediaProbeResult>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MediaProbeState {
    Measured,
    MissingSidecar,
    StartFailed,
    NonZeroExit,
    MalformedJson,
    OversizedOutput,
    TimedOut,
    Cancelled,
    /// Relative entry did not resolve under any allowed torrent/content root.
    MissingFile,
    /// Relative entry matched more than one allowed root; ambiguous matches do not bind.
    AmbiguousMatch,
    /// On-disk size differs from the torrent-declared expected size.
    SizeMismatch,
    /// File bytes/mtime/size changed while MediaInfo was running; never bindable.
    ChangedDuringProbe,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaProbeResult {
    pub relative_name: String,
    pub state: MediaProbeState,
    pub summary: Option<MediaInfoSummary>,
    pub message: Option<String>,
    /// Private; omitted from IPC / frontend JSON.
    #[serde(skip)]
    pub(crate) identity: Option<MediaFileIdentity>,
}

impl MediaProbeResult {
    fn with_state(
        relative_name: impl Into<String>,
        state: MediaProbeState,
        summary: Option<MediaInfoSummary>,
        message: Option<String>,
    ) -> Self {
        Self {
            relative_name: relative_name.into(),
            state,
            summary,
            message,
            identity: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MediaInfoSummary {
    pub duration_ms: Option<u64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub video_codec: Option<String>,
    pub video_bit_depth: Option<u32>,
    pub audio_codecs: Vec<String>,
    pub subtitle_languages: Vec<String>,
    #[serde(default)]
    pub subtitle_tracks: Vec<PlanSubtitleTrack>,
    pub scan_type: Option<String>,
}

/// Build plan-owned media evidence from a Succeeded MediaInfo terminal result set.
///
/// Only `Measured` rows with safe relative names and normalized summaries are kept.
/// Absolute paths never enter the plan. Empty measured set → `CheckFailed` (still a
/// successful job bind so formal/local audit can derive `MEDIA_CHECK_FAILED`).
///
/// Callers must gate with `media_info_may_bind_plan_evidence` and identity-match
/// before binding; this helper does not consult plan tokens.
pub fn build_plan_media_evidence(
    job_id: &str,
    snapshot_hash: &str,
    request_generation: u64,
    results: &[MediaProbeResult],
) -> PlanMediaEvidence {
    let summaries = plan_media_summaries(results);
    let status = if summaries.is_empty() {
        PlanMediaStatus::CheckFailed
    } else {
        PlanMediaStatus::Tested
    };
    let file_identities = results
        .iter()
        .filter(|item| item.state == MediaProbeState::Measured)
        .filter_map(|item| item.identity.clone())
        .collect::<Vec<_>>();
    PlanMediaEvidence {
        job_id: job_id.to_string(),
        snapshot_hash: snapshot_hash.to_string(),
        request_generation,
        status,
        summaries,
        results: plan_media_results(results),
        file_identities,
    }
}

/// Preserve one safe, bounded outcome for every torrent media file considered by MediaInfo.
pub fn plan_media_results(results: &[MediaProbeResult]) -> Vec<PlanMediaFileResult> {
    results
        .iter()
        .filter_map(|item| {
            let relative_name = safe_relative_name(&item.relative_name);
            if relative_name == "[invalid]" {
                return None;
            }
            let summary = item.summary.as_ref().map(|summary| PlanMediaSummary {
                relative_name: relative_name.clone(),
                duration_ms: summary.duration_ms,
                width: summary.width,
                height: summary.height,
                video_codec: summary.video_codec.clone(),
                video_bit_depth: summary.video_bit_depth,
                audio_codecs: summary.audio_codecs.clone(),
                subtitle_languages: summary.subtitle_languages.clone(),
                subtitle_tracks: summary.subtitle_tracks.clone(),
                scan_type: summary.scan_type.clone(),
            });
            let message = item.message.as_deref().and_then(|message| {
                let bounded = message.chars().take(MESSAGE_CHAR_LIMIT).collect::<String>();
                (!bounded.trim().is_empty()).then_some(bounded)
            });
            Some(PlanMediaFileResult {
                relative_name,
                state: media_probe_state_label(item.state).to_string(),
                summary,
                message,
            })
        })
        .collect()
}

fn media_probe_state_label(state: MediaProbeState) -> &'static str {
    match state {
        MediaProbeState::Measured => "measured",
        MediaProbeState::MissingSidecar => "missing_sidecar",
        MediaProbeState::StartFailed => "start_failed",
        MediaProbeState::NonZeroExit => "non_zero_exit",
        MediaProbeState::MalformedJson => "malformed_json",
        MediaProbeState::OversizedOutput => "oversized_output",
        MediaProbeState::TimedOut => "timed_out",
        MediaProbeState::Cancelled => "cancelled",
        MediaProbeState::MissingFile => "missing_file",
        MediaProbeState::AmbiguousMatch => "ambiguous_match",
        MediaProbeState::SizeMismatch => "size_mismatch",
        MediaProbeState::ChangedDuringProbe => "changed_during_probe",
    }
}

/// Extract relative Measured summaries only.
pub fn plan_media_summaries(results: &[MediaProbeResult]) -> Vec<PlanMediaSummary> {
    results
        .iter()
        .filter(|item| item.state == MediaProbeState::Measured)
        .filter_map(|item| {
            let summary = item.summary.as_ref()?;
            let relative_name = safe_relative_name(&item.relative_name);
            if relative_name == "[invalid]" {
                return None;
            }
            Some(PlanMediaSummary {
                relative_name,
                duration_ms: summary.duration_ms,
                width: summary.width,
                height: summary.height,
                video_codec: summary.video_codec.clone(),
                video_bit_depth: summary.video_bit_depth,
                audio_codecs: summary.audio_codecs.clone(),
                subtitle_languages: summary.subtitle_languages.clone(),
                subtitle_tracks: summary.subtitle_tracks.clone(),
                scan_type: summary.scan_type.clone(),
            })
        })
        .collect()
}

pub fn discover_media_files(
    torrent_path: &str,
    manual_paths: &[String],
) -> Result<Vec<MediaCandidate>, String> {
    let torrent = Path::new(torrent_path);
    let torrent_parent = torrent
        .parent()
        .ok_or_else(|| "torrent has no parent directory".to_string())?;
    // Display root covers both discovery roots (torrent dir and its immediate parent)
    // so child candidates stay `child/video.mkv` and parent-root stay `video.mkv`.
    let display_root_raw = torrent_parent.parent().unwrap_or(torrent_parent);
    let display_root = display_root_raw
        .canonicalize()
        .unwrap_or_else(|_| display_root_raw.to_path_buf());

    let mut roots = vec![torrent_parent.to_path_buf()];
    if let Some(parent) = torrent_parent.parent() {
        roots.push(parent.to_path_buf());
    }

    let mut paths = Vec::new();
    let mut seen = HashSet::new();
    let mut used_names = HashSet::new();
    for manual in manual_paths {
        if paths.len() >= MAX_DISCOVERY_FILES {
            break;
        }
        let path = PathBuf::from(manual);
        if is_video_file(&path) && path.is_file() {
            add_candidate(&path, &display_root, &mut paths, &mut seen, &mut used_names);
        }
    }
    for root in roots {
        collect_video_files(
            &root,
            0,
            &display_root,
            &mut paths,
            &mut seen,
            &mut used_names,
        );
    }
    paths.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(paths
        .into_iter()
        .map(|(relative_name, size, _)| MediaCandidate {
            relative_name,
            size,
        })
        .collect())
}

fn collect_video_files(
    root: &Path,
    depth: usize,
    display_root: &Path,
    output: &mut Vec<(String, u64, PathBuf)>,
    seen: &mut HashSet<PathBuf>,
    used_names: &mut HashSet<String>,
) {
    if depth > MAX_DISCOVERY_DEPTH || output.len() >= MAX_DISCOVERY_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        if output.len() >= MAX_DISCOVERY_FILES {
            return;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_video_files(&path, depth + 1, display_root, output, seen, used_names);
        } else if is_video_file(&path) {
            add_candidate(&path, display_root, output, seen, used_names);
        }
    }
}

fn add_candidate(
    path: &Path,
    display_root: &Path,
    output: &mut Vec<(String, u64, PathBuf)>,
    seen: &mut HashSet<PathBuf>,
    used_names: &mut HashSet<String>,
) {
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    if !seen.insert(canonical.clone()) {
        return;
    }
    // Keep the canonical PathBuf for internal probing; only a safe relative label is exposed.
    let relative_name = relative_label_for_candidate(&canonical, display_root, used_names);
    let size = std::fs::metadata(&canonical)
        .map(|metadata| metadata.len())
        .unwrap_or_default();
    output.push((relative_name, size, canonical));
}

/// Build a probe-safe, non-absolute relative label under the discovery display root.
/// Paths outside that root (manual picks, unresolved symlink roots) use `manual/<filename>`.
fn relative_label_for_candidate(
    canonical: &Path,
    display_root: &Path,
    used_names: &mut HashSet<String>,
) -> String {
    if let Ok(rel) = canonical.strip_prefix(display_root) {
        let name = rel.to_string_lossy().replace('\\', "/");
        if !name.is_empty() && is_safe_relative_name(&name) && used_names.insert(name.clone()) {
            return name;
        }
    }
    manual_relative_label(canonical, used_names)
}

fn manual_relative_label(path: &Path, used_names: &mut HashSet<String>) -> String {
    let raw = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("file");
    // Sanitize and bound length so labels always pass the probe name gate.
    let sanitized: String = raw
        .chars()
        .map(|character| {
            if matches!(character, '/' | '\\' | ':') || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    let mut file_name = if sanitized.is_empty() || sanitized == ".." {
        "file".to_string()
    } else {
        sanitized
    };
    // Leave headroom for the `manual/` prefix and numeric collision suffixes.
    if file_name.chars().count() > 200 {
        file_name = file_name.chars().take(200).collect();
    }

    let base = format!("manual/{file_name}");
    if is_safe_relative_name(&base) && used_names.insert(base.clone()) {
        return base;
    }
    for index in 2_u32..=10_000 {
        let candidate = format!("manual/{index}_{file_name}");
        if is_safe_relative_name(&candidate) && used_names.insert(candidate.clone()) {
            return candidate;
        }
    }
    // Deterministic last-resort label; still non-absolute and probe-safe.
    let fallback = format!("manual/file_{}", used_names.len());
    used_names.insert(fallback.clone());
    fallback
}

fn is_video_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
        })
}

/// Build the allowlisted content roots for MediaInfo path resolution.
///
/// Roots are limited to:
/// - the torrent file's parent directory
/// - that parent's parent (sibling / recent-parent layout)
/// - an optional user-selected content root directory
///
/// Filesystem / drive roots (`/`, `C:\`, …) are never accepted: the torrent
/// grandparent is skipped when it is a root, and an explicit `content_root` that
/// resolves to a root is rejected. Relative IPC entries therefore cannot resolve
/// from `/` or a drive root.
///
/// Never recursively searches arbitrary drives. Caller-supplied absolute *file*
/// paths are never accepted as probe authority.
pub fn allowed_media_content_roots(
    torrent_path: &str,
    content_root: Option<&str>,
) -> Result<Vec<PathBuf>, String> {
    let torrent = Path::new(torrent_path.trim());
    if torrent_path.trim().is_empty() {
        return Err("torrent path is required for media resolution".to_string());
    }
    if !torrent.is_file() {
        return Err("torrent path is not a readable file".to_string());
    }
    let torrent_parent = torrent
        .parent()
        .ok_or_else(|| "torrent has no parent directory".to_string())?;

    let mut roots = Vec::new();
    // Torrent parent is required for normal layouts; still skip filesystem roots.
    push_canonical_dir(torrent_parent, &mut roots);
    // Grandparent enables sibling / recent-parent layouts but must never be `/` or a drive root.
    if let Some(grandparent) = torrent_parent.parent() {
        if !is_filesystem_or_drive_root(grandparent) {
            push_canonical_dir(grandparent, &mut roots);
        }
    }
    if let Some(manual) = content_root
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let manual_path = validate_media_content_root(manual)?;
        push_canonical_dir(&manual_path, &mut roots);
    }
    if roots.is_empty() {
        return Err("no allowed content roots available".to_string());
    }
    Ok(roots)
}

/// Validate a user-selected media directory before it enters a private plan binding.
pub fn validate_media_content_root(content_root: &str) -> Result<PathBuf, String> {
    let trimmed = content_root.trim();
    if trimmed.is_empty() {
        return Err("content root is required".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err("content root is not a directory".to_string());
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
    if is_filesystem_or_drive_root(&path) || is_filesystem_or_drive_root(&canonical) {
        return Err("content root must not be a filesystem or drive root".to_string());
    }
    Ok(canonical)
}

/// True when `path` is the Unix filesystem root or a Windows drive root.
///
/// Used to keep MediaInfo relative resolution from binding under `/` or `C:\`.
/// Windows drive-root *strings* are recognized even on Unix hosts so IPC-supplied
/// `content_root` values like `C:\` fail closed regardless of the build OS.
pub fn is_filesystem_or_drive_root(path: &Path) -> bool {
    use std::path::Component;
    // Cheap string forms before component analysis (covers uncanonicalized IPC input).
    let raw = path.as_os_str();
    if raw == "/" || raw == "\\" {
        return true;
    }
    if let Some(text) = path.to_str() {
        let trimmed = text.trim();
        let bytes = trimmed.as_bytes();
        // `C:\` / `C:/` / `d:\`
        if bytes.len() == 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
        {
            return true;
        }
        // Bare drive `C:`
        if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            return true;
        }
    }
    let mut components = path.components();
    match (components.next(), components.next(), components.next()) {
        // Unix `/`
        (Some(Component::RootDir), None, None) => true,
        // Windows `C:\` / `C:/` (native path components)
        (Some(Component::Prefix(_)), Some(Component::RootDir), None) => true,
        _ => {
            // Canonical paths may still be roots; parent() is None for `/` and drive roots.
            path.parent().is_none()
                && path
                    .components()
                    .any(|component| matches!(component, Component::RootDir | Component::Prefix(_)))
        }
    }
}

fn push_canonical_dir(path: &Path, roots: &mut Vec<PathBuf>) {
    if is_filesystem_or_drive_root(path) {
        return;
    }
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if is_filesystem_or_drive_root(&canonical) {
        return;
    }
    if !canonical.is_dir() {
        return;
    }
    if roots.iter().any(|existing| existing == &canonical) {
        return;
    }
    roots.push(canonical);
}

/// Clamp a caller-supplied per-file timeout to the documented finite range.
///
/// Minimum 100ms; maximum [`MAX_MEDIA_PROBE_TIMEOUT_MS`]. Missing values use
/// [`DEFAULT_MEDIA_PROBE_TIMEOUT_MS`].
pub fn clamp_media_probe_timeout_ms(timeout_ms: Option<u64>) -> u64 {
    timeout_ms
        .unwrap_or(DEFAULT_MEDIA_PROBE_TIMEOUT_MS)
        .clamp(100, MAX_MEDIA_PROBE_TIMEOUT_MS)
}

/// Map torrent-relative video entries to backend-resolved probe requests.
///
/// Absolute probe paths supplied by the caller are rejected (not used as authority).
/// Only safe relative labels are echoed in results. Ambiguous multi-root matches
/// do not bind to a file.
pub fn resolve_media_relative_entries(
    torrent_path: &str,
    entries: &[MediaRelativeEntry],
    content_root: Option<&str>,
) -> Result<ResolvedMediaBatch, String> {
    if entries.len() > MAX_MEDIA_RELATIVE_ENTRIES {
        return Err(format!(
            "too many relative media entries (max {MAX_MEDIA_RELATIVE_ENTRIES})"
        ));
    }
    resolve_media_relative_entries_impl(torrent_path, entries, content_root)
}

/// Resolve every media file declared by the bound torrent, preserving torrent sizes.
/// This backend-owned path is not subject to the explicit IPC batch cap.
/// Resolve every torrent media file using an optional plan-bound content directory.
pub fn resolve_all_torrent_media_entries_with_root(
    torrent_path: &str,
    content_root: Option<&str>,
) -> Result<ResolvedMediaBatch, String> {
    let torrent = project_safe_torrent_context(torrent_path)?;
    let entries = torrent
        .files
        .into_iter()
        .filter(|file| is_video_file(Path::new(&file.relative_path)))
        .map(|file| MediaRelativeEntry {
            relative_name: file.relative_path,
            expected_size: Some(file.size),
        })
        .collect::<Vec<_>>();
    resolve_media_relative_entries_impl(torrent_path, &entries, content_root)
}

fn resolve_media_relative_entries_impl(
    torrent_path: &str,
    entries: &[MediaRelativeEntry],
    content_root: Option<&str>,
) -> Result<ResolvedMediaBatch, String> {
    let roots = allowed_media_content_roots(torrent_path, content_root)?;
    // Defense in depth: never resolve relative labels under a filesystem/drive root.
    let roots: Vec<PathBuf> = roots
        .into_iter()
        .filter(|root| !is_filesystem_or_drive_root(root))
        .collect();
    if roots.is_empty() {
        return Err("no allowed content roots available".to_string());
    }
    let mut requests = Vec::new();
    let mut pre_results = Vec::new();

    for entry in entries {
        let relative_name = entry.relative_name.trim();
        if relative_name.is_empty() {
            continue;
        }
        // Absolute / path-like values are never probe authority.
        if !is_safe_relative_name(relative_name) {
            pre_results.push(MediaProbeResult::with_state(
                "[invalid]",
                MediaProbeState::StartFailed,
                None,
                Some("Media probe relative name is invalid".to_string()),
            ));
            continue;
        }
        let label = relative_name.replace('\\', "/");
        let matches = resolve_under_roots(&label, &roots);
        match matches.as_slice() {
            [] => {
                pre_results.push(MediaProbeResult::with_state(
                    label,
                    MediaProbeState::MissingFile,
                    None,
                    Some("Media file was not found under allowed content roots".to_string()),
                ));
            }
            [only] => {
                if let Some(expected) = entry.expected_size {
                    let actual = std::fs::metadata(only)
                        .map(|metadata| metadata.len())
                        .unwrap_or(u64::MAX);
                    if actual != expected {
                        pre_results.push(MediaProbeResult::with_state(
                            label,
                            MediaProbeState::SizeMismatch,
                            None,
                            Some("On-disk size does not match torrent entry".to_string()),
                        ));
                        continue;
                    }
                }
                requests.push(MediaProbeRequest {
                    relative_name: label,
                    path: only.clone(),
                });
            }
            _ => {
                pre_results.push(MediaProbeResult::with_state(
                    label,
                    MediaProbeState::AmbiguousMatch,
                    None,
                    Some("Media file matched multiple content roots".to_string()),
                ));
            }
        }
    }

    Ok(ResolvedMediaBatch {
        requests,
        pre_results,
    })
}

fn resolve_under_roots(relative_name: &str, roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut matches = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let candidate = root.join(relative_name);
        let Ok(canonical) = candidate.canonicalize() else {
            continue;
        };
        if !canonical.is_file() {
            continue;
        }
        if !is_path_within_root(&canonical, root) {
            continue;
        }
        if !is_video_file(&canonical) {
            continue;
        }
        if seen.insert(canonical.clone()) {
            matches.push(canonical);
        }
    }
    matches
}

fn is_path_within_root(path: &Path, root: &Path) -> bool {
    let Ok(canonical_root) = root.canonicalize() else {
        return path.starts_with(root);
    };
    path.starts_with(&canonical_root)
}

/// Map a Rust/Tauri target triple to the staged `externalBin` filename.
/// Returns `None` for unknown targets (fail closed for packaging maps).
#[allow(dead_code)]
pub fn mediainfo_staged_name_for_target(target: &str) -> Option<&'static str> {
    match target {
        "x86_64-pc-windows-msvc" => Some("mediainfo-x86_64-pc-windows-msvc.exe"),
        "x86_64-unknown-linux-gnu" => Some("mediainfo-x86_64-unknown-linux-gnu"),
        "aarch64-apple-darwin" => Some("mediainfo-aarch64-apple-darwin"),
        _ => None,
    }
}

/// Compile-time host target triple used for staged externalBin filenames.
#[allow(dead_code)]
pub fn packaged_mediainfo_host_target_triple() -> Option<&'static str> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        Some("x86_64-pc-windows-msvc")
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        Some("x86_64-unknown-linux-gnu")
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        Some("aarch64-apple-darwin")
    }
    #[cfg(not(any(
        all(target_os = "windows", target_arch = "x86_64"),
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "macos", target_arch = "aarch64"),
    )))]
    {
        None
    }
}

/// Fixed, target-aware filenames accepted for the packaged MediaInfo sidecar.
/// Prefers Tauri `externalBin` staged triple names, then runtime bare names.
fn packaged_mediainfo_file_names() -> &'static [&'static str] {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        &[
            "mediainfo-x86_64-pc-windows-msvc.exe",
            "mediainfo.exe",
            "MediaInfo.exe",
        ]
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        &[
            "mediainfo-x86_64-unknown-linux-gnu",
            "mediainfo",
            "MediaInfo",
        ]
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        &["mediainfo-aarch64-apple-darwin", "mediainfo", "MediaInfo"]
    }
    #[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
    {
        &["mediainfo.exe", "MediaInfo.exe"]
    }
    #[cfg(all(
        not(target_os = "windows"),
        not(all(target_os = "linux", target_arch = "x86_64")),
        not(all(target_os = "macos", target_arch = "aarch64")),
    ))]
    {
        &["mediainfo", "MediaInfo"]
    }
}

/// Append fixed MediaInfo search bases under `root` (known layout only).
fn push_packaged_mediainfo_bases(root: &Path, bases: &mut Vec<PathBuf>) {
    bases.push(root.to_path_buf());
    bases.push(root.join("bin"));
    bases.push(root.join("binaries"));
    bases.push(root.join("sidecars"));
    bases.push(root.join("MediaInfo"));
    bases.push(root.join("mediainfo"));
}

/// Relative candidate locations under the app resource directory and Tauri layout.
/// Only these backend-owned paths may be used to spawn MediaInfo.
///
/// Also searches next to `std::env::current_exe()` so draft-release `--no-bundle`
/// flat archives (sidecar beside the app binary) resolve without accepting
/// arbitrary caller-supplied executable paths.
pub fn packaged_mediainfo_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    push_packaged_mediainfo_bases(resource_dir, &mut bases);
    // Tauri `externalBin` is placed next to the executable (sibling of Resources,
    // or Contents/MacOS on macOS app bundles), not only under resource_dir.
    if let Some(parent) = resource_dir.parent() {
        bases.push(parent.to_path_buf());
        bases.push(parent.join("binaries"));
        bases.push(parent.join("MacOS"));
    }
    // Flat release layout: sidecar packaged next to the running executable.
    // Derived only from current_exe() — never from IPC / caller paths.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            push_packaged_mediainfo_bases(exe_dir, &mut bases);
            bases.push(exe_dir.join("MacOS"));
        }
    }

    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for base in bases {
        for name in packaged_mediainfo_file_names() {
            let candidate = base.join(name);
            if seen.insert(candidate.clone()) {
                candidates.push(candidate);
            }
        }
    }
    candidates
}

/// Resolve MediaInfo from a packaged app resource directory only.
/// Never accepts a caller-supplied executable path.
/// Missing sidecar remains an explicit error (non-destructive).
pub fn resolve_packaged_mediainfo(resource_dir: &Path) -> Result<PathBuf, String> {
    for candidate in packaged_mediainfo_candidates(resource_dir) {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err("MediaInfo sidecar is unavailable".to_string())
}

#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|error| format!("无法读取 MediaInfo 缓存: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("无法校验 MediaInfo 缓存: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

#[cfg(any(test, all(target_os = "windows", target_arch = "x86_64")))]
fn materialize_hash_bound_file(
    app_local_data_dir: &Path,
    bundle_hash: &str,
    file_name: &str,
    embedded: &[u8],
) -> Result<PathBuf, String> {
    let expected_hash = sha256_bytes(embedded);
    let destination_dir = app_local_data_dir.join("mediainfo").join(bundle_hash);
    let destination = destination_dir.join(file_name);

    if destination.is_file()
        && sha256_file(&destination)
            .map(|actual| actual == expected_hash)
            .unwrap_or(false)
    {
        return Ok(destination);
    }

    std::fs::create_dir_all(&destination_dir)
        .map_err(|error| format!("无法创建 MediaInfo 缓存目录: {error}"))?;
    let sequence = EMBEDDED_TOOL_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = destination_dir.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        sequence
    ));
    let write_result = (|| -> Result<(), String> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| format!("无法创建 MediaInfo 临时文件: {error}"))?;
        file.write_all(embedded)
            .map_err(|error| format!("无法释放 MediaInfo: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("无法同步 MediaInfo 文件: {error}"))?;
        crate::atomic_file::replace_file_atomically(&temp, &destination)
            .map_err(|error| format!("无法提交 MediaInfo 文件: {error}"))
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temp);
        if destination.is_file()
            && sha256_file(&destination)
                .map(|actual| actual == expected_hash)
                .unwrap_or(false)
        {
            return Ok(destination);
        }
        write_result?;
    }

    if sha256_file(&destination)? != expected_hash {
        return Err("MediaInfo 缓存校验失败".to_string());
    }
    Ok(destination)
}

/// Prefer the normal packaged sidecar. Windows x64 single-file builds fall back
/// to a compile-time embedded, hash-bound copy released under app-local data.
pub fn resolve_or_release_packaged_mediainfo(
    resource_dir: &Path,
    _app_local_data_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        match resolve_packaged_mediainfo(resource_dir) {
            Ok(path) => Ok(path),
            Err(_) => {
                let release_root = _app_local_data_dir.ok_or_else(|| {
                    "MediaInfo sidecar is unavailable and app data is inaccessible".to_string()
                })?;
                let bundle_hash = sha256_bytes(EMBEDDED_MEDIAINFO);
                let executable = materialize_hash_bound_file(
                    release_root,
                    &bundle_hash,
                    "mediainfo.exe",
                    EMBEDDED_MEDIAINFO,
                )?;
                materialize_hash_bound_file(
                    release_root,
                    &bundle_hash,
                    "THIRD_PARTY_NOTICES.html",
                    EMBEDDED_MEDIAINFO_NOTICE,
                )?;
                Ok(executable)
            }
        }
    }

    #[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
    {
        let _ = _app_local_data_dir;
        resolve_packaged_mediainfo(resource_dir)
    }
}

/// Low-level probe helper. Callers that accept IPC input must resolve `sidecar`
/// via [`resolve_or_release_packaged_mediainfo`]; tests may pass fixture Paths.
///
/// Concurrency is capped at [`MEDIA_PROBE_CONCURRENCY`]. Cancellation is checked
/// between chunks and inside each child waiter so kill reaches the probe process.
#[allow(dead_code)]
pub fn probe_media_files(
    requests: Vec<MediaProbeRequest>,
    sidecar: &Path,
    cancellation: &AtomicBool,
    timeout: Duration,
) -> Vec<MediaProbeResult> {
    probe_media_files_with_progress(requests, sidecar, cancellation, timeout, |_, _| {})
}

/// Same as [`probe_media_files`] but reports `(completed, total)` after each file.
pub fn probe_media_files_with_progress(
    requests: Vec<MediaProbeRequest>,
    sidecar: &Path,
    cancellation: &AtomicBool,
    timeout: Duration,
    mut on_progress: impl FnMut(usize, usize),
) -> Vec<MediaProbeResult> {
    let total = requests.len();
    let mut results = Vec::with_capacity(total);
    let mut completed = 0_usize;
    let concurrency = MEDIA_PROBE_CONCURRENCY.max(1);
    let mut index = 0_usize;
    while index < requests.len() {
        if cancellation.load(Ordering::Relaxed) {
            for request in requests.iter().skip(index) {
                results.push(cancelled_result(request));
                completed += 1;
                on_progress(completed, total);
            }
            break;
        }
        let end = (index + concurrency).min(requests.len());
        let chunk = &requests[index..end];
        thread::scope(|scope| {
            let handles = chunk
                .iter()
                .map(|request| {
                    scope.spawn(move || probe_one(request, sidecar, cancellation, timeout))
                })
                .collect::<Vec<_>>();
            for handle in handles {
                if let Ok(result) = handle.join() {
                    results.push(result);
                }
                completed += 1;
                on_progress(completed, total);
            }
        });
        index = end;
    }
    results
}

fn probe_one(
    request: &MediaProbeRequest,
    sidecar: &Path,
    cancellation: &AtomicBool,
    timeout: Duration,
) -> MediaProbeResult {
    // Never echo caller-controlled path-like relative names in results.
    if !is_safe_relative_name(&request.relative_name) {
        return result(
            request,
            MediaProbeState::StartFailed,
            None,
            Some("Media probe relative name is invalid".to_string()),
            None,
        );
    }
    if cancellation.load(Ordering::Relaxed) {
        return cancelled_result(request);
    }
    if !sidecar.is_file() {
        return result(
            request,
            MediaProbeState::MissingSidecar,
            None,
            Some("MediaInfo sidecar is missing".to_string()),
            None,
        );
    }
    let pre_identity = match capture_media_file_identity(&request.path, &request.relative_name) {
        Ok(identity) => identity,
        Err(error) => {
            return result(
                request,
                MediaProbeState::StartFailed,
                None,
                Some(error),
                None,
            );
        }
    };
    let mut command = Command::new(sidecar);
    configure_mediainfo_command(&mut command);
    let mut child = match command
        .arg("--Output=JSON")
        .arg(&request.path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return result(
                request,
                MediaProbeState::StartFailed,
                None,
                Some(error.to_string()),
                None,
            );
        }
    };

    // Drain stdout/stderr concurrently so a verbose child cannot fill the pipe buffer
    // and deadlock while we wait for exit, timeout, or cancellation.
    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_handle = thread::spawn(move || {
        stdout_pipe
            .map(|pipe| read_bounded(pipe, MAX_PIPE_BYTES))
            .unwrap_or_default()
    });
    let stderr_handle = thread::spawn(move || {
        stderr_pipe
            .map(|pipe| read_bounded(pipe, MAX_PIPE_BYTES))
            .unwrap_or_default()
    });

    let wait_outcome = wait_for_child(&mut child, cancellation, timeout);
    if matches!(
        wait_outcome,
        WaitOutcome::TimedOut | WaitOutcome::Cancelled | WaitOutcome::WaitError(_)
    ) {
        terminate(&mut child);
    }

    let stdout = stdout_handle.join().unwrap_or_default();
    let stderr = stderr_handle.join().unwrap_or_default();

    match wait_outcome {
        WaitOutcome::Cancelled => cancelled_result(request),
        WaitOutcome::TimedOut => result(
            request,
            MediaProbeState::TimedOut,
            None,
            Some("MediaInfo probe timed out".to_string()),
            None,
        ),
        WaitOutcome::WaitError(error) => result(
            request,
            MediaProbeState::StartFailed,
            None,
            Some(error),
            None,
        ),
        WaitOutcome::Exited(status) => {
            if stdout.truncated || stderr.truncated {
                return result(
                    request,
                    MediaProbeState::OversizedOutput,
                    None,
                    Some("MediaInfo output exceeded bounded pipe limit".to_string()),
                    None,
                );
            }
            if !status.success() {
                let detail = if !stderr.data.is_empty() {
                    compact(&stderr.data)
                } else {
                    compact(&stdout.data)
                };
                let message = if detail.is_empty() {
                    "MediaInfo exited with a non-zero status".to_string()
                } else {
                    detail
                };
                return result(
                    request,
                    MediaProbeState::NonZeroExit,
                    None,
                    Some(message),
                    None,
                );
            }
            let post_identity =
                match capture_media_file_identity(&request.path, &request.relative_name) {
                    Ok(identity) => identity,
                    Err(error) => {
                        return result(
                            request,
                            MediaProbeState::StartFailed,
                            None,
                            Some(error),
                            None,
                        );
                    }
                };
            if post_identity != pre_identity {
                return result(
                    request,
                    MediaProbeState::ChangedDuringProbe,
                    None,
                    Some("Media file changed during MediaInfo probe".to_string()),
                    None,
                );
            }
            let summary = serde_json::from_slice::<Value>(&stdout.data)
                .ok()
                .and_then(|value| normalize_media_info(&value));
            match summary {
                Some(summary) => result(
                    request,
                    MediaProbeState::Measured,
                    Some(summary),
                    None,
                    Some(post_identity),
                ),
                None => result(
                    request,
                    MediaProbeState::MalformedJson,
                    None,
                    Some("MediaInfo JSON was not recognized".to_string()),
                    None,
                ),
            }
        }
    }
}

#[derive(Debug)]
enum WaitOutcome {
    Exited(std::process::ExitStatus),
    TimedOut,
    Cancelled,
    WaitError(String),
}

fn wait_for_child(child: &mut Child, cancellation: &AtomicBool, timeout: Duration) -> WaitOutcome {
    let started = Instant::now();
    loop {
        if cancellation.load(Ordering::Relaxed) {
            return WaitOutcome::Cancelled;
        }
        match child.try_wait() {
            Ok(Some(status)) => return WaitOutcome::Exited(status),
            Ok(None) if started.elapsed() >= timeout => return WaitOutcome::TimedOut,
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => return WaitOutcome::WaitError(error.to_string()),
        }
    }
}

#[derive(Debug, Default)]
struct BoundedRead {
    data: Vec<u8>,
    truncated: bool,
}

fn read_bounded(mut pipe: impl Read, max_bytes: usize) -> BoundedRead {
    let mut data = Vec::new();
    let mut buf = [0_u8; 8_192];
    let mut truncated = false;
    loop {
        match pipe.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                if truncated {
                    // Keep draining so the writer cannot block on a full pipe.
                    continue;
                }
                let remaining = max_bytes.saturating_sub(data.len());
                if remaining == 0 {
                    truncated = true;
                    continue;
                }
                let take = n.min(remaining);
                data.extend_from_slice(&buf[..take]);
                if take < n {
                    truncated = true;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    BoundedRead { data, truncated }
}

fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn cancelled_result(request: &MediaProbeRequest) -> MediaProbeResult {
    result(
        request,
        MediaProbeState::Cancelled,
        None,
        Some("MediaInfo probe cancelled".to_string()),
        None,
    )
}

fn result(
    request: &MediaProbeRequest,
    state: MediaProbeState,
    summary: Option<MediaInfoSummary>,
    message: Option<String>,
    identity: Option<MediaFileIdentity>,
) -> MediaProbeResult {
    let mut probe = MediaProbeResult::with_state(
        safe_relative_name(&request.relative_name),
        state,
        summary,
        message.map(|value| compact(value.as_bytes())),
    );
    probe.identity = identity;
    probe
}

/// Capture a private media-file identity (safe relative name + size + high-res mtime + samples).
pub(crate) fn capture_media_file_identity(
    path: &Path,
    relative_name: &str,
) -> Result<MediaFileIdentity, String> {
    let relative_name = safe_relative_name(relative_name);
    if relative_name == "[invalid]" {
        return Err("media identity relative name is invalid".to_string());
    }
    let meta =
        std::fs::metadata(path).map_err(|error| format!("media identity metadata: {error}"))?;
    if !meta.is_file() {
        return Err("media identity path is not a file".to_string());
    }
    let size = meta.len();
    let (modified_unix_secs, modified_unix_nanos) = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| (duration.as_secs(), duration.subsec_nanos()))
        .unwrap_or((0, 0));
    let content_digest = media_sample_content_digest(path, size)?;
    Ok(MediaFileIdentity {
        relative_name,
        size,
        modified_unix_secs,
        modified_unix_nanos,
        content_digest,
    })
}

/// Digest first / middle / last [`MEDIA_IDENTITY_SAMPLE_BYTES`] plus length.
///
/// The middle window is centered at `size / 2` so same-size interior rewrites are
/// not invisible to edge-only sampling.
fn media_sample_content_digest(path: &Path, size: u64) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| format!("media identity open: {error}"))?;
    let sample = MEDIA_IDENTITY_SAMPLE_BYTES as u64;

    let mut read_window = |offset: u64, len: usize| -> Result<Vec<u8>, String> {
        if len == 0 {
            return Ok(Vec::new());
        }
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| format!("media identity seek: {error}"))?;
        let mut buf = vec![0_u8; len];
        file.read_exact(&mut buf)
            .map_err(|error| format!("media identity read: {error}"))?;
        Ok(buf)
    };

    let head_len = usize::try_from(sample.min(size)).unwrap_or(0);
    let first = read_window(0, head_len)?;

    let mut middle = Vec::new();
    if size > sample {
        let mid_len = usize::try_from(sample.min(size)).unwrap_or(0);
        let mid_start = size.saturating_sub(sample) / 2;
        middle = read_window(mid_start, mid_len)?;
    }

    let mut last = Vec::new();
    if size > sample {
        let tail_start = size.saturating_sub(sample);
        last = read_window(tail_start, MEDIA_IDENTITY_SAMPLE_BYTES)?;
    }

    let mut hasher = Sha256::new();
    hasher.update(&first);
    hasher.update(&middle);
    hasher.update(&last);
    hasher.update(size.to_le_bytes());
    Ok(hex::encode(hasher.finalize()))
}

/// Re-resolve measured media files under original allowed roots and recompute identities.
///
/// Missing, replaced, ambiguous, or changed files fail closed.
pub(crate) fn revalidate_media_file_identities(
    torrent_path: &str,
    content_root: &str,
    identities: &[MediaFileIdentity],
) -> Result<(), Vec<String>> {
    if identities.is_empty() {
        return Ok(());
    }
    let roots = allowed_media_content_roots(
        torrent_path,
        (!content_root.trim().is_empty()).then_some(content_root),
    )
    .map_err(|error| vec![error])?;
    let mut failures = Vec::new();
    for identity in identities {
        let matches = resolve_under_roots(&identity.relative_name, &roots);
        match matches.len() {
            0 => failures.push(format!(
                "媒体文件缺失或不可用：{}，请重新执行发布前检查。",
                identity.relative_name
            )),
            1 => {
                let path = &matches[0];
                match capture_media_file_identity(path, &identity.relative_name) {
                    Ok(current) if current == *identity => {}
                    Ok(_) => failures.push(format!(
                        "媒体文件内容已变化：{}，请重新执行发布前检查。",
                        identity.relative_name
                    )),
                    Err(_) => failures.push(format!(
                        "媒体文件无法校验：{}，请重新执行发布前检查。",
                        identity.relative_name
                    )),
                }
            }
            _ => failures.push(format!(
                "媒体文件路径不唯一：{}，请重新执行发布前检查。",
                identity.relative_name
            )),
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures)
    }
}

/// Safe relative-path contract shared with context projection: only short relative
/// names may leave the backend in probe results. Callers may still supply a
/// separate filesystem `path` for the probe; this only guards echoed names.
fn is_safe_relative_name(path: &str) -> bool {
    if path.is_empty() || path.trim().is_empty() {
        return false;
    }
    if path != path.trim() {
        return false;
    }
    if path.chars().any(|character| character.is_control()) {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.contains(':') {
        return false;
    }
    for component in path.split(['/', '\\']) {
        if component.is_empty() || component == ".." {
            return false;
        }
    }
    path.chars().count() <= 256
}

/// Normalize a caller-supplied relative name for outbound probe results.
/// Unsafe path-like values are replaced with a fixed invalid marker.
fn safe_relative_name(path: &str) -> String {
    if is_safe_relative_name(path) {
        path.replace('\\', "/")
    } else {
        "[invalid]".to_string()
    }
}

fn compact(bytes: &[u8]) -> String {
    let lossy = String::from_utf8_lossy(bytes);
    lossy
        .chars()
        .take(MESSAGE_CHAR_LIMIT)
        .collect::<String>()
        .replace(['\n', '\r'], " ")
}

fn normalize_media_info(value: &Value) -> Option<MediaInfoSummary> {
    let tracks = value.get("media")?.get("track")?.as_array()?;
    let general = tracks
        .iter()
        .find(|track| track.get("@type").and_then(Value::as_str) == Some("General"));
    let video = tracks
        .iter()
        .find(|track| track.get("@type").and_then(Value::as_str) == Some("Video"));
    let duration_ms = general
        .and_then(|track| track.get("Duration"))
        .and_then(parse_duration_ms);
    let audio_codecs = tracks
        .iter()
        .filter(|track| track.get("@type").and_then(Value::as_str) == Some("Audio"))
        .filter_map(|track| track.get("CodecID").or_else(|| track.get("Format")))
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect();
    let subtitle_languages = tracks
        .iter()
        .filter(|track| track.get("@type").and_then(Value::as_str) == Some("Text"))
        .filter_map(|track| track.get("Language"))
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect();
    let subtitle_tracks = tracks
        .iter()
        .filter(|track| track.get("@type").and_then(Value::as_str) == Some("Text"))
        .map(|track| PlanSubtitleTrack {
            language: track
                .get("Language")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            title: track
                .get("Title")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            format: track
                .get("Format")
                .or_else(|| track.get("CodecID"))
                .and_then(Value::as_str)
                .map(ToString::to_string),
            default: track
                .get("Default")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            forced: track
                .get("Forced")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
        .collect();
    Some(MediaInfoSummary {
        duration_ms,
        width: video
            .and_then(|track| track.get("Width"))
            .and_then(parse_u32),
        height: video
            .and_then(|track| track.get("Height"))
            .and_then(parse_u32),
        video_codec: video
            .and_then(|track| track.get("CodecID").or_else(|| track.get("Format")))
            .and_then(Value::as_str)
            .map(ToString::to_string),
        video_bit_depth: video
            .and_then(|track| track.get("BitDepth"))
            .and_then(parse_u32),
        audio_codecs,
        subtitle_languages,
        subtitle_tracks,
        scan_type: video
            .and_then(|track| track.get("ScanType"))
            .and_then(Value::as_str)
            .map(ToString::to_string),
    })
}

/// MediaInfo CLI JSON reports `General.Duration` in seconds (fractional allowed).
/// Convert to rounded milliseconds, rejecting negative/non-finite/overflow values.
fn parse_duration_ms(value: &Value) -> Option<u64> {
    let seconds = value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))?;
    if !seconds.is_finite() || seconds < 0.0 {
        return None;
    }
    let millis = seconds * 1000.0;
    if !millis.is_finite() || millis > u64::MAX as f64 {
        return None;
    }
    let rounded = millis.round();
    if rounded < 0.0 || rounded > u64::MAX as f64 {
        return None;
    }
    Some(rounded as u64)
}

fn parse_u32(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .or_else(|| value.as_str()?.parse::<u32>().ok())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn normalizes_tracks_with_relative_names() {
        let value = json!({
            "media": {"track": [
                {"@type": "General", "Duration": "1234.5", "CompleteName": "/private/video.mkv"},
                {"@type": "Video", "Width": "1920", "Height": 1080, "Format": "AV1", "BitDepth": "10"},
                {"@type": "Audio", "Format": "AAC", "Language": "jpn"},
                {"@type": "Text", "Language": "zh-Hans", "Title": "简体中文", "Format": "ASS", "Default": "Yes", "Forced": "No"},
                {"@type": "Text", "Language": "zh-Hant", "Title": "繁體中文", "CodecID": "S_TEXT/ASS", "Default": "No", "Forced": "No"}
            ]}
        });
        let normalized = normalize_media_info(&value).unwrap();
        // MediaInfo Duration is seconds; 1234.5s → 1_234_500 ms.
        assert_eq!(normalized.duration_ms, Some(1_234_500));
        assert_eq!(normalized.width, Some(1920));
        assert_eq!(normalized.video_bit_depth, Some(10));
        assert_eq!(normalized.audio_codecs, vec!["AAC"]);
        assert_eq!(normalized.subtitle_languages, vec!["zh-Hans", "zh-Hant"]);
        assert_eq!(normalized.subtitle_tracks.len(), 2);
        assert_eq!(
            normalized.subtitle_tracks[0].title.as_deref(),
            Some("简体中文")
        );
        assert_eq!(normalized.subtitle_tracks[0].format.as_deref(), Some("ASS"));
        assert_eq!(
            normalized.subtitle_tracks[0].default.as_deref(),
            Some("Yes")
        );
        assert_eq!(
            normalized.subtitle_tracks[1].format.as_deref(),
            Some("S_TEXT/ASS")
        );
        assert!(!serde_json::to_string(&normalized)
            .unwrap()
            .contains("/private"));
    }

    #[test]
    fn plan_media_evidence_binds_valid_results_without_rewriting_content() {
        let results = vec![
            MediaProbeResult {
                relative_name: "show/ep01.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(MediaInfoSummary {
                    duration_ms: Some(2_000),
                    width: Some(1920),
                    height: Some(1080),
                    video_codec: Some("AV1 sk-secret-token".into()),
                    video_bit_depth: Some(10),
                    audio_codecs: vec!["AAC".into()],
                    subtitle_languages: vec![],
                    subtitle_tracks: vec![PlanSubtitleTrack {
                        language: Some("zh-Hans".into()),
                        title: Some("简体中文".into()),
                        format: Some("ASS".into()),
                        default: Some("Yes".into()),
                        forced: Some("No".into()),
                    }],
                    scan_type: None,
                }),
                message: None,
                identity: None,
            },
            MediaProbeResult {
                relative_name: "/private/tmp/secret.mkv".into(),
                state: MediaProbeState::Measured,
                summary: Some(MediaInfoSummary {
                    duration_ms: Some(1),
                    ..MediaInfoSummary::default()
                }),
                message: None,
                identity: None,
            },
            MediaProbeResult {
                relative_name: "show/ep02.mkv".into(),
                state: MediaProbeState::TimedOut,
                summary: None,
                message: Some("timeout".into()),
                identity: None,
            },
            MediaProbeResult {
                relative_name: "missing.mkv".into(),
                state: MediaProbeState::MissingFile,
                summary: None,
                message: None,
                identity: None,
            },
        ];
        let evidence = build_plan_media_evidence("job-1", "sha256:snap", 3, &results);
        assert_eq!(evidence.status, PlanMediaStatus::Tested);
        assert_eq!(evidence.summaries.len(), 1);
        assert_eq!(evidence.results.len(), 3);
        assert_eq!(evidence.results[0].state, "measured");
        assert_eq!(evidence.results[1].state, "timed_out");
        assert_eq!(evidence.results[2].state, "missing_file");
        assert!(evidence.results[0].summary.is_some());
        assert_eq!(evidence.summaries[0].relative_name, "show/ep01.mkv");
        assert_eq!(evidence.summaries[0].video_bit_depth, Some(10));
        assert_eq!(evidence.summaries[0].subtitle_tracks.len(), 1);
        assert_eq!(
            evidence.summaries[0].subtitle_tracks[0].title.as_deref(),
            Some("简体中文")
        );
        assert_eq!(
            evidence.results[0]
                .summary
                .as_ref()
                .and_then(|summary| summary.subtitle_tracks[0].format.as_deref()),
            Some("ASS")
        );
        assert!(evidence.summaries[0]
            .video_codec
            .as_deref()
            .unwrap_or("")
            .contains("sk-secret-token"));
        let serialized = serde_json::to_string(&evidence).unwrap();
        assert!(!serialized.contains("/private"));
        assert!(serialized.contains("sk-secret-token"));

        let empty = build_plan_media_evidence(
            "job-2",
            "sha256:snap",
            3,
            &[MediaProbeResult {
                relative_name: "gone.mkv".into(),
                state: MediaProbeState::MissingFile,
                summary: None,
                message: None,
                identity: None,
            }],
        );
        assert_eq!(empty.status, PlanMediaStatus::CheckFailed);
        assert!(empty.summaries.is_empty());
        assert_eq!(empty.results.len(), 1);
        assert_eq!(empty.results[0].relative_name, "gone.mkv");
    }

    #[test]
    fn parse_duration_ms_handles_fractional_zero_and_invalid() {
        assert_eq!(parse_duration_ms(&json!(0)), Some(0));
        assert_eq!(parse_duration_ms(&json!(0.0)), Some(0));
        assert_eq!(parse_duration_ms(&json!("0")), Some(0));
        assert_eq!(parse_duration_ms(&json!(1.234)), Some(1234));
        assert_eq!(parse_duration_ms(&json!("1.234")), Some(1234));
        assert_eq!(parse_duration_ms(&json!(1234.5)), Some(1_234_500));
        // Negative, non-finite, and non-numeric values must not yield a bogus duration.
        assert_eq!(parse_duration_ms(&json!(-1.0)), None);
        assert_eq!(parse_duration_ms(&json!("-3.5")), None);
        // String forms reach f64 parse (JSON numbers cannot represent NaN/Infinity).
        assert_eq!(parse_duration_ms(&json!("nan")), None);
        assert_eq!(parse_duration_ms(&json!("inf")), None);
        assert_eq!(parse_duration_ms(&json!("-inf")), None);
        assert_eq!(parse_duration_ms(&json!("not-a-number")), None);
        assert_eq!(parse_duration_ms(&json!(null)), None);
        // Overflow beyond u64::MAX milliseconds after seconds→ms conversion.
        assert_eq!(parse_duration_ms(&json!(1e300)), None);
    }

    #[test]
    fn discover_media_files_manual_paths_respect_max_discovery_files() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_manual_cap_{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!(
            "okpgui_media_manual_cap_outside_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();

        // More manual video paths than the discovery cap, all outside torrent roots so
        // the result size is driven only by the manual list (not recursive discovery).
        let manual_count = MAX_DISCOVERY_FILES + 25;
        let mut manual_paths = Vec::with_capacity(manual_count);
        for index in 0..manual_count {
            let path = outside.join(format!("manual_{index:05}.mkv"));
            std::fs::write(&path, b"video").unwrap();
            manual_paths.push(path.to_string_lossy().into_owned());
        }

        let candidates =
            discover_media_files(torrent_path.to_string_lossy().as_ref(), &manual_paths)
                .expect("discover");

        assert!(
            candidates.len() <= MAX_DISCOVERY_FILES,
            "manual discovery exceeded cap: {} > {}",
            candidates.len(),
            MAX_DISCOVERY_FILES
        );
        assert_eq!(
            candidates.len(),
            MAX_DISCOVERY_FILES,
            "expected exactly the discovery cap when over-supplied"
        );
        // Dedup/sort still applied: relative names are unique and ordered.
        let mut names: Vec<&str> = candidates
            .iter()
            .map(|c| c.relative_name.as_str())
            .collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "candidates must remain sorted");
        names.dedup();
        assert_eq!(
            names.len(),
            candidates.len(),
            "candidates must remain unique"
        );
        for candidate in &candidates {
            assert!(is_safe_relative_name(&candidate.relative_name));
            assert!(
                candidate.relative_name.starts_with("manual/"),
                "expected manual namespace label, got {}",
                candidate.relative_name
            );
        }

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn missing_sidecar_is_explicit_and_path_is_not_returned() {
        let request = MediaProbeRequest {
            relative_name: "video.mkv".into(),
            path: PathBuf::from("/private/video.mkv"),
        };
        let cancelled = AtomicBool::new(false);
        let result = probe_media_files(
            vec![request],
            Path::new("/missing/MediaInfo"),
            &cancelled,
            Duration::from_millis(10),
        );
        assert_eq!(result[0].state, MediaProbeState::MissingSidecar);
        assert!(!serde_json::to_string(&result).unwrap().contains("/private"));
    }

    #[test]
    fn packaged_mediainfo_resolution_only_accepts_resource_candidates() {
        let root =
            std::env::temp_dir().join(format!("okpgui_mediainfo_resource_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sidecars")).unwrap();

        assert!(resolve_packaged_mediainfo(&root).is_err());

        #[cfg(target_os = "windows")]
        let file_name = "MediaInfo.exe";
        #[cfg(not(target_os = "windows"))]
        let file_name = "MediaInfo";

        let sidecar = root.join("sidecars").join(file_name);
        std::fs::write(&sidecar, b"placeholder").unwrap();
        let resolved = resolve_packaged_mediainfo(&root).expect("packaged sidecar");
        // macOS's default case-insensitive filesystem may resolve the lower-case
        // candidate spelling to the same file as the fixture's `MediaInfo` name.
        assert_eq!(
            resolved.canonicalize().unwrap(),
            sidecar.canonicalize().unwrap()
        );

        // Arbitrary paths outside the fixed candidate set must not resolve.
        let outsider = root.join("evil-bin");
        std::fs::write(&outsider, b"nope").unwrap();
        assert_ne!(
            resolve_packaged_mediainfo(&root).unwrap(),
            outsider,
            "outsider must not be selected"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn embedded_tool_materialization_reuses_and_repairs_hash_bound_cache() {
        let root = std::env::temp_dir().join(format!(
            "okpgui_embedded_tool_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let bytes = b"verified embedded executable fixture";

        let bundle_hash = sha256_bytes(bytes);
        let first = materialize_hash_bound_file(&root, &bundle_hash, "mediainfo.exe", bytes)
            .expect("materialize embedded tool");
        assert_eq!(std::fs::read(&first).unwrap(), bytes);
        assert!(first.starts_with(root.join("mediainfo")));
        let notice = materialize_hash_bound_file(
            &root,
            &bundle_hash,
            "THIRD_PARTY_NOTICES.html",
            b"license notice fixture",
        )
        .expect("materialize bundled notice");
        assert_eq!(notice.parent(), first.parent());
        assert_eq!(std::fs::read(notice).unwrap(), b"license notice fixture");

        let second = materialize_hash_bound_file(&root, &bundle_hash, "mediainfo.exe", bytes)
            .expect("reuse verified embedded tool");
        assert_eq!(second, first);

        std::fs::write(&first, b"tampered").unwrap();
        let repaired = materialize_hash_bound_file(&root, &bundle_hash, "mediainfo.exe", bytes)
            .expect("repair tampered cache");
        assert_eq!(repaired, first);
        assert_eq!(std::fs::read(&repaired).unwrap(), bytes);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mediainfo_staged_name_for_target_maps_known_triples() {
        assert_eq!(
            mediainfo_staged_name_for_target("x86_64-pc-windows-msvc"),
            Some("mediainfo-x86_64-pc-windows-msvc.exe")
        );
        assert_eq!(
            mediainfo_staged_name_for_target("x86_64-unknown-linux-gnu"),
            Some("mediainfo-x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            mediainfo_staged_name_for_target("x86_64-apple-darwin"),
            None
        );
        assert_eq!(
            mediainfo_staged_name_for_target("aarch64-apple-darwin"),
            Some("mediainfo-aarch64-apple-darwin")
        );
        assert_eq!(
            mediainfo_staged_name_for_target("wasm32-unknown-unknown"),
            None
        );
        assert_eq!(mediainfo_staged_name_for_target(""), None);
    }

    #[test]
    fn packaged_mediainfo_candidates_include_target_triple_and_layout() {
        let root = PathBuf::from("/tmp/okpgui_resource_layout_probe");
        let candidates = packaged_mediainfo_candidates(&root);
        let rendered: Vec<String> = candidates
            .iter()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .collect();

        // Host triple staged name (when supported) must appear under binaries/.
        if let Some(triple) = packaged_mediainfo_host_target_triple() {
            let staged = mediainfo_staged_name_for_target(triple).expect("host triple staged name");
            assert!(
                rendered
                    .iter()
                    .any(|p| p.ends_with(&format!("/binaries/{staged}"))),
                "expected binaries/{staged} candidate, got {rendered:?}"
            );
        }

        // Runtime bare name under resource root remains accepted.
        #[cfg(target_os = "windows")]
        {
            assert!(rendered
                .iter()
                .any(|p| p.ends_with("/mediainfo.exe") || p.ends_with("/MediaInfo.exe")));
        }
        #[cfg(not(target_os = "windows"))]
        {
            assert!(rendered
                .iter()
                .any(|p| p.ends_with("/mediainfo") || p.ends_with("/MediaInfo")));
        }

        // Tauri places externalBin beside Resources / in Contents/MacOS.
        assert!(
            rendered.iter().any(|p| p.contains("/MacOS/")),
            "expected MacOS sibling candidate layout"
        );
        // Flat --no-bundle archives: candidates include current_exe parent (backend-derived only).
        if let Ok(exe) = std::env::current_exe() {
            if let Some(exe_dir) = exe.parent() {
                let exe_dir_s = exe_dir.to_string_lossy().replace('\\', "/");
                assert!(
                    rendered.iter().any(|p| p.starts_with(&exe_dir_s)),
                    "expected current_exe parent candidates for flat release layout, got {rendered:?}"
                );
            }
        }
        assert!(
            !rendered.iter().any(|p| p.contains("evil")),
            "candidates must stay within fixed layout"
        );
    }

    #[test]
    fn packaged_mediainfo_does_not_accept_arbitrary_caller_paths() {
        // Resolver only searches fixed bases under resource_dir / resource parent /
        // current_exe parent — never an arbitrary path the caller invents.
        let root = std::env::temp_dir().join(format!(
            "okpgui_mediainfo_no_arbitrary_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let outsider = root.join("not-a-known-layout-dir");
        std::fs::create_dir_all(&outsider).unwrap();
        #[cfg(target_os = "windows")]
        let file_name = "MediaInfo.exe";
        #[cfg(not(target_os = "windows"))]
        let file_name = "MediaInfo";
        let planted = outsider.join(file_name);
        std::fs::write(&planted, b"placeholder").unwrap();

        // Outsider directory is not a known base; planted binary must never be selected.
        let candidates = packaged_mediainfo_candidates(&root);
        assert!(
            !candidates.iter().any(|c| c == &planted),
            "planted outsider path must not appear in candidates"
        );
        if let Ok(resolved) = resolve_packaged_mediainfo(&root) {
            assert_ne!(
                resolved, planted,
                "arbitrary nested path must not resolve as packaged sidecar"
            );
        }

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn packaged_mediainfo_prefers_staged_triple_name_when_present() {
        let root =
            std::env::temp_dir().join(format!("okpgui_mediainfo_triple_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("binaries")).unwrap();

        let Some(triple) = packaged_mediainfo_host_target_triple() else {
            // Unsupported host: missing sidecar remains non-destructive.
            assert!(resolve_packaged_mediainfo(&root).is_err());
            let _ = std::fs::remove_dir_all(&root);
            return;
        };
        let staged = mediainfo_staged_name_for_target(triple).expect("staged name");
        let sidecar = root.join("binaries").join(staged);
        std::fs::write(&sidecar, b"placeholder").unwrap();

        let resolved = resolve_packaged_mediainfo(&root).expect("triple sidecar");
        assert_eq!(resolved, sidecar);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_bounded_flags_oversized_pipe_output() {
        let payload = vec![b'x'; MAX_PIPE_BYTES + 64];
        let bounded = read_bounded(Cursor::new(payload), MAX_PIPE_BYTES);
        assert!(bounded.truncated);
        assert_eq!(bounded.data.len(), MAX_PIPE_BYTES);
    }

    #[test]
    fn compact_preserves_absolute_paths_in_diagnostics() {
        let message = compact(b"failed reading /private/tmp/secret/video.mkv details");
        assert!(message.contains("/private/tmp/secret/video.mkv"));
    }

    #[test]
    fn probe_results_reject_path_like_relative_names() {
        let cancelled = AtomicBool::new(false);
        let cases = [
            "/private/video.mkv",
            r"C:\Users\secret\video.mkv",
            "C:/Users/secret/video.mkv",
            "//server/share/video.mkv",
            r"..\secret\video.mkv",
        ];
        for relative_name in cases {
            let results = probe_media_files(
                vec![MediaProbeRequest {
                    relative_name: relative_name.into(),
                    path: PathBuf::from("/private/video.mkv"),
                }],
                Path::new("/missing/MediaInfo"),
                &cancelled,
                Duration::from_millis(10),
            );
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].state, MediaProbeState::StartFailed);
            assert_eq!(results[0].relative_name, "[invalid]");
            let serialized = serde_json::to_string(&results).unwrap();
            assert!(
                !serialized.contains(relative_name),
                "unsafe relative_name leaked: {relative_name}"
            );
            assert!(!serialized.contains("/private"));
            assert!(!serialized.contains("Users"));
            assert!(!serialized.contains("server/share"));
        }

        // Benign relative names remain accepted unchanged.
        let ok = probe_media_files(
            vec![MediaProbeRequest {
                relative_name: "torrent/video.mkv".into(),
                path: PathBuf::from("/private/video.mkv"),
            }],
            Path::new("/missing/MediaInfo"),
            &cancelled,
            Duration::from_millis(10),
        );
        assert_eq!(ok[0].relative_name, "torrent/video.mkv");
        assert_eq!(ok[0].state, MediaProbeState::MissingSidecar);
    }

    #[test]
    fn discover_media_files_labels_are_safe_and_include_parent_root() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_discover_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();

        let child_video = torrent_dir.join("child_video.mkv");
        let parent_video = root.join("parent_video.mkv");
        std::fs::write(&child_video, b"child").unwrap();
        std::fs::write(&parent_video, b"parent").unwrap();

        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();

        let candidates =
            discover_media_files(torrent_path.to_string_lossy().as_ref(), &[]).expect("discover");

        assert!(
            !candidates.is_empty(),
            "expected discovered video candidates"
        );
        for candidate in &candidates {
            assert!(
                is_safe_relative_name(&candidate.relative_name),
                "unsafe relative_name: {}",
                candidate.relative_name
            );
            assert!(
                !candidate.relative_name.starts_with('/')
                    && !candidate.relative_name.starts_with('\\')
                    && !candidate.relative_name.contains(':'),
                "absolute/drive-like label: {}",
                candidate.relative_name
            );
        }

        let names: Vec<&str> = candidates
            .iter()
            .map(|c| c.relative_name.as_str())
            .collect();
        // Parent-root candidate stays filename-only; torrent-dir child keeps the folder prefix.
        assert!(
            names.contains(&"parent_video.mkv"),
            "missing parent-root candidate in {names:?}"
        );
        assert!(
            names.contains(&"release/child_video.mkv"),
            "missing torrent-dir candidate in {names:?}"
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn discover_media_files_manual_outside_root_uses_manual_namespace() {
        let root = std::env::temp_dir().join(format!("okpgui_media_manual_{}", std::process::id()));
        let outside = std::env::temp_dir().join(format!(
            "okpgui_media_manual_outside_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();

        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();
        let outside_video = outside.join("outside.mkv");
        std::fs::write(&outside_video, b"outside").unwrap();

        let candidates = discover_media_files(
            torrent_path.to_string_lossy().as_ref(),
            &[outside_video.to_string_lossy().into_owned()],
        )
        .expect("discover");

        let manual = candidates
            .iter()
            .find(|c| c.relative_name.starts_with("manual/"))
            .expect("manual candidate");
        assert_eq!(manual.relative_name, "manual/outside.mkv");
        assert!(is_safe_relative_name(&manual.relative_name));
        assert!(!manual
            .relative_name
            .contains(outside.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn discover_media_files_symlink_expanded_paths_strip_via_canonical_display_root() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_symlink_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let real = root.join("real");
        let link = root.join("link");
        let torrent_dir = real.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let child_video = torrent_dir.join("via_link.mkv");
        std::fs::write(&child_video, b"link").unwrap();
        let torrent_path = link.join("release").join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();

        let candidates =
            discover_media_files(torrent_path.to_string_lossy().as_ref(), &[]).expect("discover");

        for candidate in &candidates {
            assert!(
                is_safe_relative_name(&candidate.relative_name),
                "unsafe after symlink expand: {}",
                candidate.relative_name
            );
            assert!(
                !candidate.relative_name.starts_with('/'),
                "absolute label after symlink expand: {}",
                candidate.relative_name
            );
        }
        assert!(
            candidates
                .iter()
                .any(|c| c.relative_name == "release/via_link.mkv"),
            "expected relative strip through canonical display root, got {:?}",
            candidates
                .iter()
                .map(|c| c.relative_name.as_str())
                .collect::<Vec<_>>()
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_probe_policy_constants_match_v2_contract() {
        assert_eq!(DEFAULT_MEDIA_PROBE_TIMEOUT_MS, 30_000);
        assert_eq!(MAX_MEDIA_PROBE_TIMEOUT_MS, 300_000);
        assert_eq!(MAX_MEDIA_RELATIVE_ENTRIES, 256);
        assert_eq!(MEDIA_PROBE_CONCURRENCY, 2);
        const {
            assert!(MAX_MEDIA_PROBE_TIMEOUT_MS >= DEFAULT_MEDIA_PROBE_TIMEOUT_MS);
        }
    }

    #[test]
    fn clamp_media_probe_timeout_ms_applies_documented_bounds() {
        assert_eq!(
            clamp_media_probe_timeout_ms(None),
            DEFAULT_MEDIA_PROBE_TIMEOUT_MS
        );
        assert_eq!(clamp_media_probe_timeout_ms(Some(1)), 100);
        assert_eq!(clamp_media_probe_timeout_ms(Some(100)), 100);
        assert_eq!(
            clamp_media_probe_timeout_ms(Some(DEFAULT_MEDIA_PROBE_TIMEOUT_MS)),
            DEFAULT_MEDIA_PROBE_TIMEOUT_MS
        );
        assert_eq!(
            clamp_media_probe_timeout_ms(Some(MAX_MEDIA_PROBE_TIMEOUT_MS)),
            MAX_MEDIA_PROBE_TIMEOUT_MS
        );
        assert_eq!(
            clamp_media_probe_timeout_ms(Some(MAX_MEDIA_PROBE_TIMEOUT_MS + 50_000)),
            MAX_MEDIA_PROBE_TIMEOUT_MS
        );
        assert_eq!(
            clamp_media_probe_timeout_ms(Some(u64::MAX)),
            MAX_MEDIA_PROBE_TIMEOUT_MS
        );
    }

    #[test]
    fn is_filesystem_or_drive_root_detects_unix_and_drive_forms() {
        assert!(is_filesystem_or_drive_root(Path::new("/")));
        assert!(is_filesystem_or_drive_root(Path::new("\\")));
        assert!(is_filesystem_or_drive_root(Path::new("C:\\")));
        assert!(is_filesystem_or_drive_root(Path::new("C:/")));
        assert!(is_filesystem_or_drive_root(Path::new("d:\\")));
        assert!(!is_filesystem_or_drive_root(Path::new("/tmp")));
        assert!(!is_filesystem_or_drive_root(Path::new("/var/folders")));
        assert!(!is_filesystem_or_drive_root(Path::new("C:\\Users")));
        assert!(!is_filesystem_or_drive_root(Path::new("relative/path")));
    }

    #[test]
    fn resolve_media_relative_entries_caps_explicit_batch_size() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_batch_cap_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();

        let entries: Vec<MediaRelativeEntry> = (0..=MAX_MEDIA_RELATIVE_ENTRIES)
            .map(|index| MediaRelativeEntry {
                relative_name: format!("file_{index}.mkv"),
                expected_size: None,
            })
            .collect();
        let error =
            resolve_media_relative_entries(torrent_path.to_string_lossy().as_ref(), &entries, None)
                .expect_err("over-cap batch must fail");
        assert!(
            error.contains(&MAX_MEDIA_RELATIVE_ENTRIES.to_string()),
            "expected cap in error, got {error}"
        );
        assert!(!error.contains(torrent_path.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_media_relative_entries_rejects_absolute_probe_authority() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_resolve_abs_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();
        let video = torrent_dir.join("video.mkv");
        std::fs::write(&video, b"video").unwrap();

        let batch = resolve_media_relative_entries(
            torrent_path.to_string_lossy().as_ref(),
            &[MediaRelativeEntry {
                relative_name: video.to_string_lossy().into_owned(),
                expected_size: None,
            }],
            None,
        )
        .expect("resolve");
        assert!(batch.requests.is_empty());
        assert_eq!(batch.pre_results.len(), 1);
        assert_eq!(batch.pre_results[0].relative_name, "[invalid]");
        assert_eq!(batch.pre_results[0].state, MediaProbeState::StartFailed);
        let serialized = serde_json::to_string(&batch.pre_results).unwrap();
        assert!(!serialized.contains(video.to_string_lossy().as_ref()));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_media_relative_entries_maps_under_torrent_parent() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_resolve_ok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();
        let video = torrent_dir.join("episode.mkv");
        std::fs::write(&video, b"12345").unwrap();

        let batch = resolve_media_relative_entries(
            torrent_path.to_string_lossy().as_ref(),
            &[MediaRelativeEntry {
                relative_name: "episode.mkv".into(),
                expected_size: Some(5),
            }],
            None,
        )
        .expect("resolve");
        assert_eq!(batch.requests.len(), 1);
        assert_eq!(batch.requests[0].relative_name, "episode.mkv");
        assert!(batch.pre_results.is_empty());
        // Absolute path stays internal only.
        assert!(batch.requests[0].path.is_absolute());

        let mismatch = resolve_media_relative_entries(
            torrent_path.to_string_lossy().as_ref(),
            &[MediaRelativeEntry {
                relative_name: "episode.mkv".into(),
                expected_size: Some(999),
            }],
            None,
        )
        .expect("resolve mismatch");
        assert!(mismatch.requests.is_empty());
        assert_eq!(mismatch.pre_results[0].state, MediaProbeState::SizeMismatch);
        assert_eq!(mismatch.pre_results[0].relative_name, "episode.mkv");

        let missing = resolve_media_relative_entries(
            torrent_path.to_string_lossy().as_ref(),
            &[MediaRelativeEntry {
                relative_name: "nope.mkv".into(),
                expected_size: None,
            }],
            None,
        )
        .expect("resolve missing");
        assert!(missing.requests.is_empty());
        assert_eq!(missing.pre_results[0].state, MediaProbeState::MissingFile);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn selected_content_root_is_validated_and_used_for_resolution() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_selected_root_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("torrent");
        let content_dir = root.join("actual-media");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        std::fs::create_dir_all(&content_dir).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();
        std::fs::write(content_dir.join("episode.mkv"), b"12345").unwrap();

        let validated = validate_media_content_root(content_dir.to_string_lossy().as_ref())
            .expect("selected directory");
        let batch = resolve_media_relative_entries(
            torrent_path.to_string_lossy().as_ref(),
            &[MediaRelativeEntry {
                relative_name: "episode.mkv".into(),
                expected_size: Some(5),
            }],
            Some(validated.to_string_lossy().as_ref()),
        )
        .expect("resolve under selected directory");
        assert_eq!(batch.requests.len(), 1);
        assert!(batch.requests[0].path.starts_with(&validated));

        assert!(validate_media_content_root(torrent_path.to_string_lossy().as_ref()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn allowed_media_content_roots_rejects_unix_filesystem_root() {
        let root =
            std::env::temp_dir().join(format!("okpgui_media_root_reject_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let torrent_dir = root.join("release");
        std::fs::create_dir_all(&torrent_dir).unwrap();
        let torrent_path = torrent_dir.join("release.torrent");
        std::fs::write(&torrent_path, b"d4:infod4:name7:releaseee").unwrap();
        let torrent = torrent_path.to_string_lossy().into_owned();

        // Explicit content_root `/` must fail closed (not become probe authority).
        let err = allowed_media_content_roots(&torrent, Some("/"))
            .expect_err("filesystem root content_root must be rejected");
        assert!(
            err.to_ascii_lowercase().contains("root"),
            "expected root rejection message, got {err}"
        );
        assert!(!err.contains("/Users"));
        assert!(!err.contains(&torrent));

        // Normal roots must never include `/`.
        let roots = allowed_media_content_roots(&torrent, None).expect("normal roots");
        assert!(!roots.is_empty());
        for allowed in &roots {
            assert!(
                !is_filesystem_or_drive_root(allowed),
                "allowed root must not be filesystem root: {}",
                allowed.display()
            );
            assert_ne!(allowed, Path::new("/"));
        }

        // Relative resolution must also fail closed for content_root `/`.
        let resolve_err = resolve_media_relative_entries(
            &torrent,
            &[MediaRelativeEntry {
                relative_name: "etc/passwd".into(),
                expected_size: None,
            }],
            Some("/"),
        )
        .expect_err("resolve under filesystem root must fail");
        assert!(
            resolve_err.to_ascii_lowercase().contains("root"),
            "expected root rejection, got {resolve_err}"
        );

        // When the torrent grandparent is `/` (e.g. torrent under `/tmp` on Linux),
        // grandparent must be skipped and never appear in allowed roots.
        let tmp_probe = std::env::temp_dir().join(format!(
            "okpgui_media_grandparent_{}.torrent",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp_probe);
        std::fs::write(&tmp_probe, b"d4:infod4:name3:tmpee").unwrap();
        if let Ok(roots_near_tmp) =
            allowed_media_content_roots(tmp_probe.to_string_lossy().as_ref(), None)
        {
            for allowed in &roots_near_tmp {
                assert!(
                    !is_filesystem_or_drive_root(allowed),
                    "grandparent filesystem root must not be allowlisted: {}",
                    allowed.display()
                );
            }
            // Relative labels must not resolve as if content lived at `/`.
            if let Ok(batch) = resolve_media_relative_entries(
                tmp_probe.to_string_lossy().as_ref(),
                &[MediaRelativeEntry {
                    relative_name: "etc/hosts".into(),
                    expected_size: None,
                }],
                None,
            ) {
                assert!(
                    batch.requests.is_empty(),
                    "must not probe host paths via root grandparent"
                );
            }
        }
        let _ = std::fs::remove_file(&tmp_probe);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn oversized_stdout_yields_oversized_output_state() {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let script = std::env::temp_dir().join(format!(
            "okpgui_mediainfo_oversize_{}.sh",
            std::process::id()
        ));
        {
            let mut file = std::fs::File::create(&script).expect("create oversize sidecar script");
            // Emit more than MAX_PIPE_BYTES on stdout; stderr discarded.
            writeln!(file, "#!/bin/sh").unwrap();
            writeln!(file, "dd if=/dev/zero bs=1024 count=512 2>/dev/null").unwrap();
        }
        let mut permissions = std::fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&script, permissions).unwrap();

        // Real on-disk path required so private identity capture can run before MediaInfo.
        let media = std::env::temp_dir().join(format!(
            "okpgui_mediainfo_oversize_media_{}.mkv",
            std::process::id()
        ));
        std::fs::write(&media, vec![3_u8; 1_024]).unwrap();

        let request = MediaProbeRequest {
            relative_name: "video.mkv".into(),
            path: media.clone(),
        };
        let cancelled = AtomicBool::new(false);
        let results = probe_media_files(vec![request], &script, &cancelled, Duration::from_secs(5));
        let _ = std::fs::remove_file(&script);
        let _ = std::fs::remove_file(&media);

        assert_eq!(results[0].state, MediaProbeState::OversizedOutput);
        let serialized = serde_json::to_string(&results).unwrap();
        assert!(!serialized.contains(media.to_string_lossy().as_ref()));
        assert!(!serialized.contains(script.to_string_lossy().as_ref()));
    }

    #[test]
    fn media_edge_identity_is_stable_for_unchanged_file() {
        let root = std::env::temp_dir().join(format!(
            "okpgui_media_identity_stable_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("clip.mkv");
        std::fs::write(&path, vec![7_u8; 8_192]).unwrap();
        let first = capture_media_file_identity(&path, "clip.mkv").unwrap();
        let second = capture_media_file_identity(&path, "clip.mkv").unwrap();
        assert_eq!(first, second);
        assert_eq!(first.size, 8_192);
        assert!(!first.content_digest.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn media_edge_identity_changes_when_bytes_change() {
        let root = std::env::temp_dir().join(format!(
            "okpgui_media_identity_change_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("clip.mkv");
        std::fs::write(&path, vec![1_u8; 4_096]).unwrap();
        let before = capture_media_file_identity(&path, "clip.mkv").unwrap();
        std::fs::write(&path, vec![2_u8; 4_096]).unwrap();
        let after = capture_media_file_identity(&path, "clip.mkv").unwrap();
        assert_ne!(before.content_digest, after.content_digest);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn middle_only_mutation_changes_identity_for_large_file() {
        let root = std::env::temp_dir().join(format!(
            "okpgui_media_identity_middle_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("large.mkv");
        // > 128 KiB so head/mid/tail windows are distinct.
        let size = 256 * 1024_usize;
        let mut bytes = vec![9_u8; size];
        std::fs::write(&path, &bytes).unwrap();
        let before = capture_media_file_identity(&path, "large.mkv").unwrap();
        // Same-size interior rewrite only (middle window region).
        let mid = size / 2;
        bytes[mid] = 0xAA;
        bytes[mid + 1] = 0xBB;
        std::fs::write(&path, &bytes).unwrap();
        // Preserve mtime as closely as possible is not required; digest must still change.
        let after = capture_media_file_identity(&path, "large.mkv").unwrap();
        assert_eq!(before.size, after.size);
        assert_ne!(
            before.content_digest, after.content_digest,
            "middle-only mutation must change content digest"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn revalidate_media_identities_fails_closed_on_missing_file() {
        let root = std::env::temp_dir().join(format!(
            "okpgui_media_identity_missing_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let torrent = root.join("sample.torrent");
        std::fs::write(
            &torrent,
            b"d4:infod4:name4:clip12:piece lengthi1e6:pieces0:ee",
        )
        .unwrap();
        let media = root.join("clip.mkv");
        std::fs::write(&media, vec![9_u8; 2_048]).unwrap();
        let identity = capture_media_file_identity(&media, "clip.mkv").unwrap();
        std::fs::remove_file(&media).unwrap();
        let err = revalidate_media_file_identities(torrent.to_str().unwrap(), "", &[identity])
            .expect_err("missing file must fail");
        assert!(err.join(" ").contains("clip.mkv"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
