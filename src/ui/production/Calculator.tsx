import { Fragment, useMemo, useState } from "react";
import {
  billOfMaterials,
  GRAPH_LIMITS,
  planRates,
  RATE_EPSILON,
  recipeAlternatives,
  timeToFirstUnit,
  type Calculator as CalculatorSettings,
  type Catalog,
  type CatalogItem,
  type Id,
  type RecipeChoice,
} from "../../core/index.ts";
import { NumberField } from "../components/NumberField.tsx";
import { VirtualListbox } from "../components/VirtualListbox.tsx";
import type { UiStrings } from "../strings.ts";
import { itemName } from "./context.ts";
import { formatNumber, formatRate, UNIT_SECONDS, type RateUnit } from "./format.ts";
import { BomTree } from "./Report.tsx";

export interface CalculatorProps {
  readonly strings: UiStrings;
  readonly catalog: Catalog;
  readonly settings: CalculatorSettings | undefined;
  /** Recipe choice for the saved settings (savedRecipeChoice), shared with the report. */
  readonly choice: RecipeChoice;
  readonly unit: RateUnit;
  /** Item of the node selected on the canvas, offered as a quick target. */
  readonly selectedItem: Id | undefined;
  readonly onTarget: (item: Id) => void;
  /** Items/s. */
  readonly onRate: (rate: number) => void;
  /** `undefined`: back to the default recipe. */
  readonly onChoose: (item: Id, recipe: Id | undefined) => void;
  readonly onResetChoices: () => void;
}

/**
 * Rows of the requirement list. A plan lists every upstream item; real chains have tens,
 * a generated catalog could have thousands. The rest is summarized.
 */
const LINE_ROWS = 300;
const BOM_ROWS = 200;

/** Avoids 0.1 × 60 → 6.000000000000001 in the field. */
const tidy = (n: number) => Number(n.toPrecision(12));

/**
 * Rate calculator: pick an item and a rate, see every upstream item, the recipe and
 * machines for each, and the raw resources. Works on the recipe data alone (not on the
 * chain's nodes), so it also answers "what would this need?" before anything is placed.
 * Where several recipes make an item, the designer picks one; picks are saved with the
 * chain.
 */
