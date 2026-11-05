import { useEffect, useState } from "react";
import type { Change, IdGenerator, Project, Variable, VariableType } from "../../core/index.ts";
import {
  addVariable,
  changeVariableType,
  createVariable,
  isValidVariableName,
  removeVariable,
  uniqueVariableName,
  updateVariable,
  withEnumOptions,
} from "../../core/index.ts";
import { NumberField } from "../components/NumberField.tsx";
import type { UiStrings } from "../strings.ts";

const TYPES: readonly VariableType[] = ["bool", "int", "float", "string", "enum"];
/** Rows rendered at once; the search narrows larger lists (DOM size stays bounded). */
const MAX_SHOWN = 100;

export interface VariablesPanelProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
}

/** Project variables (flags, counters, quest states) used by expressions. */
export function VariablesPanel({ strings, project, newId, commit }: VariablesPanelProps) {
  const s = strings.variables;
  const [query, setQuery] = useState("");
  const all = project.manifest.variables;
  const q = query.trim().toLowerCase();
  const matching = q === "" ? all : all.filter((v) => v.name.toLowerCase().includes(q));
  const shown = matching.slice(0, MAX_SHOWN);

  return (
    <section className="card" aria-labelledby="variables-heading">
      <h2 id="variables-heading">
        {s.heading}
        {all.length > 0 && <span className="badge">{all.length}</span>}
      </h2>
      <p className="muted small">{s.hint}</p>
      {all.length > MAX_SHOWN && (
        <div className="field">
          <label htmlFor="variables-search">{s.search}</label>
          <input id="variables-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      {all.length === 0 ? (
        <p className="muted">{s.empty}</p>
      ) : (
        <ul className="variables">
          {shown.map((v) => (
            <VariableRow key={v.id} strings={strings} project={project} variable={v} newId={newId} commit={commit} />
          ))}
        </ul>
      )}
      {matching.length > shown.length && <p className="muted">{s.moreHidden(matching.length - shown.length)}</p>}
      <div className="actions">
        <button type="button" onClick={() => commit(addVariable(project, createVariable(newId, uniqueVariableName(project, s.defaultName), "bool")))}>
          {s.add}
        </button>
      </div>
    </section>
  );
}

interface RowProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly variable: Variable;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
}

function VariableRow({ strings, project, variable: v, newId, commit }: RowProps) {
  const s = strings.variables;
  const base = `var-${v.id}`;
  const update = (next: Variable) => commit(updateVariable(project, next));

  return (
    <li className="variable">
      <CommitText
        id={`${base}-name`}
        label={s.name}
        value={v.name}
        isValid={(name) => isValidVariableName(project, name, v.id)}
        invalidMessage={s.nameInvalid}
        onCommit={(name) => update({ ...v, name })}
      />
      <div className="field">
        <label htmlFor={`${base}-type`}>{s.type}</label>
        <select id={`${base}-type`} value={v.type} onChange={(e) => update(changeVariableType(v, e.target.value as VariableType, newId))}>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {s.types[t] ?? t}
            </option>
          ))}
        </select>
      </div>
      {v.type === "bool" && (
        <div className="field">
          <label htmlFor={`${base}-default`}>{s.defaultValue}</label>
          <select id={`${base}-default`} value={v.default ? "true" : "false"} onChange={(e) => update({ ...v, default: e.target.value === "true" })}>
            <option value="false">{strings.variables.boolValues.false}</option>
            <option value="true">{strings.variables.boolValues.true}</option>
          </select>
        </div>
      )}
      {(v.type === "int" || v.type === "float") && (
        <NumberField
          id={`${base}-default`}
          label={s.defaultValue}
          value={v.default}
          invalidMessage={strings.tables.invalidValue}
          isValid={(n) => n !== null && (v.type === "float" || Number.isSafeInteger(n))}
          onCommit={(n) => update({ ...v, default: n ?? 0 })}
        />
      )}
      {v.type === "string" && (
        <CommitText id={`${base}-default`} label={s.defaultValue} value={v.default} isValid={(t) => t.length <= 10_000} invalidMessage={strings.tables.invalidValue} onCommit={(t) => update({ ...v, default: t })} />
      )}
      {v.type === "enum" && (
        <>
          <CommitText
            id={`${base}-options`}
            label={s.options}
            value={v.options.map((o) => o.name).join(", ")}
            isValid={(text) => withEnumOptions(v, splitNames(text), newId) !== null}
            invalidMessage={s.optionsInvalid}
            onCommit={(text) => {
              const next = withEnumOptions(v, splitNames(text), newId);
              if (next !== null) update(next);
            }}
          />
          <div className="field">
            <label htmlFor={`${base}-default`}>{s.defaultValue}</label>
            <select id={`${base}-default`} value={v.default} onChange={(e) => update({ ...v, default: e.target.value })}>
              {v.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <div className="actions">
        <button type="button" className="danger" aria-label={s.remove(v.name)} onClick={() => commit(removeVariable(project, v.id))}>
          {strings.details.delete}
        </button>
      </div>
    </li>
  );
}

const splitNames = (text: string) =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");

interface CommitTextProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly isValid: (value: string) => boolean;
  readonly invalidMessage: string;
  readonly onCommit: (value: string) => void;
}

/**
 * Text input that commits on Enter or blur. Used where every committed value has side
 * effects (a variable rename rewrites expressions), so half-typed names never land.
 */
function CommitText({ id, label, value, isValid, invalidMessage, onCommit }: CommitTextProps) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const invalid = draft !== null && !isValid(draft);
  const errorId = `${id}-error`;
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (!invalid && draft !== value) onCommit(draft);
  };
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={draft ?? value}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        onBlur={commit}
      />
      {invalid && (
        <p id={errorId} className="field-error" role="alert">
          {invalidMessage}
        </p>
      )}
    </div>
  );
}
