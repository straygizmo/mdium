import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const switchStylesheet = resolve(root, "src/shared/styles/switch.css");

// Feature stylesheets that style switches. Extended as features adopt data-switch.
const targetStylesheets: string[] = [];

// Components that render span-based switches. Extended as features adopt data-switch.
const keyboardSwitchComponents: string[] = [];

// Components whose every checkbox is a switch.
const checkboxSwitchComponents: string[] = [];

function cssRules(css: string): Array<[selector: string, body: string]> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.replace(/\s+/g, " ").trim(), body]);
}

function switchRules(css: string): string[] {
  return cssRules(css)
    .filter(([selector]) => /input\[data-switch\]|__switch/.test(selector))
    .map(([selector, body]) => `${selector}{${body}}`);
}

function switchThumbBaseRules(css: string): string[] {
  return cssRules(css)
    .filter(([selector]) =>
      (/input\[data-switch\]::after/.test(selector) && !selector.includes(":checked")) ||
      (/__switch-thumb/.test(selector) && !selector.includes("__switch--on")))
    .map(([selector, body]) => `${selector}{${body}}`);
}

describe("switch CSS contract", () => {
  it("defines only theme-token colors and shared state behavior", () => {
    const css = readFileSync(switchStylesheet, "utf8");
    expect(css).toContain("background: var(--bg-surface)");
    expect(css).toContain("background: var(--primary)");
    expect(css).toContain("input[data-switch]:not(:checked)");
    expect(css).toContain("border: 1px solid var(--primary)");
    expect(css).toContain("background: var(--bg-base)");
    expect(css).toContain("border: 1px solid var(--border)");
    expect(css).toContain("opacity: 0.5");
    expect(css).not.toMatch(/var\([^)]*,/);
  });

  it("does not keep hard-coded switch colors in feature styles", () => {
    for (const relativePath of targetStylesheets) {
      const css = readFileSync(resolve(root, relativePath), "utf8");
      // Toggle containers must select switches by data-switch, not by checkbox type.
      expect(css, relativePath).not.toMatch(/__(?:toggle|scope-toggle|md-toggle-bar)\s+input\[type="checkbox"\]/);
      for (const rule of switchRules(css)) {
        expect(rule, relativePath).not.toMatch(/#(?:fff|ffffff)\b|\bwhite\b|var\([^)]*,|var\(--accent(?:-|\b)|var\(--text-muted\b/);
      }
    }
  });

  it("centers switch thumbs within their feature-owned tracks", () => {
    for (const relativePath of targetStylesheets) {
      const css = readFileSync(resolve(root, relativePath), "utf8");
      for (const rule of switchThumbBaseRules(css)) {
        expect(rule, relativePath).toContain("top: 50%");
        expect(rule, relativePath).toMatch(/margin-top:\s*-\d+px/);
      }
    }
  });

  it("marks every checkbox in switch components as a switch", () => {
    for (const relativePath of checkboxSwitchComponents) {
      const source = readFileSync(resolve(root, relativePath), "utf8");
      const checkboxes = source.match(/type="checkbox"/g)?.length ?? 0;
      const switches = source.match(/data-switch\b(?!-)/g)?.length ?? 0;
      expect(checkboxes, relativePath).toBeGreaterThan(0);
      expect(switches, relativePath).toBe(checkboxes);
    }
  });

  it("keeps span switches keyboard-operable and labelled", () => {
    for (const relativePath of keyboardSwitchComponents) {
      const source = readFileSync(resolve(root, relativePath), "utf8");
      for (const token of ["data-switch", 'role="switch"', "aria-checked", "aria-label", "tabIndex={0}", "onClick", "onKeyDown", "preventDefault()", "data-switch-thumb"]) {
        expect(source, `${relativePath} ${token}`).toContain(token);
      }
    }
  });
});
