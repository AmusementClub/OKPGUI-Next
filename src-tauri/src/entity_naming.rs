use serde::Deserialize;
use std::collections::HashMap;

pub const ENTITY_NAME_MAX_CHARS: usize = 128;
pub const ENTITY_ID_MAX_CHARS: usize = 128;
pub const IMPORT_CONFLICT_PREFIX: &str = "IMPORT_CONFLICT:";

const COPY_NAME_SUFFIX: &str = " 副本";
const COPY_ID_SUFFIX: &str = "-copy";

#[derive(Debug, Clone, Copy, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImportConflictStrategy {
    #[default]
    Reject,
    Overwrite,
    Copy,
}

pub fn normalize_required_value(value: &str, label: &str, max_chars: usize) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return Err(format!("{}不能为空。", label));
    }

    if normalized.chars().any(|character| character.is_control()) {
        return Err(format!("{}不能包含控制字符。", label));
    }

    if normalized.chars().count() > max_chars {
        return Err(format!("{}不能超过 {} 个字符。", label, max_chars));
    }

    Ok(normalized.to_string())
}

pub fn normalize_optional_name(
    value: &str,
    fallback: &str,
    label: &str,
    max_chars: usize,
) -> Result<String, String> {
    let normalized = value.trim();
    if normalized.is_empty() {
        return normalize_required_value(fallback, label, max_chars);
    }

    normalize_required_value(normalized, label, max_chars)
}

pub fn import_conflict_error(target: &str) -> String {
    format!("{}{}", IMPORT_CONFLICT_PREFIX, target)
}

pub fn build_copy_name(base: &str, max_chars: usize) -> String {
    build_copy_candidate(base, COPY_NAME_SUFFIX, max_chars)
}

pub fn next_available_copy_name<T>(
    base: &str,
    existing: &HashMap<String, T>,
    max_chars: usize,
) -> String {
    for index in 1.. {
        let suffix = if index == 1 {
            COPY_NAME_SUFFIX.to_string()
        } else {
            format!("{} {}", COPY_NAME_SUFFIX, index)
        };
        let candidate = build_copy_candidate(base, &suffix, max_chars);
        if !existing.contains_key(candidate.as_str()) {
            return candidate;
        }
    }

    unreachable!("copy name generation should always find an available candidate")
}

pub fn next_available_copy_id<T>(
    base: &str,
    existing: &HashMap<String, T>,
    max_chars: usize,
) -> String {
    for index in 1.. {
        let suffix = if index == 1 {
            COPY_ID_SUFFIX.to_string()
        } else {
            format!("{}-{}", COPY_ID_SUFFIX, index)
        };
        let candidate = build_copy_candidate(base, &suffix, max_chars);
        if !existing.contains_key(candidate.as_str()) {
            return candidate;
        }
    }

    unreachable!("copy id generation should always find an available candidate")
}

fn build_copy_candidate(base: &str, suffix: &str, max_chars: usize) -> String {
    let suffix_length = suffix.chars().count();
    if suffix_length >= max_chars {
        return suffix.chars().take(max_chars).collect();
    }

    let available_base_length = max_chars - suffix_length;
    let truncated_base = truncate_chars(base.trim(), available_base_length);
    let normalized_base = if truncated_base.trim().is_empty() {
        "item".to_string()
    } else {
        truncated_base.trim_end().to_string()
    };

    format!("{}{}", normalized_base, suffix)
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_required_value_rejects_control_chars() {
        let error = normalize_required_value("bad\nname", "模板名称", ENTITY_NAME_MAX_CHARS)
            .expect_err("expected control characters to be rejected");

        assert!(error.contains("控制字符"));
    }

    #[test]
    fn test_normalize_required_value_rejects_overlong_values() {
        let error = normalize_required_value(
            &"a".repeat(ENTITY_NAME_MAX_CHARS + 1),
            "模板名称",
            ENTITY_NAME_MAX_CHARS,
        )
        .expect_err("expected overlong values to be rejected");

        assert!(error.contains(&ENTITY_NAME_MAX_CHARS.to_string()));
    }

    #[test]
    fn test_next_available_copy_name_adds_incrementing_suffixes() {
        let existing = HashMap::from([
            ("季度模板".to_string(), 1_u8),
            ("季度模板 副本".to_string(), 2_u8),
        ]);

        let candidate = next_available_copy_name("季度模板", &existing, ENTITY_NAME_MAX_CHARS);

        assert_eq!(candidate, "季度模板 副本 2");
    }

    #[test]
    fn test_next_available_copy_id_adds_incrementing_suffixes() {
        let existing = HashMap::from([
            ("season-template".to_string(), 1_u8),
            ("season-template-copy".to_string(), 2_u8),
        ]);

        let candidate = next_available_copy_id("season-template", &existing, ENTITY_ID_MAX_CHARS);

        assert_eq!(candidate, "season-template-copy-2");
    }
}