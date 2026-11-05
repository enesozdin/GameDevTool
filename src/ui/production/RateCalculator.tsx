import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { defaultRecipeChoice, planRates, producersByItem, tagOfKey, type Calculator, type Catalog, type CatalogItem, type Id, type RateLine } from "../../core/index.ts";
import { NumberField } from "../components/NumberField.tsx";
import { VirtualListbox } from "../components/VirtualListbox.tsx";
import type { UiStrings } from "../strings.ts";
import { itemName } from "./context.ts";
import { formatNumber, formatRate, UNIT_SECONDS, type RateUnit } from "./format.ts";

export interface RateCalculatorProps {
  readonly strings: UiStrings;
  readonly catalog: Catalog;
  readonly calculator: Calculator | undefined;
  readonly unit: RateUnit;
  /** Target item and rate in items/s. */
  readonly onTarget: (target: Id, rate: number) => void;
  /** `undefined` = back to the first recipe that makes the item. */
  readonly onRecipe: (item: Id, recipe: Id | undefined) => void;
  readonly onReset: () => void;
}

/** A text line plus a 44 px recipe select (touch target minimum) fit in this height. */
const LINE_HEIGHT = 72;
const RAW_ROWS = 40;
const NO_RECIPES: Readonly<Record<Id, Id>> = {};

/**
 * Target-driven planning from recipe data alone ("1 Iron Sword per minute" → every
 * upstream item, recipe and machine count). Works without the canvas, so it is also the
 * phone view of a chain. Item list and result lines are virtualized.
 */
export function RateCalculator({ strings, catalog, calculator, unit, onTarget, onRecipe, onReset }: RateCalculatorProps) {
  const s = strings.production;
  const [query, setQuery] = useState("");
  const recipes = calculator?.recipes ?? NO_RECIPES;
  const target = calculator?.target !== undefined && catalog.items.has(calculator.target) ? calculator.target : undefined;
  const perUnit = UNIT_SECONDS[unit];
  const rate = calculator?.rate ?? 1 / perUnit;
  const name = (id: Id) => itemName({ catalog, strings }, id);

  const producers = useMemo(() => producersByItem(catalog), [catalog]);
  const choice = useMemo(() => defaultRecipeChoice(catalog, recipes), [catalog, recipes]);
  const plan = useMemo(() => (target === undefined ? null : planRates(choice, target, rate)), [choice, target, rate]);
  const raw = useMemo(() => (plan === null ? [] : [...plan.raw].sort((a, b) => b[1] - a[1])), [plan]);

  // Items that can be made come first; raw-only items are still plannable (shows 1 line).
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const made: CatalogItem[] = [];
    const rawOnly: CatalogItem[] = [];
    for (const item of catalog.items.values()) {
      if (q !== "" && !item.name.toLowerCase().includes(q)) continue;
      (producers.has(item.id) ? made : rawOnly).push(item);
    }
    return made.concat(rawOnly);
  }, [catalog, producers, query]);

  const changed = Object.keys(recipes).length;

  return (
    <section className="pcalc" aria-labelledby="pcalc-heading">
      <h3 id="pcalc-heading">{s.calculator}</h3>
      <p className="muted small">{s.calcHint}</p>
      <div className="pcalc-pick">
        <div className="pcalc-items">
          <input type="text" aria-label={s.search} placeholder={s.search} value={query} onChange={(e) => setQuery(e.target.value)} />
          <VirtualListbox
            id="pcalc-items"
            label={s.calcItems}
            items={items}
            getKey={(i) => i.id}
            renderItem={(i) => (
              <span className="pcalc-item">
                <span className="asset-name">{i.name}</span>
                {!producers.has(i.id) && <span className="muted small">{s.calcRaw}</span>}
              </span>
            )}
            selectedKey={target ?? null}
            onSelect={(id) => onTarget(id, rate)}
          />
        </div>
        <div className="pcalc-target">
          <p className="pcalc-making">{target === undefined ? s.calcNoTarget : s.calcTarget(name(target))}</p>
          <NumberField
            id="pcalc-rate"
            label={s.calcRate(s.unitName[unit] ?? unit)}
            value={Number((rate * perUnit).toPrecision(12))}
            invalidMessage={strings.tables.invalidValue}
            isValid={(n) => n !== null && n >= 0 && n / perUnit <= 1e9}
            onCommit={(n) => target !== undefined && n !== null && onTarget(target, n / perUnit)}
          />
          {changed > 0 && (
            <div className="actions">
              <span className="muted small">{s.calcChanged(changed)}</span>
              <button type="button" onClick={onReset}>
                {s.calcReset}
              </button>
            </div>
          )}
        </div>
      </div>

      {plan !== null && (
        <>
          {!plan.converged && (
            <p className="field-error" role="alert">
              {s.notConverged}
            </p>
          )}
          <h4>{s.calcLines}</h4>
          <Lines strings={strings} lines={plan.lines} unit={unit} producers={producers} recipes={recipes} name={name} onRecipe={onRecipe} />
          {raw.length > 0 && (
            <>
              <h4>{s.calcRawTotal}</h4>
              <dl className="facts small">
                {raw.slice(0, RAW_ROWS).map(([item, r]) => (
                  <Fact key={item} term={name(item)} value={formatRate(r, unit, s.perUnit)} />
                ))}
              </dl>
              {raw.length > RAW_ROWS && <p className="muted small">{s.reportMoreHidden(raw.length - RAW_ROWS)}</p>}
            </>
          )}
        </>
      )}
    </section>
  );
}

