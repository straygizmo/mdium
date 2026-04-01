import type { ReactNode } from "react";
import type { Scope } from "./ScopeToggle";

interface ScopeFormWrapperProps {
  scope: Scope;
  children: ReactNode;
}

export function ScopeFormWrapper({ scope, children }: ScopeFormWrapperProps) {
  return (
    <div className={`oc-section__scope-form oc-section__scope-form--${scope}`}>
      {children}
    </div>
  );
}
