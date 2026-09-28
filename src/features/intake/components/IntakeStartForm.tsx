import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ForgeProbe, ForgeRepo, IntakeKind, Provider, Workflow } from "@/shared/types/workflow";
import {
  availabilityFromProbes,
  PROVIDERS,
  providerLabel,
} from "@/features/workflow/lib/provider-options";
import { useIntakeStore } from "../intake-store";
import "./IntakeStartForm.css";

const KINDS: readonly IntakeKind[] = ["feature", "bug"];

/** Provider and model the intake agent runs on by default: the workflow's design stage. */
function designDefaults(workflow: Workflow): { provider: Provider; model: string } {
  const design = workflow.stages.find((s) => s.role === "design") ?? workflow.stages[0];
  return { provider: design?.provider ?? PROVIDERS[0], model: design?.model ?? "" };
}

/** Where the Issue would be created, or the i18n key suffix of why it cannot be. */
export type IssueTarget = { repo: ForgeRepo } | { reason: "checkFailed" | "noRepo" | "cliMissing" | "unauthenticated" };

export function issueTarget(forge: ForgeProbe | null): IssueTarget {
  if (!forge) return { reason: "checkFailed" };
  if (!forge.repo) return { reason: "noRepo" };
  if (!forge.cliAvailable) return { reason: "cliMissing" };
  if (!forge.authenticated) return { reason: "unauthenticated" };
  return { repo: forge.repo };
}

/** The user's provider/model choice for one workflow (reset when another is selected). */
interface AgentChoice {
  workflowId: string;
  provider: Provider;
  model: string;
}

export interface IntakeStartFormProps {
  /** Workflow preselected by the main window (`?workflow=`), if any. */
  initialWorkflowId: string | null;
}

