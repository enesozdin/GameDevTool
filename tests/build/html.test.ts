import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { buildCsp, cspHash, renderHtml } from "../../build/html.ts";

describe("CSP", () => {
  it("hashes the exact UTF-8 text", () => {
    const text = "console.log('ç')";
    const expected = createHash("sha256").update(Buffer.from(text, "utf8")).digest("base64");
    assert.equal(cspHash(text), `'sha256-${expected}'`);
  });

  it("blocks everything not explicitly allowed", () => {
    const csp = buildCsp({ scriptHashes: ["'sha256-a'"], styleHashes: ["'sha256-b'"] });
    assert.equal(
      csp,
      "default-src 'none'; script-src 'sha256-a'; style-src 'sha256-b'; img-src data: blob:; font-src data:; " +
        "worker-src blob: 'self'; manifest-src 'self'; form-action 'none'; base-uri 'none'",
    );
    assert.doesNotMatch(csp, /unsafe-|https?:|\*/);
  });
});

describe("renderHtml", () => {
  const script = "document.body.dataset.ok='1'";
  const style = "body{margin:0}";

  it("inlines code and puts the CSP first in <head>", () => {
    const { html, csp } = renderHtml({ title: "T", lang: "en", script, style });
    assert.ok(html.includes(`<script>${script}</script>`));
    assert.ok(html.includes(`<style>${style}</style>`));
    assert.ok(csp.includes(cspHash(script)) && csp.includes(cspHash(style)));
    const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"));
    assert.ok(head.indexOf("Content-Security-Policy") < head.indexOf("<style>"));
    assert.doesNotMatch(html, /\s(src|href)=/);
  });

  it("is deterministic", () => {
    assert.equal(renderHtml({ title: "T", lang: "en", script, style }).html, renderHtml({ title: "T", lang: "en", script, style }).html);
  });

  it("refuses code that could break out of its element", () => {
    assert.throws(() => renderHtml({ title: "T", lang: "en", script: "x='</SCRIPT>'", style }));
    assert.throws(() => renderHtml({ title: "T", lang: "en", script: "x='<!--'", style }));
    assert.throws(() => renderHtml({ title: "T", lang: "en", script, style: "a{}</style>" }));
  });

  it("escapes the title", () => {
    const { html } = renderHtml({ title: '<b>"x"</b>', lang: "en", script, style });
    assert.ok(html.includes("<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</title>"));
  });
});