export function Calculator({ strings, catalog, settings, choice, unit, selectedItem, onTarget, onRate, onChoose, onResetChoices }: CalculatorProps) {
  const s = strings.production;
  const factor = UNIT_SECONDS[unit];
  const name = (id: Id) => itemName({ catalog, strings }, id);
  const rateText = (v: number) => formatRate(v, unit, s.perUnit);

  const target = settings?.target !== undefined && catalog.items.has(settings.target) ? settings.target : undefined;
  const rate = settings?.rate ?? 1 / factor;
  const [picking, setPicking] = useState(false);
  const showPicker = picking || target === undefined;

  const alternatives = useMemo(() => recipeAlternatives(catalog), [catalog]);
  const plan = useMemo(() => (target === undefined ? null : planRates(choice, target, rate)), [choice, target, rate]);
  const extra = useMemo(
    () => (target === undefined ? null : { bom: billOfMaterials(choice, target, 1, BOM_ROWS), first: timeToFirstUnit(choice, target) }),
    [choice, target],
  );
  const picks = settings?.recipes;
  const hasPicks = picks !== undefined && Object.keys(picks).length > 0;

  return (
    <section className="pcalc" aria-labelledby="pcalc-heading">
      <h3 id="pcalc-heading">{s.calculator}</h3>
      <p className="muted small">{s.calculatorHint}</p>

      <div className="pcalc-target">
        <div className="field" role="group" aria-labelledby="pcalc-target-label">
          <span id="pcalc-target-label" className="field-label">{s.calcTarget}</span>
          <div className="actions">
            <strong className="pcalc-target-name">{target === undefined ? s.calcNoTarget : name(target)}</strong>
            {target !== undefined && (
              <button type="button" aria-expanded={showPicker} onClick={() => setPicking(!picking)}>
                {picking ? s.calcPickDone : s.calcPickChange}
              </button>
            )}
            {selectedItem !== undefined && selectedItem !== target && catalog.items.has(selectedItem) && (
              <button type="button" onClick={() => onTarget(selectedItem)}>
                {s.calcUseSelected(name(selectedItem))}
              </button>
            )}
          </div>
        </div>
        <NumberField
          id="pcalc-rate"
          label={s.fieldRate(s.unitName[unit] ?? unit)}
          value={tidy(rate * factor)}
          invalidMessage={strings.tables.invalidValue}
          isValid={(v) => v !== null && v >= 0 && v / factor <= GRAPH_LIMITS.rate}
          onCommit={(v) => v !== null && onRate(v / factor)}
        />
      </div>
      {showPicker && (
        <ItemPicker
          strings={strings}
          catalog={catalog}
          selected={target}
          // Stays open until "Done": arrow keys select as they move, and the list must not
          // disappear under the keyboard focus.
          onSelect={(item) => {
            setPicking(true);
            onTarget(item);
          }}
        />
      )}

      {plan !== null && target !== undefined && (
        <>
          {!plan.converged && (
            <p className="field-error" role="alert">
              {s.notConverged}
            </p>
          )}
          <table className="ptable pcalc-table">
            <caption>{s.calcLines(name(target), rateText(rate))}</caption>
            <thead>
              <tr>
                <th scope="col">{s.calcColumns.item}</th>
                <th scope="col">{s.calcColumns.rate}</th>
                <th scope="col">{s.calcColumns.recipe}</th>
                <th scope="col">{s.calcColumns.machines}</th>
                <th scope="col">{s.calcColumns.surplus}</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.slice(0, LINE_ROWS).map((line) => {
                const options = alternatives.get(line.item);
                const picked = picks !== undefined && Object.hasOwn(picks, line.item) && line.recipe?.id === picks[line.item];
                return (
                  <tr key={line.item}>
                    <th scope="row">{name(line.item)}</th>
                    <td data-label={s.calcColumns.rate}>{rateText(line.rate)}</td>
                    <td data-label={s.calcColumns.recipe} className="pcalc-recipe">
                      {line.recipe === undefined ? (
                        <span className="muted">{s.calcRaw}</span>
                      ) : options === undefined ? (
                        line.recipe.name
                      ) : (
                        <select
                          aria-label={s.calcChooseRecipe(name(line.item))}
                          value={line.recipe.id}
                          className={picked ? "is-picked" : undefined}
                          onChange={(e) => onChoose(line.item, e.target.value === options[0]!.id ? undefined : e.target.value)}
                        >
                          {options.map((r, i) => (
                            <option key={r.id} value={r.id}>
                              {i === 0 ? s.calcDefaultRecipe(r.name) : r.name}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td data-label={s.calcColumns.machines}>
                      {line.recipe !== undefined && (
                        <span>
                          {`${formatNumber(line.machines)} (${Number.isFinite(line.machines) ? Math.ceil(line.machines - 1e-9) : "–"})`}
                          {line.recipe.machine !== undefined && <span className="muted"> {line.recipe.machine.name}</span>}
                        </span>
                      )}
                    </td>
                    <td data-label={s.calcColumns.surplus}>{line.surplus > RATE_EPSILON ? rateText(line.surplus) : ""}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.lines.length > LINE_ROWS && <p className="muted small">{s.calcMoreLines(plan.lines.length - LINE_ROWS)}</p>}
          {hasPicks && (
            <div className="actions">
              <button type="button" onClick={onResetChoices}>
                {s.calcResetChoices}
              </button>
            </div>
          )}

          <h4>{s.rawResources}</h4>
          {plan.raw.size === 0 ? (
            <p className="muted small">{s.calcNoRaw}</p>
          ) : (
            <dl className="facts small">
              {[...plan.raw].slice(0, LINE_ROWS).map(([item, r]) => (
                <Fragment key={item}>
                  <dt>{name(item)}</dt>
                  <dd>{rateText(r)}</dd>
                </Fragment>
              ))}
            </dl>
          )}

          {extra !== null && (
            <>
              <h4>{s.bom(name(target))}</h4>
              <ul className="bom">
                <BomTree node={extra.bom.root} name={name} cycle={s.cycle} />
              </ul>
              <p className="muted small">{s.firstUnit(formatNumber(extra.first.seconds))}</p>
            </>
          )}
        </>
      )}
    </section>
  );
}

/** Searchable, virtualized item list: DOM size stays constant however many items exist. */
function ItemPicker({ strings, catalog, selected, onSelect }: { strings: UiStrings; catalog: Catalog; selected: Id | undefined; onSelect: (item: Id) => void }) {
  const s = strings.production;
  const [query, setQuery] = useState("");
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = [...catalog.items.values()];
    return q === "" ? all : all.filter((i) => i.name.toLowerCase().includes(q));
  }, [catalog, query]);

  return (
    <div className="pcalc-picker">
      <input type="text" aria-label={s.search} placeholder={s.search} value={query} onChange={(e) => setQuery(e.target.value)} />
      {items.length === 0 ? (
        <p className="muted small">{s.calcNoItems}</p>
      ) : (
        <VirtualListbox<CatalogItem>
          id="pcalc-items"
          label={s.calcTarget}
          items={items}
          getKey={(i) => i.id}
          renderItem={(i) => i.name}
          selectedKey={selected ?? null}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}
