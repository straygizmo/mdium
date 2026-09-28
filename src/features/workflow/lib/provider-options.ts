import i18n from "@/shared/i18n";
import type { Provider, ProviderProbe } from "@/shared/types/workflow";
import { isRecord } from "./errors";
import { formatCode } from "./format";

/** Every provider a stage or intake can run on, in display order. */
export const PROVIDERS: readonly Provider[] = ["codex", "copilot", "opencode", "claude"];

/** Availability kinds with their own localized label. */
const AVAILABILITY_KINDS = new Set(["missing", "unauthenticated", "too_old", "error"]);

/** Machine code shape used by the backend (`WORKFLOW_NAME_EMPTY`, ...). */
const CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

/** Localized reason a provider cannot be used per provider; null when it is available. */
export type ProviderAvailability = Partial<Record<Provider, string | null>>;

/** Localized reason a provider cannot be used, or null when it is available. */
export function unavailableReason(result: unknown): string | null {
  if (!isRecord(result)) return i18n.t("workflow:edit.availability.error");
  const kind = typeof result.kind === "string" ? result.kind : "";
  if (kind === "available") return null;
  const detail = typeof result.detail === "string" ? result.detail : "";
  const label = AVAILABILITY_KINDS.has(kind) ? i18n.t(`workflow:edit.availability.${kind}`) : formatCode(kind);
  return CODE_PATTERN.test(detail) ? `${label}: ${formatCode(detail)}` : label;
}

/**
 * Localized availability of every probed provider. Providers missing from
 * `probes` are left out (shown without availability).
 */
export function availabilityFromProbes(probes: readonly ProviderProbe[]): ProviderAvailability {
  const next: ProviderAvailability = {};
  for (const probe of probes) next[probe.provider] = unavailableReason(probe.result);
  return next;
}

/** Option label of a provider: its name, plus the reason when it is unavailable. */
export function providerLabel(provider: Provider, availability: ProviderAvailability): string {
  const name = i18n.t(`workflow:provider.${provider}`);
  const reason = availability[provider];
  return reason ? i18n.t("workflow:edit.unavailable", { provider: name, reason }) : name;
}
