use lava_torrent::torrent::v1::Torrent;
use serde::Serialize;

const MAX_BENCODE_DEPTH: usize = 128;
/// Maximum number of path components (directories + file name) accepted for
/// a single file entry. Crafted torrents with absurdly deep paths are
/// rejected instead of being walked.
const MAX_PATH_DEPTH: usize = 64;

#[derive(Debug, Clone, Serialize)]
pub struct FileTreeNode {
    pub name: String,
    pub size: Option<u64>,
    pub children: Vec<FileTreeNode>,
    pub is_file: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TorrentInfo {
    pub name: String,
    pub total_size: u64,
    pub file_tree: FileTreeNode,
    /// Set when the torrent was only readable after the compatibility
    /// fallback (non-canonical top-level dictionary order). The frontend
    /// shows this as a warning: the file is readable but violates BEP 3.
    pub compat_notice: Option<String>,
}

fn build_file_tree(name: &str, files: &[(Vec<String>, u64)]) -> FileTreeNode {
    let mut root = FileTreeNode {
        name: name.to_string(),
        size: None,
        children: Vec::new(),
        is_file: false,
    };

    for (path_parts, size) in files {
        insert_into_tree(&mut root, path_parts, *size);
    }

    root
}

fn insert_into_tree(root: &mut FileTreeNode, path_parts: &[String], size: u64) {
    let Some((file_name, dir_parts)) = path_parts.split_last() else {
        return;
    };

    // Iterative walk: a deep path must not grow the call stack.
    let mut node = root;
    for dir_name in dir_parts {
        let index = match node
            .children
            .iter()
            .position(|c| !c.is_file && c.name == *dir_name)
        {
            Some(index) => index,
            None => {
                node.children.push(FileTreeNode {
                    name: dir_name.clone(),
                    size: None,
                    children: Vec::new(),
                    is_file: false,
                });
                node.children.len() - 1
            }
        };
        node = &mut node.children[index];
    }

    node.children.push(FileTreeNode {
        name: file_name.clone(),
        size: Some(size),
        children: Vec::new(),
        is_file: true,
    });
}

/// Reorders only the top-level bencode dictionary.
///
/// Each key/value entry is copied byte-for-byte, so the encoded `info`
/// dictionary and therefore the info hash stay unchanged. The result is still
/// parsed and validated by `lava_torrent`; this scanner only finds entry
/// boundaries for the compatibility fallback.
fn sort_top_level_bencode_dictionary(input: &[u8]) -> Option<Vec<u8>> {
    if input.first() != Some(&b'd') {
        return None;
    }

    let mut cursor = 1;
    let mut entries: Vec<(&[u8], &[u8])> = Vec::new();

    while input.get(cursor) != Some(&b'e') {
        let entry_start = cursor;
        let key = read_bencode_bytes(input, &mut cursor)?;
        skip_bencode_value(input, &mut cursor, 1)?;
        entries.push((key, &input[entry_start..cursor]));
    }

    cursor += 1;
    if cursor != input.len() || entries.windows(2).all(|pair| pair[0].0 <= pair[1].0) {
        return None;
    }

    entries.sort_by(|left, right| left.0.cmp(right.0));

    let mut normalized = Vec::with_capacity(input.len());
    normalized.push(b'd');
    for (_, raw_entry) in entries {
        normalized.extend_from_slice(raw_entry);
    }
    normalized.push(b'e');

    Some(normalized)
}

fn read_bencode_bytes<'a>(input: &'a [u8], cursor: &mut usize) -> Option<&'a [u8]> {
    let length_start = *cursor;
    while matches!(input.get(*cursor).copied(), Some(b'0'..=b'9')) {
        *cursor += 1;
    }

    if *cursor == length_start || input.get(*cursor) != Some(&b':') {
        return None;
    }

    let length = std::str::from_utf8(&input[length_start..*cursor])
        .ok()?
        .parse::<usize>()
        .ok()?;
    *cursor += 1;

    let value_end = (*cursor).checked_add(length)?;
    let value = input.get(*cursor..value_end)?;
    *cursor = value_end;
    Some(value)
}

