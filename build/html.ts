import { createHash } from "node:crypto";

/** CSP source expression for an inline block, e.g. 'sha256-…'. Hashes the exact UTF-8 text. */
export function cspHash(content: string): string {
  return `'sha256-${createHash("sha256").update(content, "utf8").digest("base64")}'`;
}

export interface CspInput {
  readonly scriptHashes: readonly string[];
  readonly styleHashes: readonly string[];
}

/**
 * The policy from docs/ROADMAP.md §2.5. `default-src 'none'` blocks fetch/XHR/WebSocket
 * and every remote resource; only the hashed inline bundle may run.
 * Directives that a <meta> CSP ignores (frame-ancestors, sandbox, report-uri) are omitted.
 */
export function buildCsp({ scriptHashes, styleHashes }: CspInput): string {
  if (scriptHashes.length === 0) throw new Error("CSP: at least one script hash is required");
  const directives: readonly (readonly [string, readonly string[]])[] = [
    ["default-src", ["'none'"]],
    ["script-src", scriptHashes],
    ["style-src", styleHashes.length > 0 ? styleHashes : ["'none'"]],
    ["img-src", ["data:", "blob:"]],
    ["font-src", ["data:"]],
    // 'self' is only needed for sw.js in hosted mode.
    ["worker-src", ["blob:", "'self'"]],
    ["manifest-src", ["'self'"]],
    ["form-action", ["'none'"]],
    ["base-uri", ["'none'"]],
  ];
  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}

export interface HtmlInput {
  readonly title: string;
  readonly lang: string;
  readonly script: string;
  readonly style: string;
}

export interface HtmlOutput {
  readonly html: string;
  readonly csp: string;
}

/**
 * Inlining is only safe if the code cannot close its own element. esbuild already escapes
 * "</script" inside strings; anything left over is a build error instead of a silent
 * rewrite, because changing the bundle after hashing would break the CSP.
 */
function assertInlineSafe(content: string, tag: "script" | "style"): void {
  const lower = content.toLowerCase();
  if (lower.includes(`</${tag}`)) throw new Error(`Inline ${tag} contains "</${tag}"`);
  if (tag === "script" && lower.includes("<!--")) throw new Error('Inline script contains "<!--"');
}

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);
}

export function renderHtml({ title, lang, script, style }: HtmlInput): HtmlOutput {
  assertInlineSafe(script, "script");
  assertInlineSafe(style, "style");

  const csp = buildCsp({ scriptHashes: [cspHash(script)], styleHashes: style.length > 0 ? [cspHash(style)] : [] });

  // The CSP <meta> must come before any script or style. Hashes cover the exact text
  // between the tags, so nothing (not even whitespace) may be added inside them.
  const html =
    "<!doctype html>\n" +
    `<html lang="${escapeHtml(lang)}">\n` +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">\n` +
    '<meta name="referrer" content="no-referrer">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="color-scheme" content="light dark">\n' +
    `<title>${escapeHtml(title)}</title>\n` +
    (style.length > 0 ? `<style>${style}</style>\n` : "") +
    "</head>\n" +
    "<body>\n" +
    '<div id="root"></div>\n' +
    `<script>${script}</script>\n` +
    "</body>\n" +
    "</html>\n";

  return { html, csp };
}