/** Chooses the workflow, kind and agent of a new intake and starts it. */
export function IntakeStartForm({ initialWorkflowId }: IntakeStartFormProps) {
  const { t } = useTranslation("workflow");
  const workflows = useIntakeStore((s) => s.workflows);
  const probes = useIntakeStore((s) => s.providers);
  const forge = useIntakeStore((s) => s.forge);
  const creating = useIntakeStore((s) => s.creating);
  const handOff = useIntakeStore((s) => s.handOff);
  // Nothing can be changed or started once a session was created here.
  const locked = creating || handOff !== null;
  const ids = useId();
  const titleId = `${ids}-title`;
  const providerWarningId = `${ids}-provider-warning`;
  const usable = useMemo(() => workflows.filter((w) => w.enabled && !w.archived), [workflows]);
  // Re-localize the reasons when the language changes.
  const availability = useMemo(() => availabilityFromProbes(probes), [probes, t]);
  const [workflowId, setWorkflowId] = useState<string | null>(initialWorkflowId);
  const [kind, setKind] = useState<IntakeKind>("feature");
  const [choice, setChoice] = useState<AgentChoice | null>(null);

  // Fall back to the first usable workflow when none (or an unusable or vanished one) is selected.
  const selected = usable.find((w) => w.id === workflowId) ?? usable[0] ?? null;
  const agent = selected
    ? choice?.workflowId === selected.id
      ? choice
      : { workflowId: selected.id, ...designDefaults(selected) }
    : null;
  const issue = issueTarget(forge);

  const patchAgent = (p: Partial<Pick<AgentChoice, "provider" | "model">>) => {
    if (agent) setChoice({ ...agent, ...p });
  };

  const start = () => {
    if (!selected || !agent || locked) return;
    const model = agent.model.trim();
    void useIntakeStore
      .getState()
      .create({ workflowId: selected.id, kind, provider: agent.provider, model: model || null });
  };

  return (
    <form
      className="intake-start"
      aria-labelledby={titleId}
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      <h2 id={titleId} className="intake-start__title">
        {t("intake.start.title")}
      </h2>
      <p className="intake-start__description">{t("intake.start.description")}</p>

      <fieldset className="intake-start__fields" disabled={locked}>
        {selected && agent ? (
          <>
            <label className="intake-start__field">
              <span>{t("intake.start.workflow")}</span>
              <select name="workflow" value={selected.id} onChange={(e) => setWorkflowId(e.target.value)}>
                {usable.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="intake-start__kinds">
              <legend>{t("intake.start.kind")}</legend>
              {KINDS.map((k) => (
                <label key={k} className="intake-start__kind">
                  <input
                    type="radio"
                    name="kind"
                    value={k}
                    checked={kind === k}
                    aria-describedby={`${ids}-${k}-help`}
                    onChange={() => setKind(k)}
                  />
                  <span className="intake-start__kind-label">{t(`intake.kind.${k}`)}</span>
                  <span id={`${ids}-${k}-help`} className="intake-start__help">
                    {t(`intake.start.${k}Help`)}
                  </span>
                </label>
              ))}
            </fieldset>

            <div className="intake-start__row">
              <label className="intake-start__field">
                <span>{t("intake.start.provider")}</span>
                <select
                  name="provider"
                  value={agent.provider}
                  aria-describedby={availability[agent.provider] ? providerWarningId : undefined}
                  onChange={(e) => patchAgent({ provider: e.target.value as Provider })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {providerLabel(p, availability)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="intake-start__field">
                <span>{t("intake.start.model")}</span>
                <input
                  type="text"
                  name="model"
                  value={agent.model}
                  placeholder={t("intake.start.modelPlaceholder")}
                  onChange={(e) => patchAgent({ model: e.target.value })}
                />
              </label>
            </div>
            {availability[agent.provider] && (
              <p id={providerWarningId} className="intake-start__warning">
                {providerLabel(agent.provider, availability)}
              </p>
            )}

            {selected.issueTracking === "auto" && (
              <p className={`intake-start__issue${"reason" in issue ? " intake-start__issue--unavailable" : ""}`}>
                {"reason" in issue
                  ? t("intake.start.issueUnavailable", { reason: t(`intake.start.forgeReason.${issue.reason}`) })
                  : t("intake.start.issueWillCreate", { host: issue.repo.host, path: issue.repo.path })}
              </p>
            )}
          </>
        ) : (
          <p className="intake-start__none">{t("intake.start.noWorkflows")}</p>
        )}

        <div className="intake-start__buttons">
          <button type="submit" className="intake-start__submit" disabled={locked || !selected}>
            {creating ? t("intake.start.starting") : t("intake.start.start")}
          </button>
        </div>
      </fieldset>

      {handOff && <HandOffNotice />}
    </form>
  );
}

/** State of a session created here: its window opened, or opening it failed. */
function HandOffNotice() {
  const { t } = useTranslation("workflow");
  const handOff = useIntakeStore((s) => s.handOff);
  const creating = useIntakeStore((s) => s.creating);
  if (!handOff) return null;
  const failed = handOff.error !== null;
  // Before the first open attempt settles there is nothing to report yet.
  if (!failed && !handOff.windowOpened) return null;
  return (
    <div className="intake-start__handoff" role={failed ? "alert" : "status"}>
      <p className="intake-start__handoff-text">
        {failed ? t("intake.start.handOffFailed") : t("intake.start.handedOff")}
      </p>
      {failed && <pre className="intake-start__handoff-detail">{handOff.error}</pre>}
      <div className="intake-start__buttons">
        {failed && (
          <button
            type="button"
            className="intake-start__retry"
            disabled={creating}
            onClick={() => void useIntakeStore.getState().retryHandOff()}
          >
            {t("intake.start.openAgain")}
          </button>
        )}
        <button
          type="button"
          className="intake-start__close"
          onClick={() => void useIntakeStore.getState().closeWindow()}
        >
          {t("detail.close")}
        </button>
      </div>
    </div>
  );
}