fn skip_bencode_value(input: &[u8], cursor: &mut usize, depth: usize) -> Option<()> {
    if depth > MAX_BENCODE_DEPTH {
        return None;
    }

    match input.get(*cursor).copied() {
        Some(b'i') => {
            *cursor += 1;
            let encoded_length = input
                .get(*cursor..)?
                .iter()
                .position(|byte| *byte == b'e')?;
            *cursor += encoded_length + 1;
        }
        Some(b'l') => {
            *cursor += 1;
            while input.get(*cursor) != Some(&b'e') {
                skip_bencode_value(input, cursor, depth + 1)?;
            }
            *cursor += 1;
        }
        Some(b'd') => {
            *cursor += 1;
            while input.get(*cursor) != Some(&b'e') {
                read_bencode_bytes(input, cursor)?;
                skip_bencode_value(input, cursor, depth + 1)?;
            }
            *cursor += 1;
        }
        Some(b'0'..=b'9') => {
            read_bencode_bytes(input, cursor)?;
        }
        _ => return None,
    }

    Some(())
}

/// Parses a torrent, falling back to a byte-level normalization pass for
/// files whose top-level dictionary keys are out of order (e.g. written by
/// TorrentUtilsR as `info` before `hash`). The original file on disk is
/// never modified; only the in-memory copy is reordered, and the `info`
/// dictionary is copied verbatim so the v1 info hash is preserved.
///
/// Returns the torrent plus a user-facing notice when the fallback was used.
fn read_torrent_compat(path: &str) -> Result<(Torrent, Option<String>), String> {
    match Torrent::read_from_file(path) {
        Ok(torrent) => Ok((torrent, None)),
        Err(strict_error) => {
            let original_error = format!("解析种子文件失败: {}", strict_error);
            let bytes = std::fs::read(path).map_err(|read_error| {
                format!("{}；读取文件失败: {}", original_error, read_error)
            })?;

            let Some(normalized) = sort_top_level_bencode_dictionary(&bytes) else {
                return Err(original_error);
            };

            let torrent = Torrent::read_from_bytes(normalized).map_err(|compat_error| {
                format!(
                    "{}；修正顶层字典顺序后仍无法解析: {}",
                    original_error, compat_error
                )
            })?;

            Ok((
                torrent,
                Some(
                    "该种子文件不符合 BEP 3（顶层字典键未按字节排序）。界面已用内存修正后的副本读取；磁盘上的原文件未改动，发布时仍上传原文件。建议重新生成规范种子。"
                        .to_string(),
                ),
            ))
        }
    }
}

fn torrent_to_info(torrent: Torrent, compat_notice: Option<String>) -> Result<TorrentInfo, String> {
    let name = torrent.name.clone();

    match &torrent.files {
        Some(files) => {
            // Multi-file torrent
            let mut file_entries: Vec<(Vec<String>, u64)> = Vec::new();
            let mut total_size: u64 = 0;

            for file in files {
                let path_components: Vec<String> = file
                    .path
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().to_string())
                    .collect();
                if path_components.len() > MAX_PATH_DEPTH {
                    return Err("路径层级过深".to_string());
                }
                let size = file.length as u64;
                total_size += size;
                file_entries.push((path_components, size));
            }

            let file_tree = build_file_tree(&name, &file_entries);

            Ok(TorrentInfo {
                name,
                total_size,
                file_tree,
                compat_notice,
            })
        }
        None => {
            // Single-file torrent
            let size = torrent.length as u64;
            let file_tree = FileTreeNode {
                name: name.clone(),
                size: Some(size),
                children: Vec::new(),
                is_file: true,
            };

            Ok(TorrentInfo {
                name,
                total_size: size,
                file_tree,
                compat_notice,
            })
        }
    }
}

#[tauri::command]
pub fn parse_torrent(path: String) -> Result<TorrentInfo, String> {
    let (torrent, compat_notice) = read_torrent_compat(&path)?;
    torrent_to_info(torrent, compat_notice)
}

/// One allowlisted relative file entry for AI context (never absolute).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SafeRelativeFileMeta {
    pub relative_path: String,
    pub size: u64,
}

/// Path-free, allowlisted torrent metadata for plan-owned AI context projection.
/// Never includes trackers, announce lists, raw bencode, piece hashes, or absolute paths.
#[derive(Debug, Clone, Serialize)]
pub struct SafeTorrentProjection {
    pub name: String,
    pub total_size: u64,
    /// Nested tree of safe relative components only (`name`, `size`, `is_file`, `children`).
    pub tree: serde_json::Value,
    pub files: Vec<SafeRelativeFileMeta>,
}

