import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Tracks opencode plugin On/Off state that cannot live in opencode.jsonc.
 *
 * opencode's `plugin` field is a plain string array with no per-entry enable
 * flag, and its config schema rejects unknown keys (Zod `.strict()`), so a
 * disabled plugin simply must NOT appear in `plugin`. To still show a disabled
 * plugin in the list (with its toggle off) we remember its spec here, in
 * mdium-local persisted state. Enabled plugins are recoverable from
 * opencode.jsonc directly, so only the disabled set needs persisting.
 *
 * This state is global (the `plugin` array lives in the global config).
 */
interface OpencodePluginStateStore {
  /** Specs that are known/listed but currently disabled (absent from opencode.jsonc). */
  disabledSpecs: string[];
  /** Mark a spec disabled (keep it listed, but absent from the plugin array). */
  disable: (spec: string) => void;
  /** Clear the disabled flag for a spec (on enable or on delete). */
  clearDisabled: (spec: string) => void;
}

export const useOpencodePluginStateStore = create<OpencodePluginStateStore>()(
  persist(
    (set) => ({
      disabledSpecs: [],
      disable: (spec) =>
        set((s) =>
          s.disabledSpecs.includes(spec)
            ? s
            : { disabledSpecs: [...s.disabledSpecs, spec] }
        ),
      clearDisabled: (spec) =>
        set((s) => ({ disabledSpecs: s.disabledSpecs.filter((x) => x !== spec) })),
    }),
    { name: "mdium-opencode-disabled-plugins" }
  )
);
