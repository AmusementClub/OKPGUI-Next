use serde_json::{Map, Value};
use std::collections::HashSet;

const REDACTED: &str = "[REDACTED]";
const IMAGE_REDACTED: &str = "[IMAGE_BYTES_REDACTED]";

#[derive(Debug, Clone, Default)]
pub struct RedactionPolicy {
    secret_values: HashSet<String>,
}

impl RedactionPolicy {
    pub fn new<I, S>(secret_values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        Self {
            secret_values: secret_values
                .into_iter()
                .map(Into::into)
                .filter(|value| value.len() >= 3)
                .collect(),
        }
    }

    pub fn redact_value(&self, value: &Value) -> Value {
        redact_value(value, self)
    }

    pub fn redact_json_text(&self, text: &str) -> String {
        match serde_json::from_str::<Value>(text) {
            Ok(value) => serde_json::to_string(&self.redact_value(&value))
                .unwrap_or_else(|_| REDACTED.to_string()),
            Err(_) => self.redact_text(text),
        }
    }

    pub fn redact_text(&self, text: &str) -> String {
        let mut redacted = self.redact_secret_substrings(text);
        // Header values and production key shapes before path/url scalar heuristics.
        redacted = redact_header_secrets(&redacted);
        redacted = redact_known_api_key_shapes(&redacted);
        redacted = redact_url_userinfo(&redacted);
        redacted = redact_scheme_prefixed_paths(&redacted);
        redacted
            .split_whitespace()
            .map(redact_scalar)
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Replace known secret substrings only (no path/base64 scalar heuristics).
    /// Use for fields that must preserve relative path shape while still blocking canaries.
    pub fn redact_secret_substrings(&self, text: &str) -> String {
        let mut redacted = text.to_string();
        for secret in &self.secret_values {
            redacted = redacted.replace(secret, REDACTED);
        }
        redacted
    }
}

pub fn redact_value(value: &Value, policy: &RedactionPolicy) -> Value {
    match value {
        Value::Object(object) => {
            let mut result = Map::new();
            for (key, child) in object {
                if is_sensitive_key(key) {
                    result.insert(key.clone(), Value::String(REDACTED.to_string()));
                } else {
                    result.insert(key.clone(), redact_value(child, policy));
                }
            }
            Value::Object(result)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| redact_value(item, policy))
                .collect(),
        ),
        Value::String(text) => Value::String(policy.redact_text(text)),
        other => other.clone(),
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase();

    [
        "authorization",
        "apikey",
        "xapikey",
        "cookie",
        "setcookie",
        "secret",
        "password",
        "credential",
        "profilebody",
        "profilecookies",
        "userinfo",
        "base64",
        "imagebytes",
        "rawbencode",
        "trackers",
    ]
    .iter()
    .any(|needle| normalized.contains(needle))
        || normalized.ends_with("token")
}

fn redact_scalar(value: &str) -> String {
    if is_data_image(value) || looks_like_base64(value) {
        return IMAGE_REDACTED.to_string();
    }

    if let Some(path_start) = absolute_path_start(value) {
        return format!("{}[PATH_REDACTED]", &value[..path_start]);
    }

    value.to_string()
}

/// Redact Cookie / Set-Cookie / Authorization / Bearer header values fail-closed.
fn redact_header_secrets(text: &str) -> String {
    let mut out = redact_after_ascii_keyword_ci(text, "set-cookie:");
    out = redact_after_ascii_keyword_ci(&out, "cookie:");
    // Bearer before Authorization so "Authorization: Bearer <token>" collapses cleanly.
    out = redact_after_ascii_keyword_ci(&out, "bearer ");
    out = redact_after_ascii_keyword_ci(&out, "authorization:");
    out
}

/// Replace the value that follows an ASCII keyword (case-insensitive) until a delimiter.
fn redact_after_ascii_keyword_ci(text: &str, keyword: &str) -> String {
    let keyword_lower = keyword.to_ascii_lowercase();
    let keyword_len = keyword.len();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut out = String::with_capacity(text.len());

    while i < bytes.len() {
        let remaining = &text[i..];
        let remaining_lower = remaining.to_ascii_lowercase();
        if remaining_lower.starts_with(&keyword_lower) {
            // Keep a stable placeholder for the whole header assignment.
            out.push_str(REDACTED);
            i += keyword_len;
            while i < bytes.len() && bytes[i].is_ascii_whitespace() {
                i += 1;
            }
            while i < bytes.len() {
                let byte = bytes[i];
                if byte.is_ascii_whitespace()
                    || matches!(
                        byte,
                        b'"' | b'\'' | b',' | b';' | b'{' | b'}' | b'[' | b']' | b'<' | b'>'
                    )
                {
                    break;
                }
                i += 1;
            }
        } else {
            let ch = remaining.chars().next().expect("non-empty remaining");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// Production / live API-key shapes that must never appear in debug surfaces.
fn looks_like_api_key_token(token: &str) -> bool {
    if token.len() < 12 {
        return false;
    }
    token.starts_with("sk-proj-")
        || token.starts_with("sk-ant-")
        || token.starts_with("sk-live-")
        || token.starts_with("sk-canary")
        || token.starts_with("sk-super-secret")
        || (token.starts_with("sk-") && token.len() >= 20)
        || (token.starts_with("xai-") && token.len() >= 12)
        || (token.starts_with("AIza") && token.len() >= 20)
        || token.starts_with("ghp_")
        || token.starts_with("github_pat_")
        || (token.starts_with("AKIA") && token.len() >= 16)
}

fn redact_known_api_key_shapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();

    let flush = |token: &mut String, out: &mut String| {
        if token.is_empty() {
            return;
        }
        if looks_like_api_key_token(token) {
            out.push_str(REDACTED);
        } else {
            out.push_str(token);
        }
        token.clear();
    };

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '+' | '/') {
            token.push(ch);
        } else {
            flush(&mut token, &mut out);
            out.push(ch);
        }
    }
    flush(&mut token, &mut out);
    out
}

/// Neutralize `file://` and other scheme-prefixed absolute path forms.
fn redact_scheme_prefixed_paths(text: &str) -> String {
    text.split_whitespace()
        .map(|part| {
            let lower = part.to_ascii_lowercase();
            // file: / file:/ / file:// / file:///tmp / file:///var/folders/...
            if let Some(idx) = lower.find("file:") {
                return format!("{}[PATH_REDACTED]", &part[..idx]);
            }
            if let Some(scheme_end) = part.find("://") {
                let after = &part[scheme_end + 3..];
                // scheme:///absolute or scheme://\absolute (no host userinfo case)
                if after.starts_with('/') || after.starts_with('\\') {
                    return format!("{}[PATH_REDACTED]", &part[..scheme_end + 3]);
                }
            }
            part.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_data_image(value: &str) -> bool {
    value.to_ascii_lowercase().starts_with("data:image/")
}

fn looks_like_base64(value: &str) -> bool {
    if value.len() < 96 || value.len() % 4 != 0 {
        return false;
    }
    value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

/// Windows root-relative path: `\Users\owen\secret` (single leading `\`, not UNC `\\`).
/// Requires a second `\` after a non-empty component so ordinary single-backslash
/// diagnostics like `\x1b[0m` are not treated as filesystem paths.
fn looks_like_windows_root_relative_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes[0] != b'\\' {
        return false;
    }
    // UNC (double leading backslash) is handled separately.
    if bytes.len() >= 2 && bytes[1] == b'\\' {
        return false;
    }
    // `\Component\...` — second separator after a non-empty first component.
    bytes[1..].iter().any(|&byte| byte == b'\\')
}

fn looks_like_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
        || looks_like_windows_root_relative_path(value)
        || (value.len() >= 3
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':'
            && matches!(value.as_bytes()[2], b'/' | b'\\'))
}

fn absolute_path_start(value: &str) -> Option<usize> {
    if looks_like_absolute_path(value) {
        return Some(0);
    }

    let bytes = value.as_bytes();
    for index in 1..bytes.len() {
        if bytes[index] == b'/' && bytes[index - 1] != b'/' && bytes[index - 1] != b'\\' {
            // Skip the first slash of a URL scheme separator "://..." so userinfo /
            // host redaction stays intact. Still treat glued forms like "error:/tmp/secret"
            // (single colon, not "://") as an absolute path start.
            if bytes[index - 1] == b':' {
                let is_scheme_slash = index + 1 < bytes.len() && bytes[index + 1] == b'/';
                if is_scheme_slash {
                    continue;
                }
            }
            return Some(index);
        }
        // Drive letter paths (C:\..., D:/...) only at a token boundary so the
        // trailing letter of a label is not consumed (error:/tmp → erro[...]).
        if index + 2 < bytes.len()
            && bytes[index].is_ascii_alphabetic()
            && bytes[index + 1] == b':'
            && matches!(bytes[index + 2], b'/' | b'\\')
            && !bytes[index - 1].is_ascii_alphanumeric()
        {
            return Some(index);
        }
        // Embedded Windows root-relative: `error:\Users\owen\secret` (not UNC `\\`).
        if bytes[index] == b'\\'
            && bytes[index - 1] != b'\\'
            && looks_like_windows_root_relative_path(&value[index..])
        {
            return Some(index);
        }
    }
    None
}

fn redact_url_userinfo(text: &str) -> String {
    text.split_whitespace()
        .map(|part| {
            let Some(scheme_end) = part.find("://") else {
                return part.to_string();
            };
            let authority_start = scheme_end + 3;
            let authority_end = part[authority_start..]
                .find(['/', '?', '#'])
                .map(|index| authority_start + index)
                .unwrap_or(part.len());
            let authority = &part[authority_start..authority_end];
            if !authority.contains('@') {
                return part.to_string();
            }
            let host = authority
                .rsplit_once('@')
                .map(|(_, host)| host)
                .unwrap_or(authority);
            format!(
                "{}{}@{}{}",
                &part[..authority_start],
                REDACTED,
                host,
                &part[authority_end..]
            )
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_sensitive_keys_and_secret_values_recursively() {
        let policy = RedactionPolicy::new(["sk-live-secret"]);
        let value = json!({
            "headers": {"Authorization": "Bearer sk-live-secret"},
            "nested": [{"profile_body": "private"}],
            "title": "safe"
        });
        let redacted = policy.redact_value(&value);
        assert_eq!(redacted["headers"]["Authorization"], REDACTED);
        assert_eq!(redacted["nested"][0]["profile_body"], REDACTED);
        assert_eq!(redacted["title"], "safe");
    }

    #[test]
    fn redacts_paths_urls_and_image_payloads() {
        let policy = RedactionPolicy::default();
        let text =
            "https://user:pass@example.test/a 错误：/Users/owen/app data:image/png;base64,AAAA";
        let redacted = policy.redact_text(text);
        assert!(!redacted.contains("user:pass"));
        assert!(!redacted.contains("/Users/owen"));
        assert!(redacted.contains("错误：[PATH_REDACTED]"));
        assert!(!redacted.contains("data:image"));
    }

    #[test]
    fn redacts_embedded_windows_paths() {
        let redacted = RedactionPolicy::default().redact_text("错误：C:\\Users\\owen\\app");
        assert_eq!(redacted, "错误：[PATH_REDACTED]");
    }

    #[test]
    fn keeps_unicode_and_non_sensitive_text() {
        let policy = RedactionPolicy::new(["secret"]);
        assert_eq!(policy.redact_text("字幕 日本語 中文"), "字幕 日本語 中文");
    }

    #[test]
    fn redacts_base64_labeled_keys_recursively() {
        let policy = RedactionPolicy::default();
        let value = json!({
            "wrapper": {
                "nested": [
                    {
                        "image_base64": "c2VjcmV0LWltYWdlLWJ5dGVzLXRoYXQtbXVzdC1ub3QtbGVhaw==",
                        "Base64Payload": "another-labeled-secret-blob"
                    }
                ]
            },
            "title": "safe-title"
        });
        let redacted = policy.redact_value(&value);
        assert_eq!(
            redacted["wrapper"]["nested"][0]["image_base64"], REDACTED,
            "keys containing base64 must be redacted by key name"
        );
        assert_eq!(
            redacted["wrapper"]["nested"][0]["Base64Payload"], REDACTED,
            "normalized Base64* keys must be redacted recursively"
        );
        assert_eq!(redacted["title"], "safe-title");
        let serialized = serde_json::to_string(&redacted).unwrap();
        assert!(!serialized.contains("c2VjcmV0"));
        assert!(!serialized.contains("another-labeled-secret-blob"));
    }

    #[test]
    fn redacts_cookie_and_set_cookie_header_values() {
        let policy = RedactionPolicy::default();
        let text = "Cookie: session=abc123def456; theme=dark Set-Cookie: id=xyz; HttpOnly";
        let redacted = policy.redact_text(text);
        assert!(!redacted.contains("session=abc123def456"), "{redacted}");
        assert!(!redacted.contains("id=xyz"), "{redacted}");
        assert!(redacted.contains(REDACTED), "{redacted}");
    }

    #[test]
    fn redacts_production_api_key_shapes() {
        let policy = RedactionPolicy::default();
        let samples = [
            "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
            "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
            "xai-abcdefghijklmnopqrstuvwxyz",
            "AIzaSyA-abcdefghijklmnopqrstuv",
            "ghp_abcdefghijklmnopqrstuvwxyz012345",
            "AKIAAAAAAAAAAAAAAAAA",
        ];
        for sample in samples {
            let redacted = policy.redact_text(&format!("provider rejected key {sample}"));
            assert!(
                !redacted.contains(sample),
                "production key shape must be redacted: {sample} -> {redacted}"
            );
            assert!(redacted.contains(REDACTED), "{redacted}");
        }
    }

    #[test]
    fn redacts_file_scheme_absolute_paths() {
        let policy = RedactionPolicy::default();
        for sample in [
            "file:///tmp/secret-key.pem",
            "file:///var/folders/xx/abcdef/T/canary",
            "error file:///private/tmp/okpgui/cache",
        ] {
            let redacted = policy.redact_text(sample);
            assert!(
                !redacted.contains("file://"),
                "raw file URL must not survive: {redacted}"
            );
            assert!(
                !redacted.contains("/tmp/") && !redacted.contains("/var/folders/"),
                "path residue must not survive: {redacted}"
            );
            assert!(redacted.contains("[PATH_REDACTED]"), "{redacted}");
        }
    }

    #[test]
    fn redacts_glued_absolute_paths_after_label() {
        let policy = RedactionPolicy::default();
        // Glued label:path forms must redact the entire absolute fragment.
        let redacted = policy.redact_text("error:/tmp/secret");
        assert_eq!(redacted, "error:[PATH_REDACTED]");
        assert!(!redacted.contains("/tmp/secret"), "{redacted}");

        let redacted_users = policy.redact_text("failed:/Users/owen/secret/key");
        assert!(
            redacted_users.starts_with("failed:[PATH_REDACTED]"),
            "{redacted_users}"
        );
        assert!(!redacted_users.contains("/Users/owen"), "{redacted_users}");

        // URL userinfo redaction must remain intact (not weakened by glued-path fix).
        let with_userinfo = policy.redact_text("https://user:pass@example.test/a");
        assert!(!with_userinfo.contains("user:pass"), "{with_userinfo}");
        assert!(with_userinfo.contains(REDACTED), "{with_userinfo}");
    }

    #[test]
    fn redacts_windows_root_relative_paths() {
        let policy = RedactionPolicy::default();
        // Single leading backslash root-relative path (not drive-letter, not UNC).
        let redacted = policy.redact_text(r"leak \Users\owen\secret");
        assert!(
            !redacted.contains(r"\Users\owen"),
            "root-relative Windows path must not survive: {redacted}"
        );
        assert!(
            redacted.contains("[PATH_REDACTED]"),
            "expected path placeholder: {redacted}"
        );

        // Fullwidth colon avoids the ASCII `letter:\` drive-letter heuristic so the
        // dedicated root-relative branch is exercised (same pattern as C:\ glued tests).
        let glued = policy.redact_text("错误：\\Users\\owen\\secret\\key");
        assert!(
            !glued.contains(r"\Users\owen"),
            "glued root-relative path must not survive: {glued}"
        );
        assert!(
            glued.contains("错误：[PATH_REDACTED]"),
            "expected label-preserving root-relative redaction: {glued}"
        );

        // Ordinary single-backslash diagnostics must not be treated as paths.
        let diag = policy.redact_text(r"provider diag: status \x1b[0m reset");
        assert!(
            diag.contains(r"\x1b"),
            "ANSI-style single backslash must survive: {diag}"
        );
        assert!(!diag.contains("[PATH_REDACTED]"), "{diag}");

        // Real UNC double-backslash paths still redact.
        let unc = policy.redact_text(r"open \\server\share\secret");
        assert!(
            !unc.contains("server") || unc.contains("[PATH_REDACTED]"),
            "UNC must redact: {unc}"
        );
        assert!(unc.contains("[PATH_REDACTED]"), "{unc}");
    }
}
