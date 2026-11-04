import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseUntrustedJson, stableStringify } from "../../src/core/index.ts";

const limits = { maxChars: 1_000, maxDepth: 4, maxValues: 50 };

describe("parseUntrustedJson", () => {
  it("parses valid JSON", () => {
    assert.deepEqual(parseUntrustedJson('{"a":[1,"x",null,true]}', limits), { ok: true, value: { a: [1, "x", null, true] } });
  });

  it("rejects invalid JSON without throwing", () => {
    assert.deepEqual(parseUntrustedJson("{a:1}", limits), { ok: false, error: { code: "invalid-json" } });
  });

  it("enforces the size limit before parsing", () => {
    const r = parseUntrustedJson(`"${"x".repeat(2_000)}"`, limits);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error.code, "too-large");
  });

  it("enforces the depth limit", () => {
    assert.equal(parseUntrustedJson("[[[[1]]]]", limits).ok, true);
    const r = parseUntrustedJson("[[[[[1]]]]]", limits);
    assert.equal(!r.ok && r.error.code, "too-deep");
  });

  it("survives hostile nesting without stack overflow", () => {
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    const r = parseUntrustedJson(deep, { maxChars: 1_000_000, maxDepth: 64, maxValues: 1_000_000 });
    assert.equal(!r.ok && r.error.code, "too-deep");
  });

  it("enforces the value count limit", () => {
    const r = parseUntrustedJson(JSON.stringify(Array.from({ length: 100 }, () => 0)), limits);
    assert.equal(!r.ok && r.error.code, "too-many-values");
  });

  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`rejects the key ${key} at any depth`, () => {
      const r = parseUntrustedJson(`{"a":{"b":[{"${key}":{"polluted":true}}]}}`, limits);
      assert.deepEqual(r, { ok: false, error: { code: "forbidden-key", key } });
      assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    });
  }
});

describe("stableStringify", () => {
  it("sorts keys and is independent of insertion order", () => {
    const a = stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } });
    const b = stableStringify({ a: { c: null, d: [3, { y: 2, z: 1 }] }, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{\n  "a": {\n    "c": null,\n    "d": [\n      3,\n      {\n        "y": 2,\n        "z": 1\n      }\n    ]\n  },\n  "b": 1\n}\n');
  });

  it("matches JSON.parse round-trip and skips undefined properties", () => {
    const value = { s: 'q"\\\n ', n: -1.5e-7, e: [], o: {}, u: undefined };
    assert.deepEqual(JSON.parse(stableStringify(value)), { s: value.s, n: value.n, e: [], o: {} });
  });

  it("rejects non-finite numbers", () => {
    assert.throws(() => stableStringify({ x: Number.NaN }), TypeError);
  });
});
