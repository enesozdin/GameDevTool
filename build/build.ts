/**
 * Builds dist/GameDevTool.html: one self-contained file with all JS and CSS inlined and a
 * hash-based CSP. Reproducible: no timestamps, no absolute paths, same commit → same bytes.
 *
 * Usage: node build/build.ts
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { renderHtml } from "./html.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(root, "dist");
const outFile = "GameDevTool.html";

const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ["src/app/main.tsx"],
  outdir: "dist/.bundle", // Required for naming outputs; nothing is written (write: false).
  write: false,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022", "chrome111", "edge111", "firefox115", "safari16.4"],
  minify: true,
  sourcemap: false,
  legalComments: "eof", // License notices of bundled packages stay in the file.
  jsx: "automatic",
  tsconfig: "src/tsconfig.json",
  define: {
    "process.env.NODE_ENV": '"production"',
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  metafile: true,
  logLevel: "warning",
});

const pick = (ext: string): string => {
  const files = result.outputFiles.filter((f) => f.path.endsWith(ext));
  if (files.length > 1) throw new Error(`Expected at most one ${ext} output, got ${files.length}`);
  return files[0]?.text ?? "";
};

const script = pick(".js");
const style = pick(".css");
if (script.length === 0) throw new Error("Empty JS bundle");

const { html } = renderHtml({ title: "GameDevTool", lang: "en", script, style });
const bytes = Buffer.from(html, "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");

await mkdir(distDir, { recursive: true });
await writeFile(path.join(distDir, outFile), bytes);
// `sha256sum -c` compatible.
await writeFile(path.join(distDir, `${outFile}.sha256`), `${sha256}  ${outFile}\n`);

// ---- Size report ----------------------------------------------------------------------
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const byPackage = new Map<string, number>();
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, info] of Object.entries(output.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input);
    const key = match?.[1] ?? "(own code)";
    byPackage.set(key, (byPackage.get(key) ?? 0) + info.bytesInOutput);
  }
}

console.log(`dist/${outFile}`);
console.log(`  size     ${kb(bytes.length)} (gzip ${kb(gzipSync(bytes, { level: 9 }).length)})`);
console.log(`  js       ${kb(Buffer.byteLength(script))}, css ${kb(Buffer.byteLength(style))}`);
console.log(`  sha256   ${sha256}`);
console.log("  by package (minified bytes in output):");
for (const [name, size] of [...byPackage].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${name.padEnd(28)} ${kb(size).padStart(10)}`);
}
