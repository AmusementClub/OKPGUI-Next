use crate::ai::redaction::RedactionPolicy;
use crate::config::Template;
use crate::domain::publish_plan::LocalExecutionBinding;
use crate::torrent::{project_safe_torrent_context, SafeTorrentProjection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::HashMap;

pub const DEFAULT_CONTEXT_CEILING: usize = 512 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextFile {
    pub id: String,
    pub relative_path: String,
    pub content: String,
}
/// Internal builder input for pure projection. Not accepted from public IPC.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ContextProjectionInput {
    #[serde(default)]
    pub torrent_name: String,
    #[serde(default)]
    pub torrent_tree: Value,
    #[serde(default)]
    pub templates: Vec<Value>,
    #[serde(default)]
    pub shared_content: Vec<Value>,
    #[serde(default)]
    pub files: Vec<ContextFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextProjection {
    pub version: u32,
    pub torrent_name: String,
    pub torrent_tree: Value,
    pub templates: Vec<Value>,
    pub shared_content: Vec<Value>,
    pub files: Vec<ContextFile>,
    pub bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContextError {
    PayloadTooLarge { bytes: usize, ceiling: usize },
    InvalidRelativePath(String),
    Serialization(String),
    /// Path-free torrent parse / tree safety failure.
    Torrent(String),
    /// Bound torrent identity or fingerprint drifted after parse (replacement fail-closed).
    IdentityDrift(String),
}

impl std::fmt::Display for ContextError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PayloadTooLarge { bytes, ceiling } => {
                write!(
                    formatter,
                    "PAYLOAD_TOO_LARGE: {bytes} bytes exceeds {ceiling}"
                )
            }
            Self::InvalidRelativePath(path) => write!(formatter, "invalid relative path: {path}"),
            Self::Serialization(error) => {
                write!(formatter, "context serialization failed: {error}")
            }
            Self::Torrent(message) => write!(formatter, "{message}"),
            Self::IdentityDrift(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for ContextError {}

/// Map projection errors to public IPC strings.
/// Absolute paths never leave; `PAYLOAD_TOO_LARGE` is preserved verbatim (non-truncating).
pub fn context_error_to_public(error: ContextError) -> String {
    match error {
        ContextError::PayloadTooLarge { bytes, ceiling } => {
            format!("PAYLOAD_TOO_LARGE: {bytes} bytes exceeds {ceiling}")
        }
        ContextError::InvalidRelativePath(_) => {
            "context projection rejected unsafe relative paths".to_string()
        }
        ContextError::Serialization(_) => "context serialization failed".to_string(),
        ContextError::Torrent(message) => message,
        ContextError::IdentityDrift(message) => message,
    }
}

/// Project allowlisted context from a prepared plan's private local execution binding.
///
/// 1. Parse the bound torrent in Rust (path-free errors).
/// 2. Build an explicit allowlist of relative tree/file metadata + template content.
/// 3. Revalidate torrent identity/fingerprint after parse so replacements fail closed.
/// 4. Redact and enforce the ceiling without truncation.
///
/// Absolute paths, raw bencode, trackers, credentials, generic PublishPlan
/// serialization, and client-supplied names/files never enter the projection.
pub fn project_context_from_binding(
    binding: &LocalExecutionBinding,
    policy: &RedactionPolicy,
    ceiling: usize,
) -> Result<ContextProjection, ContextError> {
    let torrent_path = binding.request().torrent_path.as_str();
    let safe_torrent = project_safe_torrent_context(torrent_path)
        .map_err(ContextError::Torrent)?;

    // Revalidate AFTER parse so a same-path replacement cannot return stale/wrong context.
    if let Err(failures) = binding.revalidate() {
        return Err(ContextError::IdentityDrift(failures.join("；")));
    }

    let input = build_projection_input_from_bound_sources(&safe_torrent, &binding.request().template);
    project_context(input, policy, ceiling)
}

/// Build internal projection input from backend-owned torrent + template sources only.
fn build_projection_input_from_bound_sources(
    torrent: &SafeTorrentProjection,
    template: &Template,
) -> ContextProjectionInput {
    let files = torrent
        .files
        .iter()
        .enumerate()
        .map(|(index, file)| ContextFile {
            id: format!("torrent-file-{index}"),
            relative_path: file.relative_path.clone(),
            // Metadata-only: never embed filesystem file bodies.
            content: format!(r#"{{"size":{}}}"#, file.size),
        })
        .collect();

    ContextProjectionInput {
        torrent_name: torrent.name.clone(),
        torrent_tree: allowlisted_torrent_tree(torrent),
        templates: vec![allowlisted_template(template)],
        shared_content: Vec::new(),
        files,
    }
}

/// Explicit torrent tree allowlist: name, total_size, relative files, nested tree.
/// No trackers, announce, pieces, info-hash, or absolute paths.
fn allowlisted_torrent_tree(torrent: &SafeTorrentProjection) -> Value {
    json!({
        "name": torrent.name,
        "total_size": torrent.total_size,
        "files": torrent.files.iter().map(|file| json!({
            "relative_path": file.relative_path,
            "size": file.size,
        })).collect::<Vec<_>>(),
        "tree": torrent.tree,
    })
}

/// Explicit template content allowlist. Never includes profile secrets, credentials,
/// publish history, or non-template request fields.
fn allowlisted_template(template: &Template) -> Value {
    json!({
        "ep_pattern": template.ep_pattern,
        "resolution_pattern": template.resolution_pattern,
        "title_pattern": template.title_pattern,
        "poster": template.poster,
        "about": template.about,
        "tags": template.tags,
        "description": template.description,
        "description_html": template.description_html,
        "title": template.title,
        "sites": {
            "dmhy": template.sites.dmhy,
            "nyaa": template.sites.nyaa,
            "acgrip": template.sites.acgrip,
            "bangumi": template.sites.bangumi,
            "acgnx_asia": template.sites.acgnx_asia,
            "acgnx_global": template.sites.acgnx_global,
        },
    })
}

pub fn project_context(
    input: ContextProjectionInput,
    policy: &RedactionPolicy,
    ceiling: usize,
) -> Result<ContextProjection, ContextError> {
    let files = input
        .files
        .into_iter()
        .map(|mut file| {
            if !is_safe_relative_path(&file.relative_path) {
                return Err(ContextError::InvalidRelativePath(file.relative_path));
            }
            // Secret-only on relative_path: path/URL heuristics would corrupt
            // multi-component forms such as `dir/video.mkv` → `dir[PATH_REDACTED]`.
            file.relative_path = policy.redact_secret_substrings(&file.relative_path);
            if !is_safe_relative_path(&file.relative_path) {
                return Err(ContextError::InvalidRelativePath(file.relative_path));
            }
            // Free-text file content keeps path/URL/base64 heuristics.
            file.content = policy.redact_text(&file.content);
            Ok(file)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut projection = ContextProjection {
        version: 1,
        // Torrent name / tree are allowlisted relative metadata — secret substrings
        // only so safe multi-component relative paths keep their shape.
        torrent_name: policy.redact_secret_substrings(&input.torrent_name),
        torrent_tree: redact_torrent_metadata_value(&input.torrent_tree, policy),
        // Template / shared free-text keep full path/URL heuristics.
        templates: deduplicate_values(input.templates, policy),
        shared_content: deduplicate_values(input.shared_content, policy),
        files,
        bytes: 0,
    };

    // Measure the final serialized projection including the `bytes` field.
    // Never truncate to fit the ceiling; reject when the fixed-point size exceeds it.
    let bytes = measure_final_projection_bytes(&projection)?;
    if bytes > ceiling {
        return Err(ContextError::PayloadTooLarge { bytes, ceiling });
    }
    projection.bytes = bytes;
    Ok(projection)
}

/// Redact torrent-tree / path metadata with secret-substring replacement only.
///
/// Generic path heuristics (`dir/video.mkv` → `dir[PATH_REDACTED]`) must not run
/// on allowlisted relative torrent metadata. Free-text fields use `redact_value`.
fn redact_torrent_metadata_value(value: &Value, policy: &RedactionPolicy) -> Value {
    match value {
        Value::Object(object) => {
            let mut result = Map::new();
            for (key, child) in object {
                result.insert(key.clone(), redact_torrent_metadata_value(child, policy));
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_torrent_metadata_value(item, policy))
                .collect(),
        ),
        Value::String(text) => Value::String(policy.redact_secret_substrings(text)),
        other => other.clone(),
    }
}

/// Fixed-point size of the projection once `bytes` embeds its own serialization length.
/// Ensures PAYLOAD_TOO_LARGE accounts for the final form, not a `bytes: 0` placeholder.
fn measure_final_projection_bytes(
    projection: &ContextProjection,
) -> Result<usize, ContextError> {
    let mut working = projection.clone();
    working.bytes = 0;
    let mut bytes = serde_json::to_vec(&working)
        .map_err(|error| ContextError::Serialization(error.to_string()))?
        .len();
    // Digit-width of `bytes` can change the encoded length a few times near
    // powers of ten; usize needs at most ~20 digits so this always converges.
    for _ in 0..24 {
        working.bytes = bytes;
        let next = serde_json::to_vec(&working)
            .map_err(|error| ContextError::Serialization(error.to_string()))?
            .len();
        if next == bytes {
            return Ok(bytes);
        }
        bytes = next;
    }
    Ok(bytes)
}

fn deduplicate_values(values: Vec<Value>, policy: &RedactionPolicy) -> Vec<Value> {
    let mut seen = HashMap::<String, usize>::new();
    let mut result = Vec::new();
    for value in values {
        let redacted = policy.redact_value(&value);
        let key = serde_json::to_string(&redacted).unwrap_or_default();
        if !seen.contains_key(&key) {
            seen.insert(key, result.len());
            result.push(redacted);
        }
    }
    result
}

fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.trim().is_empty() {
        return false;
    }
    if path != path.trim() {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') {
        return false;
    }
    if path.contains(':') {
        return false;
    }
    if path.chars().any(|character| character.is_control()) {
        return false;
    }
    for component in path.split(['/', '\\']) {
        if component.is_empty() || component == "." || component == ".." {
            return false;
        }
    }
    path.chars().count() <= 1024
}

pub fn safe_object(entries: impl IntoIterator<Item = (String, Value)>) -> Value {
    let mut object = Map::new();
    for (key, value) in entries {
        object.insert(key, value);
    }
    Value::Object(object)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Template;
    use crate::domain::publish_plan::{PlanRegistry, PublishPlan};
    use crate::publish::PublishRequest;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn deduplicates_shared_content_and_preserves_unicode() {
        let input = ContextProjectionInput {
            torrent_name: "日語标题".into(),
            torrent_tree: json!({"name": "video.mkv"}),
            templates: vec![json!({"id": "t1"}), json!({"id": "t1"})],
            shared_content: vec![json!({"id": "c1"}), json!({"id": "c1"})],
            files: vec![ContextFile {
                id: "f1".into(),
                relative_path: "dir/video.mkv".into(),
                content: "正文".into(),
            }],
        };
        let result =
            project_context(input, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING).unwrap();
        assert_eq!(result.templates.len(), 1);
        assert_eq!(result.shared_content.len(), 1);
        assert_eq!(result.torrent_name, "日語标题");
    }

    #[test]
    fn rejects_absolute_paths_and_never_truncates_oversized_payloads() {
        let bad_path = ContextProjectionInput {
            files: vec![ContextFile {
                id: "f".into(),
                relative_path: "/private/file".into(),
                content: "x".into(),
            }],
            ..Default::default()
        };
        assert!(matches!(
            project_context(bad_path, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING),
            Err(ContextError::InvalidRelativePath(_))
        ));

        let large = ContextProjectionInput {
            torrent_name: "x".repeat(100),
            files: vec![ContextFile {
                id: "f".into(),
                relative_path: "a.txt".into(),
                content: "x".repeat(100),
            }],
            ..Default::default()
        };
        let err = project_context(large, &RedactionPolicy::default(), 10).unwrap_err();
        assert!(matches!(err, ContextError::PayloadTooLarge { .. }));
        let public = context_error_to_public(err);
        assert!(
            public.starts_with("PAYLOAD_TOO_LARGE:"),
            "must preserve code without truncating payload: {public}"
        );
        // No silent partial projection — error is fail-closed.
        assert!(!public.contains("…") && !public.contains("truncated"));
    }

    #[test]
    fn relative_tree_safety_rejects_parent_and_absolute_forms() {
        for path in [
            "../secret",
            "..\\secret",
            "/etc/passwd",
            "C:\\Windows\\system32",
            "dir//file",
            "",
            " ",
            "a/\0/b",
        ] {
            let input = ContextProjectionInput {
                files: vec![ContextFile {
                    id: "f".into(),
                    relative_path: path.into(),
                    content: "x".into(),
                }],
                ..Default::default()
            };
            assert!(
                matches!(
                    project_context(input, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING),
                    Err(ContextError::InvalidRelativePath(_))
                ),
                "expected reject for {path:?}"
            );
        }

        let ok = ContextProjectionInput {
            files: vec![ContextFile {
                id: "f".into(),
                relative_path: "dir/sub/video.mkv".into(),
                content: "ok".into(),
            }],
            ..Default::default()
        };
        assert!(project_context(ok, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING).is_ok());
    }

    #[test]
    fn redaction_strips_secrets_from_template_and_file_content() {
        let secret = "sk-super-secret-canary-xyz";
        let policy = RedactionPolicy::new(vec![secret.to_string()]);
        let input = ContextProjectionInput {
            torrent_name: format!("show-{secret}"),
            torrent_tree: json!({"name": format!("file-{secret}.mkv")}),
            templates: vec![json!({
                "description": format!("desc {secret}"),
                "title": "safe title",
            })],
            shared_content: vec![],
            files: vec![ContextFile {
                id: "f".into(),
                relative_path: "a.txt".into(),
                content: format!("body {secret}"),
            }],
        };
        let result = project_context(input, &policy, DEFAULT_CONTEXT_CEILING).unwrap();
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(
            !serialized.contains(secret),
            "secret must not appear in projection: {serialized}"
        );
        assert!(serialized.contains("[REDACTED]"));
    }

    fn write_valid_torrent(name: &str, contents_marker: &[u8]) -> PathBuf {
        // Minimal single-file torrent lava_torrent accepts (length=1, one 20-byte piece).
        // `contents_marker` is mixed into the piece hash so file digests differ on replacement.
        let mut bytes = format!(
            "d4:infod6:lengthi1e4:name{}:{}12:piece lengthi1e6:pieces20:",
            name.len(),
            name
        )
        .into_bytes();
        let mut pieces = [0xffu8; 20];
        for (index, byte) in contents_marker.iter().take(20).enumerate() {
            pieces[index] = *byte;
        }
        bytes.extend_from_slice(&pieces);
        bytes.extend_from_slice(b"ee");
        let path = std::env::temp_dir().join(format!(
            "okpgui-ctx-{}-{}-{}.torrent",
            std::process::id(),
            TEST_COUNTER.fetch_add(1, Ordering::Relaxed),
            name
        ));
        std::fs::write(&path, &bytes).expect("write torrent");
        path
    }

    fn sample_request(torrent_path: PathBuf, secret_in_template: Option<&str>) -> PublishRequest {
        let mut template = Template::default();
        template.title = "Demo Title".into();
        template.description = secret_in_template
            .map(|secret| format!("description with {secret}"))
            .unwrap_or_else(|| "description".into());
        template.ep_pattern = r"(?P<ep>\d+)".into();
        PublishRequest {
            publish_id: "publish".into(),
            torrent_path: torrent_path.display().to_string(),
            profile_name: "profile".into(),
            template,
        }
    }

    #[test]
    fn project_from_binding_allowlists_relative_metadata_and_hides_absolute_paths() {
        let torrent_path = write_valid_torrent("show.mkv", b"v1-identity-marker");
        let abs = torrent_path.display().to_string();
        let plan = PublishPlan::from_publish_request(1, sample_request(torrent_path.clone(), None), None)
            .expect("plan");
        let binding = plan.get_local_binding().expect("binding");
        let projection =
            project_context_from_binding(binding, &RedactionPolicy::default(), DEFAULT_CONTEXT_CEILING)
                .expect("project");

        assert_eq!(projection.torrent_name, "show.mkv");
        assert_eq!(projection.files.len(), 1);
        assert_eq!(projection.files[0].relative_path, "show.mkv");
        assert!(!projection.files[0].relative_path.starts_with('/'));
        assert_eq!(projection.templates.len(), 1);
        assert!(projection.templates[0].get("description").is_some());
        assert!(projection.templates[0].get("profile").is_none());
        assert!(projection.templates[0].get("publish_history").is_none());

        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(
            !serialized.contains(&abs),
            "absolute torrent path must not enter ContextProjection: {serialized}"
        );
        assert!(!serialized.contains("announce"));
        assert!(!serialized.contains("pieces"));
        // Generic PublishPlan fields must not be dumped into context.
        assert!(!serialized.contains("local_blockers"));
        assert!(!serialized.contains("binding_fingerprint"));
        assert!(!serialized.contains("prepare_token"));

        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn replacement_identity_fails_closed_after_parse() {
        let torrent_path = write_valid_torrent("show.mkv", b"original-bytes-aaaa");
        let plan =
            PublishPlan::from_publish_request(2, sample_request(torrent_path.clone(), None), None)
                .expect("plan");
        let binding = plan.get_local_binding().expect("binding").clone();

        // Same-path replacement with different digest.
        let replaced = write_valid_torrent("show.mkv", b"replaced-bytes-bbbb");
        let replaced_bytes = std::fs::read(&replaced).expect("read replaced");
        std::fs::write(&torrent_path, replaced_bytes).expect("overwrite bound path");
        let _ = std::fs::remove_file(&replaced);

        let err = project_context_from_binding(
            &binding,
            &RedactionPolicy::default(),
            DEFAULT_CONTEXT_CEILING,
        )
        .expect_err("replacement must fail closed");
        assert!(
            matches!(err, ContextError::IdentityDrift(_)),
            "expected IdentityDrift, got {err:?}"
        );
        let public = context_error_to_public(err);
        assert!(
            !public.contains(torrent_path.to_string_lossy().as_ref()),
            "public error must not include absolute path: {public}"
        );

        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn missing_unbound_and_expired_tokens_fail_closed() {
        let mut registry = PlanRegistry::default();

        // Missing
        let missing = registry.resolve_binding_for_context("plan_does_not_exist");
        assert!(missing.is_err());
        assert!(missing
            .unwrap_err()
            .contains("missing or expired"));

        // Unbound (lightweight prepare has no LocalExecutionBinding)
        let unbound_token = registry
            .prepare_plan("sha256:abc".into(), 1)
            .expect("prepare unbound");
        let unbound = registry.resolve_binding_for_context(&unbound_token);
        assert!(unbound.is_err());
        assert!(unbound
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("binding"));

        // Expired
        let torrent_path = write_valid_torrent("exp.mkv", b"expire-marker");
        let mut expiring = PlanRegistry::new(0);
        let prepared = expiring
            .prepare_plan_with_request_and_blockers(
                1,
                sample_request(torrent_path.clone(), None),
                Vec::new(),
                false,
                None,
            )
            .expect("prepare");
        let expired = expiring.resolve_binding_for_context(&prepared.token);
        assert!(expired.is_err());
        assert!(expired.unwrap_err().contains("missing or expired"));

        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn binding_projection_redacts_template_secrets() {
        let secret = "sk-ctx-binding-secret-999";
        let torrent_path = write_valid_torrent("show.mkv", b"redact-marker");
        let plan = PublishPlan::from_publish_request(
            3,
            sample_request(torrent_path.clone(), Some(secret)),
            None,
        )
        .expect("plan");
        let binding = plan.get_local_binding().expect("binding");
        let policy = RedactionPolicy::new(vec![secret.to_string()]);
        let projection =
            project_context_from_binding(binding, &policy, DEFAULT_CONTEXT_CEILING).unwrap();
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(!serialized.contains(secret));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn oversized_bound_projection_never_truncates() {
        let torrent_path = write_valid_torrent("show.mkv", b"size-marker");
        let mut request = sample_request(torrent_path.clone(), None);
        request.template.description = "Y".repeat(2048);
        let plan = PublishPlan::from_publish_request(4, request, None).expect("plan");
        let binding = plan.get_local_binding().expect("binding");
        let err = project_context_from_binding(binding, &RedactionPolicy::default(), 64)
            .expect_err("must exceed ceiling");
        match &err {
            ContextError::PayloadTooLarge { bytes, ceiling } => {
                assert!(*bytes > *ceiling);
                assert_eq!(*ceiling, 64);
            }
            other => panic!("expected PayloadTooLarge, got {other:?}"),
        }
        let public = context_error_to_public(err);
        assert!(public.starts_with("PAYLOAD_TOO_LARGE:"));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn multi_component_relative_paths_survive_projection_and_stay_consistent() {
        // Regression M6: full redact_value/redact_text path heuristics turned
        // `dir/video.mkv` into `dir[PATH_REDACTED]`. Torrent metadata must keep
        // multi-component relative shape while still redacting secret substrings.
        let secret = "sk-path-canary-m6-xyz";
        let policy = RedactionPolicy::new(vec![secret.to_string()]);
        let input = ContextProjectionInput {
            torrent_name: format!("Show-{secret}"),
            torrent_tree: json!({
                "name": format!("Show-{secret}"),
                "total_size": 100,
                "files": [
                    {"relative_path": "dir/video.mkv", "size": 50},
                    {"relative_path": format!("dir/{secret}.txt"), "size": 50},
                ],
                "tree": {
                    "name": format!("Show-{secret}"),
                    "is_file": false,
                    "size": null,
                    "children": [{
                        "name": "dir",
                        "is_file": false,
                        "size": null,
                        "children": [
                            {"name": "video.mkv", "is_file": true, "size": 50, "children": []},
                            {"name": format!("{secret}.txt"), "is_file": true, "size": 50, "children": []},
                        ]
                    }]
                }
            }),
            templates: vec![json!({
                "description": format!("desc {secret} and /Users/owen/private"),
            })],
            shared_content: vec![json!({
                "note": "https://user:pass@example.test/x and /tmp/abs",
            })],
            files: vec![
                ContextFile {
                    id: "torrent-file-0".into(),
                    relative_path: "dir/video.mkv".into(),
                    content: r#"{"size":50}"#.into(),
                },
                ContextFile {
                    id: "torrent-file-1".into(),
                    relative_path: format!("dir/{secret}.txt"),
                    content: format!(r#"{{"size":50,"hint":"{secret}"}}"#),
                },
            ],
        };

        let result = project_context(input, &policy, DEFAULT_CONTEXT_CEILING).unwrap();

        // Multi-component relative path survives projection (no PATH_REDACTED).
        assert_eq!(result.files[0].relative_path, "dir/video.mkv");
        assert!(!result.files[0].relative_path.contains("PATH_REDACTED"));

        let tree_files = result.torrent_tree["files"]
            .as_array()
            .expect("torrent_tree.files array");
        assert_eq!(
            tree_files[0]["relative_path"].as_str().unwrap(),
            "dir/video.mkv",
            "torrent_tree relative_path must keep multi-component shape"
        );
        // ContextFile.relative_path and torrent_tree file relative_path stay consistent.
        assert_eq!(
            result.files[0].relative_path,
            tree_files[0]["relative_path"].as_str().unwrap()
        );

        // Secret substrings still redacted on path metadata without path-shape heuristics.
        assert_eq!(result.files[1].relative_path, "dir/[REDACTED].txt");
        assert_eq!(
            tree_files[1]["relative_path"].as_str().unwrap(),
            "dir/[REDACTED].txt"
        );
        assert!(!result.torrent_name.contains(secret));
        assert!(result.torrent_name.contains("[REDACTED]"));

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(
            !serialized.contains(secret),
            "secret must not appear in projection: {serialized}"
        );
        assert!(
            !serialized.contains("dir[PATH_REDACTED]"),
            "path heuristics must not run on torrent relative paths: {serialized}"
        );

        // Free-text template/shared-content fields still apply path/URL heuristics.
        let templates = serde_json::to_string(&result.templates).unwrap();
        assert!(!templates.contains(secret));
        assert!(
            templates.contains("PATH_REDACTED") || !templates.contains("/Users/owen"),
            "template free-text must still redact absolute paths: {templates}"
        );
        let shared = serde_json::to_string(&result.shared_content).unwrap();
        assert!(!shared.contains("user:pass"));
        assert!(
            shared.contains("PATH_REDACTED") || !shared.contains("/tmp/abs"),
            "shared free-text must still redact absolute paths: {shared}"
        );
    }

    #[test]
    fn final_serialized_bytes_including_bytes_field_obeys_ceiling() {
        // Regression M6: ceiling was checked on a serialization with `bytes: 0`,
        // then `bytes` was overwritten — final form could exceed the ceiling.
        let input = ContextProjectionInput {
            torrent_name: "show".into(),
            torrent_tree: json!({
                "name": "show",
                "files": [{"relative_path": "dir/video.mkv", "size": 1}],
            }),
            files: vec![ContextFile {
                id: "f".into(),
                relative_path: "dir/video.mkv".into(),
                content: "payload-body".into(),
            }],
            templates: vec![json!({"title": "t"})],
            shared_content: vec![],
        };

        let ok = project_context(
            input.clone(),
            &RedactionPolicy::default(),
            DEFAULT_CONTEXT_CEILING,
        )
        .expect("projection under default ceiling");
        let actual = serde_json::to_vec(&ok).expect("serialize").len();
        assert_eq!(
            ok.bytes, actual,
            "bytes field must equal final serialized length including itself"
        );
        // Multi-component path still intact under size accounting path.
        assert_eq!(ok.files[0].relative_path, "dir/video.mkv");

        // Exact final size is accepted; one byte under is rejected without truncation.
        let exact = ok.bytes;
        let again = project_context(input.clone(), &RedactionPolicy::default(), exact)
            .expect("exact final size must be accepted");
        assert_eq!(again.bytes, exact);
        assert_eq!(serde_json::to_vec(&again).unwrap().len(), exact);

        let err = project_context(input, &RedactionPolicy::default(), exact - 1)
            .expect_err("one under final size must fail closed");
        match err {
            ContextError::PayloadTooLarge { bytes, ceiling } => {
                assert_eq!(ceiling, exact - 1);
                assert_eq!(
                    bytes, exact,
                    "reported size must be the final fixed-point size, not a bytes:0 placeholder"
                );
                assert!(bytes > ceiling);
            }
            other => panic!("expected PayloadTooLarge, got {other:?}"),
        }
        let public = context_error_to_public(ContextError::PayloadTooLarge {
            bytes: exact,
            ceiling: exact - 1,
        });
        assert!(public.starts_with("PAYLOAD_TOO_LARGE:"));
        assert!(!public.contains("…") && !public.contains("truncated"));
    }
}
