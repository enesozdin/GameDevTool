import { useEffect, useState } from "react";

export interface NameFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly invalidMessage: string;
  readonly isValid: (value: string) => boolean;
  /** Called on every valid keystroke; the history coalesces them into one undo step. */
  readonly onCommit: (value: string) => void;
}

/**
 * Text input bound to project data. Valid input is committed immediately; invalid input
 * (e.g. an empty name) stays a local draft, so the project never holds an invalid value.
 * Leaving the field, or an undo that changes the value, drops the draft.
 */
export function NameField({ id, label, value, invalidMessage, isValid, onCommit }: NameFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => setDraft(null), [value]);

  const invalid = draft !== null && !isValid(draft);
  const errorId = `${id}-error`;

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
        onChange={(e) => {
          const next = e.target.value;
          if (isValid(next)) {
            setDraft(null);
            onCommit(next);
          } else {
            setDraft(next);
          }
        }}
        onBlur={() => setDraft(null)}
      />
      {invalid && (
        <p id={errorId} className="field-error" role="alert">
          {invalidMessage}
        </p>
      )}
    </div>
  );
}
