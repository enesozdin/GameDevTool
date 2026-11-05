/** Generic text file download / pick (CSV export and import). Read with Blob.text(), never fetch(). */

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

/** Opens the file picker; resolves null on cancel, on read errors or for oversized files. */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        if (file === undefined || file.size > MAX_TEXT_FILE_BYTES) return resolve(null);
        file.text().then(
          (text) => resolve({ name: file.name, text }),
          () => resolve(null),
        );
      },
      { once: true },
    );
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
}
