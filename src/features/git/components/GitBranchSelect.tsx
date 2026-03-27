import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ask } from "@tauri-apps/plugin-dialog";
import { useGitStore } from "@/stores/git-store";

interface GitBranchSelectProps {
  folderPath: string;
  hasUncommitted: boolean;
}

export function GitBranchSelect({ folderPath, hasUncommitted }: GitBranchSelectProps) {
  const { t } = useTranslation("git");
  const currentBranch = useGitStore((s) => s.currentBranch);
  const branches = useGitStore((s) => s.branches);
  const switchBranch = useGitStore((s) => s.switchBranch);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSwitch = async (branch: string) => {
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    if (hasUncommitted) {
      const ok = await ask(t("switchBranchWarning"), {
        title: t("switchBranch"),
        kind: "warning",
      });
      if (!ok) {
        setOpen(false);
        return;
      }
    }
    setOpen(false);
    await switchBranch(folderPath, branch);
  };

  return (
    <div className="git-branch-select" ref={ref}>
      <button
        className="git-branch-select__trigger"
        onClick={() => setOpen(!open)}
        title={t("switchBranch")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="git-branch-select__name">{currentBranch || "—"}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="git-branch-select__dropdown">
          {branches.map((b) => (
            <button
              key={b}
              className={`git-branch-select__item ${b === currentBranch ? "git-branch-select__item--active" : ""}`}
              onClick={() => handleSwitch(b)}
            >
              {b}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
