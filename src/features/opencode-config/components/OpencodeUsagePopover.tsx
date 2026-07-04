import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChatUIStore } from "../hooks/useOpencodeChat";
import { useOpencodeUsageStore } from "@/stores/opencode-usage-store";
import {
  emptyTotals,
  localDayKey,
  tokenSum,
  type UsageTotals,
} from "@/stores/opencode-usage-core";
import { formatTokenCount, formatUsageCost } from "../lib/usage-format";

function TotalsRows({ totals }: { totals: UsageTotals }) {
  const { t } = useTranslation("opencode-config");
  const rows: Array<[string, string]> = [
    [t("ocUsageInput"), formatTokenCount(totals.input)],
    [t("ocUsageOutput"), formatTokenCount(totals.output)],
    [t("ocUsageReasoning"), formatTokenCount(totals.reasoning)],
    [t("ocUsageCacheRead"), formatTokenCount(totals.cacheRead)],
    [t("ocUsageCacheWrite"), formatTokenCount(totals.cacheWrite)],
    [t("ocUsageCost"), formatUsageCost(totals.cost)],
  ];
  return (
    <div className="oc-chat__usage-rows">
      {rows.map(([label, value]) => (
        <div key={label} className="oc-chat__usage-row">
          <span>{label}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

function ModelBreakdown({ byModel }: { byModel: Record<string, UsageTotals> }) {
  const entries = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
  return (
    <div className="oc-chat__usage-models">
      {entries.map(([model, totals]) => (
        <div key={model} className="oc-chat__usage-row">
          <span className="oc-chat__usage-model-name" title={model}>
            {model}
          </span>
          <span>
            {formatUsageCost(totals.cost)} · {formatTokenCount(tokenSum(totals))}
          </span>
        </div>
      ))}
    </div>
  );
}

export function OpencodeUsagePopover() {
  const { t } = useTranslation("opencode-config");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const currentSessionId = useChatUIStore((s) => s.currentSessionId);
  const sessions = useOpencodeUsageStore((s) => s.sessions);
  const days = useOpencodeUsageStore((s) => s.days);

  const sessionTotals =
    (currentSessionId ? sessions[currentSessionId] : undefined) ?? emptyTotals();

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Compact toolbar label: cost when known, token count for zero-cost
  // (e.g. subscription-authenticated providers), icon only when unused.
  const label =
    sessionTotals.cost > 0
      ? formatUsageCost(sessionTotals.cost)
      : tokenSum(sessionTotals) > 0
        ? formatTokenCount(tokenSum(sessionTotals))
        : null;

  const todayKey = localDayKey(new Date());
  const today = days[todayKey];
  const dayKeys = Object.keys(days).sort().reverse();
  const sessionHasUsage = sessionTotals.cost > 0 || tokenSum(sessionTotals) > 0;

  return (
    <div className="oc-chat__usage" ref={rootRef}>
      <button
        className="oc-chat__toolbar-btn oc-chat__usage-btn"
        onClick={() => setOpen((v) => !v)}
        title={t("ocUsageTitle")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="2" x2="12" y2="22" />
          <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
        </svg>
        {label && <span className="oc-chat__usage-label">{label}</span>}
      </button>
      {open && (
        <div className="oc-chat__usage-popover">
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageSession")}</div>
            {sessionHasUsage ? (
              <TotalsRows totals={sessionTotals} />
            ) : (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            )}
          </div>
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageToday")}</div>
            {today ? (
              <>
                <div className="oc-chat__usage-row oc-chat__usage-row--total">
                  <span>{t("ocUsageCost")}</span>
                  <span>
                    {formatUsageCost(today.total.cost)} ·{" "}
                    {formatTokenCount(tokenSum(today.total))}
                  </span>
                </div>
                <ModelBreakdown byModel={today.byModel} />
              </>
            ) : (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            )}
          </div>
          <div className="oc-chat__usage-section">
            <div className="oc-chat__usage-heading">{t("ocUsageLast30Days")}</div>
            {dayKeys.length === 0 ? (
              <div className="oc-chat__usage-empty">{t("ocUsageEmpty")}</div>
            ) : (
              dayKeys.map((key) => (
                <details key={key} className="oc-chat__usage-day">
                  <summary className="oc-chat__usage-row">
                    <span>{key}</span>
                    <span>
                      {formatUsageCost(days[key].total.cost)} ·{" "}
                      {formatTokenCount(tokenSum(days[key].total))}
                    </span>
                  </summary>
                  <ModelBreakdown byModel={days[key].byModel} />
                </details>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
