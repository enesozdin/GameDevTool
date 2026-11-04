/**
 * Save / Open project file: download and upload. Works in every browser, from file://
 * and when hosted. Files are read with Blob.text(), never fetch(), so the CSP's
 * `default-src 'none'` is never in the way.
 */
import { DEFAULT_JSON_LIMITS, loadProject, PROJECT_FILE_EXTENSION, saveProject, type LoadedProject, type LoadError, type Project, type Result } from "../../core/index.ts";

export type OpenError = LoadError | { readonly code: "read-failed" };

export interface OpenedFile {
  readonly fileName: string;
  readonly loaded: LoadedProject;
}

/**
 * Bytes >= UTF-16 code units for any UTF-8 text, so rejecting files above the char limit
 * before reading never refuses a file that would pass the parser's own check.
 */
const MAX_FILE_BYTES = DEFAULT_JSON_LIMITS.maxChars;

export async function readProjectFile(file: File): Promise<Result<OpenedFile, OpenError>> {
  if (file.size > MAX_FILE_BYTES) {
    return { ok: false, error: { code: "too-large", limit: MAX_FILE_BYTES, actual: file.size } };
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: { code: "read-failed" } };
  }
  const loaded = loadProject(text);
  return loaded.ok ? { ok: true, value: { fileName: file.name, loaded: loaded.value } } : loaded;
}

/** Opens the system file picker. Resolves null when the user cancels. */
export function pickProjectFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `${PROJECT_FILE_EXTENSION},application/json`;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}

/** File name derived from the project name, safe on Windows, macOS and Linux. */
export function defaultFileName(projectName: string): string {
  const base = projectName
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 100);
  return `${base.length > 0 ? base : "project"}${PROJECT_FILE_EXTENSION}`;
}

/** Serializes the project and hands it to the browser as a download. */
export function downloadProject(project: Project, fileName: string): void {
  const blob = new Blob([saveProject(project)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke on the next task: some browsers start the download asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
