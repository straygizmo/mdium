import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider, Availability } from "@/shared/types/agent-runner";
import { useTabStore } from "@/stores/tab-store";
import { useUiStore } from "@/stores/ui-store";
import { OpencodeConfigPanel } from "@/features/opencode-config/components/OpencodeConfigPanel";
import { ClaudePanel } from "@/features/claude-config/components/ClaudePanel";
import { useAgentChatStore, type ChatProviderTab } from "../agent-chat-store";
import { NativeChat } from "./NativeChat";
import "@/features/opencode-config/components/OpencodeConfigPanel.css";
import "./AgentChatPanel.css";

const TABS: ChatProviderTab[] = ["opencode", "claude", "codex", "copilot"];
const LABEL_KEYS: Record<ChatProviderTab, string> = {
  opencode: "providerOpencode",
  claude: "providerClaude",
  codex: "providerCodex",
  copilot: "providerCopilot",
};

/** Machine-readable `error` detail codes that map to a specific localized message. */
const CHECK_FAILED_DETAILS = new Set(["spawn", "version"]);
const RUNNER_FAILED_DETAILS = new Set(["RUNNER_EXITED", "RUNNER_START_TIMEOUT"]);

function useUnavailableReason(): (provider: AgentProvider, availability: Availability | undefined) => string | null {
  const { t } = useTranslation("agent-chat");
  return (provider, availability) => {
    const name = t(LABEL_KEYS[provider]);
    if (!availability) return t("checking");
    switch (availability.kind) {
      case "available":
        return null;
      case "missing":
        return t("unavailableMissing", { name });
      case "unauthenticated":
        return t("unavailableUnauthenticated", { name, command: availability.detail });
      case "too_old":
        return t("unavailableTooOld", { name, minimum: availability.detail, found: availability.detectedVersion ?? t("unknownVersion") });
      case "error": {
        // Never render the raw machine-readable detail code; map the known
        // ones to a localized explanation and fall back to a generic one.
        if (CHECK_FAILED_DETAILS.has(availability.detail)) return t("availabilityCheckFailed", { name });
        if (RUNNER_FAILED_DETAILS.has(availability.detail)) return t("availabilityRunnerFailed", { name });
        return t("unavailableError", { name });
      }
    }
  };
}

export function AgentChatPanel() {
  const { t } = useTranslation("agent-chat");
  const folder = useTabStore((s) => s.activeFolderPath);
  const selectedTab = useAgentChatStore((s) => s.selectedTab);
  const availability = useAgentChatStore((s) => s.availability);
  const setSelectedTab = useAgentChatStore((s) => s.setSelectedTab);
  const reason = useUnavailableReason();
  // AgentChatPanel is mounted once and kept alive behind a CSS visibility
  // toggle (see LeftPanel), so a plain mount-only effect would only ever
  // probe once. Track visibility via the left panel selection instead, so
  // providers stuck in "error" (or never probed) are retried each time the
  // panel becomes visible again, not just on first mount.
  const visible = useUiStore((s) => s.leftPanel === "opencode-config");

  useEffect(() => {
    if (!visible) return;
    const { probe, availability: known } = useAgentChatStore.getState();
    (["codex", "copilot"] as const).forEach((p) => {
      const a = known[p];
      if (!a || a.kind === "error") void probe(p);
    });
  }, [visible]);

  return (
    <div className="agent-chat">
      <div className="agent-chat__tabs oc-panel__top-tabs" role="tablist" aria-label={t("tabList")}>
        {TABS.map((tab) => {
          const why = tab === "opencode" || tab === "claude" ? null : reason(tab, availability[tab]);
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selectedTab === tab}
              disabled={why !== null}
              title={why ?? undefined}
              className={`oc-panel__top-tab${selectedTab === tab ? " oc-panel__top-tab--active" : ""}`}
              onClick={() => setSelectedTab(tab)}
            >
              {t(LABEL_KEYS[tab])}
            </button>
          );
        })}
      </div>
      <div className="agent-chat__body">
        {selectedTab === "opencode" ? (
          <OpencodeConfigPanel />
        ) : selectedTab === "claude" ? (
          <ClaudePanel />
        ) : folder ? (
          <NativeChat folder={folder} provider={selectedTab} />
        ) : (
          <div className="agent-chat__empty">{t("noFolder")}</div>
        )}
      </div>
    </div>
  );
}
