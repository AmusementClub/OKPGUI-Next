use lava_torrent::torrent::v1::Torrent;
use serde::Serialize;

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
    let dir_node = if let Some(pos) = node.children.iter().position(|c| !c.is_file && c.name == *dir_name) {
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

#[tauri::command]
pub fn parse_torrent(path: String) -> Result<TorrentInfo, String> {
    let torrent = Torrent::read_from_file(&path).map_err(|e| format!("解析种子文件失败: {}", e))?;

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

            Ok(TorrentInfo {
                name,
                total_size,
                file_tree,
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
            })
        }
    }
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
}