/// Parse a bound torrent path into allowlisted relative metadata for AI context.
///
/// Failure messages are path-free (safe for public IPC). Absolute paths, trackers,
/// raw bencode, and piece material never appear in the result.
pub fn project_safe_torrent_context(path: &str) -> Result<SafeTorrentProjection, String> {
    validate_torrent_path_for_context(path)?;
    let (torrent, _compat_notice) = read_torrent_compat_path_free(path)?;
    let info = torrent_to_info(torrent, None)
        .map_err(|_| "无法解析种子文件内容，请重新执行发布前检查。".to_string())?;
    safe_projection_from_torrent_info(&info)
}

fn validate_torrent_path_for_context(path: &str) -> Result<(), String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("未选择种子文件，请先选择 .torrent 文件。".to_string());
    }
    let torrent = std::path::PathBuf::from(path);
    if !torrent.exists() {
        return Err("种子文件不存在，请重新执行发布前检查。".to_string());
    }
    let metadata = std::fs::metadata(&torrent)
        .map_err(|_| "无法读取种子文件，请重新执行发布前检查。".to_string())?;
    if !metadata.is_file() {
        return Err("种子路径不是文件，请重新执行发布前检查。".to_string());
    }
    let is_torrent = torrent
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("torrent"))
        .unwrap_or(false);
    if !is_torrent {
        return Err("所选文件不是 .torrent 文件，请重新执行发布前检查。".to_string());
    }
    Ok(())
}

/// Same as `read_torrent_compat` but maps all failures to path-free messages.
fn read_torrent_compat_path_free(path: &str) -> Result<(Torrent, Option<String>), String> {
    match Torrent::read_from_file(path) {
        Ok(torrent) => Ok((torrent, None)),
        Err(_strict_error) => {
            let bytes = std::fs::read(path)
                .map_err(|_| "无法读取种子文件，请重新执行发布前检查。".to_string())?;
            let Some(normalized) = sort_top_level_bencode_dictionary(&bytes) else {
                return Err("无法解析种子文件内容，请重新执行发布前检查。".to_string());
            };
            let torrent = Torrent::read_from_bytes(normalized)
                .map_err(|_| "无法解析种子文件内容，请重新执行发布前检查。".to_string())?;
            Ok((
                torrent,
                Some(
                    "该种子文件不符合 BEP 3（顶层字典键未按字节排序）。界面已用内存修正后的副本读取；磁盘上的原文件未改动，发布时仍上传原文件。建议重新生成规范种子。"
                        .to_string(),
                ),
            ))
        }
    }
}

fn safe_projection_from_torrent_info(info: &TorrentInfo) -> Result<SafeTorrentProjection, String> {
    if !is_safe_path_component(&info.name) {
        return Err("种子名称包含不安全路径成分，请重新执行发布前检查。".to_string());
    }

    let mut files = Vec::new();
    collect_safe_relative_files(&info.file_tree, &mut files)?;
    let tree = file_tree_to_allowlisted_json(&info.file_tree)?;

    Ok(SafeTorrentProjection {
        name: info.name.clone(),
        total_size: info.total_size,
        tree,
        files,
    })
}

/// Collect file entries as relative paths under the torrent root.
/// Single-file torrents use the torrent name as the sole relative path.
/// Multi-file torrents exclude the root directory name from relative paths.
fn collect_safe_relative_files(
    root: &FileTreeNode,
    out: &mut Vec<SafeRelativeFileMeta>,
) -> Result<(), String> {
    if !is_safe_path_component(&root.name) {
        return Err("种子文件树包含不安全相对路径，请重新执行发布前检查。".to_string());
    }
    if root.is_file {
        if !is_safe_relative_torrent_path(&root.name) {
            return Err("种子文件树包含不安全相对路径，请重新执行发布前检查。".to_string());
        }
        out.push(SafeRelativeFileMeta {
            relative_path: root.name.clone(),
            size: root.size.unwrap_or(0),
        });
        return Ok(());
    }
    for child in &root.children {
        collect_safe_relative_files_under(child, "", out)?;
    }
    Ok(())
}

