/**
 * All user-facing UI text lives in string tables, never inline in components.
 * English is the source table; others (e.g. Turkish) are added in Phase 6 and must
 * satisfy the same `UiStrings` shape.
 */
export const en = {
  appName: "GameDevTool",
  untitledProject: "Untitled project",
  tagline: "Engine-agnostic, local-first toolkit for game designers.",
  privacyNote: "Your data stays on this device. This app makes no network requests.",
  projectSection: "Project",
  projectName: "Name",
  schemaVersion: "Schema version",
  assetCount: "Assets",
  issueCount: "Validation issues",
  version: (v: string) => `Version ${v}`,
} as const;

export type UiStrings = { readonly [K in keyof typeof en]: (typeof en)[K] extends (...args: infer A) => string ? (...args: A) => string : string };
