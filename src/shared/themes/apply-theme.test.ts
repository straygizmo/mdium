// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme, flowNodeDefaults, taskStatusDefaults } from "./apply-theme";
import { themePresets } from "./index";

const switchVariables = {
  primary: "--primary",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  border: "--border",
} as const;

describe("applyTheme switch variables", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme-type");
    document.documentElement.removeAttribute("data-theme-id");
    document.documentElement.style.cssText = "";
  });

  it("publishes the switch variables for every registered preset", () => {
    for (const theme of themePresets) {
      applyTheme(theme);
      for (const [key, variable] of Object.entries(switchVariables)) {
        const value = theme.colors[key as keyof typeof theme.colors];
        expect(value, `${theme.id}.${key}`).toBeTruthy();
        expect(document.documentElement.style.getPropertyValue(variable), `${theme.id} ${variable}`).toBe(value);
      }
    }
  });
});

const taskStatusVariables = {
  taskStatusInboxBackground: "--task-status-inbox-background",
  taskStatusRunningBackground: "--task-status-running-background",
  taskStatusAwaitingUserBackground: "--task-status-awaiting-user-background",
  taskStatusAttentionBackground: "--task-status-attention-background",
  taskStatusOnHoldBackground: "--task-status-on-hold-background",
  taskStatusCompletedBackground: "--task-status-completed-background",
  taskStatusCancelledBackground: "--task-status-cancelled-background",
} as const;

describe("task status theme tokens", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme-type");
    document.documentElement.removeAttribute("data-theme-id");
    document.documentElement.style.cssText = "";
  });

  it("publishes all seven task status variables for every preset", () => {
    for (const theme of themePresets) {
      applyTheme(theme);
      for (const variable of Object.values(taskStatusVariables)) {
        expect(
          document.documentElement.style.getPropertyValue(variable).trim(),
          `${theme.id} ${variable}`,
        ).not.toBe("");
      }
    }
  });

  it("lets an explicit preset value override the derived default", () => {
    const base = themePresets[0];
    const theme = {
      ...base,
      colors: { ...base.colors, taskStatusRunningBackground: "#123456" },
    };
    applyTheme(theme);
    expect(document.documentElement.style.getPropertyValue("--task-status-running-background")).toBe("#123456");
  });

  it("derives defaults from the preset's accent colors", () => {
    for (const theme of themePresets) {
      const defaults = taskStatusDefaults(theme.colors);
      expect(defaults.taskStatusInboxBackground).toContain(theme.colors.textMuted);
      expect(defaults.taskStatusRunningBackground).toContain(theme.colors.accentBlue);
      expect(defaults.taskStatusAwaitingUserBackground).toContain(theme.colors.primary);
      expect(defaults.taskStatusAttentionBackground).toContain(theme.colors.accentRed);
      expect(defaults.taskStatusOnHoldBackground).toContain(theme.colors.textSecondary);
      expect(defaults.taskStatusCompletedBackground).toContain(theme.colors.accentGreen);
      expect(defaults.taskStatusCancelledBackground).toContain(theme.colors.textMuted);
      expect(defaults.taskStatusRunningBackground).toContain(theme.colors.bgSurface);
    }
  });
});

describe("flow node theme tokens", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme-type");
    document.documentElement.removeAttribute("data-theme-id");
    document.documentElement.style.cssText = "";
  });

  const kinds = ["agent", "command", "approval", "loop", "branch", "subflow", "action"];

  it("publishes a variable per node kind for every preset", () => {
    for (const theme of themePresets) {
      applyTheme(theme);
      for (const kind of kinds) {
        const value = document.documentElement.style.getPropertyValue(`--flow-node-${kind}`).trim();
        expect(value, `${theme.id} ${kind}`).not.toBe("");
      }
    }
  });

  it("derives defaults from accent tokens and lets presets override them", () => {
    const base = themePresets[0];
    expect(flowNodeDefaults(base.colors).flowNodeCommand).toBe(base.colors.accentBlue);
    applyTheme({ ...base, colors: { ...base.colors, flowNodeLoop: "#abcdef" } });
    expect(document.documentElement.style.getPropertyValue("--flow-node-loop")).toBe("#abcdef");
  });
});
