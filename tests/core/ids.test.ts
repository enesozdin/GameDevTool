import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { describe, it } from "node:test";
import { createIdGenerator, ULID_PATTERN, ulidTime } from "../../src/core/index.ts";

describe("ULID generator", () => {
  it("encodes the timestamp and matches the ULID pattern", () => {
    const now = 1_767_225_600_000;
    const id = createIdGenerator({ now: () => now, fillRandom: (b) => webcrypto.getRandomValues(b) })();
    assert.match(id, ULID_PATTERN);
    assert.equal(ulidTime(id), now);
  });

  it("matches the reference encoding of the ULID spec", () => {
    // Spec example timestamp 1469918176385 encodes to 01ARYZ6S41.
    const id = createIdGenerator({ now: () => 1_469_918_176_385, fillRandom: (b) => b.fill(0) })();
    assert.equal(id, "01ARYZ6S410000000000000000");
  });

  it("is strictly monotonic within one millisecond and when the clock goes back", () => {
    let now = 1_000;
    const next = createIdGenerator({ now: () => now, fillRandom: (b) => webcrypto.getRandomValues(b) });
    const ids: string[] = [];
    for (let i = 0; i < 1_000; i++) {
      if (i === 500) now = 999; // clock moved backwards
      ids.push(next());
    }
    for (let i = 1; i < ids.length; i++) assert.ok(ids[i - 1]! < ids[i]!, `${ids[i - 1]} < ${ids[i]}`);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("carries across random digits", () => {
    const next = createIdGenerator({ now: () => 0, fillRandom: (b) => b.fill(31) });
    // All random digits are 31 ("Z"), so the increment overflows and must throw.
    assert.equal(next(), "0000000000ZZZZZZZZZZZZZZZZ");
    assert.throws(() => next(), RangeError);
  });

  it("rejects timestamps outside 48 bits", () => {
    assert.throws(() => createIdGenerator({ now: () => 2 ** 48, fillRandom: (b) => b.fill(0) })(), RangeError);
    assert.throws(() => createIdGenerator({ now: () => -1, fillRandom: (b) => b.fill(0) })(), RangeError);
  });
});
