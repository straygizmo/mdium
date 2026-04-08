import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTabStore } from "@/stores/tab-store";
import type { CommitFileEntry } from "@/features/git/lib/parse-log";

function getMonacoLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    rs: "rust", py: "python", json: "json", css: "css", html: "html",
    md: "markdown", yaml: "yaml", yml: "yaml", toml: "toml",
  };
  return map[ext] ?? "plaintext";
}

function statusColor(status: string): string {
  switch (status) {
    case "M": return "var(--git-modified, #e2a438)";
    case "A": return "var(--git-added, #73c991)";
    case "D": return "var(--git-deleted, #f44747)";
    case "R": return "var(--git-renamed, #6eb5ff)";
    default: return "var(--text-muted)";
  }
}

interface GitGraphCommitFilesProps {
  files: CommitFileEntry[];
  folderPath: string;
  commitHash: string;
}

export function GitGraphCommitFiles({ files, folderPath, commitHash }: GitGraphCommitFilesProps) {
  const openDiffTab = useTabStore((s) => s.openDiffTab);

  const handleFileClick = useCallback(
    async (file: CommitFileEntry) => {
      const fileName = file.path.split("/").pop() ?? file.path;
      const language = getMonacoLanguage(file.path);
      try {
        let original = "";
        let modified = "";

        if (file.status !== "A") {
          original = await invoke<string>("git_show_file", {
            path: folderPath,
            revision: `${commitHash}~1`,
            file: file.path,
          }).catch(() => "");
        }
        if (file.status !== "D") {
          modified = await invoke<string>("git_show_file", {
            path: folderPath,
            revision: commitHash,
            file: file.path,
          }).catch(() => "");
        }

        openDiffTab({
          folderPath,
          filePath: file.path,
          fileName,
          original,
          modified,
          language,
          originalLabel: `${fileName} (${commitHash.slice(0, 7)}~1)`,
          modifiedLabel: `${fileName} (${commitHash.slice(0, 7)})`,
          staged: false,
          status: file.status,
        });
      } catch (e) {
        console.error("Failed to load commit diff:", e);
      }
    },
    [folderPath, commitHash, openDiffTab],
  );

  return (
    <div className="git-graph-commit-files">
      {files.map((f) => (
        <div
          key={f.path}
          className="git-graph-commit-files__row"
          onClick={(e) => {
            e.stopPropagation();
            handleFileClick(f);
          }}
        >
          <span
            className="git-graph-commit-files__status"
            style={{ color: statusColor(f.status) }}
          >
            {f.status}
          </span>
          <span className="git-graph-commit-files__path">
            {f.path.split("/").pop()}
          </span>
          <span className="git-graph-commit-files__dir">
            {f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""}
          </span>
        </div>
      ))}
    </div>
  );
}
