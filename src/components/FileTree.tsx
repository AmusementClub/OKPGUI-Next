import { Folder, File, ChevronRight, ChevronDown } from 'lucide-react';
import { useState } from 'react';

export interface FileTreeNodeData {
    name: string;
    size: number | null;
    children: FileTreeNodeData[];
    is_file: boolean;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

interface FileTreeNodeProps {
    node: FileTreeNodeData;
    depth: number;
}

function FileTreeNode({ node, depth }: FileTreeNodeProps) {
    const [expanded, setExpanded] = useState(depth < 2);

    if (node.is_file) {
        return (
            <div
                className="flex items-center gap-2 py-0.5 text-sm text-slate-300 hover:bg-slate-700/30 rounded px-1"
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
            >
                <File size={14} className="text-slate-500 shrink-0" />
                <span className="truncate">{node.name}</span>
                {node.size !== null && (
                    <span className="text-xs text-slate-500 ml-auto shrink-0">
                        {formatSize(node.size)}
                    </span>
                )}
            </div>
        );
    }

    return (
        <div>
            <button
                onClick={() => setExpanded(!expanded)}
                className="w-full flex items-center gap-2 py-0.5 text-sm text-slate-300 hover:bg-slate-700/30 rounded px-1"
                style={{ paddingLeft: `${depth * 16 + 8}px` }}
            >
                {expanded ? (
                    <ChevronDown size={14} className="text-slate-500 shrink-0" />
                ) : (
                    <ChevronRight size={14} className="text-slate-500 shrink-0" />
                )}
                <Folder size={14} className="text-yellow-500 shrink-0" />
                <span className="truncate">{node.name}</span>
                <span className="text-xs text-slate-500 ml-auto shrink-0">
                    {node.children.length} 项
                </span>
            </button>
            {expanded && (
                <div>
                    {node.children.map((child, i) => (
                        <FileTreeNode key={`${child.name}-${i}`} node={child} depth={depth + 1} />
                    ))}
                </div>
            )}
        </div>
    );
}

interface FileTreeProps {
    root: FileTreeNodeData | null;
    totalSize?: number;
}

export default function FileTree({ root, totalSize }: FileTreeProps) {
    if (!root) {
        return (
            <div className="text-sm text-slate-500 py-4 text-center">
                暂无文件信息
            </div>
        );
    }

    return (
        <div className="bg-slate-800/50 rounded-lg border border-slate-700 p-2 max-h-48 overflow-y-auto">
            {totalSize !== undefined && (
                <div className="text-xs text-slate-500 mb-1 px-2">
                    总大小: {formatSize(totalSize)}
                </div>
            )}
            <FileTreeNode node={root} depth={0} />
        </div>
    );
}
