import { useState, useCallback } from "react";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import { BatchConvertTreeNode } from "./BatchConvertTreeNode";

interface BatchConvertTreeProps {
  tree: ConvertibleTreeNode[];
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  skipExisting: boolean;
}

export function BatchConvertTree({
  tree,
  selected,
  onToggleFile,
  onToggleFolder,
  skipExisting,
}: BatchConvertTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const handleToggleCollapse = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  return (
    <div className="batch-convert__tree">
      {tree.map((node) => (
        <BatchConvertTreeNode
          key={node.path}
          node={node}
          depth={0}
          selected={selected}
          onToggleFile={onToggleFile}
          onToggleFolder={onToggleFolder}
          collapsed={collapsed}
          onToggleCollapse={handleToggleCollapse}
          skipExisting={skipExisting}
        />
      ))}
    </div>
  );
}
