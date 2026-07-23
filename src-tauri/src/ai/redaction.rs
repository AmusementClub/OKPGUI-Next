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

        redacted = redact_url_userinfo(&redacted);
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

fn looks_like_absolute_path(value: &str) -> bool {
    value.starts_with('/')
        || value.starts_with("\\\\")
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
        if bytes[index] == b'/'
            && bytes[index - 1] != b':'
            && bytes[index - 1] != b'/'
            && bytes[index - 1] != b'\\'
        {
            return Some(index);
        }
        if index + 2 < bytes.len()
            && bytes[index].is_ascii_alphabetic()
            && bytes[index + 1] == b':'
            && matches!(bytes[index + 2], b'/' | b'\\')
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
}
