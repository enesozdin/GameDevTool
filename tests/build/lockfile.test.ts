import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { checkLockfile } from "../../scripts/check-lockfile.ts";

const good = {
  resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
  integrity: "sha512-abc",
};

describe("lockfile check", () => {
  it("passes the committed lockfile", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
    assert.deepEqual(checkLockfile(pkg, lock), []);
  });

  it("rejects ranges, foreign URLs, links and weak integrity", () => {
    const problems = checkLockfile(
      { dependencies: { a: "^1.0.0", b: "1.2.3" }, devDependencies: { c: "latest" } },
      {
        lockfileVersion: 3,
        packages: {
          "": {},
          "node_modules/ok": good,
          "node_modules/git": { resolved: "git+https://github.com/x/y.git", integrity: "sha512-x" },
          "node_modules/mirror": { resolved: "https://registry.npmjs.org.evil.example/x.tgz", integrity: "sha512-x" },
          "node_modules/sha1": { resolved: good.resolved, integrity: "sha1-x" },
          "node_modules/linked": { link: true },
        },
      },
    );
    assert.deepEqual(problems, [
      'a: "^1.0.0" is not an exact version',
      'c: "latest" is not an exact version',
      "node_modules/git: resolved from git+https://github.com/x/y.git",
      "node_modules/mirror: resolved from https://registry.npmjs.org.evil.example/x.tgz",
      "node_modules/sha1: missing sha512 integrity",
      "node_modules/linked: linked package (not from the registry)",
    ]);
  });
});
