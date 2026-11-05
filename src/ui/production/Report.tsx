import { useEffect, useMemo, useRef, useState } from "react";
import {
  billOfMaterials,
  defaultRecipeChoice,
  hasRandomness,
  NodeKind,
  timeToFirstUnit,
  type BomNode,
  type Catalog,
  type GraphNode,
  type Id,
  type Network,
  type ProductionGraphAsset,
  type Project,
  type SolveResult,
} from "../../core/index.ts";
import { itemName } from "./context.ts";
import { HistogramChart } from "./HistogramChart.tsx";
import type { UiStrings } from "../strings.ts";
import { formatNumber, formatRate, type RateUnit } from "./format.ts";
import type { SimulationHandle, SimulationResult, SimulationService } from "./simulation.ts";

export interface ReportProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly graph: ProductionGraphAsset;
  readonly catalog: Catalog;
  readonly network: Network;
  readonly result: SolveResult;
  readonly unit: RateUnit;
  readonly selected: GraphNode | undefined;
  readonly simulation: SimulationService;
  /** Lock state of the current scenario (gates.ts); undefined = everything open. */
  readonly locked: Uint8Array | undefined;
}

const SIM_RUNS = 2_000;
const BOM_ROWS = 200;
/**
 * Rows per report list. A chain can have thousands of sinks and recipes; the report keeps
 * its DOM small and shows the largest entries (the full data is in the CSV exports).
 */
const REPORT_ROWS = 40;

/** The `limit` entries with the largest `key`, plus how many were left out. */
function largest<T>(list: readonly T[], key: (t: T) => number, limit = REPORT_ROWS): { shown: T[]; hidden: number } {
  if (list.length <= limit) return { shown: [...list], hidden: 0 };
  return { shown: [...list].sort((a, b) => key(b) - key(a)).slice(0, limit), hidden: list.length - limit };
}

export function Report({ strings, project, graph, catalog, network: net, result, unit, selected, simulation, locked }: ReportProps) {
  const s = strings.production;
  const name = (id: Id) => itemName({ catalog, strings }, id);
  const rate = (v: number) => formatRate(v, unit, s.perUnit);

  const summary = useMemo(() => {
    const raw = new Map<Id, number>();
    const machines: { node: number; count: number }[] = [];
    const outputs: { node: number; rate: number }[] = [];
    for (let u = 0; u < net.nodeCount; u++) {
      const a = result.activity[u]!;
      if (net.kind[u] === NodeKind.source) {
        const item = net.outItem[net.outStart[u]!]!;
        raw.set(item, (raw.get(item) ?? 0) + a);
      } else if (net.kind[u] === NodeKind.recipe && !Number.isNaN(result.machines[u]!)) {
        machines.push({ node: u, count: result.machines[u]! });
      } else if (net.kind[u] === NodeKind.sink) {
        outputs.push({ node: u, rate: a });
      }
    }
    return {
      raw: largest([...raw], (r) => r[1]),
      machines: largest(machines, (m) => m.count),
      outputs: largest(outputs, (o) => o.rate),
    };
  }, [net, result]);

  // Bill of materials and time to first unit for the selected recipe's main output.
  const focusItem = selected?.type === "recipe" ? catalog.recipes.get(selected.recipe)?.outputs[0]?.item : selected?.type === "sink" ? selected.item : undefined;
  // Uses the recipe choices of the rate calculator, so both show the same chain.
  const choices = graph.calculator?.recipes;
  const plan = useMemo(() => {
    if (focusItem === undefined) return null;
    const choice = defaultRecipeChoice(catalog, choices);
    return { bom: billOfMaterials(choice, focusItem, 1, BOM_ROWS), first: timeToFirstUnit(choice, focusItem) };
  }, [catalog, focusItem, choices]);

  const title = (u: number) => {
    const node = graph.nodes[u]!;
    if (node.label !== undefined) return node.label;
    return node.type === "recipe" ? (catalog.recipes.get(node.recipe)?.name ?? s.unknownRecipe) : name(node.item);
  };

  return (
    <section className="preport" aria-labelledby="preport-heading">
      <h3 id="preport-heading">{s.report}</h3>
      {!result.converged && (
        <p className="field-error" role="alert">
          {s.notConverged}
        </p>
      )}
      {summary.raw.shown.length === 0 && summary.outputs.shown.every((o) => o.rate === 0) ? (
        <p className="muted small">{s.noFlow}</p>
      ) : (
        <>
          <dl className="facts small">
            {summary.outputs.shown.map((o) => (
              <Fact key={`o${o.node}`} term={`${s.targets}: ${title(o.node)}`} value={rate(o.rate)} />
            ))}
            {summary.raw.shown.map(([item, r]) => (
              <Fact key={`r${item}`} term={`${s.rawResources}: ${name(item)}`} value={rate(r)} />
            ))}
            {summary.machines.shown.map((m) => (
              <Fact key={`m${m.node}`} term={`${s.machineCounts}: ${title(m.node)}`} value={`${formatNumber(m.count)} (${Math.ceil(m.count - 1e-9)})`} />
            ))}
          </dl>
          {summary.outputs.hidden + summary.raw.hidden + summary.machines.hidden > 0 && (
            <p className="muted small">{s.reportMoreHidden(summary.outputs.hidden + summary.raw.hidden + summary.machines.hidden)}</p>
          )}
        </>
      )}

      {plan !== null && focusItem !== undefined && (
        <>
          <h4>{s.bom(name(focusItem))}</h4>
          <ul className="bom">
            <BomTree node={plan.bom.root} name={name} cycle={s.cycle} />
          </ul>
          <p className="muted small">{s.firstUnit(formatNumber(plan.first.seconds))}</p>
        </>
      )}

      <MonteCarlo strings={strings} project={project} graph={graph} network={net} simulation={simulation} title={title} locked={locked} />
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

function BomTree({ node, name, cycle }: { node: BomNode; name: (id: Id) => string; cycle: string }) {
  return (
    <li>
      {formatNumber(node.quantity)} × {name(node.item)}
      {node.cycle && ` ${cycle}`}
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => (
            <BomTree key={i} node={c} name={name} cycle={cycle} />
          ))}
        </ul>
      )}
    </li>
  );
}

