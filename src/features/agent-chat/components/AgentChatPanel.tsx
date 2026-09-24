import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider, Availability } from "@/shared/types/agent-runner";
import { useTabStore } from "@/stores/tab-store";
import { OpencodeConfigPanel } from "@/features/opencode-config/components/OpencodeConfigPanel";
import { useAgentChatStore, type ChatProviderTab } from "../agent-chat-store";
import { NativeChat } from "./NativeChat";
import "@/features/opencode-config/components/OpencodeConfigPanel.css";
import "./AgentChatPanel.css";

const TABS: ChatProviderTab[] = ["opencode", "codex", "copilot"];
const LABEL_KEYS: Record<ChatProviderTab, string> = {
  opencode: "providerOpencode",
  codex: "providerCodex",
  copilot: "providerCopilot",
};

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
        return t("unavailableTooOld", { name, minimum: availability.detail, found: availability.detectedVersion ?? "?" });
      default:
        return t("unavailableError", { name, detail: availability.detail });
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

  useEffect(() => {
    const { probe, availability: known } = useAgentChatStore.getState();
    (["codex", "copilot"] as const).forEach((p) => {
      if (!known[p]) void probe(p);
    });
  }, []);

  return (
    <div className="agent-chat">
      <div className="agent-chat__tabs oc-panel__top-tabs" role="tablist" aria-label={t("tabList")}>
        {TABS.map((tab) => {
          const why = tab === "opencode" ? null : reason(tab, availability[tab]);
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
        ) : folder ? (
          <NativeChat folder={folder} provider={selectedTab} />
        ) : (
          <div className="agent-chat__empty">{t("noFolder")}</div>
        )}
      </div>
    </div>
  );
}
