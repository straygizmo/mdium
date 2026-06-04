import { useCallback, useEffect, useRef } from "react";
import type { ConvertibleTreeNode } from "../lib/collectConvertibleFiles";
import { collectDescendantPaths } from "../lib/collectConvertibleFiles";
import { getFileIcon } from "@/features/file-tree/components/FileTree";

type CheckState = "checked" | "unchecked" | "indeterminate";

interface BatchConvertTreeNodeProps {
  node: ConvertibleTreeNode;
  depth: number;
  selected: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleFolder: (paths: string[], select: boolean) => void;
  collapsed: Set<string>;
  onToggleCollapse: (path: string) => void;
  skipExisting: boolean;
  saveToMdium: boolean;
  deleteMode: boolean;
}

function collectDescendantFiles(
  node: ConvertibleTreeNode
): ConvertibleTreeNode[] {
  if (!node.isDir) return [node];
  const files: ConvertibleTreeNode[] = [];
  for (const child of node.children ?? []) {
    files.push(...collectDescendantFiles(child));
  }
  return files;
}

function getCheckState(
  node: ConvertibleTreeNode,
  selected: Set<string>,
  skipExisting: boolean,
  saveToMdium: boolean
): CheckState {
  const nodeExists = (n: ConvertibleTreeNode) =>
    saveToMdium ? !!n.hasExistingMdInMdium : !!n.hasExistingMdSibling;

  if (!node.isDir) {
    if (skipExisting && nodeExists(node)) return "unchecked";
    return selected.has(node.path) ? "checked" : "unchecked";
  }
  const files = collectDescendantFiles(node);
  const selectable = skipExisting
    ? files.filter((f) => !nodeExists(f))
    : files;
  if (selectable.length === 0) return "unchecked";
  const selectedCount = selectable.filter((f) => selected.has(f.path)).length;
  if (selectedCount === 0) return "unchecked";
  if (selectedCount === selectable.length) return "checked";
  return "indeterminate";
}

export function BatchConvertTreeNode({
  node,
  depth,
  selected,
  onToggleFile,
  onToggleFolder,
  collapsed,
  onToggleCollapse,
  skipExisting,
  saveToMdium,
  deleteMode,
}: BatchConvertTreeNodeProps) {
  const checkboxRef = useRef<HTMLInputElement>(null);
  const isCollapsed = collapsed.has(node.path);

  const checkState = getCheckState(node, selected, skipExisting, saveToMdium);

  const effectiveExisting = saveToMdium
    ? !!node.hasExistingMdInMdium
    : !!node.hasExistingMdSibling;

  const isDisabled = !node.isDir && skipExisting && effectiveExisting;

  useEffect(() => {
    if (checkboxRef.current) {
      checkboxRef.current.indeterminate = checkState === "indeterminate";
    }
  }, [checkState]);

  const handleCheckboxChange = useCallback(() => {
    if (node.isDir) {
      const paths = collectDescendantPaths(node);
      const shouldSelect = checkState !== "checked";
      onToggleFolder(paths, shouldSelect);
    } else {
      onToggleFile(node.path);
    }
  }, [node, checkState, onToggleFile, onToggleFolder]);

  const handleNameClick = useCallback(() => {
    if (node.isDir) {
      onToggleCollapse(node.path);
    }
  }, [node, onToggleCollapse]);

  // In delete mode, file rows represent the generated .md file (the deletion
  // target), so show the .md name/icon instead of the source (docx/pdf) name.
  const displayName =
    !node.isDir && deleteMode
      ? `${node.name.replace(/\.\w+$/i, "")}.md`
      : node.name;

  const icon = node.isDir
    ? isCollapsed
      ? "+"
      : "−"
    : getFileIcon(displayName);

  return (
    <>
      <div
        className="batch-convert__tree-node"
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={checkState === "checked"}
          onChange={handleCheckboxChange}
          disabled={isDisabled}
          className="batch-convert__tree-checkbox"
        />
        <span
          className={`batch-convert__tree-icon ${node.isDir ? "batch-convert__tree-icon--dir" : ""}`}
          onClick={node.isDir ? handleNameClick : undefined}
        >
          {icon}
        </span>
        <span
          className={`batch-convert__tree-name ${node.isDir ? "batch-convert__tree-name--dir" : ""}`}
          title={node.path}
          onClick={node.isDir ? handleNameClick : undefined}
        >
          {displayName}
        </span>
        {!node.isDir && !deleteMode && effectiveExisting && (
          <span className="batch-convert__item-badge">.md exists</span>
        )}
      </div>
      {node.isDir && !isCollapsed && node.children && (
        <div className="batch-convert__tree-children">
          {node.children.map((child) => (
            <BatchConvertTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onToggleFile={onToggleFile}
              onToggleFolder={onToggleFolder}
              collapsed={collapsed}
              onToggleCollapse={onToggleCollapse}
              skipExisting={skipExisting}
              saveToMdium={saveToMdium}
              deleteMode={deleteMode}
            />
          ))}
        </div>
      )}
    </>
  );
}
