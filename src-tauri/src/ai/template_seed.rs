//! Opaque AutoTemplate → QuickPublish seed registry.
//!
//! Seeds bind a catalog-validated quick-publish template identity (id + revision +
//! digest) to a current torrent file identity. Browser clients only ever store the
//! opaque token plus public template id; raw torrent paths stay in the Rust binding.
//!
//! Consume/inspect re-validate against the live catalog and current torrent bytes
//! before returning hydration data — never a remove-only check.

use crate::config::{QuickPublishTemplate, SiteSelection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TemplateSeed {
    pub token: String,
    pub template_id: String,
    pub template_revision: u64,
    pub template_digest: String,
    pub torrent_name: String,
}

/// Server-only binding; never serialized to browser storage.
#[derive(Debug, Clone)]
pub struct TemplateSeedBinding {
    pub torrent_path: String,
    pub torrent_digest: String,
    pub torrent_len: u64,
}

/// Eligible catalog entry exposed to the provider (no body/secret-bearing fields).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EligibleTemplateCatalogEntry {
    pub id: String,
    pub name: String,
    pub revision: u64,
    pub digest: String,
    pub summary: String,
}

#[derive(Debug, Clone)]
struct StoredSeed {
    public: TemplateSeed,
    binding: TemplateSeedBinding,
    expires_at: Instant,
}

#[derive(Debug, Clone)]
pub struct TemplateSeedRegistry {
    seeds: HashMap<String, StoredSeed>,
    ttl: Duration,
}

impl Default for TemplateSeedRegistry {
    fn default() -> Self {
        Self {
            seeds: HashMap::new(),
            ttl: Duration::from_secs(600),
        }
    }
}

impl TemplateSeedRegistry {
    #[allow(dead_code)]
    pub fn with_ttl(ttl: Duration) -> Self {
        Self {
            seeds: HashMap::new(),
            ttl,
        }
    }

    /// Mint a seed after the caller has already validated the catalog selection.
    /// Binds the current torrent file identity (digest + length) into the private binding.
    pub fn prepare(
        &mut self,
        template_id: String,
        template_revision: u64,
        template_digest: String,
        torrent_name: String,
        torrent_path: String,
    ) -> Result<TemplateSeed, String> {
        if template_id.trim().is_empty()
            || template_digest.trim().is_empty()
            || torrent_path.trim().is_empty()
        {
            return Err(
                "template seed requires a current template and torrent binding".to_string(),
            );
        }
        let torrent_identity = read_torrent_identity(&torrent_path)?;
        let token = opaque_seed_token();
        let public = TemplateSeed {
            token: token.clone(),
            template_id,
            template_revision,
            template_digest,
            torrent_name,
        };
        self.seeds.insert(
            token,
            StoredSeed {
                public: public.clone(),
                binding: TemplateSeedBinding {
                    torrent_path: torrent_identity.path,
                    torrent_digest: torrent_identity.digest,
                    torrent_len: torrent_identity.len,
                },
                expires_at: Instant::now() + self.ttl,
            },
        );
        Ok(public)
    }

    /// Inspect without consuming. Re-validates TTL, catalog identity, and torrent identity.
    /// Stale seeds are invalidated (removed) and yield `None`.
    pub fn inspect_validated(
        &mut self,
        token: &str,
        catalog: &[EligibleTemplateCatalogEntry],
    ) -> Option<TemplateSeed> {
        self.remove_expired();
        let stored = self.seeds.get(token).cloned()?;
        if validate_seed_against_current_state(&stored, catalog).is_err() {
            self.seeds.remove(token);
            return None;
        }
        Some(stored.public)
    }

    /// Legacy inspect (TTL only). Prefer `inspect_validated`.
    #[allow(dead_code)]
    pub fn inspect(&mut self, token: &str) -> Option<&TemplateSeed> {
        self.remove_expired();
        self.seeds.get(token).map(|seed| &seed.public)
    }

