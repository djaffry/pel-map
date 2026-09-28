// DOM smoke test (not part of the unit suite): validates render + drag-drop wiring.
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM(`<!DOCTYPE html><body><div id="summary"></div><ul id="tree"></ul></body>`, {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;

const { validatePeople } = await import("../src/validate.js");
const { buildHierarchy } = await import("../src/balance.js");
const { render } = await import("../src/render.js");
const { checkMove, checkTree } = await import("../src/constraints.js");
const { walk } = await import("../src/tree.js");

const sample = JSON.parse(readFileSync(join(dir, "..", "sample-data.json"), "utf8"));
const span = { min: 3, max: 8 };
const { people } = validatePeople(sample);
const result = buildHierarchy(people, { span });

const targets = { treeEl: document.getElementById("tree"), summaryEl: document.getElementById("summary") };
render(targets, result, { onDrop() {} }, { span });

const cards = document.querySelectorAll(".card");
const stats = document.querySelectorAll(".stat").length;
console.log(`rendered cards: ${cards.length}, stat tiles: ${stats}`);
if (cards.length !== people.length) throw new Error(`expected ${people.length} cards, got ${cards.length}`);
if (stats < 5) throw new Error("summary stats missing");

{
  let ho;
  walk(result.root, (n) => { if (n.person.role === "HO") ho = n; });
  const hoCard = document.querySelector(`.card[data-id="${ho.id}"]`);
  const strip = hoCard.querySelector(".capacity");
  if (!strip) throw new Error("HO card should have a capacity strip");
  const filled = strip.querySelectorAll(".slot.filled").length;
  const open = strip.querySelectorAll(".slot.open").length;
  const realDirects = ho.children.filter((c) => c.person.role !== "NSE").length;
  console.log(`HO capacity strip: ${filled} filled + ${open} open (= ${span.max})`);
  if (filled !== realDirects) throw new Error(`expected ${realDirects} filled pips, got ${filled}`);
  if (filled + open !== span.max) throw new Error(`filled + open should equal span.max (${span.max}), got ${filled + open}`);
  // Every filled pip carries a colour tier (under=amber / ok=green); the HO sits
  // within [min,max], so all its filled pips are green (.ok) and none are red.
  const tiered = strip.querySelectorAll(".slot.filled.under, .slot.filled.ok").length;
  if (tiered !== filled) throw new Error(`every filled pip needs a colour tier, got ${tiered}/${filled}`);
  if (strip.querySelectorAll(".slot.over").length !== 0) throw new Error("HO within capacity must show no over (red) pips");
  const vpCard = document.querySelector(".card.role-VP");
  if (vpCard && vpCard.querySelector(".capacity")) throw new Error("VP card must not show a capacity strip");
  if (open > 0) {
    let dropped = null;
    render(targets, result, { onDrop: (childId, parentId) => { dropped = { childId, parentId }; } }, { span });
    const openSlot = document.querySelector(`.card[data-id="${ho.id}"] .slot.open`);
    const dt = { data: {}, setData(k, v) { this.data[k] = v; }, getData(k) { return this.data[k]; } };
    dt.setData("text/plain", "drag-xyz");
    const ev = new dom.window.Event("drop", { bubbles: true, cancelable: true });
    ev.dataTransfer = dt;
    openSlot.dispatchEvent(ev);
    if (!dropped || dropped.childId !== "drag-xyz" || dropped.parentId !== ho.id) {
      throw new Error(`dropping on an open slot should assign to the HO, got ${JSON.stringify(dropped)}`);
    }
    console.log("open-slot drop assigns to leader: OK");
  }
}

const chips = document.querySelectorAll(".card .loc-chip");
console.log(`location chips: ${chips.length}`);
if (chips.length !== cards.length) throw new Error(`expected one loc-chip per card (${cards.length}), got ${chips.length}`);

const nseCards = document.querySelectorAll(".card.role-NSE");
const nseInData = people.filter((p) => p.role === "NSE").length;
console.log(`non-SE cards: ${nseCards.length}, metrics.marked: ${result.metrics.marked}`);
if (nseInData > 0) {
  if (nseCards.length !== nseInData) throw new Error(`expected ${nseInData} role-NSE cards, got ${nseCards.length}`);
  if (result.metrics.marked !== nseInData) throw new Error(`metrics.marked should be ${nseInData}`);
  // A marked person must never be a people leader and must have no reports.
  walk(result.root, (n) => {
    if (n.person.role === "NSE" && n.children.length) throw new Error("marked node must be a leaf");
  });
}

{
  const { makeNode, attach } = await import("../src/tree.js");
  const { computeMetrics } = await import("../src/balance.js");
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ic = makeNode({ name: "IC", role: "TA", location: "VIE", isPeopleLeader: false, level: 1 }); // IC with a report => NODE_LEAF
  const rep = makeNode({ name: "R", role: "TA", location: "VIE", isPeopleLeader: false, level: 1 });
  attach(vp, ic); attach(ic, rep);
  const errResult = { root: vp, metrics: computeMetrics(vp), constraints: checkTree(vp, { span }), notes: [] };
  render({ treeEl: document.getElementById("tree"), summaryEl: document.getElementById("summary") }, errResult, {});
  const badges = document.querySelectorAll(".error-badge");
  console.log(`error badges: ${badges.length}`);
  if (badges.length < 1) throw new Error("expected a red error badge on the violating node");
  if (badges[0].textContent !== "!") throw new Error("error badge should read '!'");

  const cardErr = document.querySelector(".card.has-error .card-error");
  console.log(`inline card-error: ${cardErr ? JSON.stringify(cardErr.textContent) : "none"}`);
  if (!cardErr) throw new Error("expected inline .card-error text on the violating node");
  if (!/not a people leader/.test(cardErr.textContent)) throw new Error("inline .card-error should carry the violation message");

  let focused = null;
  render(
    { treeEl: document.getElementById("tree"), summaryEl: document.getElementById("summary") },
    errResult,
    { onFocusNode: (id) => { focused = id; } }
  );
  const focusable = document.querySelectorAll(".issues.error li.issue-focusable[data-node-id]");
  console.log(`focusable summary errors: ${focusable.length}`);
  if (focusable.length < 1) throw new Error("expected a click-to-focus Summary error item");
  const li = focusable[0];
  if (li.getAttribute("data-node-id") !== ic.id) throw new Error("summary error should target the offending node id");
  li.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  if (focused !== ic.id) throw new Error("clicking a Summary error should call onFocusNode with its node id");
}

{
  const { makeNode, attach } = await import("../src/tree.js");
  const { computeMetrics } = await import("../src/balance.js");
  const P = (name, role, level, leader = false) => ({ name, role, location: "VIE", isPeopleLeader: leader, ...(level ? { level } : {}) });
  const root = makeNode(P("Root", "VP", undefined, true));
  // Deliberately attach children out of seniority order.
  const kids = [
    makeNode(P("nse", "NSE")),
    makeNode(P("se2", "SE", 2)),
    makeNode(P("ta1", "TA", 1)),
    makeNode(P("ta3", "TA", 3)),
    makeNode(P("se4", "SE", 4)),
  ];
  for (const k of kids) attach(root, k);
  const ordResult = { root, metrics: computeMetrics(root), constraints: checkTree(root, { span }), notes: [] };
  const ordTargets = { treeEl: document.getElementById("tree"), summaryEl: document.getElementById("summary") };

  const expected = ["Root", "ta3", "ta1", "se4", "se2", "nse"];
  const readOrder = () => [...ordTargets.treeEl.querySelectorAll(".card .headline")].map((h) => h.textContent);

  render(ordTargets, ordResult, {});
  const treeOrder = readOrder();
  console.log(`tree sibling order: ${treeOrder.slice(1).join(",")}`);
  if (JSON.stringify(treeOrder) !== JSON.stringify(expected)) throw new Error(`tree order wrong: ${treeOrder}`);

  render(ordTargets, ordResult, { onToggleCollapse() {} }, { view: "list" });
  const listOrder = readOrder();
  console.log(`list sibling order: ${listOrder.slice(1).join(",")}`);
  if (JSON.stringify(listOrder) !== JSON.stringify(expected)) throw new Error(`list order wrong: ${listOrder}`);
}

{
  const { makeNode, attach } = await import("../src/tree.js");
  const { computeMetrics } = await import("../src/balance.js");
  const P = (name, role, location, level, leader = false) => ({ name, role, location, isPeopleLeader: leader, ...(level ? { level } : {}) });
  const boxTargets = { treeEl: document.getElementById("tree"), summaryEl: document.getElementById("summary") };

  // Leader with interleaved VIE / LNZ / GRZ IC leadees => two grouping boxes,
  // and the render must order them contiguously by location.
  const mgr = makeNode(P("Mgr", "HO", "VIE", undefined, true));
  attach(mgr, makeNode(P("lnzHi", "TA", "LNZ", 2)));
  attach(mgr, makeNode(P("vieHi", "TA", "VIE", 2)));
  attach(mgr, makeNode(P("grz", "TA", "GRZ", 1)));
  attach(mgr, makeNode(P("vieLo", "TA", "VIE", 1)));
  attach(mgr, makeNode(P("lnzLo", "TA", "LNZ", 1)));
  const boxResult = { root: mgr, metrics: computeMetrics(mgr), constraints: checkTree(mgr, { span }), notes: [] };
  render(boxTargets, boxResult, {});
  const boxes = boxTargets.treeEl.querySelectorAll(".loc-box");
  console.log(`location boxes (2 VIE + 2 LNZ + 1 GRZ leadees): ${boxes.length}`);
  if (boxes.length !== 2) throw new Error(`expected 2 loc-box groups, got ${boxes.length}`);
  if (!boxTargets.treeEl.querySelector(".loc-overlay")) throw new Error("expected a .loc-overlay in the tree");
  // Siblings must be grouped by location: VIE (hi,lo), then LNZ (hi,lo), then GRZ.
  const boxOrder = [...boxTargets.treeEl.querySelectorAll(".card .headline")].map((h) => h.textContent).slice(1);
  console.log(`box-case sibling order: ${boxOrder.join(",")}`);
  if (JSON.stringify(boxOrder) !== JSON.stringify(["vieHi", "vieLo", "lnzHi", "lnzLo", "grz"])) {
    throw new Error(`siblings not grouped by location: ${boxOrder}`);
  }

  // A lone same-location report is now boxed together with its same-location
  // LEADER (leader + one report). Here the VIE leader has one VIE sub-leader
  // (branch) and one VIE leaf, so each region forms a box (2). (With real
  // geometry the emptiness test may decline; jsdom has no layout so both form.)
  const scoped = makeNode(P("Top", "VP", "VIE", undefined, true));
  const subHO = makeNode(P("SubHO", "HO", "VIE", undefined, true));
  attach(subHO, makeNode(P("gc", "TA", "VIE", 1))); // gives the sub-leader a subtree
  attach(scoped, subHO);
  attach(scoped, makeNode(P("ic1", "TA", "VIE", 1))); // the VP's own single leaf
  render(boxTargets, { root: scoped, metrics: computeMetrics(scoped), constraints: checkTree(scoped, { span }), notes: [] }, {});
  const scopedBoxes = boxTargets.treeEl.querySelectorAll(".loc-box").length;
  console.log(`location boxes (VIE leader + 1 VIE sub-leader + 1 VIE leaf): ${scopedBoxes}`);
  if (scopedBoxes !== 2) throw new Error(`leader should be boxed with its lone same-location reports; expected 2, got ${scopedBoxes}`);

  // …but a lone same-location run under a DIFFERENT-location leader is not boxed
  // (no ≥2-card group forms): an LNZ leader over one VIE sub-leader + one VIE leaf.
  const diff = makeNode(P("TopX", "VP", "LNZ", undefined, true));
  const subHOx = makeNode(P("SubHOx", "HO", "VIE", undefined, true));
  attach(subHOx, makeNode(P("gcx", "TA", "VIE", 1)));
  attach(diff, subHOx);
  attach(diff, makeNode(P("icx", "TA", "VIE", 1)));
  render(boxTargets, { root: diff, metrics: computeMetrics(diff), constraints: checkTree(diff, { span }), notes: [] }, {});
  const diffBoxes = boxTargets.treeEl.querySelectorAll(".loc-box").length;
  console.log(`location boxes (LNZ leader + lone VIE runs): ${diffBoxes}`);
  if (diffBoxes !== 0) throw new Error(`lone runs under a different-location leader must not be boxed; expected 0, got ${diffBoxes}`);

  // Straddling case: a location with members in BOTH the branch region and the
  // leaf region must yield TWO boxes (one per region), never one box that spans
  // across an in-between node. 2 VIE branches + 1 LNZ branch + 2 VIE leaves.
  const strad = makeNode(P("Str", "VP", "VIE", undefined, true));
  const vb1 = makeNode(P("vieB1", "HO", "VIE", undefined, true)); attach(vb1, makeNode(P("vb1c", "TA", "VIE", 1)));
  const vb2 = makeNode(P("vieB2", "HO", "VIE", undefined, true)); attach(vb2, makeNode(P("vb2c", "TA", "VIE", 1)));
  const lb = makeNode(P("lnzB", "HO", "LNZ", undefined, true)); attach(lb, makeNode(P("lbc", "TA", "LNZ", 1)));
  attach(strad, vb1); attach(strad, vb2); attach(strad, lb);
  attach(strad, makeNode(P("vieL1", "TA", "VIE", 2)));
  attach(strad, makeNode(P("vieL2", "TA", "VIE", 1)));
  render(boxTargets, { root: strad, metrics: computeMetrics(strad), constraints: checkTree(strad, { span }), notes: [] }, {});
  const stradBoxes = boxTargets.treeEl.querySelectorAll(".loc-box").length;
  console.log(`location boxes (2 VIE branches + 2 VIE leaves, straddling): ${stradBoxes}`);
  if (stradBoxes !== 2) throw new Error(`straddling location must split into 2 boxes, got ${stradBoxes}`);

  // All-different leaf locations, none matching the leader => no boxes.
  const mgr2 = makeNode(P("Mgr2", "HO", "RIE", undefined, true));
  attach(mgr2, makeNode(P("x", "TA", "VIE", 1)));
  attach(mgr2, makeNode(P("y", "TA", "LNZ", 1)));
  attach(mgr2, makeNode(P("z", "TA", "GRZ", 1)));
  render(boxTargets, { root: mgr2, metrics: computeMetrics(mgr2), constraints: checkTree(mgr2, { span }), notes: [] }, {});
  const noBoxes = boxTargets.treeEl.querySelectorAll(".loc-box").length;
  console.log(`location boxes (all different): ${noBoxes}`);
  if (noBoxes !== 0) throw new Error(`expected 0 loc-box for all-different siblings, got ${noBoxes}`);

  render(boxTargets, boxResult, { onToggleCollapse() {} }, { view: "list" });
  if (boxTargets.treeEl.querySelectorAll(".loc-box").length !== 0) throw new Error("list view must not draw location boxes");
}

render(targets, result, { onToggleCollapse() {} }, { view: "list" });
const listCards = document.querySelectorAll("#tree.as-list .list-row .card");
const toggles = document.querySelectorAll("#tree .list-toggle:not(.spacer)");
console.log(`list cards: ${listCards.length}, disclosure toggles: ${toggles.length}`);
if (listCards.length !== people.length) throw new Error(`list view: expected ${people.length} cards, got ${listCards.length}`);
if (toggles.length < 1) throw new Error("list view: expected disclosure toggles on parents");

// collapsing the root hides every descendant (only the root card remains)
render(targets, result, {}, { view: "list", collapsed: [result.root.person.name] });
const collapsedCards = document.querySelectorAll("#tree .list-row .card");
console.log(`list cards with root collapsed: ${collapsedCards.length}`);
if (collapsedCards.length !== 1) throw new Error(`collapsed root should show only itself, got ${collapsedCards.length}`);

render(targets, result, {});

{
  const { planCapacity } = await import("../src/capacity.js");
  const { renderCapacity } = await import("../src/render.js");
  const capEl = document.createElement("div");
  capEl.id = "capacity";
  document.body.appendChild(capEl);

  // Balanced sample → renders without throwing.
  renderCapacity(capEl, planCapacity(result.root, { span }));

  // Under-led BU: many ICs, no leaders → demand rows appear.
  const mk = (name, role, location, leader, level) => ({ name, role, location, isPeopleLeader: leader, ...(level ? { level } : {}) });
  const people = [mk("V", "VP", "VIE", true), mk("H", "HO", "VIE", true)];
  for (let i = 0; i < 9; i++) people.push(mk(`t${i}`, "TA", "VIE", false, ((i % 3) + 1)));
  for (let i = 0; i < 9; i++) people.push(mk(`s${i}`, "SE", "VIE", false, ((i % 4) + 1)));
  const plan = planCapacity(people, { span });
  renderCapacity(capEl, plan);
  const needs = capEl.querySelectorAll(".capacity-need");
  console.log(`capacity: +${plan.addLeaders} leaders, ${needs.length} demand row(s)`);
  if (plan.addLeaders < 1) throw new Error("capacity: expected additional leaders for the under-led BU");
  if (!needs.length) throw new Error("capacity: expected at least one demand row");
}

// an illegal move (DE person under an AT stream branch) must be rejected
let deIC, atLead;
walk(result.root, (n) => {
  if (!deIC && n.person.role === "SE" && n.person.location === "KAR") deIC = n;
  if (!atLead && n.person.role === "SE" && n.person.isPeopleLeader && n.person.location === "VIE") atLead = n;
});
const illegal = checkMove(result.root, deIC.id, atLead.id, { span });
console.log("illegal move rejected:", !illegal.ok, "-", illegal.reasons.join(" "));
if (illegal.ok) throw new Error("expected cross-BU stream move to be rejected");

// visual snapshot diff tree: render it and assert status-coded nodes appear.
const { buildDiffTree } = await import("../src/diff.js");
const { renderDiffTree } = await import("../src/render.js");
const { makeSnapshot } = await import("../src/snapshots.js");

const before = people.map((p) => ({ ...p }));
const after = people.map((p) => ({ ...p }));
// Guaranteed attribute change: relocate one IC to a different location.
const changeIdx = after.findIndex((p) => !p.isPeopleLeader);
const newLoc = after[changeIdx].location === "VIE" ? "LNZ" : "VIE";
after[changeIdx] = { ...after[changeIdx], location: newLoc };
// A clear addition.
after.push({ name: "ZZ New IC", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 });

const mk = (name, ppl) => makeSnapshot(name, { people: ppl, span, pins: [], flags: [] });
const dt = buildDiffTree(mk("A", before), mk("B", after));
const treeEl = renderDiffTree(dt, { aName: "A", bName: "B" });
const wrap = document.createElement("div");
wrap.appendChild(treeEl);

const diffCards = wrap.querySelectorAll(".diff-tree .card");
const addedNodes = wrap.querySelectorAll(".diff-node-added");
const changedNodes = wrap.querySelectorAll(".diff-node-changed");
console.log(`diff tree cards: ${diffCards.length}, added: ${addedNodes.length}, changed: ${changedNodes.length}`);
if (diffCards.length < people.length) throw new Error("diff tree did not render the after-structure");
if (addedNodes.length < 1) throw new Error("expected at least one added node in diff tree");
if (changedNodes.length < 1) throw new Error("expected at least one changed node in diff tree");

{
  const { buildExportSvgString, exportElementAsImage, exportElementAsSvg } = await import("../src/export-image.js");
  if (typeof exportElementAsImage !== "function") throw new Error("exportElementAsImage should be a function");
  if (typeof exportElementAsSvg !== "function") throw new Error("exportElementAsSvg should be a function");
  const { buildExportDialog, buildConfirmDialog } = await import("../src/render.js");
  if (typeof buildExportDialog !== "function") throw new Error("buildExportDialog should be a function");
  if (typeof buildConfirmDialog !== "function") throw new Error("buildConfirmDialog should be a function");

  // The unified Export… button and its modal host must exist in index.html.
  const html = readFileSync(join(dir, "..", "index.html"), "utf8");
  if (!/id="export"/.test(html)) throw new Error('index.html missing id="export" button');
  if (!/id="exportModal"/.test(html)) throw new Error('index.html missing id="exportModal" host');
  if (!/id="confirmModal"/.test(html)) throw new Error('index.html missing id="confirmModal" host');

  // The export dialog builder must render both format tabs and an Export action.
  const exportCard = buildExportDialog({ prefs: {}, onExport() {}, onCancel() {} });
  if (!exportCard.querySelector(".export-tabs")) throw new Error("export dialog must render tabs");
  if (!exportCard.querySelector(".export-go")) throw new Error("export dialog must render an Export button");
  if (!exportCard.querySelector("#exportImageFormat")) throw new Error("export dialog must offer an image format select");

  // The confirm dialog builder must expose a danger confirm + cancel.
  const confirmCard = buildConfirmDialog({ title: "T", message: "M", danger: true, onConfirm() {}, onCancel() {} });
  if (!confirmCard.querySelector(".confirm-ok.danger")) throw new Error("confirm dialog must render a danger confirm button");
  if (!confirmCard.querySelector(".confirm-cancel")) throw new Error("confirm dialog must render a cancel button");

  // The balancer UI has been removed — its controls must NOT be present.
  if (/id="balancePriority"/.test(html)) throw new Error('index.html should no longer contain the balancePriority select');
  if (/id="hardLocation"/.test(html)) throw new Error('index.html should no longer contain the hardLocation checkbox');
  if (/id="rebalance"/.test(html)) throw new Error('index.html should no longer contain the Auto-rebalance button');
  if (/id="loadSample"/.test(html)) throw new Error('index.html should no longer contain the Load example button');
  // The span inputs remain (they feed the SPAN_MAX / SPAN_MIN constraint checks).
  if (!/id="spanMin"/.test(html) || !/id="spanMax"/.test(html)) throw new Error('index.html must keep the span inputs');

  // Build an SVG wrapping the freshly rendered tree; must be valid, sized markup.
  render(targets, buildHierarchy(people, { span }), {});
  const serialized = new dom.window.XMLSerializer().serializeToString(document.getElementById("tree"));
  const svg = buildExportSvgString({ bodyXhtml: serialized, css: "body{}", width: 800, height: 600, background: "#dce0e8" });
  if (!svg.startsWith("<svg")) throw new Error("export SVG must start with <svg");
  if (!svg.includes("<foreignObject")) throw new Error("export SVG must contain a foreignObject");
  if (!svg.includes('width="800"') || !svg.includes('height="600"')) throw new Error("export SVG must carry the requested size");
  if (!svg.includes("background:#dce0e8")) throw new Error("export SVG must carry the solid background");
  console.log("image export: unified dialog wired + SVG builder OK");
}

{
  let edited = null;
  render(targets, buildHierarchy(people, { span }), { onStartEdit: (id) => { edited = id; } });
  const card = document.querySelector("#tree .card");
  if (!card) throw new Error("expected at least one card to right-click");
  card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  const menu = document.querySelector(".card-menu");
  if (!menu || menu.hidden) throw new Error("right-click should open a visible .card-menu");
  const items = menu.querySelectorAll(".card-menu-item");
  console.log(`card menu items: ${items.length}`);
  if (items.length < 2) throw new Error("card menu should offer multiple actions");
  items[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  if (edited !== card.getAttribute("data-id")) throw new Error("first menu item (Edit) should call onStartEdit for the card");
  if (!document.querySelector(".card-menu").hidden) throw new Error("choosing an action should close the menu");
  // Re-open, then Escape closes it.
  card.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  if (document.querySelector(".card-menu").hidden) throw new Error("menu should reopen on right-click");
  document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  if (!document.querySelector(".card-menu").hidden) throw new Error("Escape should close the card menu");
  console.log("card context menu: open + act + Esc close OK");
}

console.log("SMOKE OK");