import { useEffect, useMemo, useState } from "react";
import type { ConditionCompiler } from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

export interface ConditionFieldProps {
  readonly id: string;
  readonly label: string;
  readonly strings: UiStrings;
  readonly value: string;
  readonly conditions: ConditionCompiler;
  readonly onCommit: (value: string) => void;
}

/** Variables listed in the hint below the field; the rest are summarized. */
const MAX_LISTED_VARIABLES = 8;

/**
 * Text input for a bool condition (expression language). Checks the draft live and
 * commits on Enter or blur (one undo step per edit). Invalid conditions can still be
 * committed: they are work in progress, and validation lists them.
 */
export function ConditionField({ id, label, strings, value, conditions, onCommit }: ConditionFieldProps) {
  const s = strings.expression;
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const text = draft ?? value;
  const result = useMemo(() => (text.trim() === "" ? null : conditions.compile(text)), [text, conditions]);
  const error = result !== null && !result.ok ? result.error : undefined;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const names = conditions.scope.entries;

  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (draft !== value) onCommit(draft);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        spellCheck={false}
        autoComplete="off"
        maxLength={10_000}
        value={text}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined ? `${errorId} ${hintId}` : hintId}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        onBlur={commit}
      />
      {error !== undefined && (
        <p id={errorId} className="field-error" role="alert">
          {s.message(error.code, error.params ?? {})} {s.at(error.start + 1)}
        </p>
      )}
      <p id={hintId} className="muted small">
        {names.length === 0
          ? s.noVariables
          : s.variables(
              names
                .slice(0, MAX_LISTED_VARIABLES)
                .map((e) => e.name)
                .join(", "),
              Math.max(0, names.length - MAX_LISTED_VARIABLES),
            )}
      </p>
    </div>
  );
}
