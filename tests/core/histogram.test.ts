import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { monteCarloHistograms, type MonteCarloState } from "../../src/core/index.ts";

/** Two sinks, run-major samples. Only the fields the histogram reads. */
function state(a: readonly number[], b: readonly number[]): MonteCarloState {
  const samples = new Float64Array(a.length * 2);
  a.forEach((v, r) => {
    samples[r * 2] = v;
    samples[r * 2 + 1] = b[r]!;
  });
  return { sinks: Int32Array.of(0, 1), samples, done: a.length } as unknown as MonteCarloState;
}

const total = (counts: Uint32Array) => counts.reduce((s, c) => s + c, 0);

describe("monte carlo histograms", () => {
  it("uses one bin per value for small whole-number ranges and equal bins otherwise", () => {
    const [whole, real] = monteCarloHistograms(state([3, 5, 5, 4, 7], [0, 0.25, 0.5, 1, 10]), 5);
    assert.deepEqual({ start: whole!.start, width: whole!.width }, { start: 2.5, width: 1 });
    assert.deepEqual([...whole!.counts], [1, 1, 2, 0, 1]);

    assert.equal(real!.start, 0);
    assert.equal(real!.width, 2);
    assert.deepEqual([...real!.counts], [4, 0, 0, 0, 1]); // the maximum falls into the last bin
  });

  it("groups wide whole-number ranges into bins of a whole width", () => {
    const values = Array.from({ length: 100 }, (_, i) => i);
    const [h] = monteCarloHistograms(state(values, values), 10);
    assert.deepEqual({ start: h!.start, width: h!.width, bins: h!.counts.length }, { start: -0.5, width: 10, bins: 10 });
    assert.ok(h!.counts.every((c) => c === 10));
    // 61 values in at most 40 bins: width 2, every bin covers two values (no comb).
    const wide = Array.from({ length: 61 }, (_, i) => 60 + i);
    const [w] = monteCarloHistograms(state(wide, wide), 40);
    assert.equal(w!.width, 2);
    assert.equal(w!.counts.length, 31);
    assert.equal(total(w!.counts), 61);
    assert.ok(w!.counts.slice(0, -1).every((c) => c === 2));
  });

  it("treats floating-point noise as whole numbers", () => {
    const [h] = monteCarloHistograms(state([55.00000000000001, 56, 56.99999999999999], [0, 0, 0]));
    assert.deepEqual({ start: h!.start, width: h!.width, counts: [...h!.counts] }, { start: 54.5, width: 1, counts: [1, 1, 1] });
  });

  it("handles constant results and no finished runs", () => {
    const [constant] = monteCarloHistograms(state([2.5, 2.5], [1, 1]));
    assert.deepEqual([...constant!.counts], [2]);
    assert.equal(constant!.start, 2);
    const empty = monteCarloHistograms({ ...state([1], [1]), done: 0 } as MonteCarloState);
    assert.equal(empty[0]!.counts.length, 0);
  });
});
