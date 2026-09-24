// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { applyTheme } from "./apply-theme";
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
