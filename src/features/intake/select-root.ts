export type RootSelection =
  | { view: "main" }
  | { view: "intake"; root: string; intakeId: string | null };

/** Decide which top-level UI a window renders from its URL query string. */
export function selectRoot(search: string): RootSelection {
  const params = new URLSearchParams(search);
  if (params.get("view") !== "intake") return { view: "main" };
  return {
    view: "intake",
    root: params.get("root") ?? "",
    intakeId: params.get("intake") || null,
  };
}
