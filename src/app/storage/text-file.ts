/** Generic text file download / pick (CSV export and import). Read with Blob.text(), never fetch(). */

import type { PickedTextFile } from "../../ui/tables/TableEditor.tsx";

/** CSV files are table data, far smaller than projects; this keeps memory bounded. */
const MAX_TEXT_FILE_BYTES = 64 * 1024 * 1024;

export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Opens the file picker; resolves null on cancel, an `error` entry for oversized or unreadable files. */
export function pickTextFile(accept: string): Promise<PickedTextFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (file === undefined) return resolve(null);
        if (file.size > MAX_TEXT_FILE_BYTES) return resolve({ name: file.name, error: "too-large" });
        file.text().then(
          (text) => resolve({ name: file.name, text }),
          () => resolve({ name: file.name, error: "read-failed" }),
        );
      },
      { once: true },
    );
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}
