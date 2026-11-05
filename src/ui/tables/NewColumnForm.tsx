import { useMemo, useState } from "react";
import { columnTypeFromSpec, isValidIdentifier, type ColumnSpec, type ColumnType, type Id, type IdGenerator, type Project, type ScalarSpec, type TableAsset } from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";

const KINDS = ["float", "int", "string", "bool", "text", "enum", "reference", "list", "stacks"] as const;
const LIST_KINDS = ["string", "int", "float", "bool", "enum", "reference"] as const;
type Kind = (typeof KINDS)[number];
type ListKind = (typeof LIST_KINDS)[number];

export interface NewColumnFormProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly table: TableAsset;
  readonly newId: IdGenerator;
  /** Called with a valid column; the form clears its name afterwards. */
  readonly onAdd: (column: { id: Id; name: string; type: ColumnType }) => void;
}

/**
 * "Add column" controls for the table toolbar. Kinds with settings show extra fields:
 * enum options, the target table of references and item amounts, the item type of lists.
 */
export function NewColumnForm({ strings, project, table, newId, onAdd }: NewColumnFormProps) {
  const s = strings.tables;
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("float");
  const [listKind, setListKind] = useState<ListKind>("string");
  const [options, setOptions] = useState("");
  const [target, setTarget] = useState<Id | "">("");

  const tables = useMemo(() => project.assets.filter((a): a is TableAsset => a.kind === "table"), [project.assets]);
  // Item amounts point into an items table: offer those first.
  const targets = useMemo(
    () => (kind === "stacks" ? [...tables.filter((t) => t.role?.kind === "items"), ...tables.filter((t) => t.role?.kind !== "items")] : tables),
    [kind, tables],
  );
  const tableId = target !== "" && targets.some((t) => t.id === target) ? target : (targets[0]?.id ?? "");

  const itemKind = kind === "list" ? listKind : kind;
  const needsOptions = itemKind === "enum";
  const needsTable = itemKind === "reference" || kind === "stacks";

  const spec = (): ColumnSpec => {
    const scalar = (k: ListKind): ScalarSpec => (k === "enum" ? { kind: "enum", options } : k === "reference" ? { kind: "reference", table: tableId } : { kind: k });
    if (kind === "list") return { kind: "list", item: scalar(listKind) };
    if (kind === "stacks") return { kind: "stacks", table: tableId };
    if (kind === "text") return { kind: "text" };
    return scalar(kind);
  };
  // Validated with a throwaway id source; real ids are drawn only when the column is added.
  const check = columnTypeFromSpec(project, spec(), () => "");
  const nameValid = isValidIdentifier(name) && !table.columns.some((c) => c.name.toLowerCase() === name.toLowerCase());
  const specMessage = check.ok || (needsOptions && options.trim() === "" && check.error.code === "enum-empty") ? null : check.error.name === undefined ? s.specErrors[check.error.code] : s.specErrorName(s.specErrors[check.error.code] ?? "", check.error.name);

  const add = () => {
    if (!nameValid) return;
    const type = columnTypeFromSpec(project, spec(), newId);
    if (!type.ok) return;
    onAdd({ id: newId(), name, type: type.value });
    setName("");
    setOptions("");
  };

  return (
    <>
      <input type="text" className="narrow" aria-label={s.columnName} placeholder={s.columnName} value={name} aria-invalid={name !== "" && !nameValid} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      <select aria-label={s.columnType} value={kind} onChange={(e) => {
          setKind(e.target.value as Kind);
          // Each kind proposes its own default table (item amounts: the items table).
          setTarget("");
        }}>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {s.kinds[k]}
          </option>
        ))}
      </select>
      {kind === "list" && (
        <select aria-label={s.listOf} value={listKind} onChange={(e) => setListKind(e.target.value as ListKind)}>
          {LIST_KINDS.map((k) => (
            <option key={k} value={k}>
              {`${s.listOf} ${s.kinds[k]}`}
            </option>
          ))}
        </select>
      )}
      {needsOptions && (
        <input
          type="text"
          className="narrow"
          aria-label={s.enumOptions}
          placeholder={s.enumOptionsPlaceholder}
          title={s.enumOptions}
          value={options}
          aria-invalid={specMessage !== null}
          onChange={(e) => setOptions(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
      )}
      {needsTable &&
        (targets.length === 0 ? (
          <span className="muted small">{s.noTables}</span>
        ) : (
          <select aria-label={s.targetTable} value={tableId} onChange={(e) => setTarget(e.target.value)}>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        ))}
      <button type="button" onClick={add} disabled={!nameValid || !check.ok}>
        {s.addColumn}
      </button>
      {specMessage !== null && (
        <span className="field-error small" role="alert">
          {specMessage}
        </span>
      )}
    </>
  );
}
