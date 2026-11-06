import { useEffect, useState } from "react";
import { parseNumberInput } from "../../core/index.ts";

export interface NumberFieldProps {
  readonly id: string;
  readonly label: string;
  /** null = empty. */
  readonly value: number | null;
  readonly invalidMessage: string;
  /** Extra range check on parsed values. */
  readonly isValid?: (value: number | null) => boolean;
  readonly onCommit: (value: number | null) => void;
}

/**
 * Number input bound to project data. Commits on Enter or blur (one undo step per edit);
 * invalid text stays a local draft and is never written to the project.
 */
export function NumberField({ id, label, value, invalidMessage, isValid = () => true, onCommit }: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);
  const parsed = draft === null ? value : parseNumberInput(draft);
  const invalid = draft !== null && (parsed === undefined || !isValid(parsed));
  const errorId = `${id}-error`;

  const commit = () => {
    if (draft === null || invalid || parsed === undefined) return;
    setDraft(null);
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={draft ?? (value === null ? "" : String(value))}
        aria-invalid={invalid}
        aria-describedby={invalid ? errorId : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setDraft(null);
        }}
        onBlur={() => {
          commit();
          setDraft(null);
        }}
      />
      {invalid && (
        <p id={errorId} className="field-error" role="alert">
          {invalidMessage}
        </p>
      )}
    </div>
  );
}
