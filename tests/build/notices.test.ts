import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildNotices, packageDirOf } from "../../build/notices.ts";

describe("third-party notices", () => {
  it("maps bundle inputs to package directories", () => {
    assert.equal(packageDirOf("src/app/main.tsx"), null);
    assert.equal(packageDirOf("node_modules/react/index.js"), "node_modules/react");
    assert.equal(packageDirOf("node_modules/@tanstack/virtual-core/dist/esm/index.js"), "node_modules/@tanstack/virtual-core");
    assert.equal(packageDirOf("node_modules/a/node_modules/b/lib/x.js"), "node_modules/b");
    assert.equal(packageDirOf("node_modules\\zod\\v4\\index.js"), "node_modules/zod");
  });

  it("includes each package's license text, sorted and deterministic", async () => {
    const dirs = ["node_modules/zod", "node_modules/react", "node_modules/react"];
    const text = await buildNotices(process.cwd(), dirs);
    assert.equal(text, await buildNotices(process.cwd(), [...dirs].reverse()));
    const react = text.indexOf("\nreact ");
    const zod = text.indexOf("\nzod ");
    assert.ok(react > 0 && zod > react, "sorted by name, each package once");
    assert.equal(text.split("\nreact ").length, 2);
    assert.match(text, /\(MIT\)\n-{80}\n\nMIT License/);
    assert.doesNotMatch(text, /\r/);
  });
});
