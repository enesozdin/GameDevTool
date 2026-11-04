/**
 * Supply-chain check for package-lock.json (docs/DEPENDENCIES.md, "CI checks"):
 * - every installed package resolves to https://registry.npmjs.org/ (no git, file, tarball
 *   or mirror URLs) and carries a sha512 integrity hash;
 * - every direct dependency in package.json is an exact version (no ranges).
 *
 * Usage: node scripts/check-lockfile.ts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REGISTRY = "https://registry.npmjs.org/";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

interface LockEntry {
  readonly resolved?: string;
  readonly integrity?: string;
  readonly link?: boolean;
}

interface PackageJson {
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

interface Lockfile {
  readonly lockfileVersion?: number;
  readonly packages?: Readonly<Record<string, LockEntry>>;
}

/** Returns one message per problem; an empty list means the lockfile passes. */
export function checkLockfile(pkg: PackageJson, lock: Lockfile): string[] {
  const problems: string[] = [];
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion must be 3, got ${String(lock.lockfileVersion)}`);

  for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    if (!EXACT_VERSION.test(spec)) problems.push(`${name}: "${spec}" is not an exact version`);
  }

  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue; // The root project itself.
    if (entry.link === true) {
      problems.push(`${key}: linked package (not from the registry)`);
      continue;
    }
    if (entry.resolved === undefined || !entry.resolved.startsWith(REGISTRY)) {
      problems.push(`${key}: resolved from ${entry.resolved ?? "(missing)"}`);
    }
    if (entry.integrity === undefined || !entry.integrity.startsWith("sha512-")) {
      problems.push(`${key}: missing sha512 integrity`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const read = async (file: string): Promise<unknown> => JSON.parse(await readFile(path.join(root, file), "utf8"));
  const problems = checkLockfile((await read("package.json")) as PackageJson, (await read("package-lock.json")) as Lockfile);
  if (problems.length > 0) {
    for (const p of problems) console.error(`lockfile: ${p}`);
    process.exit(1);
  }
  console.log("lockfile: all packages resolve to the npm registry with sha512 integrity");
}
