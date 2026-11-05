/**
 * Monte Carlo worker. Bundled separately by build/build.ts and started from a Blob URL
 * (worker-src blob: in the CSP). One run per worker: the app terminates it when the run
 * ends, is cancelled, or the tab is hidden, so no idle worker stays alive.
 */
import { compileCatalog, compileNetwork, monteCarloHistograms, monteCarloPercentiles, startMonteCarlo, stepMonteCarlo, type Project } from "../../core/index.ts";
import type { SimulationRequest, SimulationResult } from "../../ui/production/simulation.ts";

export type WorkerMessage = { readonly type: "progress"; readonly done: number; readonly total: number } | { readonly type: "done"; readonly result: SimulationResult };

/** Runs per progress message. */
const CHUNK = 100;

const scope = self as unknown as { onmessage: ((e: MessageEvent<SimulationRequest>) => void) | null; postMessage(message: WorkerMessage): void };

scope.onmessage = (e) => {
  const { graph, tables, options } = e.data;
  // Only `assets` is read by the catalog; the manifest is a placeholder.
  const project = { manifest: undefined, assets: tables } as unknown as Project;
  const net = compileNetwork(graph, compileCatalog(project, graph.recipes, graph.items));
  const state = startMonteCarlo(net, options);
  const total = state.sinks.length === 0 ? 0 : state.samples.length / state.sinks.length;
  while (!stepMonteCarlo(net, state, options, CHUNK)) scope.postMessage({ type: "progress", done: state.done, total });
  scope.postMessage({ type: "done", result: { runs: state.done, sinks: [...state.sinks], percentiles: monteCarloPercentiles(state), histograms: monteCarloHistograms(state) } });
};
