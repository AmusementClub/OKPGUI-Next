import type { FileTreeNodeData } from '../components/FileTree';

export interface TorrentInfo {
    name: string;
    total_size: number;
    file_tree: FileTreeNodeData;
    compat_notice?: string | null;
}
