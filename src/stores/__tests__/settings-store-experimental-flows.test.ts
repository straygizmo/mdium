// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { useSettingsStore } from "../settings-store";

describe("experimentalFlows setting", () => {
  it("is off by default, can be toggled, and is persisted", () => {
    expect(useSettingsStore.getState().experimentalFlows).toBe(false);
    useSettingsStore.getState().setExperimentalFlows(true);
    expect(useSettingsStore.getState().experimentalFlows).toBe(true);
    const persisted = JSON.parse(localStorage.getItem("mdium-settings") ?? "{}");
    expect(persisted.state.experimentalFlows).toBe(true);
    useSettingsStore.getState().setExperimentalFlows(false);
  });
});
