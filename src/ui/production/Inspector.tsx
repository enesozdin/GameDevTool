import type { Catalog, ConditionCompiler, GraphEdge, GraphGroup, GraphNode, Id } from "../../core/index.ts";
import { GRAPH_LIMITS } from "../../core/index.ts";
import { ConditionField } from "../components/ConditionField.tsx";
import { NameField } from "../components/NameField.tsx";
import { NumberField } from "../components/NumberField.tsx";
import type { UiStrings } from "../strings.ts";
import { UNIT_SECONDS, type RateUnit } from "./format.ts";

export interface InspectorProps {
  readonly strings: UiStrings;
  readonly catalog: Catalog;
  readonly conditions: ConditionCompiler;
  readonly unit: RateUnit;
  readonly node: GraphNode | undefined;
  /** Selected sub-chain, and the number of nodes inside it at any depth. */
  readonly group: GraphGroup | undefined;
  readonly groupNodeCount: number;
  readonly edge: GraphEdge | undefined;
  readonly selectionSize: number;
  readonly onNodeChange: (nodeId: Id, fields: Record<string, unknown>) => void;
  readonly onEdgeRatio: (edgeId: Id, ratio: number | undefined) => void;
  readonly onGroupChange: (groupId: Id, fields: { label?: string; collapsed?: boolean }) => void;
  readonly onUngroup: () => void;
  readonly onDelete: () => void;
}

/** Avoids 0.1 × 60 → 6.000000000000001 in the fields. */
const tidy = (n: number) => Number(n.toPrecision(12));

export function Inspector({ strings, catalog, conditions, unit, node, group, groupNodeCount, edge, selectionSize, onNodeChange, onEdgeRatio, onGroupChange, onUngroup, onDelete }: InspectorProps) {
  const s = strings.production;
  const factor = UNIT_SECONDS[unit];
  const unitName = s.unitName[unit] ?? unit;
  const rateOk = (v: number | null) => v === null || (v >= 0 && v / factor <= GRAPH_LIMITS.rate);

  if (selectionSize === 0) {
    return (
      <section className="pinspector" aria-labelledby="pinspector-heading">
        <h3 id="pinspector-heading">{s.inspector}</h3>
        <p className="muted small">{s.inspectorEmpty}</p>
      </section>
    );
  }

  const itemSelect = (n: GraphNode & { item: Id }) => (
    <div className="field">
      <label htmlFor="pi-item">{s.fieldItem}</label>
      <select id="pi-item" value={n.item} onChange={(e) => onNodeChange(n.id, { item: e.target.value })}>
        {!catalog.items.has(n.item) && <option value={n.item}>{s.unknownItem}</option>}
        {[...catalog.items.values()].map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <section className="pinspector" aria-labelledby="pinspector-heading">
      <h3 id="pinspector-heading">
        {s.inspector}
        {node !== undefined && <span className="badge">{s.nodeType[node.type]}</span>}
        {group !== undefined && <span className="badge">{s.nodeType["group"]}</span>}
      </h3>
      {group !== undefined && (
        <div key={group.id}>
          <NameField
            id="pi-group-name"
            label={s.fieldGroupName}
            value={group.label}
            invalidMessage={strings.tables.invalidValue}
            isValid={(v) => v.trim().length >= 1 && v.length <= 200}
            onCommit={(label) => onGroupChange(group.id, { label })}
          />
          <p className="muted small">{s.groupNodes(groupNodeCount)}</p>
          <div className="actions">
            <button type="button" onClick={() => onGroupChange(group.id, { collapsed: group.collapsed !== true })}>
              {group.collapsed === true ? s.expand : s.collapse}
            </button>
            <button type="button" title={s.ungroupHint} onClick={onUngroup}>
              {s.ungroup}
            </button>
          </div>
        </div>
      )}
      {node !== undefined && (
        <div key={node.id}>
          {node.type === "recipe" ? (
            <>
              <div className="field">
                <label htmlFor="pi-recipe">{s.fieldRecipe}</label>
                <select id="pi-recipe" value={node.recipe} onChange={(e) => onNodeChange(node.id, { recipe: e.target.value })}>
                  {!catalog.recipes.has(node.recipe) && <option value={node.recipe}>{s.unknownRecipe}</option>}
                  {[...catalog.recipes.values()].map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <NumberField
                id="pi-machines"
                label={s.fieldMachines}
                value={node.machines ?? null}
                invalidMessage={strings.tables.invalidValue}
                isValid={(v) => v === null || (v >= 0 && v <= GRAPH_LIMITS.machines)}
                onCommit={(v) => onNodeChange(node.id, { machines: v ?? undefined })}
              />
            </>
          ) : (
            itemSelect(node)
          )}
          {node.type === "source" && (
            <>
              <NumberField
                id="pi-rate"
                label={s.fieldRate(unitName)}
                value={tidy(node.rate * factor)}
                invalidMessage={strings.tables.invalidValue}
                isValid={(v) => v !== null && rateOk(v)}
                onCommit={(v) => onNodeChange(node.id, { rate: (v ?? 0) / factor })}
              />
              <div className="field">
                <label htmlFor="pi-dist">{s.fieldDistribution}</label>
                <select id="pi-dist" value={node.distribution ?? "fixed"} onChange={(e) => onNodeChange(node.id, { distribution: e.target.value === "fixed" ? undefined : e.target.value })}>
                  <option value="fixed">{s.distributionFixed}</option>
                  <option value="poisson">{s.distributionPoisson}</option>
                </select>
              </div>
            </>
          )}
          {node.type === "sink" && (
            <NumberField
              id="pi-target"
              label={s.fieldTarget(unitName)}
              value={node.rate === undefined ? null : tidy(node.rate * factor)}
              invalidMessage={strings.tables.invalidValue}
              isValid={rateOk}
              onCommit={(v) => onNodeChange(node.id, { rate: v === null ? undefined : v / factor })}
            />
          )}
          {node.type === "storage" && (
            <NumberField
              id="pi-capacity"
              label={s.fieldCapacity}
              value={node.capacity ?? null}
              invalidMessage={strings.tables.invalidValue}
              isValid={(v) => v === null || (v >= 0 && v <= 1e15)}
              onCommit={(v) => onNodeChange(node.id, { capacity: v ?? undefined })}
            />
          )}
          {node.type === "gate" && (
            <ConditionField id="pi-condition" label={s.fieldCondition} strings={strings} value={node.condition} conditions={conditions} onCommit={(condition) => onNodeChange(node.id, { condition })} />
          )}
        </div>
      )}
      {node === undefined && edge !== undefined && (
        <NumberField
          key={edge.id}
          id="pi-ratio"
          label={s.fieldRatio}
          value={edge.ratio ?? null}
          invalidMessage={strings.tables.invalidValue}
          isValid={(v) => v === null || (v > 0 && v <= 1e6)}
          onCommit={(v) => onEdgeRatio(edge.id, v ?? undefined)}
        />
      )}
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          {s.deleteSelected}
        </button>
      </div>
    </section>
  );
}