function MonteCarlo({
  strings,
  project,
  graph,
  network,
  simulation,
  title,
  locked,
}: {
  strings: UiStrings;
  project: Project;
  graph: ProductionGraphAsset;
  network: Network;
  simulation: SimulationService;
  title: (u: number) => string;
  locked: Uint8Array | undefined;
}) {
  const s = strings.production;
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<SimulationResult | null>(null);
  const [chartSink, setChartSink] = useState(0);
  const [interrupted, setInterrupted] = useState(false);
  // Runs we stopped ourselves (cancel button, edit, restart, unmount): only stops we did
  // not ask for (tab hidden, worker error) show the notice. A WeakSet, because the
  // promise of a cancelled run settles after `cancel()` returns.
  const stoppedByUs = useRef(new WeakSet<SimulationHandle>());
  const handle = useRef<SimulationHandle | null>(null);
  const random = hasRandomness(network);

  // Results describe one version of the chain; editing it makes them stale.
  const stop = () => {
    const run = handle.current;
    if (run === null) return;
    stoppedByUs.current.add(run);
    run.cancel();
  };
  useEffect(() => {
    setOutcome(null);
    setInterrupted(false);
    stop();
  }, [network, locked]);
  useEffect(() => stop, []);

  const start = () => {
    stop();
    setInterrupted(false);
    const tables = project.assets.filter((a) => a.kind === "table" && a.role !== undefined);
    const run = simulation.run({ graph, tables, options: { runs: SIM_RUNS, seconds: 3_600, seed: 1, locked } }, (done, total) => setProgress({ done, total }));
    handle.current = run;
    setProgress({ done: 0, total: SIM_RUNS });
    void run.result.then((r) => {
      if (handle.current !== run) return;
      handle.current = null;
      setProgress(null);
      if (r !== null) {
        setOutcome(r);
        setChartSink(0);
      } else if (!stoppedByUs.current.has(run)) {
        setInterrupted(true);
      }
    });
  };

  return (
    <div className="psim">
      <div className="actions">
        {progress === null ? (
          <button type="button" onClick={start} disabled={!random} title={s.simulateHint}>
            {s.simulate}
          </button>
        ) : (
          <>
            <span role="status">{s.simulating(progress.done, progress.total)}</span>
            <button type="button" onClick={stop}>
              {s.cancel}
            </button>
          </>
        )}
      </div>
      {!random && <p className="muted small">{s.simNoRandomness}</p>}
      {interrupted && <p className="field-error" role="status">{s.simInterrupted}</p>}
      {outcome !== null && (
        <table className="ptable small">
          <caption>{s.simResult(outcome.runs)}</caption>
          <thead>
            <tr>
              <th scope="col">{s.simColumns.sink}</th>
              <th scope="col">{s.simColumns.p10}</th>
              <th scope="col">{s.simColumns.p50}</th>
              <th scope="col">{s.simColumns.p90}</th>
              <th scope="col">{s.simColumns.mean}</th>
            </tr>
          </thead>
          <tbody>
            {outcome.sinks.slice(0, REPORT_ROWS).map((u, i) => {
              const p = outcome.percentiles[i]!;
              return (
                <tr key={u}>
                  <th scope="row">{u < graph.nodes.length ? title(u) : u}</th>
                  <td>{formatNumber(p.p10)}</td>
                  <td>{formatNumber(p.p50)}</td>
                  <td>{formatNumber(p.p90)}</td>
                  <td>{formatNumber(p.mean)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {outcome !== null && outcome.unconverged > 0 && <p className="field-error" role="status">{s.simUnconverged(outcome.unconverged, outcome.runs)}</p>}
      {outcome !== null && outcome.sinks.length > REPORT_ROWS && <p className="muted small">{s.reportMoreHidden(outcome.sinks.length - REPORT_ROWS)}</p>}
      {outcome !== null && outcome.histograms[chartSink] !== undefined && (
        <>
          {outcome.sinks.length > 1 && (
            <div className="field">
              <label htmlFor="psim-chart-sink">{s.simChartSink}</label>
              <select id="psim-chart-sink" value={chartSink} onChange={(e) => setChartSink(Number(e.target.value))}>
                {outcome.sinks.slice(0, REPORT_ROWS).map((u, i) => (
                  <option key={u} value={i}>
                    {u < graph.nodes.length ? title(u) : u}
                  </option>
                ))}
              </select>
            </div>
          )}
          <HistogramChart
            histogram={outcome.histograms[chartSink]!}
            percentiles={outcome.percentiles[chartSink]!}
            label={s.simChartLabel(title(outcome.sinks[chartSink]!), formatNumber(outcome.percentiles[chartSink]!.p10), formatNumber(outcome.percentiles[chartSink]!.p50), formatNumber(outcome.percentiles[chartSink]!.p90))}
            xLabel={s.simChartX}
            yLabel={s.simChartY}
          />
          <p className="muted small">{s.simChartHint}</p>
        </>
      )}
    </div>
  );
}
