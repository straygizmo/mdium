// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/shared/i18n";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { useFtpBrowserStore } from "@/stores/ftp-browser-store";
import { useFtpMirrorStore } from "@/stores/ftp-mirror-store";
import { FtpPanel } from "../FtpPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = "ftp://me@ftp.example.com:21";
const saved = [
  { host: "ftp.example.com", port: 21, user: "me", secure: true, acceptInvalidCerts: false, hasPassword: true },
  { host: "old.example.com", port: 21, user: "me", secure: false, acceptInvalidCerts: false, hasPassword: true },
];
const tree: Record<string, unknown[]> = {
  [ROOT]: [
    { name: "public_html", path: `${ROOT}/public_html`, is_dir: true },
    { name: "README.md", path: `${ROOT}/README.md`, is_dir: false },
  ],
  [`${ROOT}/public_html`]: [{ name: "docs", path: `${ROOT}/public_html/docs`, is_dir: true }],
};

function handle(cmd: string, args: Record<string, unknown>) {
  switch (cmd) {
    case "ftp_list_connections":
      return saved;
    case "ftp_connect":
      return ROOT;
    case "get_file_tree":
      return tree[args.path as string] ?? [];
    case "ftp_mirror_open":
      return "C:/mirrors/abc";
    default:
      return undefined;
  }
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe("FtpPanel", () => {
  let root: ReturnType<typeof createRoot>;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => handle(cmd, args));
    useFtpBrowserStore.setState({
      recent: ["me@old.example.com:21"],
      rootPaths: {},
      connection: null,
      children: {},
      expanded: {},
      loading: {},
      errors: {},
      selected: null,
    });
    useFtpMirrorStore.setState({ mirrors: {}, statuses: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const nodeNamed = (name: string) =>
    [...container.querySelectorAll<HTMLElement>(".file-tree__node")].find(
      (n) => n.querySelector(".file-tree__name")?.textContent === name,
    );

  it("lists saved connections, most recently used first", async () => {
    await act(async () => root.render(<FtpPanel onOpenWorkingFolder={vi.fn()} />));
    await flush();
    const keys = [...container.querySelectorAll("[data-connection]")].map((n) => n.getAttribute("data-connection"));
    expect(keys).toEqual(["me@old.example.com:21", "me@ftp.example.com:21"]);
  });

  it("connects with the stored password and browses the tree lazily", async () => {
    await act(async () => root.render(<FtpPanel onOpenWorkingFolder={vi.fn()} />));
    await flush();
    await act(async () => container.querySelector<HTMLElement>('[data-connection="me@ftp.example.com:21"]')!.click());
    await flush();

    expect(invoke).toHaveBeenCalledWith("ftp_connect", {
      profile: { host: "ftp.example.com", port: 21, user: "me", secure: true, acceptInvalidCerts: false },
      password: null,
      remotePath: "/",
    });
    expect(useFtpBrowserStore.getState().recent[0]).toBe("me@ftp.example.com:21");
    expect(nodeNamed("/")).toBeDefined();
    expect(nodeNamed("public_html")).toBeDefined();
    expect(nodeNamed("README.md")).toBeDefined();
    expect(nodeNamed("docs")).toBeUndefined();

    await act(async () => nodeNamed("public_html")!.click());
    await flush();
    expect(invoke).toHaveBeenCalledWith("get_file_tree", expect.objectContaining({ path: `${ROOT}/public_html` }));
    expect(nodeNamed("docs")).toBeDefined();
  });

  it("opens a folder as a working folder through the local mirror", async () => {
    const onOpen = vi.fn();
    useFtpBrowserStore.getState().setConnected("me@ftp.example.com:21", ROOT, "/");
    await act(async () => root.render(<FtpPanel onOpenWorkingFolder={onOpen} />));
    await flush();

    await act(async () => {
      nodeNamed("public_html")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
    });
    const item = [...container.querySelectorAll<HTMLButtonElement>(".context-menu button")].find(
      (b) => b.textContent === "Open as Working Folder",
    );
    expect(item).toBeDefined();
    await act(async () => item!.click());
    await flush();

    expect(invoke).toHaveBeenCalledWith("ftp_mirror_open", { uri: `${ROOT}/public_html` });
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/public_html`, "C:/mirrors/abc");
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("does not offer opening files as working folders", async () => {
    useFtpBrowserStore.getState().setConnected("me@ftp.example.com:21", ROOT, "/");
    await act(async () => root.render(<FtpPanel onOpenWorkingFolder={vi.fn()} />));
    await flush();
    await act(async () => {
      nodeNamed("README.md")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    expect(container.querySelector(".context-menu")).toBeNull();
  });

  it("shows the full path of the clicked item and copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    useFtpBrowserStore.getState().setConnected("me@ftp.example.com:21", ROOT, "/");
    await act(async () => root.render(<FtpPanel onOpenWorkingFolder={vi.fn()} />));
    await flush();

    const pathInput = () => container.querySelector<HTMLInputElement>(".ftp-panel__path-input")!;
    expect(pathInput().value).toBe(ROOT);

    await act(async () => nodeNamed("public_html")!.click());
    await flush();
    await act(async () => nodeNamed("docs")!.click());
    expect(pathInput().value).toBe(`${ROOT}/public_html/docs`);
    expect(nodeNamed("docs")!.classList.contains("file-tree__node--active")).toBe(true);

    await act(async () => nodeNamed("README.md")!.click());
    expect(pathInput().value).toBe(`${ROOT}/README.md`);

    await act(async () => container.querySelector<HTMLButtonElement>('.ftp-panel__path button[aria-label="Copy path"]')!.click());
    expect(writeText).toHaveBeenCalledWith(`${ROOT}/README.md`);
  });
});
