// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentMeta, IntakeMessage, IntakeSessionView } from "@/shared/types/workflow";

const api = vi.hoisted(() => ({
  intakeGet: vi.fn(),
  intakeListDrafts: vi.fn(),
  intakeSend: vi.fn(),
  intakeRetry: vi.fn(),
  intakeCancelTurn: vi.fn(),
  intakeAddDraftPath: vi.fn(),
  intakeAddDraftBytes: vi.fn(),
  intakeRemoveDraft: vi.fn(),
  intakeDraftPath: vi.fn(),
}));
vi.mock("@/features/workflow/lib/workflow-api", () => ({
  workflowApi: api,
  subscribeIntakeChanged: vi.fn(),
  subscribeWorkflowsChanged: vi.fn(),
}));
const dialogOpen = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: dialogOpen }));
const readFile = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-fs", () => ({ readFile }));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ close: vi.fn() }) }));
vi.mock("@/stores/dialog-store", () => ({ showMessage: vi.fn() }));
const speech = vi.hoisted(() => ({
  status: "idle" as string,
  transcript: "",
  toggle: vi.fn(),
  setTranscript: vi.fn(),
}));
vi.mock("@/features/speech/hooks/useSpeechToText", () => ({
  useSpeechToText: () => ({ ...speech, partialTranscript: "" }),
}));

import i18n from "@/shared/i18n";
import { useSettingsStore } from "@/stores/settings-store";
import { formatCode } from "@/features/workflow/lib/format";
import { useIntakeStore } from "../../intake-store";
import { showMessage } from "@/stores/dialog-store";
import { IntakeConversation } from "../IntakeConversation";
import { appendTranscript, pastedImageName } from "../ComposeBox";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: "workflow", ...opts });
const ROOT = "C:\\proj";

function message(role: IntakeMessage["role"], text: string, extra: Partial<IntakeMessage> = {}): IntakeMessage {
  return { id: `${role}-${text}`, role, text, draftIds: [], at: "2026-09-28T00:00:00Z", detail: null, ...extra };
}

function session(extra: Partial<IntakeSessionView> = {}): IntakeSessionView {
  return {
    id: "i1",
    kind: "feature",
    status: "active",
    busy: false,
    messages: [],
    lastQuestion: null,
    proposal: null,
    docUpdates: [],
    appliedDocPaths: [],
    ...extra,
  } as IntakeSessionView;
}

function draft(id: string, name: string, mime: string): AttachmentMeta {
  return {
    schemaVersion: 1,
    id,
    originalName: name,
    storedName: name,
    mime,
    size: 10,
    sha256: "x",
    createdAt: "2026-09-28T00:00:00Z",
  };
}