    /// Consume once after re-validating catalog + torrent identity.
    /// On validation failure the seed is invalidated and an error is returned
    /// (not a remove-only success).
    pub fn consume_validated(
        &mut self,
        token: &str,
        catalog: &[EligibleTemplateCatalogEntry],
    ) -> Result<(TemplateSeed, TemplateSeedBinding), String> {
        self.remove_expired();
        let stored =
            self.seeds.get(token).cloned().ok_or_else(|| {
                "template seed is missing, expired, or already consumed".to_string()
            })?;
        if let Err(reason) = validate_seed_against_current_state(&stored, catalog) {
            // Fail closed: drop the stale seed so it cannot succeed later.
            self.seeds.remove(token);
            return Err(reason);
        }
        self.seeds.remove(token);
        Ok((stored.public, stored.binding))
    }

    /// Legacy remove-only consume. Prefer `consume_validated`.
    pub fn consume(&mut self, token: &str) -> Option<(TemplateSeed, TemplateSeedBinding)> {
        self.remove_expired();
        self.seeds
            .remove(token)
            .map(|seed| (seed.public, seed.binding))
    }

    fn remove_expired(&mut self) {
        self.seeds
            .retain(|_, seed| Instant::now() < seed.expires_at);
    }
}

#[derive(Debug, Clone)]
struct TorrentFileIdentity {
    path: String,
    digest: String,
    len: u64,
}

fn validate_seed_against_current_state(
    stored: &StoredSeed,
    catalog: &[EligibleTemplateCatalogEntry],
) -> Result<(), String> {
    find_catalog_match(
        catalog,
        &stored.public.template_id,
        stored.public.template_revision,
        &stored.public.template_digest,
    )
    .ok_or_else(|| {
        "template seed catalog identity is stale or missing (id/revision/digest mismatch)"
            .to_string()
    })?;

    let current = read_torrent_identity(&stored.binding.torrent_path).map_err(|_| {
        "template seed torrent is missing or no longer a regular .torrent file".to_string()
    })?;
    if current.digest != stored.binding.torrent_digest || current.len != stored.binding.torrent_len
    {
        return Err("template seed torrent identity changed (file was replaced)".to_string());
    }
    Ok(())
}

/// Digest of public quick-publish template content + revision for catalog identity.
/// Does not include publish history timestamps or raw filesystem paths.
pub fn digest_quick_publish_template(template: &QuickPublishTemplate) -> String {
    #[derive(Serialize)]
    struct Payload<'a> {
        id: &'a str,
        name: &'a str,
        summary: &'a str,
        title: &'a str,
        ep_pattern: &'a str,
        resolution_pattern: &'a str,
        title_pattern: &'a str,
        poster: &'a str,
        about: &'a str,
        tags: &'a str,
        default_profile: &'a str,
        default_sites: &'a SiteSelection,
        body_markdown: &'a str,
        body_html: &'a str,
        shared_content_template_id: Option<&'a str>,
        revision: u64,
    }
    let id = if template.id.trim().is_empty() {
        ""
    } else {
        template.id.as_str()
    };
    let payload = Payload {
        id,
        name: &template.name,
        summary: &template.summary,
        title: &template.title,
        ep_pattern: &template.ep_pattern,
        resolution_pattern: &template.resolution_pattern,
        title_pattern: &template.title_pattern,
        poster: &template.poster,
        about: &template.about,
        tags: &template.tags,
        default_profile: &template.default_profile,
        default_sites: &template.default_sites,
        body_markdown: &template.body_markdown,
        body_html: &template.body_html,
        shared_content_template_id: template.shared_content_template_id.as_deref(),
        revision: template.revision,
    };
    digest_json(&payload)
}

