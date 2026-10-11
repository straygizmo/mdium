import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { defaultExpandedKeys, flattenVisible, type RunTreeRow } from "../lib/run-tree";
import { formatUsd } from "../lib/run-format";

interface RunNodeTreeProps {
  rows: RunTreeRow[];
  selectedKey: string | null;
  onSelect(key: string): void;
  onOpenApproval(nodeKey: string): void;
}

/** Nested node rows of a run, with per-scope aggregates and expandable loop iterations. */
export function RunNodeTree({ rows, selectedKey, onSelect, onOpenApproval }: RunNodeTreeProps) {
  const { t } = useTranslation("flow");
  const [expanded, setExpanded] = useState<Set<string>>(() => defaultExpandedKeys(rows));
  const seeded = useRef<Set<string>>(new Set(expanded));

  // Re-seed when new hot scopes appear; keys the user already saw keep their manual state.
  const hot = useMemo(() => defaultExpandedKeys(rows), [rows]);
  useEffect(() => {
    const fresh = [...hot].filter((k) => !seeded.current.has(k));
    if (fresh.length === 0) return;
    fresh.forEach((k) => seeded.current.add(k));
    setExpanded((prev) => new Set([...prev, ...fresh]));
  }, [hot]);

  const visible = flattenVisible(rows, expanded);
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <ul className="flow-tree" role="tree">
      {visible.map((row) => {
        const hasChildren = row.children.length > 0;
        const isOpen = expanded.has(row.key);
        const status = row.node?.status;
        const { agg } = row;
        // The whole row is a mouse target; the label button is the keyboard target.
        const choose = () => {
          onSelect(row.key);
          if (row.kind === "node" && status === "awaiting_approval") onOpenApproval(row.key);
        };
        return (
          <li
            key={row.key}
            role="treeitem"
            aria-level={row.depth + 1}
            aria-expanded={hasChildren ? isOpen : undefined}
            aria-selected={row.key === selectedKey}
            className={`flow-tree__row${status ? ` flow-run__node--${status}` : ""}${row.key === selectedKey ? " flow-tree__row--selected" : ""}`}
            style={{ paddingLeft: `${row.depth * 16 + 6}px` }}
            onClick={choose}
          >
            {hasChildren ? (
              <button
                type="button"
                className="flow-tree__toggle"
                aria-label={isOpen ? t("run.collapse") : t("run.expand")}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(row.key);
                }}
              >
                {isOpen ? "▾" : "▸"}
              </button>
            ) : (
              <span className="flow-tree__toggle" aria-hidden="true" />
            )}
            <button
              type="button"
              className="flow-tree__select"
              onClick={(e) => {
                e.stopPropagation();
                choose();
              }}
            >
              <span className="flow-run__node-name" title={row.key}>
                {row.kind === "iteration" ? t("run.iteration", { n: row.iterationIndex }) : row.label}
              </span>
            </button>
            {status && <span className="flow-run__node-status">{t(`nodeStatus.${status}`)}</span>}
            {hasChildren && (
              <span className="flow-tree__agg">
                {agg.running > 0 && <span>{t("run.agg.running", { n: agg.running })}</span>}
                {agg.failed > 0 && <span>{t("run.agg.failed", { n: agg.failed })}</span>}
                {agg.awaiting > 0 && <span>{t("run.agg.awaiting", { n: agg.awaiting })}</span>}
                {agg.costUsd > 0 && <span>{t("run.cost", { usd: formatUsd(agg.costUsd) })}</span>}
                {agg.progress && <span>{agg.progress}</span>}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
