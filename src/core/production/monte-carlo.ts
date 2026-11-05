/**
 * Monte Carlo runs for chance-based outputs and random sources (ROADMAP §4.1). Pure and
 * seeded, so a run is reproducible; the app calls it from a Web Worker in chunks.
 *
 * Each run samples what one period of `seconds` actually yields:
 * - a "poisson" source delivers Poisson(rate × seconds) items;
 * - an output with chance p over c cycles yields Binomial(c, p) × count items, where c is
 *   the cycle count of the deterministic supply-driven solution. When a recipe lists one
 *   item several times, each stack is sampled with its own chance and the yields add up.
 * The supply-driven solver then turns those effective rates into sink output. Using the
 * deterministic cycle count is an approximation: upstream randomness changes c slightly,
 * which only matters for long chains of chance outputs.
 *
 * Gates are evaluated once per simulation (one scenario of variable values): a locked node
 * yields nothing in every run.
 */
import { createRandom, sampleBinomial, samplePoisson, type Random } from "../random.ts";
import type { Network } from "./network.ts";
import { NodeKind } from "./network.ts";
import { solveNetwork, type SolveResult } from "./solve.ts";

export interface MonteCarloOptions {
  readonly runs: number;
  /** Length of one simulated period in seconds (e.g. 3600 for "per hour"). */
  readonly seconds: number;
  readonly seed: number;
  /** Per node: 1 = locked by a gate (see gates.ts). Same lock state in every run. */
  readonly locked?: Uint8Array;
}

export interface MonteCarloState {
  readonly random: Random;
  readonly base: SolveResult;
  /** Sink node indices, in node order. */
  readonly sinks: Int32Array;
  /** Items per period at each sink, run-major: samples[run * sinks.length + s]. */
  readonly samples: Float64Array;
  done: number;
}

export interface Percentiles {
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  readonly mean: number;
}

export const MONTE_CARLO_LIMITS = { runs: 100_000, seconds: 1e9 } as const;

/** True if the network has anything random; without it every run is identical. */
export function hasRandomness(net: Network): boolean {
  for (let p = 0; p < net.outChance.length; p++) if (net.outChance[p]! < 1) return true;
  for (let u = 0; u < net.nodeCount; u++) {
    const node = net.graph.nodes[u]!;
    if (node.type === "source" && node.distribution === "poisson") return true;
  }
  return false;
}

export function startMonteCarlo(net: Network, options: MonteCarloOptions): MonteCarloState {
  const runs = Math.max(1, Math.min(MONTE_CARLO_LIMITS.runs, Math.floor(options.runs)));
  const sinks: number[] = [];
  for (let u = 0; u < net.nodeCount; u++) if (net.kind[u] === NodeKind.sink) sinks.push(u);
  return {
    random: createRandom(options.seed),
    base: solveNetwork(net, "supply", { locked: options.locked }),
    sinks: Int32Array.from(sinks),
    samples: new Float64Array(runs * sinks.length),
    done: 0,
  };
}

/** Runs up to `count` more runs. Returns true when all runs are done. */
export function stepMonteCarlo(net: Network, state: MonteCarloState, options: MonteCarloOptions, count: number): boolean {
  const runs = state.samples.length / Math.max(1, state.sinks.length);
  const total = state.sinks.length === 0 ? 0 : runs;
  const seconds = options.seconds;
  const sourceRate = new Float64Array(net.nodeCount).fill(NaN);
  const outScale = new Float64Array(net.outItem.length).fill(1);
  const end = Math.min(total, state.done + count);

  for (let run = state.done; run < end; run++) {
    for (let u = 0; u < net.nodeCount; u++) {
      if (net.kind[u] !== NodeKind.source) continue;
      const node = net.graph.nodes[u]!;
      if (node.type === "source" && node.distribution === "poisson") {
        sourceRate[u] = samplePoisson(state.random, net.rate[u]! * seconds) / seconds;
      }
    }
    for (let u = 0; u < net.nodeCount; u++) {
      const cycles = state.base.activity[u]! * seconds;
      for (let p = net.outStart[u]!; p < net.outStart[u + 1]!; p++) {
        if (net.outChance[p]! >= 1 || !(cycles > 0)) continue;
        // Each stack of the port separately: guaranteed parts yield count × cycles, chance
        // parts count × Binomial(cycles, chance).
        let sampled = 0;
        for (let k = net.outPartStart[p]!; k < net.outPartStart[p + 1]!; k++) {
          const chance = net.outPartChance[k]!;
          sampled += net.outPartCount[k]! * (chance >= 1 ? cycles : sampleBinomial(state.random, cycles, chance));
        }
        outScale[p] = sampled / (cycles * net.outCoef[p]!);
      }
    }
    const result = solveNetwork(net, "supply", { sourceRate, outScale, maxSweeps: 200, locked: options.locked });
    for (let s = 0; s < state.sinks.length; s++) {
      state.samples[run * state.sinks.length + s] = result.activity[state.sinks[s]!]! * seconds;
    }
  }
  state.done = end;
  return end >= total;
}