/// Build the sorted eligible catalog from current config templates.
/// Provider payloads may only use these public entries (id/name/revision/digest/summary).
pub fn build_eligible_catalog(
    templates: &HashMap<String, QuickPublishTemplate>,
) -> Vec<EligibleTemplateCatalogEntry> {
    let mut entries = templates
        .iter()
        .filter_map(|(map_id, template)| {
            let id = if template.id.trim().is_empty() {
                map_id.trim().to_string()
            } else {
                template.id.trim().to_string()
            };
            if id.is_empty() {
                return None;
            }
            let name = if template.name.trim().is_empty() {
                id.clone()
            } else {
                template.name.clone()
            };
            Some(EligibleTemplateCatalogEntry {
                id: id.clone(),
                name,
                revision: template.revision,
                digest: digest_quick_publish_template(template),
                summary: template.summary.clone(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.id.cmp(&right.id));
    entries
}

pub fn find_catalog_match<'a>(
    catalog: &'a [EligibleTemplateCatalogEntry],
    template_id: &str,
    template_revision: u64,
    template_digest: &str,
) -> Option<&'a EligibleTemplateCatalogEntry> {
    let template_id = template_id.trim();
    let template_digest = template_digest.trim();
    if template_id.is_empty() || template_digest.is_empty() {
        return None;
    }
    catalog.iter().find(|entry| {
        entry.id == template_id
            && entry.revision == template_revision
            && entry.digest == template_digest
    })
}

/// Snapshot hash over the eligible catalog for job identity binding.
pub fn catalog_snapshot_hash(catalog: &[EligibleTemplateCatalogEntry]) -> String {
    digest_json(&catalog)
}

/// Strict structured-output schema for automatic template selection.
pub fn template_selection_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["matched", "template_id", "template_revision", "template_digest"],
        "properties": {
            "matched": { "type": "boolean" },
            "template_id": { "type": "string" },
            "template_revision": { "type": "integer", "minimum": 0 },
            "template_digest": { "type": "string" }
        }
    })
}

/// Provider prompt: model may only pick an existing catalog id/revision/digest.
pub fn build_template_selection_prompt(
    torrent_name: &str,
    catalog: &[EligibleTemplateCatalogEntry],
) -> String {
    let catalog_json = serde_json::to_string(catalog).unwrap_or_else(|_| "[]".to_string());
    format!(
        "You select exactly one existing quick-publish template for a torrent release.\n\
         Return ONLY the strict JSON schema object.\n\
         Set matched=true only when one catalog entry clearly fits; otherwise matched=false and empty identity fields.\n\
         When matched=true, template_id, template_revision, and template_digest MUST copy an entry from the catalog exactly.\n\
         Never invent template content, ids, revisions, digests, or filesystem paths.\n\
         torrent_name={torrent_name}\n\
         catalog={catalog_json}\n"
    )
}

/// Parse and validate a provider structured selection against the live catalog.
pub fn parse_template_selection(
    structured: &Value,
    catalog: &[EligibleTemplateCatalogEntry],
) -> Result<EligibleTemplateCatalogEntry, String> {
    #[derive(Debug, Deserialize)]
    #[serde(deny_unknown_fields)]
    struct SelectionEnvelope {
        matched: bool,
        template_id: String,
        template_revision: u64,
        template_digest: String,
    }

    let envelope: SelectionEnvelope = serde_json::from_value(structured.clone())
        .map_err(|_| "provider template selection failed schema validation".to_string())?;

    if !envelope.matched {
        return Err("provider reported no matching template in the current catalog".to_string());
    }

    find_catalog_match(
        catalog,
        &envelope.template_id,
        envelope.template_revision,
        &envelope.template_digest,
    )
    .cloned()
    .ok_or_else(|| "provider selected an invalid or stale template id/revision/digest".to_string())
}

fn read_torrent_identity(torrent_path: &str) -> Result<TorrentFileIdentity, String> {
    let torrent_path = torrent_path.trim();
    if torrent_path.is_empty() {
        return Err("template seed requires a current template and torrent binding".to_string());
    }

    let path = Path::new(torrent_path);
    let metadata = std::fs::metadata(path).map_err(|_| {
        "template seed torrent path must be an existing regular .torrent file".to_string()
    })?;
    if !metadata.is_file() {
        return Err(
            "template seed torrent path must be an existing regular .torrent file".to_string(),
        );
    }

    let is_torrent = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("torrent"));
    if !is_torrent {
        return Err(
            "template seed torrent path must be an existing regular .torrent file".to_string(),
        );
    }

    let bytes = std::fs::read(path).map_err(|_| {
        "template seed torrent path must be an existing regular .torrent file".to_string()
    })?;
    let len = bytes.len() as u64;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(TorrentFileIdentity {
        path: path.to_string_lossy().into_owned(),
        digest: format!("sha256:{}", hex::encode(hasher.finalize())),
        len,
    })
}

fn digest_json<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

static SEED_COUNTER: AtomicU64 = AtomicU64::new(0);

