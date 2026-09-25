import test from "node:test";
import assert from "node:assert/strict";
import { buildExportSvgString, fitExportPixels } from "../src/export-image.js";

test("buildExportSvgString wraps body + css in a sized SVG foreignObject", () => {
  const svg = buildExportSvgString({
    bodyXhtml: '<div class="content">hello</div>',
    css: ".content{color:red}",
    width: 640,
    height: 480,
    background: "#dce0e8",
  });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<foreignObject /);
  assert.match(svg, /width="640"/);
  assert.match(svg, /height="480"/);
  assert.ok(svg.includes("<style>.content{color:red}</style>"), "embeds css");
  assert.ok(svg.includes('<div class="content">hello</div>'), "embeds body");
  assert.ok(svg.includes("background:#dce0e8"), "applies solid background");
  assert.ok(/font-family:[^"]*sans-serif/.test(svg), "pins a sans-serif font on the export root");
  assert.ok(svg.includes('xmlns="http://www.w3.org/1999/xhtml"'), "xhtml namespaced");
  assert.ok(svg.trimEnd().endsWith("</svg>"));
});

test("buildExportSvgString can preserve a transparent background", () => {
  const svg = buildExportSvgString({
    bodyXhtml: '<section class="content">hello</section>',
    css: "/* native <details> */ .content > .child { color: red }",
    width: 320,
    height: 200,
    background: "transparent",
  });
  assert.ok(!svg.includes("background:#"), "does not emit a solid root background");
  assert.ok(!svg.includes("<rect"), "does not add an opaque SVG backing rect");
  assert.ok(svg.includes("&lt;details&gt;"), "still XML-escapes CSS");
  assert.ok(svg.includes(".content &gt; .child"), "still escapes CSS combinators");
  assert.ok(svg.includes('<section class="content">hello</section>'), "embeds body");
});

test("buildExportSvgString ceils fractional dimensions and defaults background", () => {
  const svg = buildExportSvgString({
    bodyXhtml: "<p>x</p>",
    css: "",
    width: 100.2,
    height: 50.9,
  });
  assert.match(svg, /width="101"/);
  assert.match(svg, /height="51"/);
  assert.ok(svg.includes("background:#ffffff"), "defaults to white background");
});

test("buildExportSvgString never returns zero-size dimensions", () => {
  const svg = buildExportSvgString({ bodyXhtml: "", css: "", width: 0, height: 0 });
  assert.match(svg, /width="1"/);
  assert.match(svg, /height="1"/);
});

test("buildExportSvgString XML-escapes CSS so a comment or combinator can't break the SVG", () => {
  // A CSS comment containing `<` (e.g. "native <details>") and a `>` child
  // combinator must be escaped, or the embedded <style> makes the SVG malformed
  // and the export <img> fails to load ("Could not render image").
  const css = "/* native <details> */ .a > .b { color: red } .c { content: '&' }";
  const svg = buildExportSvgString({ bodyXhtml: "<p>x</p>", css, width: 10, height: 10 });
  // No raw markup-breaking chars leaked from the CSS into the document…
  assert.ok(!svg.includes("<details>"), "raw < from CSS must be escaped");
  assert.ok(svg.includes("&lt;details&gt;"), "CSS < / > are entity-escaped");
  assert.ok(svg.includes(".a &gt; .b"), "child combinator escaped");
  assert.ok(svg.includes("content: '&amp;'"), "ampersand escaped");
  // The body markup itself is still emitted verbatim (already valid XML).
  assert.ok(svg.includes("<p>x</p>"), "body markup untouched");
});

test("fitExportPixels: small views keep their requested scale", () => {
  const out = fitExportPixels(800, 600, 2);
  assert.deepEqual({ w: out.width, h: out.height }, { w: 1600, h: 1200 });
  assert.equal(out.scale, 2);
});

test("fitExportPixels: clamps to the 32 MP budget, preserving aspect ratio", () => {
  // 5000x4000 @2x = 10000x8000 = 80 MP → must shrink under 32 MP.
  const out = fitExportPixels(5000, 4000, 2);
  assert.ok(out.width * out.height <= 32_000_000, `pixels ${out.width * out.height} <= 32MP`);
  // aspect ratio (5:4) preserved within rounding.
  assert.ok(Math.abs(out.width / out.height - 5 / 4) < 0.01, `aspect ${out.width}/${out.height}`);
  assert.ok(out.scale < 2, "scaled down from the requested 2x");
});

test("fitExportPixels: clamps a very long side to the max dimension", () => {
  // 20000x1000 @1x → width would be 20000 (> 8192).
  const out = fitExportPixels(20000, 1000, 1);
  assert.ok(out.width <= 8192, `width ${out.width} <= 8192`);
  assert.ok(out.height <= 8192, `height ${out.height} <= 8192`);
  assert.ok(out.width * out.height <= 32_000_000);
});

test("fitExportPixels: never returns a zero side", () => {
  const out = fitExportPixels(0, 0, 1);
  assert.ok(out.width >= 1 && out.height >= 1);
});

test("fitExportPixels: 8192x4096-style requests come back within budget", () => {
  // The exact size Miro rejects (33.5 MP) must be brought under 32 MP.
  const out = fitExportPixels(8192, 4096, 1);
  assert.ok(out.width * out.height <= 32_000_000, `${out.width}x${out.height}`);
});