/** P10 / P50 / P90 and mean per sink over the finished runs. */
export function monteCarloPercentiles(state: MonteCarloState): Percentiles[] {
  const sinks = state.sinks.length;
  const values = new Float64Array(state.done);
  const out: Percentiles[] = [];
  for (let s = 0; s < sinks; s++) {
    let sum = 0;
    for (let r = 0; r < state.done; r++) {
      const v = state.samples[r * sinks + s]!;
      values[r] = v;
      sum += v;
    }
    values.sort();
    out.push({
      p10: quantile(values, 0.1),
      p50: quantile(values, 0.5),
      p90: quantile(values, 0.9),
      mean: state.done === 0 ? 0 : sum / state.done,
    });
  }
  return out;
}

export interface Histogram {
  /** Left edge of the first bin. */
  readonly start: number;
  /** Bin width (> 0). */
  readonly width: number;
  /** Runs per bin. */
  readonly counts: Uint32Array;
}

/**
 * Distribution of items per period at each sink, for charts, in at most `maxBins` bins.
 * Whole-number results get bins of a whole width with edges halfway between values (one
 * bin per value when the range is small); everything else gets equal bins from min to max.
 * O(runs × sinks), no sorting.
 */
export function monteCarloHistograms(state: MonteCarloState, maxBins = 40): Histogram[] {
  const sinks = state.sinks.length;
  const bins = Math.max(1, Math.floor(maxBins));
  const out: Histogram[] = [];
  for (let s = 0; s < sinks; s++) {
    let min = Infinity;
    let max = -Infinity;
    let whole = true;
    for (let r = 0; r < state.done; r++) {
      const v = state.samples[r * sinks + s]!;
      if (!Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      // Counts come out of rate × seconds, so allow floating-point noise (55.00000000000001).
      if (whole && Math.abs(v - Math.round(v)) > 1e-9 * Math.max(1, Math.abs(v))) whole = false;
    }
    if (min > max) {
      out.push({ start: 0, width: 1, counts: new Uint32Array(0) });
      continue;
    }
    // Whole numbers: bins of a whole width with edges halfway between values, so every bin
    // holds the same number of possible values (no comb pattern). Otherwise equal bins.
    const discrete = whole || min === max;
    if (whole) {
      min = Math.round(min);
      max = Math.round(max);
    }
    const width = discrete ? Math.max(1, Math.ceil((max - min + 1) / bins)) : (max - min) / bins;
    const start = discrete ? min - 0.5 : min;
    const counts = new Uint32Array(discrete ? Math.ceil((max - min + 1) / width) : bins);
    const last = counts.length - 1;
    for (let r = 0; r < state.done; r++) {
      const v = state.samples[r * sinks + s]!;
      if (!Number.isFinite(v)) continue;
      counts[Math.min(last, Math.max(0, Math.floor(((whole ? Math.round(v) : v) - start) / width)))]!++;
    }
    out.push({ start, width, counts });
  }
  return out;
}

/** Linear interpolation between order statistics (type 7, as in spreadsheets). */
function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
}
