import { useTranslation } from "react-i18next";
import type { SidecarPermissionRequest } from "@/shared/types/claude-sidecar";

interface Props {
  request: SidecarPermissionRequest;
  onRespond: (id: string, behavior: "allow" | "deny") => void;
}

export function PermissionCard({ request, onRespond }: Props) {
  const { t } = useTranslation("claude-config");
  return (
    <div className="claude-permission">
      <div className="claude-permission__title">{t("permissionTitle")}</div>
      <div className="claude-permission__tool">{request.toolName}</div>
      <pre className="claude-permission__input">
        {JSON.stringify(request.input, null, 2)}
      </pre>
      <div className="claude-permission__actions">
        <button
          className="claude-permission__btn claude-permission__btn--allow"
          onClick={() => onRespond(request.id, "allow")}
        >
          {t("allow")}
        </button>
        <button
          className="claude-permission__btn"
          onClick={() => onRespond(request.id, "deny")}
        >
          {t("deny")}
        </button>
      </div>
    </div>
  );
}
