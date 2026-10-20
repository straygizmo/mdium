// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { useSettingsStore } from "../settings-store";

const ALL_ON = { claude: true, codex: true, copilot: true };

describe("mdiumRagTools setting", () => {
  it("defaults to all providers enabled", () => {
    expect(useSettingsStore.getState().mdiumRagTools).toEqual(ALL_ON);
  });

  it("flips only the given provider and persists it", () => {
    useSettingsStore.getState().setMdiumRagTool("codex", false);
    expect(useSettingsStore.getState().mdiumRagTools).toEqual({ ...ALL_ON, codex: false });
    const persisted = JSON.parse(localStorage.getItem("mdium-settings") ?? "{}");
    expect(persisted.state.mdiumRagTools).toEqual({ ...ALL_ON, codex: false });
    useSettingsStore.getState().setMdiumRagTool("codex", true);
  });

  it("fills missing keys with true when merging persisted state", async () => {
    localStorage.setItem(
      "mdium-settings",
      JSON.stringify({ state: { fontSize: 18 }, version: 0 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().mdiumRagTools).toEqual(ALL_ON);

    localStorage.setItem(
      "mdium-settings",
      JSON.stringify({ state: { mdiumRagTools: { claude: false } }, version: 0 }),
    );
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState().mdiumRagTools).toEqual({ ...ALL_ON, claude: false });
  });
});
