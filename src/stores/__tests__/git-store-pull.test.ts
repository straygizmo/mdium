import { describe, it, expect, beforeEach, vi } from "vitest";

// The git store imports tauri's invoke and the opencode chat module at load
// time. Stub both so the store can be exercised in a plain node test env
// without a real backend.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("@/features/opencode-config/hooks/useOpencodeChat", () => ({
  getOpencodeClient: () => null,
  useChatUIStore: { getState: () => ({ connected: false }) },
}));

import { useGitStore } from "../git-store";

const FOLDER = "C:/repo";

/** Default backend responses: a clean repo on main with one upstream. */
function stubBackend(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    git_status_porcelain: "",
    git_branch_list: "* main\n  remotes/origin/main\n",
    git_current_branch: "main",
    git_get_remote_url: "https://example.com/repo.git",
    git_commits_ahead: 0,
    git_commits_behind: 0,
    git_fetch: "",
    git_log_graph: "",
    git_pull: "Already up to date.\n",
    ...overrides,
  };
  invokeMock.mockImplementation((cmd: string) => {
    const value = responses[cmd];
    if (value instanceof Error) return Promise.reject(value.message);
    return Promise.resolve(value ?? "");
  });
}

function calls(cmd: string) {
  return invokeMock.mock.calls.filter((c) => c[0] === cmd);
}

describe("git-store pull", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    useGitStore.getState().reset();
  });

  it("invokes git_pull and refreshes status afterwards", async () => {
    stubBackend();

    await useGitStore.getState().pull(FOLDER);

    expect(calls("git_pull")).toEqual([["git_pull", { path: FOLDER }]]);
    // refresh() re-queries status after the pull completed
    expect(calls("git_status_porcelain").length).toBeGreaterThan(0);
    expect(useGitStore.getState().error).toBeNull();
    expect(useGitStore.getState().loading).toBe(false);
  });

  it("surfaces the git error and still refreshes the file list on failure", async () => {
    stubBackend({
      git_pull: new Error("CONFLICT (content): Merge conflict in a.md"),
      git_status_porcelain: "UU a.md\n",
    });

    await useGitStore.getState().pull(FOLDER);

    const state = useGitStore.getState();
    expect(state.error).toContain("CONFLICT");
    // The conflicted file must be visible so the user can resolve it
    expect(state.files.map((f) => f.path)).toContain("a.md");
    expect(state.loading).toBe(false);
  });

  it("tracks how many commits the branch is behind its upstream", async () => {
    stubBackend({ git_commits_behind: 2 });

    await useGitStore.getState().refresh(FOLDER);
    // refresh() kicks off the ahead/behind queries without awaiting them
    await vi.waitFor(() => {
      expect(useGitStore.getState().commitsBehind).toBe(2);
    });
  });

  it("exposes fetch failures from refreshGraph instead of swallowing them", async () => {
    stubBackend({ git_fetch: new Error("fatal: could not read Username") });

    await useGitStore.getState().refreshGraph(FOLDER);

    expect(useGitStore.getState().fetchError).toContain("could not read Username");
    // The graph itself still loads from the local refs
    expect(calls("git_log_graph").length).toBe(1);
  });

  it("clears a previous fetch error once fetch succeeds", async () => {
    stubBackend();
    useGitStore.setState({ fetchError: "old failure" });

    await useGitStore.getState().refreshGraph(FOLDER);

    expect(useGitStore.getState().fetchError).toBeNull();
  });

  it("reset clears pull-related state", () => {
    useGitStore.setState({ commitsBehind: 3, fetchError: "x" });

    useGitStore.getState().reset();

    expect(useGitStore.getState().commitsBehind).toBe(0);
    expect(useGitStore.getState().fetchError).toBeNull();
  });
});
