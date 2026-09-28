// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const showMessage = vi.hoisted(() => vi.fn());
vi.mock("@/stores/dialog-store", () => ({ showMessage }));

import i18n from "@/shared/i18n";
import { externalUrl } from "../../lib/open-external";
import { SafeMarkdown } from "../SafeMarkdown";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("SafeMarkdown", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  async function render(source: string) {
    await act(async () => root.render(<SafeMarkdown source={source} className="md" />));
  }

  /** Clicks the element and returns whether the default action was prevented. */
  function click(el: Element, type = "click"): boolean {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: type === "auxclick" ? 1 : 0 });
    el.dispatchEvent(event);
    return event.defaultPrevented;
  }

  function link(text: string) {
    return [...container.querySelectorAll("a")].find((a) => a.textContent === text)!;
  }

  it("renders sanitized Markdown", async () => {
    await render('**bold** <img src=x onerror="alert(1)">');
    expect(container.querySelector(".md strong")?.textContent).toBe("bold");
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  it("opens http and https links externally and never navigates", async () => {
    await render("[secure](https://example.com/a?b=1) [plain](http://example.com/) [**nested**](https://example.com/n)");
    expect(click(link("secure"))).toBe(true);
    expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.com/a?b=1" });
    expect(click(link("plain"))).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("open_external_url", { url: "http://example.com/" });
    // happy-dom runs a descendant click's link activation before the event reaches
    // React's root listener (browsers run it after dispatch); hide the resolved
    // href from it so the test stays offline. The handler reads the attribute.
    const nested = container.querySelector("a strong")!;
    Object.defineProperty(nested.parentElement!, "href", { get: () => "" });
    expect(click(nested)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith("open_external_url", { url: "https://example.com/n" });
    expect(invoke).toHaveBeenCalledTimes(3);
  });

  it("does nothing for other schemes and relative links", async () => {
    await render("[mail](mailto:a@b.c) [rel](docs/a.md) [file](file:///C:/x.txt) [anchor](#top) [data](data:text/html,x)");
    for (const text of ["mail", "rel", "file", "anchor"]) {
      expect(click(link(text)), text).toBe(true);
    }
    // DOMPurify may drop the data: href; the anchor still must not navigate.
    expect(click(link("data"))).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(showMessage).not.toHaveBeenCalled();
  });

  it("prevents middle-click navigation", async () => {
    await render("[secure](https://example.com/)");
    expect(click(link("secure"), "auxclick")).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows a failed open", async () => {
    invoke.mockRejectedValue("boom");
    await render("[secure](https://example.com/)");
    await act(async () => {
      click(link("secure"));
    });
    expect(showMessage).toHaveBeenCalledWith(expect.any(String), {
      title: i18n.t("workflow:intake.linkOpenFailed"),
      kind: "error",
    });
  });
});

describe("externalUrl", () => {
  it("accepts only absolute http and https URLs", () => {
    expect(externalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(externalUrl("HTTP://Example.com")).toBe("http://example.com/");
    expect(externalUrl("javascript:alert(1)")).toBeNull();
    expect(externalUrl("docs/a.md")).toBeNull();
    expect(externalUrl("//example.com/x")).toBeNull();
    expect(externalUrl("")).toBeNull();
  });

  it("keeps query separators, commas and percent-encoding", () => {
    // The backend encodes commas for the Windows opener.
    expect(externalUrl("https://example.com/a,b")).toBe("https://example.com/a,b");
    expect(externalUrl("https://example.com/search?q=a&page=2")).toBe("https://example.com/search?q=a&page=2");
    expect(externalUrl("https://ja.wikipedia.org/wiki/%E6%97%A5")).toBe("https://ja.wikipedia.org/wiki/%E6%97%A5");
  });

  it("never opens URLs with whitespace or control characters", () => {
    // Spaces and DEL in the path are percent-encoded by the parser.
    expect(externalUrl("https://example.com/a b")).toBe("https://example.com/a%20b");
    expect(externalUrl(`https://example.com/${String.fromCharCode(0x7f)}`)).toBe("https://example.com/%7F");
    expect(externalUrl(`https://exa${String.fromCharCode(0)}mple.com/`)).toBeNull();
  });
});
