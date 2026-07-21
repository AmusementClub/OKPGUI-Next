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

/// Fansub titles often embed a revision marker directly after the episode,
/// e.g. `[02v2]`. The digit run inside `v2` is not an episode number, but a
/// generic ep pattern like `\d{1,3}` still matches it, and the
/// closest-before-resolution heuristic then prefers it over the real
/// episode. Drop an ep capture only when it is a fansub revision suffix of the
/// form `…[digit]v[digits]…` / `…[digit]V[digits]…` (ASCII digit immediately
/// before the `v`/`V`). Standalone `v2` (space/punctuation before `v`) and
/// word-internal forms like `MV03` are kept. If every candidate is filtered
/// out, keep the original list so behavior for titles that only contain a
/// revision marker is unchanged.
fn filter_revision_marker_candidates(
    filename: &str,
    matches: Vec<NamedCaptureMatch>,
) -> Vec<NamedCaptureMatch> {
    // Drop only when: filename[start-1] is v/V AND start >= 2 AND
    // filename[start-2] is an ASCII digit (`02v2` → drop `2`; ` v2` / `MV03`
    // → keep). UTF-8 safe: continuation bytes are >= 0x80 and can never equal
    // `v`/`V` or be ASCII digits.
    let is_revision_marker = |episode_match: &&NamedCaptureMatch| {
        let start = episode_match.start;
        start >= 2
            && matches!(filename.as_bytes()[start - 1], b'v' | b'V')
            && filename.as_bytes()[start - 2].is_ascii_digit()
    };
    let kept: Vec<NamedCaptureMatch> = matches
        .iter()
        .filter(|episode_match| !is_revision_marker(episode_match))
        .cloned()
        .collect();

    if kept.is_empty() {
        matches
    } else {
        kept
    }
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
    let episode_matches = filter_revision_marker_candidates(filename, episode_matches);
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

    /// App default ep pattern: single episode or optional range, 1–3 digits per side.
    const DEFAULT_EP_PATTERN: &str = r"(?P<ep>\d{1,3}(?:[-~～]\d{1,3})?)";
    const DEFAULT_RESOLUTION_PATTERN: &str = r"(?P<res>1080p|720p)";

    #[test]
    fn test_parse_title_details_pairs_generic_episode_before_named_resolution() {
        let filename =
            "[Nekomoe kissaten][Azur Lane - Bisoku Zenshin! S2][01][1080p][JPSC].mp4.torrent";
        let title_pattern = "[<ep>][<res>]";

        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            title_pattern.to_string(),
        )
        .unwrap();

        assert_eq!(result.title, "[01][1080p]");
        assert_eq!(result.episode, "01");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_ignores_revision_marker_after_episode() {
        let filename = "[LoliHouse] Some Title [02v2][1080p].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "02");
        assert_eq!(result.resolution, "1080p");
        assert_eq!(result.title, "[02][1080p]");
    }

    #[test]
    fn test_parse_title_details_ignores_uppercase_revision_marker() {
        let filename = "[LoliHouse] Some Title [02V2][1080p].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "02");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_ignores_revision_marker_after_range() {
        let filename = "[LoliHouse] Some Title [01-12v2][1080p].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "01-12");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_parse_title_details_falls_back_when_only_revision_marker_matches() {
        // The only digit run is inside a revision marker: filtering would
        // leave no candidates, so the pre-fix behavior is preserved.
        let filename = "Some Movie v2.mkv";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "2");
    }

    #[test]
    fn test_parse_title_details_keeps_standalone_v_revision_before_resolution() {
        // Space before `v` is not a fansub revision suffix; keep `2` so
        // closest-before-res prefers it over the `108` fragment of `1080p`.
        let filename = "Some Movie v2 [1080p].mkv";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "2");
        assert_eq!(result.resolution, "1080p");
        assert_eq!(result.title, "[2][1080p]");
    }

    #[test]
    fn test_parse_title_details_keeps_episode_inside_word_before_v() {
        // `V` in `MV03` is part of a word, not a revision marker; keep `03`.
        let filename = "Title 2024 MV03 [1080p]";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "03");
        assert_eq!(result.resolution, "1080p");
    }

    #[test]
    fn test_match_title_pairs_generic_episode_before_named_resolution() {
        let filename =
            "[Nekomoe kissaten][Azur Lane - Bisoku Zenshin! S2][01][1080p][JPSC].mp4.torrent";
        let result = match_title(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result, "[01][1080p]");
    }

    #[test]
    fn test_parse_title_details_bracket_episode_range_pack() {
        let filename = "[Nekomoe kissaten][Kamiina Botan, Yoeru Sugata wa Yuri no Hana][01-12][1080p|[JPSC].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "01-12");
        assert_eq!(result.resolution, "1080p");
        assert_eq!(result.title, "[01-12][1080p]");
    }

    #[test]
    fn test_parse_title_details_dash_style_single_episode() {
        let filename = "[喵萌奶茶屋&LoliHouse] Kimi ga Shinu made Koi wo Shitai - 01 [WebRip 1080p HEVC-10bit AAC][简繁日内封字幕].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[喵萌奶茶屋&LoliHouse] Kimi ga Shinu made Koi wo Shitai - <ep> [WebRip <res> HEVC-10bit AAC][简繁日内封字幕]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "01");
        assert_eq!(result.resolution, "1080p");
        assert!(result.title.contains("- 01 [WebRip 1080p"));
    }

    #[test]
    fn test_parse_title_details_dash_style_episode_range() {
        let filename = "[喵萌奶茶屋&LoliHouse] Kimi ga Shinu made Koi wo Shitai - 01-12 [WebRip 1080p HEVC-10bit AAC][简繁日内封字幕].torrent";
        let result = parse_title_details(
            filename.to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[喵萌奶茶屋&LoliHouse] Kimi ga Shinu made Koi wo Shitai - <ep> [WebRip <res> HEVC-10bit AAC][简繁日内封字幕]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "01-12");
        assert_eq!(result.resolution, "1080p");
        assert!(result.title.contains("- 01-12 [WebRip 1080p"));
    }

    #[test]
    fn test_parse_title_details_multi_season_continuous_range() {
        let result = parse_title_details(
            "[Group] Title - 50-80 [WebRip 1080p HEVC-10bit AAC].torrent".to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "Title - <ep> [<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "50-80");
        assert_eq!(result.resolution, "1080p");
        assert_eq!(result.title, "Title - 50-80 [1080p]");
    }

    #[test]
    fn test_parse_title_details_tilde_episode_range() {
        let result = parse_title_details(
            "[Group][Title][01~12][1080p].torrent".to_string(),
            DEFAULT_EP_PATTERN.to_string(),
            DEFAULT_RESOLUTION_PATTERN.to_string(),
            "[<ep>][<res>]".to_string(),
        )
        .unwrap();

        assert_eq!(result.episode, "01~12");
        assert_eq!(result.resolution, "1080p");
        assert_eq!(result.title, "[01~12][1080p]");
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
