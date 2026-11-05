import type { Asset, MonteCarloOptions, Percentiles, ProductionGraphAsset } from "../../core/index.ts";

/** What a Monte Carlo run needs: the graph and the tables it reads. Structured-cloneable. */
export interface SimulationRequest {
  readonly graph: ProductionGraphAsset;
  readonly tables: readonly Asset[];
  readonly options: MonteCarloOptions;
}

export interface SimulationResult {
  readonly runs: number;
  /** Graph node index of each sink, in the order of `percentiles`. */
  readonly sinks: readonly number[];
  readonly percentiles: readonly Percentiles[];
}

export interface SimulationHandle {
  readonly result: Promise<SimulationResult | null>;
  /** Stops the run; `result` then resolves to null. */
  cancel(): void;
}

/** Runs simulations off the main thread. Provided by the app (Web Worker). */
export interface SimulationService {
  run(request: SimulationRequest, onProgress: (done: number, total: number) => void): SimulationHandle;
}
