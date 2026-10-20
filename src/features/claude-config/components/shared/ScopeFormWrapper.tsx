import type { ReactNode } from "react";
import type { Scope } from "./ScopeToggle";

interface ScopeFormWrapperProps {
  scope: Scope;
  children: ReactNode;
}

export function ScopeFormWrapper({ scope, children }: ScopeFormWrapperProps) {
  return (
    <div className={`claude-section__scope-form claude-section__scope-form--${scope}`}>
      {children}
    </div>
  );
}
