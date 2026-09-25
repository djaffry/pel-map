const DEFAULT_BG = "#ffffff";
const TRANSPARENT_BG = "transparent";

// Cap PNG output at ≤32 MP / ≤8192 px per side because tools like Miro reject larger images.
const MAX_EXPORT_PIXELS = 32_000_000;
const MAX_EXPORT_DIMENSION = 8192;
const NO_LINKED_CSS = Symbol("no linked CSS");

const EXPORT_FONT =
  "var(--font, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif)";

export function buildExportSvgString({ bodyXhtml, css, width, height, background }) {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  const bg = background || DEFAULT_BG;
  const bgStyle = isTransparentBackground(bg) ? "" : `background:${bg};`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
      `<foreignObject x="0" y="0" width="${w}" height="${h}">` +
        `<div xmlns="http://www.w3.org/1999/xhtml" ` +
             `style="width:${w}px;height:${h}px;overflow:hidden;${bgStyle}font-family:${EXPORT_FONT}">` +
          `<style>${escapeCssForXml(css)}</style>` +
          bodyXhtml +
        `</div>` +
      `</foreignObject>` +
    `</svg>`
  );
}

export function fitExportPixels(width, height, scale, caps = {}) {
  const maxPixels = caps.maxPixels ?? MAX_EXPORT_PIXELS;
  const maxDimension = caps.maxDimension ?? MAX_EXPORT_DIMENSION;
  const w0 = Math.max(1, width) * Math.max(scale, 0.01);
  const h0 = Math.max(1, height) * Math.max(scale, 0.01);
  const factor = Math.min(
    1,
    maxDimension / w0,
    maxDimension / h0,
    Math.sqrt(maxPixels / (w0 * h0))
  );
  return {
    width: Math.max(1, Math.floor(w0 * factor)),
    height: Math.max(1, Math.floor(h0 * factor)),
    scale: scale * factor,
  };
}

export async function exportElementAsImage(el, opts = {}) {
  if (!el) throw new Error("Nothing to export.");
  const {
    filename = "export.png",
    background = DEFAULT_BG,
    margin = 32,
    scale = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1),
  } = opts;

  const { svg, width, height } = await buildSvgForElement(el, { background, margin });
  await rasterizeAndDownload(svg, { width, height, background, scale, filename });
}

export async function exportElementAsSvg(el, opts = {}) {
  if (!el) throw new Error("Nothing to export.");
  const {
    filename = "export.svg",
    background = DEFAULT_BG,
    margin = 32,
  } = opts;

  const { svg } = await buildSvgForElement(el, { background, margin });
  downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename);
}

async function buildSvgForElement(el, { background, margin }) {
  const { clone, host } = mountExportClone(el);
  try {
    const box = contentBox(clone);
    if (!box) throw new Error("Nothing visible to export.");
    const { cropX, cropY, width, height } = cropContentBox(box, margin);
    const bodyXhtml = serializeCroppedClone(clone, cropX, cropY);
    const css = await collectCss();
    const svg = buildExportSvgString({ bodyXhtml, css, width, height, background });
    return { svg, width, height };
  } finally {
    host.remove();
  }
}

function rasterizeAndDownload(svg, { width, height, background, scale, filename }) {
  return new Promise((resolve, reject) => {
    const url = svgDataUrl(svg);
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = drawImageToCanvas(img, { width, height, background, scale });
        canvas.toBlob((png) => finishPngDownload(png, filename, resolve, reject), "image/png");
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("Could not render image."));
    img.src = url;
  });
}

function drawImageToCanvas(img, { width, height, background, scale }) {
  const out = fitExportPixels(width, height, scale);
  const canvas = document.createElement("canvas");
  canvas.width = out.width;
  canvas.height = out.height;
  const ctx = canvas.getContext("2d");
  if (!isTransparentBackground(background)) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(img, 0, 0, out.width, out.height);
  return canvas;
}

function finishPngDownload(png, filename, resolve, reject) {
  if (!png) {
    reject(new Error("Could not encode image."));
    return;
  }
  downloadBlob(png, filename);
  resolve();
}

function mountExportClone(el) {
  const clone = el.cloneNode(true);
  clone.style.setProperty("--zoom", "1");
  clone.style.margin = "0";
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none;z-index:-1;";
  host.appendChild(clone);
  document.body.appendChild(host);
  return { clone, host };
}

function cropContentBox(box, margin) {
  return {
    cropX: box.minX - margin,
    cropY: box.minY - margin,
    width: box.maxX - box.minX + margin * 2,
    height: box.maxY - box.minY + margin * 2,
  };
}

function serializeCroppedClone(clone, cropX, cropY) {
  const serialized = new XMLSerializer().serializeToString(clone);
  return (
    `<div xmlns="http://www.w3.org/1999/xhtml" ` +
    `style="position:absolute;left:${-cropX}px;top:${-cropY}px">${serialized}</div>`
  );
}

function svgDataUrl(svg) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function isTransparentBackground(background) {
  return String(background).trim().toLowerCase() === TRANSPARENT_BG;
}

function escapeCssForXml(css) {
  // Escape inlined CSS because a < or & in a rule would corrupt the SVG document.
  return String(css ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function collectCss() {
  const linkedCss = await fetchLinkedStylesheet();
  if (linkedCss !== NO_LINKED_CSS) return linkedCss;

  let out = "";
  for (const sheet of document.styleSheets || []) {
    try {
      for (const rule of sheet.cssRules) out += rule.cssText + "\n";
    } catch {}
  }
  return out;
}

async function fetchLinkedStylesheet() {
  try {
    const href = document.querySelector('link[rel="stylesheet"]')?.href;
    if (!href) return NO_LINKED_CSS;
    const res = await fetch(href);
    return res.ok ? await res.text() : NO_LINKED_CSS;
  } catch {}
  return NO_LINKED_CSS;
}

function contentBox(root) {
  const rootRect = root.getBoundingClientRect();
  const nodes = root.querySelectorAll(".card, .list-row, .loc-box");
  let box = null;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    box = mergeBoxes(box, {
      minX: r.left - rootRect.left,
      minY: r.top - rootRect.top,
      maxX: r.right - rootRect.left,
      maxY: r.bottom - rootRect.top,
    });
  }
  return box;
}

function mergeBoxes(a, b) {
  if (!a) return b;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
