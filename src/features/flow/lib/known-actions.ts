// Mirrors `KNOWN_ACTIONS` in src-tauri/crates/flow-core/src/model.rs (derived from `ACTION_SPECS`), same order.
export const KNOWN_ACTIONS = [
  "mdium/screen-input",
  "mdium/git-worktree-create",
  "mdium/design-doc-commit",
  "mdium/issue-entry",
  "mdium/git-merge-local",
  "mdium/issue-close",
  "mdium/git-worktree-discard",
  "mdium/project-setup",
  "mdium/flow-run-latest",
  "mdium/metrics-compare",
];

/** Inputs of each built-in action; mirrors `ACTION_SPECS` in flow-core (`required` = no default). */
export const ACTION_INPUTS: Record<string, { name: string; required: boolean }[]> = {
  "mdium/screen-input": [{ name: "text", required: true }],
  "mdium/git-worktree-create": [{ name: "title", required: true }],
  "mdium/design-doc-commit": [
    { name: "worktree", required: true },
    { name: "docPath", required: true },
    { name: "title", required: true },
    { name: "body", required: true },
  ],
  "mdium/issue-entry": [
    { name: "issue", required: true },
    { name: "entry", required: true },
    { name: "body", required: true },
    { name: "returned", required: false },
    { name: "worktree", required: false },
  ],
  "mdium/git-merge-local": [
    { name: "worktree", required: true },
    { name: "acknowledgeReviewPaths", required: false },
  ],
  "mdium/issue-close": [{ name: "issue", required: true }],
  "mdium/git-worktree-discard": [{ name: "worktree", required: true }],
  "mdium/project-setup": [{ name: "projectRoot", required: false }],
  "mdium/flow-run-latest": [{ name: "flow", required: true }],
  "mdium/metrics-compare": [
    { name: "baseline", required: true },
    { name: "candidate", required: true },
  ],
};
