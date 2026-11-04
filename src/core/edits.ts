/**
 * Typed edit operations on a project. Each returns a Change for the history (or null when
 * the edit is invalid or changes nothing), so the UI never builds patch paths by hand.
 */
import type { Change } from "./history.ts";
import type { IdGenerator } from "./ids.ts";
import type { DocumentAsset } from "./model/document.ts";
import { NameSchema, type Id } from "./model/primitives.ts";
import type { Asset, Project } from "./model/project.ts";
import { MAX_ASSETS } from "./model/project.ts";
import type { TableAsset } from "./model/table.ts";

export function isValidName(name: string): boolean {
  return NameSchema.safeParse(name).success;
}

export function renameProject(project: Project, name: string): Change | null {
  if (!isValidName(name) || name === project.manifest.name) return null;
  return {
    label: "rename-project",
    coalesceKey: "rename-project",
    patches: [{ op: "set", path: ["manifest", "name"], value: name }],
  };
}

export function createDocument(newId: IdGenerator, name: string): DocumentAsset {
  return { id: newId(), kind: "document", name, markdown: "" };
}

export function createTable(newId: IdGenerator, name: string): TableAsset {
  return { id: newId(), kind: "table", name, columns: [], rows: [] };
}

export function addAsset(project: Project, asset: Asset): Change | null {
  if (project.assets.length >= MAX_ASSETS) return null;
  return {
    label: `add-${asset.kind}`,
    patches: [{ op: "insert", path: ["assets"], index: project.assets.length, value: asset }],
  };
}

export function findAssetIndex(project: Project, id: Id): number {
  return project.assets.findIndex((a) => a.id === id);
}

export function renameAsset(project: Project, id: Id, name: string): Change | null {
  const index = findAssetIndex(project, id);
  if (index < 0 || !isValidName(name) || project.assets[index]!.name === name) return null;
  return {
    label: "rename-asset",
    coalesceKey: `rename-asset:${id}`,
    patches: [{ op: "set", path: ["assets", index, "name"], value: name }],
  };
}

export function removeAsset(project: Project, id: Id): Change | null {
  const index = findAssetIndex(project, id);
  if (index < 0) return null;
  return { label: "remove-asset", patches: [{ op: "remove", path: ["assets"], index }] };
}
