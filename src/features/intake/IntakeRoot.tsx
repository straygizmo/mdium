import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settings-store";
import { startSettingsSync } from "@/shared/lib/settings-sync";
import { AppDialog } from "@/shared/components/AppDialog";
import "./IntakeRoot.css";

export interface IntakeRootProps {
  /** Normalized project root passed by the main window. */
  root: string;
  /** Existing intake to open, or null to start a new one. */
  intakeId: string | null;
}

/** Top-level component of the intake window. */
export function IntakeRoot({ root, intakeId }: IntakeRootProps) {
  const { t } = useTranslation("workflow");

  useEffect(() => {
    useSettingsStore.getState().initializeTheme();
  }, []);

  // Follow theme and language changes made in the main window.
  useEffect(() => startSettingsSync(), []);

  // Re-run when the language changes so the title follows it.
  useEffect(() => {
    getCurrentWindow()
      .setTitle(t("intake.windowTitle"))
      .catch((err) => console.error("[intake] setTitle failed", err));
  }, [t]);

  return (
    <div className="intake-root" data-root={root} data-intake-id={intakeId ?? ""}>
      {/* Placeholder until the intake app is mounted here. */}
      <h1 className="intake-root__placeholder">{t("intake.windowTitle")}</h1>
      <AppDialog />
    </div>
  );
}