function Fact({ term, value }: { term: string; value: string }) {
  return (
    <>
      <dt>{term}</dt>
      <dd>{value}</dd>
    </>
  );
}

interface LinesProps {
  readonly strings: UiStrings;
  readonly lines: readonly RateLine[];
  readonly unit: RateUnit;
  readonly producers: ReadonlyMap<Id, readonly { id: Id; name: string }[]>;
  readonly recipes: Readonly<Record<Id, Id>>;
  readonly name: (id: Id) => string;
  readonly onRecipe: (item: Id, recipe: Id | undefined) => void;
}

/** One row per involved item: rate, recipe (a choice when several make it), machines. */
function Lines({ strings, lines, unit, producers, recipes, name, onRecipe }: LinesProps) {
  const s = strings.production;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_HEIGHT,
    getItemKey: (i) => lines[i]!.item,
    overscan: 6,
  });

  return (
    <div ref={scrollRef} className="pcalc-lines" role="list" aria-label={s.calcLines}>
      <div className="listbox-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((v) => {
          const line = lines[v.index]!;
          const options = tagOfKey(line.item) === undefined ? (producers.get(line.item) ?? []) : [];
          const saved = Object.hasOwn(recipes, line.item) ? recipes[line.item] : undefined;
          const selectId = `pcalc-r-${v.index}`;
          return (
            <div key={v.key} role="listitem" className="pcalc-line" style={{ height: LINE_HEIGHT, transform: `translateY(${v.start}px)` }}>
              <div className="pcalc-line-head">
                <span className="asset-name">{name(line.item)}</span>
                <span>{formatRate(line.rate, unit, s.perUnit)}</span>
              </div>
              <div className="pcalc-line-detail small">
                {options.length > 1 ? (
                  <>
                    <select id={selectId} aria-label={s.calcRecipeFor(name(line.item))} value={saved !== undefined && options.some((o) => o.id === saved) ? saved : ""} onChange={(e) => onRecipe(line.item, e.target.value === "" ? undefined : e.target.value)}>
                      <option value="">{s.calcDefault(options[0]!.name)}</option>
                      {options.slice(1).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </>
                ) : (
                  <span className="muted">{line.recipe?.name ?? s.calcRawFrom}</span>
                )}
                {line.recipe !== undefined && <span>{Number.isNaN(line.machines) ? "–" : s.calcMachines(formatNumber(line.machines), Math.ceil(line.machines - 1e-9))}</span>}
                {line.surplus > 1e-9 && <span className="pcalc-surplus">{s.surplus(formatRate(line.surplus, unit, s.perUnit))}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
