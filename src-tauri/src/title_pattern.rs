use std::collections::HashMap;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone)]
struct NamedCaptureMatch {
    value: String,
    start: usize,
    end: usize,
    captures: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ParsedTitleDetails {
    pub title: String,
    pub episode: String,
    pub resolution: String,
}

fn extract_named_value(filename: &str, pattern: &str, group_name: &str) -> Result<String, String> {
    if pattern.trim().is_empty() {
        return Ok(String::new());
    }

    let re = Regex::new(pattern).map_err(|e| format!("正则表达式错误: {}", e))?;
    let caps = re
        .captures(filename)
        .ok_or_else(|| "未匹配到内容".to_string())?;

    Ok(caps
        .name(group_name)
        .map(|matched| matched.as_str().to_string())
        .unwrap_or_default())
}

fn captures_to_map(re: &Regex, caps: &regex::Captures<'_>) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for name in re.capture_names().flatten() {
        values.insert(
            name.to_string(),
            caps.name(name)
                .map(|matched| matched.as_str().to_string())
                .unwrap_or_default(),
        );
    }

    values
}

fn extract_named_captures(
    filename: &str,
    pattern: &str,
) -> Result<HashMap<String, String>, String> {
    if pattern.trim().is_empty() {
        return Ok(HashMap::new());
    }

    let re = Regex::new(pattern).map_err(|e| format!("正则表达式错误: {}", e))?;
    let Some(caps) = re.captures(filename) else {
        return Ok(HashMap::new());
    };

    Ok(captures_to_map(&re, &caps))
}

fn collect_named_capture_matches(
    filename: &str,
    pattern: &str,
    group_name: &str,
) -> Result<Vec<NamedCaptureMatch>, String> {
    if pattern.trim().is_empty() {
        return Ok(Vec::new());
    }

    let re = Regex::new(pattern).map_err(|e| format!("正则表达式错误: {}", e))?;
    Ok(re
        .captures_iter(filename)
        .filter_map(|caps| {
            let matched = caps.name(group_name)?;
            Some(NamedCaptureMatch {
                value: matched.as_str().to_string(),
                start: matched.start(),
                end: matched.end(),
                captures: captures_to_map(&re, &caps),
            })
        })
        .collect())
}

fn choose_episode_match<'a>(
    episode_matches: &'a [NamedCaptureMatch],
    resolution_match: Option<&NamedCaptureMatch>,
) -> Option<&'a NamedCaptureMatch> {
    if episode_matches.len() <= 1 {
        return episode_matches.first();
    }

    let Some(resolution_match) = resolution_match else {
        return episode_matches.first();
    };

    episode_matches
        .iter()
        .filter(|episode_match| episode_match.end <= resolution_match.start)
        .min_by_key(|episode_match| resolution_match.start.saturating_sub(episode_match.end))
        .or_else(|| episode_matches.first())
}

fn build_title(
    title_pattern: &str,
    replacements: &HashMap<String, String>,
    requires_episode: bool,
    requires_resolution: bool,
) -> String {
    if title_pattern.trim().is_empty() {
        return String::new();
    }

    let episode = replacements.get("ep").map(String::as_str).unwrap_or("");
    let resolution = replacements.get("res").map(String::as_str).unwrap_or("");

    if replacements.is_empty()
        || (requires_episode && episode.is_empty())
        || (requires_resolution && resolution.is_empty())
    {
        return String::new();
    }

    let mut title = title_pattern.to_string();
    for (name, value) in replacements {
        title = title.replace(&format!("<{}>", name), value);
    }

    title
}

fn parse_title_details_internal(
    filename: &str,
    ep_pattern: &str,
    resolution_pattern: &str,
    title_pattern: &str,
) -> Result<ParsedTitleDetails, String> {
    let requires_episode = title_pattern.contains("<ep>");
    let requires_resolution = title_pattern.contains("<res>");
    let ep_captures = extract_named_captures(filename, ep_pattern)?;
    let resolution_captures = extract_named_captures(filename, resolution_pattern)?;
    let episode_matches = collect_named_capture_matches(filename, ep_pattern, "ep")?;
    let resolution_matches = collect_named_capture_matches(filename, resolution_pattern, "res")?;

    let selected_resolution_match = resolution_matches.first();
    let selected_episode_match = choose_episode_match(&episode_matches, selected_resolution_match);

    let episode = selected_episode_match
        .map(|matched| matched.value.clone())
        .or_else(|| ep_captures.get("ep").cloned())
        .unwrap_or_default();
    let resolution = selected_resolution_match
        .map(|matched| matched.value.clone())
        .or_else(|| resolution_captures.get("res").cloned())
        .or_else(|| ep_captures.get("res").cloned())
        .unwrap_or_default();

    let mut replacements = ep_captures;
    replacements.extend(resolution_captures);
    if let Some(matched) = selected_episode_match {
        replacements.extend(matched.captures.clone());
    }
    if let Some(matched) = selected_resolution_match {
        replacements.extend(matched.captures.clone());
    }
    if !episode.is_empty() {
        replacements.insert("ep".to_string(), episode.clone());
    }
    if !resolution.is_empty() {
        replacements.insert("res".to_string(), resolution.clone());
    }

    let title = build_title(
        title_pattern,
        &replacements,
        requires_episode,
        requires_resolution,
    );

    Ok(ParsedTitleDetails {
        title,
        episode,
        resolution,
    })
}

#[tauri::command]
pub fn parse_title_details(
    filename: String,
    ep_pattern: String,
    resolution_pattern: String,
    title_pattern: String,
) -> Result<ParsedTitleDetails, String> {
    parse_title_details_internal(&filename, &ep_pattern, &resolution_pattern, &title_pattern)
}

