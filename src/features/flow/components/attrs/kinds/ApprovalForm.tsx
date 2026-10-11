import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowApprovalNode } from "@/shared/types/flow";
import { StringListEditor } from "../StringListEditor";
import { TextField } from "../fields";
import type { KindFormProps } from "./types";

type Option = NonNullable<FlowApprovalNode["options"]>[number];

const nameOf = (option: Option): string => (typeof option === "string" ? option : option.name);
const requiresComment = (option: Option): boolean => typeof option !== "string" && option.commentRequired === true;

/** A row with `commentRequired` false serializes to a plain string. */
const toOption = (name: string, commentRequired: boolean): Option => (commentRequired ? { name, commentRequired: true } : name);

export function ApprovalForm({ node, path, onChange }: KindFormProps<FlowApprovalNode>) {
  const { t } = useTranslation("flow");
  const [draft, setDraft] = useState("");
  const write = (patch: Partial<FlowApprovalNode>) => onChange(path, patch);
  const options = node.options ?? [];
  const writeOptions = (next: Option[]) => write({ options: next.length === 0 ? undefined : next });
  const add = () => {
    const name = draft.trim();
    if (name === "") return;
    writeOptions([...options, name]);
    setDraft("");
  };
  return (
    <div className="flow-attrs">
      <TextField label={t("attrs.message")} multiline value={node.message} onCommit={(message) => write({ message })} />
      <div className="flow-attrs__field">
        <span>{t("attrs.show")}</span>
        <StringListEditor
          items={node.show ?? []}
          addLabel={t("attrs.addRow")}
          onChange={(items) => write({ show: items.length === 0 ? undefined : items })}
        />
      </div>
      <div className="flow-attrs__field">
        <span>{t("attrs.options")}</span>
        <div className="flow-attrs__list">
          {options.map((option, i) => (
            <div key={`${i}:${nameOf(option)}`} className="flow-attrs__row">
              <input
                type="text"
                aria-label={t("attrs.optionName")}
                defaultValue={nameOf(option)}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name === nameOf(option)) return;
                  writeOptions(name === "" ? options.filter((_, j) => j !== i) : options.map((o, j) => (j === i ? toOption(name, requiresComment(o)) : o)));
                }}
              />
              <label className="flow-attrs__check">
                <input
                  type="checkbox"
                  checked={requiresComment(option)}
                  onChange={(e) => writeOptions(options.map((o, j) => (j === i ? toOption(nameOf(o), e.target.checked) : o)))}
                />
                <span>{t("attrs.commentRequired")}</span>
              </label>
              <button type="button" onClick={() => writeOptions(options.filter((_, j) => j !== i))}>
                {t("attrs.remove")}
              </button>
            </div>
          ))}
          <div className="flow-attrs__row">
            <input
              type="text"
              aria-label={t("attrs.optionName")}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
            <button type="button" onClick={add}>
              {t("attrs.addRow")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
