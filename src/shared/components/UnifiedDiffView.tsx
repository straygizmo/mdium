import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import "./UnifiedDiffView.css";

const DEFAULT_MAX_LINES = 5000;

type DiffLineKind = "added" | "removed" | "header" | "meta" | "context";

function isFileHeader(line: string): boolean {
  return line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++");
}

// Classifies lines in order. Inside a hunk, "---"/"+++" are removed/added
// content lines (e.g. a removed "-- comment"), not file headers; a new
// "diff " line ends the hunk.
function classifyLines(lines: string[]): DiffLineKind[] {
  let inHunk = false;
  return lines.map((line) => {
    if (line.startsWith("diff ")) {
      inHunk = false;
      return "meta";
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      return "header";
    }
    if (!inHunk && isFileHeader(line)) return "meta";
    if (line.startsWith("+")) return "added";
    if (line.startsWith("-")) return "removed";
    return "context";
  });
}

interface UnifiedDiffViewProps {
  diff: string;
  maxLines?: number;
}

export function UnifiedDiffView({ diff, maxLines = DEFAULT_MAX_LINES }: UnifiedDiffViewProps) {
  const { t } = useTranslation("common");

  const { lines, kinds, hidden } = useMemo(() => {
    const all = diff.length === 0 ? [] : diff.replace(/\r?\n$/, "").split(/\r?\n/);
    const limit = Math.max(0, maxLines);
    const shown = all.slice(0, limit);
    return { lines: shown, kinds: classifyLines(shown), hidden: Math.max(0, all.length - limit) };
  }, [diff, maxLines]);

  return (
    <div className="unified-diff">
      {lines.map((line, i) => (
        <div key={i} className={`unified-diff__line unified-diff__line--${kinds[i]}`}>
          {line}
        </div>
      ))}
      {hidden > 0 && (
        <div className="unified-diff__truncated">{t("truncatedLines", { count: hidden })}</div>
      )}
    </div>
  );
}