describe("IntakeConversation", () => {
  let root: ReturnType<typeof createRoot> | undefined;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.clearAllMocks();
    speech.status = "idle";
    speech.transcript = "";
    container = document.createElement("div");
    document.body.appendChild(container);
    useIntakeStore.setState(useIntakeStore.getInitialState(), true);
    useSettingsStore.setState({ speechEnabled: false });
    api.intakeGet.mockResolvedValue(session());
    api.intakeListDrafts.mockResolvedValue([]);
    api.intakeDraftPath.mockImplementation(async (_r: string, _i: string, id: string) => `C:\\drafts\\${id}`);
    readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
  });

  async function mount(view: IntakeSessionView, drafts: AttachmentMeta[] = []) {
    useIntakeStore.setState({ root: ROOT, intakeId: view.id, session: view, drafts });
    root = createRoot(container);
    await act(async () => {
      root?.render(<Wrapper />);
    });
  }

  /** Renders the conversation of the store's current session. */
  function Wrapper() {
    const current = useIntakeStore((s) => s.session);
    return current ? <IntakeConversation session={current} /> : null;
  }

  function textarea() {
    return container.querySelector<HTMLTextAreaElement>(".intake-compose__input")!;
  }

  function sendButton() {
    return container.querySelector<HTMLButtonElement>(".intake-compose__send")!;
  }

  async function type(value: string) {
    const el = textarea();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(el: Element) {
    await act(async () => {
      (el as HTMLElement).click();
    });
  }

  it("renders each message kind", async () => {
    await mount(
      session({
        messages: [
          message("user", "I need export", { draftIds: ["d1"] }),
          message("assistant", "**Which** format?"),
          message("error", "INTAKE_TURN_TIMEOUT", { detail: "raw reply" }),
        ],
      }),
      [draft("d1", "spec.pdf", "application/pdf")],
    );
    const user = container.querySelector(".intake-message--user")!;
    expect(user.textContent).toContain("I need export");
    expect(user.querySelector(".intake-message__chip")?.textContent).toBe("spec.pdf");
    const assistant = container.querySelector(".intake-message--assistant")!;
    expect(assistant.querySelector("strong")?.textContent).toBe("Which");
    const error = container.querySelector(".intake-message--error")!;
    expect(error.textContent).toContain(formatCode("INTAKE_TURN_TIMEOUT"));
    expect(error.querySelector("details summary")?.textContent).toBe(t("intake.conversation.details"));
    expect(error.querySelector("details pre")?.textContent).toBe("raw reply");
  });

  it("shows the empty hint without messages", async () => {
    await mount(session());
    expect(container.textContent).toContain(t("intake.conversation.empty"));
  });

  it("renders assistant text inertly (no script, no handlers)", async () => {
    await mount(
      session({
        messages: [message("assistant", '<img src=x onerror="alert(1)"><script>alert(2)</script>')],
      }),
    );
    const body = container.querySelector(".intake-message--assistant")!;
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("[onerror]")).toBeNull();
  });

  it("renders user text as plain text", async () => {
    await mount(session({ messages: [message("user", "<b>bold</b>")] }));
    const user = container.querySelector(".intake-message--user")!;
    expect(user.querySelector("b")).toBeNull();
    expect(user.textContent).toContain("<b>bold</b>");
  });

  it("sends a question option as the answer", async () => {
    api.intakeSend.mockResolvedValue(session({ busy: true }));
    await mount(
      session({
        messages: [message("assistant", "Which format?")],
        lastQuestion: { text: "Which format?", options: ["CSV", "JSON"] },
      }),
    );
    const options = container.querySelectorAll<HTMLButtonElement>(".intake-question__option");
    expect([...options].map((b) => b.textContent)).toEqual(["CSV", "JSON"]);
    await click(options[1]);
    expect(api.intakeSend).toHaveBeenCalledWith(ROOT, "i1", "JSON", []);
  });

  it("hides question options while the agent is busy", async () => {
    await mount(
      session({
        busy: true,
        messages: [message("assistant", "Which format?")],
        lastQuestion: { text: "Which format?", options: ["CSV"] },
      }),
    );
    expect(container.querySelector(".intake-question__option")).toBeNull();
  });

  it("retries after the last error", async () => {
    api.intakeRetry.mockResolvedValue(session({ busy: true }));
    await mount(session({ messages: [message("user", "hi"), message("error", "INTAKE_TURN_FAILED")] }));
    const retry = container.querySelector<HTMLButtonElement>(".intake-message__retry")!;
    expect(retry.textContent).toBe(t("intake.conversation.retry"));
    await click(retry);
    expect(api.intakeRetry).toHaveBeenCalledWith(ROOT, "i1");
  });

  it("offers retry only on the last message", async () => {
    await mount(
      session({
        messages: [message("user", "hi"), message("error", "INTAKE_TURN_FAILED"), message("user", "again")],
      }),
    );
    expect(container.querySelector(".intake-message__retry")).toBeNull();
  });

  it("shows the thinking indicator with cancel while busy", async () => {
    api.intakeCancelTurn.mockResolvedValue(true);
    await mount(session({ busy: true, messages: [message("user", "hi")] }));
    expect(container.textContent).toContain(t("intake.conversation.thinking"));
    const cancel = container.querySelector<HTMLButtonElement>(".intake-thinking__cancel")!;
    await click(cancel);
    expect(api.intakeCancelTurn).toHaveBeenCalledWith(ROOT, "i1");
  });

  it("sends with Ctrl+Enter including the pending draft ids and clears the strip", async () => {
    api.intakeSend.mockResolvedValue(
      session({
        busy: true,
        messages: [message("user", "first", { draftIds: ["d1"] }), message("user", "hello", { draftIds: ["d2"] })],
      }),
    );
    await mount(session({ messages: [message("user", "first", { draftIds: ["d1"] })] }), [
      draft("d1", "old.txt", "text/plain"),
      draft("d2", "new.txt", "text/plain"),
    ]);
    // Drafts already sent with a message are not pending.
    expect([...container.querySelectorAll(".intake-drafts__name")].map((e) => e.textContent)).toEqual(["new.txt"]);
    await type("hello");
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(api.intakeSend).not.toHaveBeenCalled();
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(api.intakeSend).toHaveBeenCalledTimes(1);
    expect(api.intakeSend).toHaveBeenCalledWith(ROOT, "i1", "hello", ["d2"]);
    expect(textarea().value).toBe("");
    expect(container.querySelector(".intake-drafts__name")).toBeNull();
  });

  it("keeps the text when sending fails", async () => {
    api.intakeSend.mockRejectedValue({ code: "INTAKE_TURN_BUSY", message: "" });
    await mount(session());
    await type("hello");
    await click(sendButton());
    expect(textarea().value).toBe("hello");
  });

  it("sends only once while a send is in flight", async () => {
    let resolve!: (v: IntakeSessionView) => void;
    api.intakeSend.mockReturnValue(new Promise((r) => (resolve = r)));
    await mount(session());
    await type("hello");
    await click(sendButton());
    expect(sendButton().disabled).toBe(true);
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(api.intakeSend).toHaveBeenCalledTimes(1);
    await act(async () => resolve(session({ busy: true })));
  });

  it("disables send while empty or busy", async () => {
    await mount(session({ busy: true }));
    expect(sendButton().disabled).toBe(true);
    await type("hello");
    expect(sendButton().disabled).toBe(true);
    await act(async () => useIntakeStore.setState({ session: session() }));
    expect(sendButton().disabled).toBe(false);
    await type("   ");
    expect(sendButton().disabled).toBe(true);
  });

  it("allows sending drafts without text", async () => {
    await mount(session(), [draft("d1", "a.txt", "text/plain")]);
    expect(sendButton().disabled).toBe(false);
  });

  it("disables the conversation when the session is not active", async () => {
    await mount(
      session({
        status: "finalizing",
        messages: [message("assistant", "Q?"), message("error", "INTAKE_TURN_FAILED")],
        lastQuestion: { text: "Q?", options: ["A"] },
      }),
      [draft("d1", "a.txt", "text/plain")],
    );
    expect(container.textContent).toContain(t("intake.conversation.notActive"));
    expect(textarea().disabled).toBe(true);
    expect(sendButton().disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".intake-compose__attach")!.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>(".intake-message__retry")!.disabled).toBe(true);
    expect(container.querySelector(".intake-question__option")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>(".intake-drafts__remove")!.disabled).toBe(true);
  });

  it("adds pasted images as drafts and leaves text paste alone", async () => {
    api.intakeAddDraftBytes.mockResolvedValue(draft("d9", "shot.png", "image/png"));
    const readAsDataURL = vi.fn(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:image/png;base64,QUJD" });
      this.onload?.({} as ProgressEvent<FileReader>);
    });
    const OriginalReader = globalThis.FileReader;
    globalThis.FileReader = class {
      result: string | null = null;
      onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = readAsDataURL;
    } as unknown as typeof FileReader;
    try {
      await mount(session());
      const file = new File([new Uint8Array([65, 66, 67])], "shot.png", { type: "image/png" });
      const imagePaste = new Event("paste", { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown;
      };
      imagePaste.clipboardData = { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] };
      await act(async () => {
        textarea().dispatchEvent(imagePaste);
      });
      expect(imagePaste.defaultPrevented).toBe(true);
      expect(api.intakeAddDraftBytes).toHaveBeenCalledWith(ROOT, "i1", "shot.png", "QUJD");
      expect(container.querySelector(".intake-drafts__name")?.textContent).toBe("shot.png");

      const textPaste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      textPaste.clipboardData = { items: [{ kind: "string", type: "text/plain", getAsFile: () => null }] };
      await act(async () => {
        textarea().dispatchEvent(textPaste);
      });
      expect(textPaste.defaultPrevented).toBe(false);
      expect(api.intakeAddDraftBytes).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.FileReader = OriginalReader;
    }
  });

  it("attaches files chosen in the dialog", async () => {
    dialogOpen.mockResolvedValue(["C:\\a.txt", "C:\\b.png"]);
    api.intakeAddDraftPath.mockImplementation(async (_r: string, _i: string, path: string) =>
      draft(path.endsWith("a.txt") ? "da" : "db", path.slice(3), path.endsWith("a.txt") ? "text/plain" : "image/png"),
    );
    await mount(session());
    await click(container.querySelector(".intake-compose__attach")!);
    expect(dialogOpen).toHaveBeenCalledWith(expect.objectContaining({ multiple: true }));
    expect(api.intakeAddDraftPath).toHaveBeenNthCalledWith(1, ROOT, "i1", "C:\\a.txt");
    expect(api.intakeAddDraftPath).toHaveBeenNthCalledWith(2, ROOT, "i1", "C:\\b.png");
    expect([...container.querySelectorAll(".intake-drafts__name")].map((e) => e.textContent)).toEqual([
      "a.txt",
      "b.png",
    ]);
  });

  it("does nothing when the dialog is cancelled", async () => {
    dialogOpen.mockResolvedValue(null);
    await mount(session());
    await click(container.querySelector(".intake-compose__attach")!);
    expect(api.intakeAddDraftPath).not.toHaveBeenCalled();
  });

  it("removes a draft", async () => {
    api.intakeRemoveDraft.mockResolvedValue(undefined);
    await mount(session(), [draft("d1", "a.txt", "text/plain")]);
    await click(container.querySelector(".intake-drafts__remove")!);
    expect(api.intakeRemoveDraft).toHaveBeenCalledWith(ROOT, "i1", "d1");
    expect(container.querySelector(".intake-drafts__name")).toBeNull();
  });

  it("shows image thumbnails from blob URLs and revokes them", async () => {
    const created: string[] = [];
    const createSpy = vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = `blob:thumb-${created.length}`;
      created.push(url);
      return url;
    });
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    api.intakeRemoveDraft.mockResolvedValue(undefined);
    try {
      await mount(session(), [draft("d1", "a.png", "image/png"), draft("d2", "b.png", "image/png")]);
      expect(api.intakeDraftPath).toHaveBeenCalledWith(ROOT, "i1", "d1");
      expect(readFile).toHaveBeenCalledWith("C:\\drafts\\d1");
      const thumbs = [...container.querySelectorAll<HTMLImageElement>(".intake-drafts__thumb")];
      expect(thumbs.map((img) => img.getAttribute("src"))).toEqual(["blob:thumb-0", "blob:thumb-1"]);
      // Removing a draft revokes its URL.
      await click(container.querySelector(".intake-drafts__remove")!);
      expect(revokeSpy).toHaveBeenCalledWith("blob:thumb-0");
      expect(revokeSpy).not.toHaveBeenCalledWith("blob:thumb-1");
      await act(async () => root?.unmount());
      root = undefined;
      expect(revokeSpy).toHaveBeenCalledWith("blob:thumb-1");
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("revokes a thumbnail that finishes loading after unmount", async () => {
    let resolveBytes!: (v: Uint8Array) => void;
    readFile.mockReturnValue(new Promise((r) => (resolveBytes = r)));
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      await mount(session(), [draft("d1", "a.png", "image/png")]);
      await act(async () => root?.unmount());
      root = undefined;
      await act(async () => resolveBytes(new Uint8Array([1])));
      // Never shown, so no URL is kept alive.
      expect(createSpy.mock.calls.length).toBe(revokeSpy.mock.calls.length);
    } finally {
      createSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  it("appends voice transcripts to the message", async () => {
    useSettingsStore.setState({ speechEnabled: true });
    await mount(session());
    await type("hello");
    const voice = container.querySelector<HTMLButtonElement>(".intake-compose__voice")!;
    expect(voice.getAttribute("aria-label")).toBe(t("intake.compose.voice"));
    await click(voice);
    expect(speech.toggle).toHaveBeenCalled();
    speech.transcript = "world";
    // Any re-render picks up the hook's new transcript.
    await act(async () => useIntakeStore.setState({ session: session() }));
    expect(textarea().value).toBe("hello world");
    expect(speech.setTranscript).toHaveBeenCalledWith("");
  });

  it("hides the voice button when speech input is disabled", async () => {
    await mount(session());
    expect(container.querySelector(".intake-compose__voice")).toBeNull();
  });

  it("keeps typed text when answering with an option", async () => {
    api.intakeSend.mockResolvedValue(session({ busy: true }));
    await mount(
      session({
        messages: [message("assistant", "Which format?")],
        lastQuestion: { text: "Which format?", options: ["CSV"] },
      }),
    );
    await type("draft note");
    await click(container.querySelector(".intake-question__option")!);
    expect(api.intakeSend).toHaveBeenCalledWith(ROOT, "i1", "CSV", []);
    expect(textarea().value).toBe("draft note");
  });

  it("disables retry while sending and send and options while retrying", async () => {
    await mount(session({ messages: [message("assistant", "Q?"), message("error", "INTAKE_TURN_FAILED")] }));
    await type("hello");
    await act(async () => useIntakeStore.setState({ sending: true }));
    expect(container.querySelector<HTMLButtonElement>(".intake-message__retry")!.disabled).toBe(true);
    await act(async () => useIntakeStore.setState({ sending: false, retrying: true }));
    expect(sendButton().disabled).toBe(true);
    await act(async () =>
      useIntakeStore.setState({
        session: session({ messages: [message("assistant", "Q?")], lastQuestion: { text: "Q?", options: ["A"] } }),
      }),
    );
    expect(container.querySelector<HTMLButtonElement>(".intake-question__option")!.disabled).toBe(true);
  });

  it("skips oversized pasted images and reports all failures at once", async () => {
    api.intakeAddDraftBytes.mockRejectedValue({ code: "ATTACHMENT_TOO_MANY", message: "" });
    const readAsDataURL = vi.fn(function (this: FileReader) {
      Object.defineProperty(this, "result", { value: "data:image/png;base64,QUJD" });
      this.onload?.({} as ProgressEvent<FileReader>);
    });
    const OriginalReader = globalThis.FileReader;
    globalThis.FileReader = class {
      result: string | null = null;
      onload: ((e: ProgressEvent<FileReader>) => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL = readAsDataURL;
    } as unknown as typeof FileReader;
    try {
      await mount(session());
      const big = new File([new Uint8Array(1)], "big.png", { type: "image/png" });
      Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
      const small = new File([new Uint8Array(1)], "", { type: "image/bmp" });
      const paste = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      paste.clipboardData = {
        items: [
          { kind: "file", type: "image/png", getAsFile: () => big },
          { kind: "file", type: "image/bmp", getAsFile: () => small },
        ],
      };
      await act(async () => {
        textarea().dispatchEvent(paste);
      });
      // The oversized image is never read or sent.
      expect(readAsDataURL).toHaveBeenCalledTimes(1);
      expect(api.intakeAddDraftBytes).toHaveBeenCalledTimes(1);
      expect(api.intakeAddDraftBytes).toHaveBeenCalledWith(ROOT, "i1", "image.png", "QUJD");
      expect(showMessage).toHaveBeenCalledTimes(1);
      const [text, options] = vi.mocked(showMessage).mock.calls[0];
      expect(text).toBe(
        [
          t("intake.compose.addFailedItem", { name: "big.png", reason: formatCode("ATTACHMENT_TOO_LARGE") }),
          t("intake.compose.addFailedItem", { name: "image.png", reason: formatCode("ATTACHMENT_TOO_MANY") }),
        ].join("\n"),
      );
      expect(options).toEqual(expect.objectContaining({ title: t("intake.compose.addFailed"), kind: "error" }));
    } finally {
      globalThis.FileReader = OriginalReader;
    }
  });

  it("reports failed attachments in one message", async () => {
    dialogOpen.mockResolvedValue(["C:\\dir\\a.txt", "C:\\dir\\b.txt"]);
    api.intakeAddDraftPath.mockRejectedValue({ code: "ATTACHMENT_NOT_A_FILE", message: "" });
    await mount(session());
    await click(container.querySelector(".intake-compose__attach")!);
    expect(showMessage).toHaveBeenCalledTimes(1);
    const text = vi.mocked(showMessage).mock.calls[0][0];
    expect(text).toContain(t("intake.compose.addFailedItem", { name: "a.txt", reason: formatCode("ATTACHMENT_NOT_A_FILE") }));
    expect(text).toContain(t("intake.compose.addFailedItem", { name: "b.txt", reason: formatCode("ATTACHMENT_NOT_A_FILE") }));
  });

  it("keeps voice stop enabled while recording in an inactive session", async () => {
    useSettingsStore.setState({ speechEnabled: true });
    speech.status = "recording";
    await mount(session({ status: "finalizing" }));
    const voice = container.querySelector<HTMLButtonElement>(".intake-compose__voice")!;
    expect(voice.getAttribute("aria-label")).toBe(t("intake.compose.voiceStop"));
    expect(voice.disabled).toBe(false);
  });

  it("announces new agent replies and errors, not the history", async () => {
    await mount(session({ messages: [message("assistant", "Old reply")] }));
    const live = container.querySelector("[aria-live='polite']")!;
    expect(live.textContent).toBe("");
    await act(async () =>
      useIntakeStore.setState({
        session: session({ messages: [message("assistant", "Old reply"), message("error", "INTAKE_TURN_TIMEOUT")] }),
      }),
    );
    expect(live.textContent).toBe(
      t("intake.conversation.announce", { role: t("intake.conversation.error"), text: formatCode("INTAKE_TURN_TIMEOUT") }),
    );
  });

  it("follows new messages only while scrolled to the bottom", async () => {
    const withMessages = (...texts: string[]) =>
      act(async () => useIntakeStore.setState({ session: session({ messages: texts.map((x) => message("assistant", x)) }) }));
    await mount(session({ messages: [message("assistant", "a")] }));
    const list = container.querySelector<HTMLDivElement>(".intake-messages")!;
    Object.defineProperty(list, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(list, "clientHeight", { configurable: true, value: 200 });
    // Scrolled up: new content does not move the view.
    list.scrollTop = 100;
    await act(async () => list.dispatchEvent(new Event("scroll")));
    await withMessages("a", "b");
    expect(list.scrollTop).toBe(100);
    // Back at the bottom: it follows again.
    list.scrollTop = 800;
    await act(async () => list.dispatchEvent(new Event("scroll")));
    await withMessages("a", "b", "c");
    expect(list.scrollTop).toBe(1000);
  });
});

describe("compose helpers", () => {
  it("names pasted images with a safe extension", () => {
    expect(pastedImageName("image/png")).toBe("image.png");
    expect(pastedImageName("image/jpeg")).toBe("image.jpg");
    expect(pastedImageName("image/GIF")).toBe("image.gif");
    expect(pastedImageName("image/webp")).toBe("image.webp");
    expect(pastedImageName("image/svg+xml")).toBe("image.png");
    expect(pastedImageName("image/../x")).toBe("image.png");
  });

  it("separates transcript chunks with a space when needed", () => {
    expect(appendTranscript("", "hi")).toBe("hi");
    expect(appendTranscript("hello", "world")).toBe("hello world");
    expect(appendTranscript("hello ", "world")).toBe("hello world");
    expect(appendTranscript("hello", " world")).toBe("hello world");
  });
});
