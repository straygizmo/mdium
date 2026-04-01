import { useMemo } from "react";
import type { Scope } from "../components/shared/ScopeToggle";

export interface ScopeItem<T> {
  scope: Scope;
  data: T;
}

export function useScopeItems<T>(
  globalItems: T[],
  projectItems: T[]
): ScopeItem<T>[] {
  return useMemo(
    () => [
      ...globalItems.map((data) => ({ scope: "global" as const, data })),
      ...projectItems.map((data) => ({ scope: "project" as const, data })),
    ],
    [globalItems, projectItems]
  );
}