fn collect_safe_relative_files_under(
    node: &FileTreeNode,
    parent_rel: &str,
    out: &mut Vec<SafeRelativeFileMeta>,
) -> Result<(), String> {
    if !is_safe_path_component(&node.name) {
        return Err("种子文件树包含不安全相对路径，请重新执行发布前检查。".to_string());
    }
    let relative_path = if parent_rel.is_empty() {
        node.name.clone()
    } else {
        format!("{parent_rel}/{}", node.name)
    };
    if !is_safe_relative_torrent_path(&relative_path) {
        return Err("种子文件树包含不安全相对路径，请重新执行发布前检查。".to_string());
    }
    if node.is_file {
        out.push(SafeRelativeFileMeta {
            relative_path,
            size: node.size.unwrap_or(0),
        });
        return Ok(());
    }
    for child in &node.children {
        collect_safe_relative_files_under(child, &relative_path, out)?;
    }
    Ok(())
}

fn file_tree_to_allowlisted_json(node: &FileTreeNode) -> Result<serde_json::Value, String> {
    if !is_safe_path_component(&node.name) {
        return Err("种子文件树包含不安全相对路径，请重新执行发布前检查。".to_string());
    }
    let mut children = Vec::with_capacity(node.children.len());
    for child in &node.children {
        children.push(file_tree_to_allowlisted_json(child)?);
    }
    Ok(serde_json::json!({
        "name": node.name,
        "size": node.size,
        "is_file": node.is_file,
        "children": children,
    }))
}

fn is_safe_path_component(name: &str) -> bool {
    if name.is_empty() || name.trim().is_empty() {
        return false;
    }
    if name != name.trim() {
        return false;
    }
    if name == "." || name == ".." {
        return false;
    }
    if name.contains('/') || name.contains('\\') || name.contains(':') {
        return false;
    }
    if name.chars().any(|character| character.is_control()) {
        return false;
    }
    name.chars().count() <= 256
}