fn opaque_seed_token() -> String {
    let counter = SEED_COUNTER.fetch_add(1, Ordering::Relaxed);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(timestamp.to_le_bytes());
    hasher.update(counter.to_le_bytes());
    format!("seed_{}", hex::encode(hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use std::thread;
    use std::time::Duration as StdDuration;

    fn write_temp_torrent(file_name: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "okpgui_seed_{}_{}_{}",
            std::process::id(),
            SEED_COUNTER.fetch_add(1, Ordering::Relaxed),
            file_name
        ));
        let mut file = std::fs::File::create(&path).expect("create temp torrent");
        file.write_all(contents).expect("write torrent");
        path
    }

    fn sample_template(id: &str, revision: u64, title: &str) -> QuickPublishTemplate {
        QuickPublishTemplate {
            id: id.to_string(),
            name: format!("Name {id}"),
            summary: "summary".into(),
            title: title.into(),
            revision,
            ..QuickPublishTemplate::default()
        }
    }

    #[test]
    fn seed_is_opaque_and_consumed_once_with_validation() {
        let torrent_path = write_temp_torrent("valid.torrent", b"d4:infod4:name4:testee");
        let template = sample_template("tpl-a", 2, "Title A");
        let mut templates = HashMap::new();
        templates.insert("tpl-a".into(), template);
        let catalog = build_eligible_catalog(&templates);
        let entry = catalog.first().unwrap();

        let mut registry = TemplateSeedRegistry::default();
        let seed = registry
            .prepare(
                entry.id.clone(),
                entry.revision,
                entry.digest.clone(),
                "torrent".into(),
                torrent_path.to_string_lossy().into_owned(),
            )
            .unwrap();
        assert!(!seed.token.contains("tpl-a"));
        assert!(registry.inspect_validated(&seed.token, &catalog).is_some());
        let consumed = registry
            .consume_validated(&seed.token, &catalog)
            .expect("consume");
        assert_eq!(consumed.1.torrent_path, torrent_path.to_string_lossy());
        assert!(consumed.1.torrent_digest.starts_with("sha256:"));
        assert!(registry.consume_validated(&seed.token, &catalog).is_err());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn prepare_rejects_invalid_torrent_path() {
        let mut registry = TemplateSeedRegistry::default();
        let missing = registry.prepare(
            "template".into(),
            1,
            "digest".into(),
            "torrent".into(),
            "/no/such/path/file.torrent".into(),
        );
        assert!(missing.is_err());
        assert!(missing.unwrap_err().contains(".torrent"));

        let not_torrent = write_temp_torrent("notes.txt", b"not a torrent");
        let wrong_ext = registry.prepare(
            "template".into(),
            1,
            "digest".into(),
            "torrent".into(),
            not_torrent.to_string_lossy().into_owned(),
        );
        assert!(wrong_ext.is_err());
        let _ = std::fs::remove_file(&not_torrent);

        let dir = std::env::temp_dir().join(format!("okpgui_seed_dir_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let dir_err = registry.prepare(
            "template".into(),
            1,
            "digest".into(),
            "torrent".into(),
            dir.to_string_lossy().into_owned(),
        );
        assert!(dir_err.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_invalid_provider_id_and_revision() {
        let mut templates = HashMap::new();
        templates.insert("tpl-a".into(), sample_template("tpl-a", 1, "A"));
        templates.insert("tpl-b".into(), sample_template("tpl-b", 3, "B"));
        let catalog = build_eligible_catalog(&templates);

        let invalid_id = parse_template_selection(
            &json!({
                "matched": true,
                "template_id": "tpl-missing",
                "template_revision": 1,
                "template_digest": catalog[0].digest,
            }),
            &catalog,
        );
        assert!(invalid_id.is_err());

        let digest_a = catalog
            .iter()
            .find(|e| e.id == "tpl-a")
            .unwrap()
            .digest
            .clone();
        let invalid_revision = parse_template_selection(
            &json!({
                "matched": true,
                "template_id": "tpl-a",
                "template_revision": 99,
                "template_digest": digest_a,
            }),
            &catalog,
        );
        assert!(invalid_revision.is_err());

        let no_match = parse_template_selection(
            &json!({
                "matched": false,
                "template_id": "",
                "template_revision": 0,
                "template_digest": "",
            }),
            &catalog,
        );
        assert!(no_match.is_err());
        assert!(no_match.unwrap_err().contains("no matching template"));
    }

    #[test]
    fn consume_rejects_catalog_revision_drift() {
        let torrent_path = write_temp_torrent("drift.torrent", b"d4:infod4:name4:driftee");
        let mut templates = HashMap::new();
        templates.insert("tpl-a".into(), sample_template("tpl-a", 1, "A"));
        let catalog = build_eligible_catalog(&templates);
        let entry = catalog.first().unwrap().clone();

        let mut registry = TemplateSeedRegistry::default();
        let seed = registry
            .prepare(
                entry.id.clone(),
                entry.revision,
                entry.digest.clone(),
                "drift".into(),
                torrent_path.to_string_lossy().into_owned(),
            )
            .unwrap();

        templates.insert("tpl-a".into(), sample_template("tpl-a", 2, "A"));
        let drifted = build_eligible_catalog(&templates);
        let err = registry
            .consume_validated(&seed.token, &drifted)
            .expect_err("stale revision");
        assert!(err.contains("stale") || err.contains("mismatch"));
        assert!(registry.consume_validated(&seed.token, &catalog).is_err());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn consume_rejects_torrent_replacement() {
        let torrent_path = write_temp_torrent("replace.torrent", b"d4:infod4:name4:origee");
        let mut templates = HashMap::new();
        templates.insert("tpl-a".into(), sample_template("tpl-a", 1, "A"));
        let catalog = build_eligible_catalog(&templates);
        let entry = catalog.first().unwrap().clone();

        let mut registry = TemplateSeedRegistry::default();
        let seed = registry
            .prepare(
                entry.id.clone(),
                entry.revision,
                entry.digest.clone(),
                "orig".into(),
                torrent_path.to_string_lossy().into_owned(),
            )
            .unwrap();

        std::fs::write(&torrent_path, b"d4:infod4:name4:newxee").expect("replace torrent");
        let err = registry
            .consume_validated(&seed.token, &catalog)
            .expect_err("replaced torrent");
        assert!(err.contains("replaced") || err.contains("identity"));
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn ttl_expiry_and_replay_fail_closed() {
        let torrent_path = write_temp_torrent("ttl.torrent", b"d4:infod4:name3:ttlee");
        let mut templates = HashMap::new();
        templates.insert("tpl-a".into(), sample_template("tpl-a", 1, "A"));
        let catalog = build_eligible_catalog(&templates);
        let entry = catalog.first().unwrap().clone();

        let mut registry = TemplateSeedRegistry::with_ttl(StdDuration::from_millis(30));
        let seed = registry
            .prepare(
                entry.id.clone(),
                entry.revision,
                entry.digest.clone(),
                "ttl".into(),
                torrent_path.to_string_lossy().into_owned(),
            )
            .unwrap();

        thread::sleep(StdDuration::from_millis(50));
        assert!(registry.inspect_validated(&seed.token, &catalog).is_none());
        assert!(registry.consume_validated(&seed.token, &catalog).is_err());

        let mut registry = TemplateSeedRegistry::default();
        let seed = registry
            .prepare(
                entry.id.clone(),
                entry.revision,
                entry.digest.clone(),
                "ttl".into(),
                torrent_path.to_string_lossy().into_owned(),
            )
            .unwrap();
        assert!(registry.consume_validated(&seed.token, &catalog).is_ok());
        assert!(registry.consume_validated(&seed.token, &catalog).is_err());
        let _ = std::fs::remove_file(&torrent_path);
    }

    #[test]
    fn catalog_never_silently_picks_first_entry() {
        let mut templates = HashMap::new();
        templates.insert("aaa-first".into(), sample_template("aaa-first", 1, "First"));
        templates.insert("zzz-last".into(), sample_template("zzz-last", 1, "Last"));
        let catalog = build_eligible_catalog(&templates);
        assert_eq!(catalog[0].id, "aaa-first");

        let err = parse_template_selection(
            &json!({
                "matched": true,
                "template_id": "",
                "template_revision": 0,
                "template_digest": "",
            }),
            &catalog,
        )
        .unwrap_err();
        assert!(err.contains("invalid") || err.contains("stale"));
    }
}
