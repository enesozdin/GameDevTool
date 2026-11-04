import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Package directory ("node_modules/@scope/name") of a bundled input, or null for own code. */
export function packageDirOf(input: string): string | null {
  // The last node_modules segment wins, so nested copies map to their own package.
  const match = /^(?:.*\/)?(node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
  return match?.[1] ?? null;
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:\.(?:md|txt))?$/i;

interface Notice {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly text: string;
}

/**
 * THIRD_PARTY_NOTICES text for the packages that actually ended up in the bundle.
 * Deterministic: sorted by package name, LF line endings. Fails the build when a bundled
 * package ships no license file, so a notice can never be silently missing.
 */
export async function buildNotices(root: string, packageDirs: Iterable<string>): Promise<string> {
  const notices: Notice[] = [];
  for (const dir of new Set(packageDirs)) {
    const abs = path.join(root, dir);
    const pkg = JSON.parse(await readFile(path.join(abs, "package.json"), "utf8")) as { name: string; version: string; license?: string };
    const files = (await readdir(abs)).filter((f) => LICENSE_FILE.test(f)).sort();
    if (files.length === 0) throw new Error(`${pkg.name}: no license file found in ${dir}`);
    const texts = await Promise.all(files.map((f) => readFile(path.join(abs, f), "utf8")));
    notices.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "(see license text)",
      text: texts.map((t) => t.replace(/\r\n?/g, "\n").trim()).join("\n\n"),
    });
  }
  notices.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const rule = "-".repeat(80);
  const parts = [
    "GameDevTool includes the following third-party software.",
    ...notices.map((n) => `${rule}\n${n.name} ${n.version} (${n.license})\n${rule}\n\n${n.text}`),
  ];
  return parts.join("\n\n") + "\n";
}