fn is_safe_relative_torrent_path(path: &str) -> bool {
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
        if !is_safe_path_component(component) {
            return false;
        }
    }
    path.chars().count() <= 1024
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_file_tree() {
        let files = vec![
            (vec!["dir1".to_string(), "file1.mkv".to_string()], 100),
            (vec!["dir1".to_string(), "file2.mkv".to_string()], 200),
            (vec!["file3.txt".to_string()], 50),
        ];

        let tree = build_file_tree("test_torrent", &files);
        assert_eq!(tree.name, "test_torrent");
        assert!(!tree.is_file);
        assert_eq!(tree.children.len(), 2); // dir1 + file3.txt
    }

    #[test]
    fn sorts_only_the_top_level_dictionary() {
        let malformed = b"d4:infod1:ai1ee4:hash1:xe";
        let normalized = sort_top_level_bencode_dictionary(malformed).unwrap();

        assert_eq!(normalized, b"d4:hash1:x4:infod1:ai1eee");
    }

    #[test]
    fn leaves_nested_dictionaries_byte_for_byte_untouched() {
        // The nested `info` dictionary has its own keys in reverse order; only
        // the top level may be reordered, so the nested bytes must survive
        // verbatim (otherwise the v1 info hash would change).
        let malformed = b"d4:infod4:name1:x6:lengthi1ee4:hash1:ye";
        let normalized = sort_top_level_bencode_dictionary(malformed).unwrap();

        assert_eq!(normalized, b"d4:hash1:y4:infod4:name1:x6:lengthi1eee");
    }

    #[test]
    fn leaves_a_sorted_top_level_dictionary_unchanged() {
        let canonical = b"d1:ai1e1:bl1:xee";
        assert!(sort_top_level_bencode_dictionary(canonical).is_none());
    }

    #[test]
    fn rejects_trailing_data_during_compatibility_check() {
        let input = b"d1:ai1eejunk";
        assert!(sort_top_level_bencode_dictionary(input).is_none());
    }

    #[test]
    fn normalized_torrent_is_accepted_by_lava_torrent() {
        let mut malformed = b"d4:infod6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:".to_vec();
        malformed.extend_from_slice(&[0xff; 20]);
        malformed.extend_from_slice(b"e4:hash1:xe");

        assert!(Torrent::read_from_bytes(&malformed).is_err());

        let normalized = sort_top_level_bencode_dictionary(&malformed).unwrap();
        let torrent = Torrent::read_from_bytes(normalized).unwrap();

        assert_eq!(torrent.name, "x");
        assert_eq!(torrent.length, 1);
    }

    /// Writes a multi-file torrent whose single file has `components` path
    /// components ("a/a/.../a") to a temp file and returns its path.
    fn write_deep_path_torrent(components: usize) -> std::path::PathBuf {
        let mut bytes = b"d4:infod5:filesld6:lengthi1e4:pathl".to_vec();
        for _ in 0..components {
            bytes.extend_from_slice(b"1:a");
        }
        bytes.extend_from_slice(b"eee4:name1:x12:piece lengthi1e6:pieces20:");
        // 0xff keeps `pieces` a byte string: lava_torrent decodes valid-UTF-8
        // byte strings as string elements and would reject them here.
        bytes.extend_from_slice(&[0xff; 20]);
        bytes.extend_from_slice(b"ee");

        let path = std::env::temp_dir().join(format!(
            "okpgui-deep-path-{}-{}.torrent",
            std::process::id(),
            components
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn rejects_a_path_deeper_than_the_depth_cap() {
        let path = write_deep_path_torrent(10_000);
        let result = parse_torrent(path.to_string_lossy().to_string());
        let _ = std::fs::remove_file(&path);

        let err = result.expect_err("a 10k-component path must be rejected");
        assert!(
            err.contains("路径层级过深"),
            "unexpected error message: {}",
            err
        );
    }

    #[test]
    fn accepts_a_path_at_the_depth_cap() {
        let path = write_deep_path_torrent(MAX_PATH_DEPTH);
        let result = parse_torrent(path.to_string_lossy().to_string());
        let _ = std::fs::remove_file(&path);

        let info = result.expect("a depth-64 path must parse successfully");

        // Walk the tree: 63 nested "a" directories, then the "a" file.
        let mut node = &info.file_tree;
        let mut depth = 0usize;
        while !node.is_file {
            assert_eq!(node.children.len(), 1);
            node = &node.children[0];
            depth += 1;
        }
        assert_eq!(depth, MAX_PATH_DEPTH);
        assert_eq!(node.size, Some(1));
    }

    fn write_minimal_single_file_torrent(name: &str) -> std::path::PathBuf {
        let mut bytes = format!(
            "d4:infod6:lengthi1e4:name{}:{}12:piece lengthi1e6:pieces20:",
            name.len(),
            name
        )
        .into_bytes();
        bytes.extend_from_slice(&[0xff; 20]);
        bytes.extend_from_slice(b"ee");
        let path = std::env::temp_dir().join(format!(
            "okpgui-safe-ctx-{}-{}.torrent",
            std::process::id(),
            name
        ));
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn project_safe_torrent_context_is_relative_only_and_path_free_on_errors() {
        let path = write_minimal_single_file_torrent("video.mkv");
        let abs = path.to_string_lossy().to_string();
        let projection = project_safe_torrent_context(&abs).expect("safe projection");
        assert_eq!(projection.name, "video.mkv");
        assert_eq!(projection.files.len(), 1);
        assert_eq!(projection.files[0].relative_path, "video.mkv");
        assert!(!projection.files[0].relative_path.starts_with('/'));
        let serialized = serde_json::to_string(&projection).unwrap();
        assert!(
            !serialized.contains(&abs),
            "absolute path must not appear in projection: {serialized}"
        );
        let _ = std::fs::remove_file(&path);

        let missing = project_safe_torrent_context("/tmp/definitely-missing-okpgui.torrent");
        let err = missing.expect_err("missing torrent");
        assert!(!err.contains("/tmp/"), "error must be path-free: {err}");
    }

    #[test]
    fn project_safe_torrent_context_rejects_unsafe_relative_components() {
        // Manually craft a tree via torrent_to_info path: multi-file with ".." component.
        let mut bytes = b"d4:infod5:filesld6:lengthi1e4:pathl2:..4:evileee4:name4:root12:piece lengthi1e6:pieces20:".to_vec();
        bytes.extend_from_slice(&[0xff; 20]);
        bytes.extend_from_slice(b"ee");
        let path =
            std::env::temp_dir().join(format!("okpgui-unsafe-rel-{}-.torrent", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let result = project_safe_torrent_context(&path.to_string_lossy());
        let _ = std::fs::remove_file(&path);
        let err = result.expect_err(".. path must fail closed");
        assert!(
            err.contains("不安全") || err.contains("无法解析"),
            "unexpected: {err}"
        );
        assert!(
            !err.contains(".."),
            "should not echo raw path in public error"
        );
    }
}
