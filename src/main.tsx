import "./features/code-editor/lib/monaco-setup";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app/App";
import { IntakeRoot } from "./features/intake/IntakeRoot";
import { selectRoot } from "./features/intake/select-root";
import "./shared/i18n";
import "./shared/styles/switch.css";

const selection = selectRoot(window.location.search);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {selection.view === "intake" ? (
      <IntakeRoot root={selection.root} intakeId={selection.intakeId} workflowId={selection.workflowId} />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
