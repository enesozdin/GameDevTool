import type { ConditionCompiler, GateState, Id, Value, Variable } from "../../core/index.ts";
import { NumberField } from "../components/NumberField.tsx";
import type { UiStrings } from "../strings.ts";

export interface ScenarioProps {
  readonly strings: UiStrings;
  readonly variables: readonly Variable[];
  readonly conditions: ConditionCompiler;
  readonly gates: GateState;
  readonly values: readonly Value[];
  readonly overrides: Readonly<Record<Id, Value>>;
  readonly allOpen: boolean;
  readonly onOverride: (variable: Id, value: Value | undefined) => void;
  readonly onReset: () => void;
  readonly onAllOpen: (open: boolean) => void;
}

/**
 * Variable values the chain is calculated with. Lists only the variables this chain's
 * conditions read. Values are saved with the chain (undoable) and never change the
 * variables' start values.
 */
export function Scenario({ strings, variables, conditions, gates, values, overrides, allOpen, onOverride, onReset, onAllOpen }: ScenarioProps) {
  const s = strings.production;
  if (gates.slots.length === 0 && gates.lockedCount === 0) return null;
  const byId = new Map(variables.map((v) => [v.id, v]));

  return (
    <section className="pscenario" aria-labelledby="pscenario-heading">
      <h3 id="pscenario-heading">
        {s.scenario}
        {!allOpen && gates.lockedCount > 0 && <span className="badge">{s.lockedCount(gates.lockedCount)}</span>}
      </h3>
      <p className="muted small">{s.scenarioHint}</p>
      <label className="check">
        <input type="checkbox" checked={allOpen} onChange={(e) => onAllOpen(e.target.checked)} />
        {s.allGatesOpen}
      </label>
      {!allOpen &&
        gates.slots.map((slot) => {
          const entry = conditions.scope.entries[slot]!;
          const variable = entry.variable === undefined ? undefined : byId.get(entry.variable);
          if (variable === undefined) return null;
          const id = `ps-${variable.id}`;
          const value = values[slot]!;
          const changed = Object.hasOwn(overrides, variable.id);
          const label = changed ? s.scenarioChanged(variable.name) : variable.name;
          const set = (v: Value) => onOverride(variable.id, v === variable.default ? undefined : v);
          switch (variable.type) {
            case "bool":
              return (
                <label key={variable.id} className="check">
                  <input type="checkbox" checked={value === true} onChange={(e) => set(e.target.checked)} />
                  {label}
                </label>
              );
            case "int":
            case "float":
              return (
                <NumberField
                  key={variable.id}
                  id={id}
                  label={label}
                  value={value as number}
                  invalidMessage={strings.tables.invalidValue}
                  isValid={(n) => n !== null && (variable.type === "float" || Number.isSafeInteger(n))}
                  onCommit={(n) => set(n ?? variable.default)}
                />
              );
            case "enum":
              return (
                <div key={variable.id} className="field">
                  <label htmlFor={id}>{label}</label>
                  <select id={id} value={value as string} onChange={(e) => set(e.target.value)}>
                    {variable.options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              );
            case "string":
              return (
                <div key={variable.id} className="field">
                  <label htmlFor={id}>{label}</label>
                  <input id={id} type="text" spellCheck={false} maxLength={10_000} value={value as string} onChange={(e) => set(e.target.value)} />
                </div>
              );
          }
        })}
      {!allOpen && Object.keys(overrides).length > 0 && (
        <div className="actions">
          <button type="button" onClick={onReset}>
            {s.scenarioReset}
          </button>
        </div>
      )}
    </section>
  );
}