#[tauri::command]
pub fn match_title(
    filename: String,
    ep_pattern: String,
    resolution_pattern: String,
    title_pattern: String,
) -> Result<String, String> {
    Ok(
        parse_title_details_internal(&filename, &ep_pattern, &resolution_pattern, &title_pattern)?
            .title,
    )
}

#[tauri::command]
pub fn extract_episode_value(filename: String, ep_pattern: String) -> Result<String, String> {
    extract_named_value(&filename, &ep_pattern, "ep")
}

#[tauri::command]
pub fn extract_resolution_value(
    filename: String,
    resolution_pattern: String,
) -> Result<String, String> {
    extract_named_value(&filename, &resolution_pattern, "res")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_match_title_basic() {
        let filename = "[Group] Title - 01 [1080p].mkv";
        let ep_pattern =
            r"\[(?P<group>.+?)\]\s*(?P<title>.+?)\s*-\s*(?P<ep>\d+)\s*\[(?P<res>\d+p)\]";
        let resolution_pattern = r"\[(?P<res>\d+p)\]";
        let title_pattern = "[<group>] <title> - <ep> [<res>]";

        let result = match_title(
            filename.to_string(),
            ep_pattern.to_string(),
            resolution_pattern.to_string(),
            title_pattern.to_string(),
        );

        assert!(result.is_ok());
        let title = result.unwrap();
        assert_eq!(title, "[Group] Title - 01 [1080p]");
    }

    #[test]
    fn test_match_title_no_match() {
        let result = match_title(
            "no_match_file.mkv".to_string(),
            r"(?P<ep>\d{2})".to_string(),
            r"(?P<res>\d{3,4}p)".to_string(),
            "Episode <ep>".to_string(),
        );

        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn test_match_title_empty_pattern() {
        let result = match_title(
            "file.mkv".to_string(),
            String::new(),
            String::new(),
            "title".to_string(),
        );
        assert_eq!(result.unwrap(), "");
    }

    #[test]
    fn test_extract_episode_value() {
        let result = extract_episode_value(
            "[Group] Title - 12 [1080p].mkv".to_string(),
            r"\[(?P<group>.+?)\]\s*(?P<title>.+?)\s*-\s*(?P<ep>\d+)\s*\[(?P<res>\d+p)\]"
                .to_string(),
        );

        assert_eq!(result.unwrap(), "12");
    }

    #[test]
    fn test_extract_resolution_value() {
        let result = extract_resolution_value(
            "[Group] Title - 12 [1080p].mkv".to_string(),
            r"\[(?P<res>\d+p)\]".to_string(),
        );

        assert_eq!(result.unwrap(), "1080p");
    }

    #[test]
    fn test_parse_title_details_with_resolution_only() {
        let result = parse_title_details(
            "[Group] Title - 12 [1080p].mkv".to_string(),
            String::new(),
            r"\[(?P<res>\d+p)\]".to_string(),
            "Title [<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "Title [1080p]");
        assert_eq!(result.episode, "");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_keeps_episode_when_resolution_pattern_does_not_match() {
        let result = parse_title_details(
            "[Group] Title - 12 [1080p].mkv".to_string(),
            r"\[(?P<group>.+?)\]\s*(?P<title>.+?)\s*-\s*(?P<ep>\d+)\s*\[(?P<res>\d+p)\]"
                .to_string(),
            r"\((?P<res>\d+p)\)".to_string(),
            "Episode <ep>".to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "Episode 12");
        assert_eq!(result.episode, "12");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_keeps_resolution_when_episode_pattern_does_not_match() {
        let result = parse_title_details(
            "Movie [1080p].mkv".to_string(),
            r"Episode\s+(?P<ep>\d+)".to_string(),
            r"\[(?P<res>\d+p)\]".to_string(),
            "Release [<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "Release [1080p]");
        assert_eq!(result.episode, "");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_pairs_generic_episode_before_named_resolution() {
        let filename =
            "[Nekomoe kissaten][Azur Lane - Bisoku Zenshin! S2][01][1080p][JPSC].mp4.torrent";
        let ep_pattern = r"(?P<ep>\d+)";
        let resolution_pattern = r"(?P<res>1080p|720p)";
        let title_pattern = "[<ep>][<res>]";

        let result = parse_title_details(
            filename.to_string(),
            ep_pattern.to_string(),
            resolution_pattern.to_string(),
            title_pattern.to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "[01][1080p]");
        assert_eq!(result.episode, "01");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_match_title_pairs_generic_episode_before_named_resolution() {
        let filename =
            "[Nekomoe kissaten][Azur Lane - Bisoku Zenshin! S2][01][1080p][JPSC].mp4.torrent";
        let result = match_title(
            filename.to_string(),
            r"(?P<ep>\d+)".to_string(),
            r"(?P<res>1080p|720p)".to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result, "[01][1080p]");
    }

    #[test]
    fn test_parse_title_details_keeps_single_episode_candidate_compatibility() {
        let result = parse_title_details(
            "Movie [1080p] Episode 01.mkv".to_string(),
            r"Episode (?P<ep>\d+)".to_string(),
            r"(?P<res>1080p|720p)".to_string(),
            "Episode <ep> [<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "Episode 01 [1080p]");
        assert_eq!(result.episode, "01");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_still_errors_on_invalid_regex() {
        let result = parse_title_details(
            "Movie [1080p].mkv".to_string(),
            r"(?P<ep>\d+".to_string(),
            r"\[(?P<res>\d+p)\]".to_string(),
            "Release [<res>]".to_string(),
        );

        assert!(result.is_err());
    }
}
