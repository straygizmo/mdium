// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setTemplateLanguage = vi.hoisted(() => vi.fn());
vi.mock("../flow-api", () => ({ flowApi: { setTemplateLanguage } }));

import i18n from "@/shared/i18n";
import { startTemplateLanguageSync } from "../template-language";

describe("startTemplateLanguageSync", () => {
  let stop: (() => void) | undefined;

  beforeEach(async () => {
    setTemplateLanguage.mockReset().mockResolvedValue(undefined);
    await i18n.changeLanguage("ja");
  });

  afterEach(() => stop?.());

  it("sends the current language at once and again on every change", async () => {
    stop = startTemplateLanguageSync();
    expect(setTemplateLanguage).toHaveBeenCalledTimes(1);
    expect(setTemplateLanguage).toHaveBeenLastCalledWith("ja");
    await i18n.changeLanguage("en");
    expect(setTemplateLanguage).toHaveBeenCalledTimes(2);
    expect(setTemplateLanguage).toHaveBeenLastCalledWith("en");
  });

  it("stops following changes once stopped", async () => {
    stop = startTemplateLanguageSync();
    stop();
    stop = undefined;
    await i18n.changeLanguage("en");
    expect(setTemplateLanguage).toHaveBeenCalledTimes(1);
  });

  it("ignores a failing command (no templates outside the desktop app)", async () => {
    setTemplateLanguage.mockRejectedValue(new Error("no transport"));
    stop = startTemplateLanguageSync();
    await i18n.changeLanguage("en");
    expect(setTemplateLanguage).toHaveBeenCalledTimes(2);
  });
});
