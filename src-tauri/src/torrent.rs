use lava_torrent::torrent::v1::Torrent;
use serde::Serialize;

const MAX_BENCODE_DEPTH: usize = 128;

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

fn insert_into_tree(node: &mut FileTreeNode, path_parts: &[String], size: u64) {
    if path_parts.is_empty() {
        return;
    }

    if path_parts.len() == 1 {
        // This is a file
        node.children.push(FileTreeNode {
            name: path_parts[0].clone(),
            size: Some(size),
            children: Vec::new(),
            is_file: true,
        });
        return;
    }

    // This is a directory component
    let dir_name = &path_parts[0];
    let remaining = &path_parts[1..];

    // Find or create the directory node
    let dir_node = if let Some(pos) = node
        .children
        .iter()
        .position(|c| !c.is_file && c.name == *dir_name)
    {
        &mut node.children[pos]
    } else {
        node.children.push(FileTreeNode {
            name: dir_name.clone(),
            size: None,
            children: Vec::new(),
            is_file: false,
        });
        node.children.last_mut().unwrap()
    };

    insert_into_tree(dir_node, remaining, size);
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
            let encoded_length = input.get(*cursor..)?.iter().position(|byte| *byte == b'e')?;
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
            let bytes = std::fs::read(path)
                .map_err(|read_error| format!("{}；读取文件失败: {}", original_error, read_error))?;

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
                    "该种子文件不符合 BEP 3 规范（顶层字典键未按字节排序），已自动修正后读取。建议重新生成规范的种子文件。"
                        .to_string(),
                ),
            ))
        }
    }
}

fn torrent_to_info(torrent: Torrent, compat_notice: Option<String>) -> TorrentInfo {
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
                let size = file.length as u64;
                total_size += size;
                file_entries.push((path_components, size));
            }

            let file_tree = build_file_tree(&name, &file_entries);

            TorrentInfo {
                name,
                total_size,
                file_tree,
                compat_notice,
            }
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

            TorrentInfo {
                name,
                total_size: size,
                file_tree,
                compat_notice,
            }
        }
    }
}

#[tauri::command]
pub fn parse_torrent(path: String) -> Result<TorrentInfo, String> {
    let (torrent, compat_notice) = read_torrent_compat(&path)?;
    Ok(torrent_to_info(torrent, compat_notice))
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
        let mut malformed =
            b"d4:infod6:lengthi1e4:name1:x12:piece lengthi1e6:pieces20:".to_vec();
        malformed.extend_from_slice(&[0xff; 20]);
        malformed.extend_from_slice(b"e4:hash1:xe");

        assert!(Torrent::read_from_bytes(&malformed).is_err());

        let normalized = sort_top_level_bencode_dictionary(&malformed).unwrap();
        let torrent = Torrent::read_from_bytes(normalized).unwrap();

        assert_eq!(torrent.name, "x");
        assert_eq!(torrent.length, 1);
    }
}
