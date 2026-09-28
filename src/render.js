import { buOf, colorOf, labelOf, ROLES, LOCATIONS, STREAM_ROLES, levelsFor, levelOf, isMarked, MARKED_ROLE, compareForDisplay } from "./model.js";
import { walk } from "./tree.js";
import { priorityRank } from "./constraints.js";

const LEAF_STACK_MIN = 3;
let cardMenuEl = null;

export function render(targets, result, hooks = {}, opts = {}) {
  renderSummary(targets.summaryEl, result, hooks, opts.flags ?? []);
  const view = opts.view === "list" ? "list" : "tree";
  targets.treeEl.innerHTML = "";
  targets.treeEl.classList.toggle("as-list", view === "list");

  if (!result.root) {
    targets.treeEl.appendChild(buildEmptyState());
    return;
  }

  const ctx = buildRenderContext(result, hooks, opts);
  if (view === "list") {
    targets.treeEl.appendChild(renderList(result.root, ctx));
  } else {
    targets.treeEl.appendChild(renderNode(result.root, ctx));
    drawLocationGroups(targets.treeEl, result.root, ctx);
  }
}

export function buildPersonForm(spec, handlers) {
  const isEdit = spec.mode === "edit";
  const init = spec.initial;

  const form = el("form", { class: "card editing" });
  form.appendChild(el("div", { class: "kicker" }, spec.title ?? (isEdit ? "Edit person" : "New report")));

  const name = buildNameInput(init);
  form.appendChild(name);

  const role = buildSelect(ROLES.map((r) => [r, r === MARKED_ROLE ? "Non-SE" : r]), init.role);
  const loc = buildSelect(LOCATIONS.map((l) => [l, `${labelOf(l)} · ${buOf(l)}`]), init.location);
  const level = buildLevelSelect(role, init);
  form.appendChild(el("div", { class: "inl-row" }, [role, loc, level]));

  const { leader, check } = buildLeaderCheckbox(init);
  form.appendChild(check);

  const syncMarked = () => syncMarkedLeader(role, leader, check);
  syncMarked();
  role.addEventListener("change", syncMarked);

  appendFormNotes(form, spec.notes);

  const actions = buildFormActions(isEdit, handlers);
  form.appendChild(actions);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const values = { name: name.value.trim(), role: role.value, location: loc.value, isPeopleLeader: role.value === MARKED_ROLE ? false : leader.checked };
    if (STREAM_ROLES.has(role.value)) values.level = Number(level.value);
    handlers.onSave(values);
  });
  setTimeout(() => name.focus(), 0);
  return form;
}

export function defaultChild(parentPerson) {
  if (!parentPerson) return { name: "", role: "VP", location: LOCATIONS[0], isPeopleLeader: true };
  const roleByParent = { VP: "HO", HO: "TA", TA: "TA", SE: "SE" };
  const role = roleByParent[parentPerson.role] ?? "TA";
  const child = {
    name: "",
    role,
    location: parentPerson.location,
    isPeopleLeader: false,
  };
  if (STREAM_ROLES.has(role)) child.level = 1;
  return child;
}

export function renderCapacity(capacityEl, plan) {
  capacityEl.innerHTML = "";
  if (!plan || !plan.totalStream) {
    capacityEl.appendChild(el("p", { class: "capacity-empty" }, "No stream people yet — load or add TA/SE people to plan leadership."));
    return;
  }

  if (plan.addLeaders === 0) {
    capacityEl.appendChild(el("p", { class: "capacity-head ok" },
      `✓ Enough leaders — ${plan.currentLeaders} people leader(s) cover all ${plan.totalStream} stream people within the max of ${plan.span.max} reports each.`));
    return;
  }

  capacityEl.appendChild(el("p", { class: "capacity-head warn" },
    `You have ${plan.currentLeaders} people leader(s) for ${plan.totalStream} stream people. ` +
    `Add at least ${plan.addLeaders} more so no leader exceeds ${plan.span.max} reports (max span).`));

  const needUl = el("ul", { class: "capacity-needs" });
  for (const n of plan.needs) needUl.appendChild(buildCapacityNeed(n));
  capacityEl.appendChild(needUl);

  for (const b of plan.byBU) {
    if (b.add === 0) continue;
    capacityEl.appendChild(buildCapacityBU(b));
  }
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, v);
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function renderSnapshotDiff(diff, { aName, bName }) {
  const root = el("div", { class: "diff" });
  root.appendChild(buildDiffHeading(aName, bName));
  appendDiffChips(root, diff.counts);

  if (diff.empty) {
    root.appendChild(el("p", { class: "diff-empty" }, "No differences — these snapshots are identical."));
    return root;
  }

  appendPeopleDiffGroup(root, diff.people);
  appendReportingDiffGroup(root, diff.reporting);
  appendConfigDiffGroup(root, diff.config);
  return root;
}

export function renderDiffTree(diffTree, { aName, bName }) {
  const root = el("div", { class: "diff-tree-wrap" });
  const head = buildDiffTreeHeader(aName, bName);
  root.appendChild(head);

  const viewport = el("div", { class: "diff-tree-viewport" });
  root.appendChild(viewport);

  const tree = diffTree?.tree;
  if (!tree) {
    viewport.appendChild(el("p", { class: "diff-empty" }, "No structure to compare."));
    return root;
  }

  const ul = el("ul", { class: "tree diff-tree" });
  if (tree.person) {
    ul.appendChild(renderDiffTreeNode(tree));
  } else {
    for (const c of tree.children ?? []) ul.appendChild(renderDiffTreeNode(c));
  }
  viewport.appendChild(ul);
  return root;
}

export function buildConfirmDialog(spec = {}) {
  const {
    title = "Are you sure?",
    message = "",
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    danger = false,
    onConfirm,
    onCancel,
  } = spec;

  const card = el("div", { class: "confirm-card" });
  card.appendChild(el("h2", { id: "confirmTitle", class: "confirm-title" }, title));
  const body = el("div", { class: "confirm-msg" });
  body.appendChild(typeof message === "string" ? document.createTextNode(message) : message);
  card.appendChild(body);

  const actions = el("div", { class: "confirm-actions" });
  const cancel = el("button", { type: "button", class: "inl-btn confirm-cancel" }, cancelLabel);
  cancel.addEventListener("click", () => onCancel?.());
  const ok = el("button", { type: "button", class: `inl-btn confirm-ok ${danger ? "danger" : "primary"}` }, confirmLabel);
  ok.addEventListener("click", () => onConfirm?.());
  actions.appendChild(cancel);
  actions.appendChild(ok);
  card.appendChild(actions);
  return card;
}

export function buildExportDialog(spec = {}) {
  const prefs = spec.prefs || {};
  const jp = prefs.json || {};
  const ip = prefs.image || {};

  const card = el("div", { class: "export-card" });
  card.appendChild(el("h2", { id: "exportTitle", class: "export-title" }, "Export"));

  const tabData = el("button", { type: "button", class: "diff-tab is-active", role: "tab", "aria-selected": "true" }, "Data (JSON)");
  const tabImage = el("button", { type: "button", class: "diff-tab", role: "tab", "aria-selected": "false" }, "Image");
  card.appendChild(el("div", { class: "diff-tabs export-tabs", role: "tablist" }, [tabData, tabImage]));

  const jsonName = el("input", { type: "text", class: "inl-input", value: jp.filename || "people.json", placeholder: "people.json", autocomplete: "off" });
  const jsonFormat = dialogSelect("exportJsonFormat", [["pretty", "Pretty (indented)"], ["minified", "Minified"]], jp.minified ? "minified" : "pretty");
  const dataPane = buildExportDataPane(jsonName, jsonFormat);

  const imgName = el("input", { type: "text", class: "inl-input", value: ip.filename || "", placeholder: "org-tree.png", autocomplete: "off" });
  const bgSel = dialogSelect("exportImageBg", [["white", "White"], ["transparent", "Transparent"], ["canvas", "App canvas"]], ip.background || "white");
  const scaleSel = dialogSelect("exportImageScale", [["1", "1× (standard)"], ["2", "2× (retina)"], ["3", "3× (print)"]], String(ip.scale || 2));
  const fmtSel = dialogSelect("exportImageFormat", [["png", "PNG (raster)"], ["svg", "SVG (vector)"]], ip.format || "png");
  const scaleField = dialogField("Scale", scaleSel);
  const imagePane = buildExportImagePane(imgName, bgSel, fmtSel, scaleField);

  card.appendChild(dataPane);
  card.appendChild(imagePane);

  const syncScale = () => {
    const isSvg = fmtSel.value === "svg";
    scaleField.classList.toggle("disabled", isSvg);
    scaleSel.disabled = isSvg;
  };
  fmtSel.addEventListener("change", syncScale);
  syncScale();

  let kind = "json";
  const selectTab = (which) => {
    kind = which;
    const isData = which === "json";
    tabData.classList.toggle("is-active", isData);
    tabImage.classList.toggle("is-active", !isData);
    tabData.setAttribute("aria-selected", String(isData));
    tabImage.setAttribute("aria-selected", String(!isData));
    dataPane.hidden = !isData;
    imagePane.hidden = isData;
  };
  tabData.addEventListener("click", () => selectTab("json"));
  tabImage.addEventListener("click", () => selectTab("image"));

  const actions = buildExportActions(spec, () => kind, { jsonName, jsonFormat, imgName, bgSel, scaleSel, fmtSel });
  card.appendChild(actions);
  return card;
}

function buildEmptyState() {
  const actions = el("div", { class: "empty-state-actions" }, [
    el("button", { type: "button", class: "primary", "data-empty-action": "upload" }, "Upload file"),
  ]);
  const hint = el("p", { class: "empty-state-hint" });
  hint.append("Or press ", el("kbd", {}, "A"), " to add a person and build the tree by hand.");
  return el("div", { class: "empty-state" }, [
    el("h2", {}, "No people loaded"),
    el("p", {}, "Upload a people/org JSON file — a structured export restores its tree exactly."),
    actions,
    hint,
  ]);
}

function buildRenderContext(result, hooks, opts) {
  const errorIds = new Set(result.constraints.errors.map((e) => e.nodeId));
  const warnIds = new Set(result.constraints.warnings.map((w) => w.nodeId));
  const errorMsgs = messagesByNode(result.constraints.errors);
  const pinnedChildren = new Map((opts.pins ?? []).map((p) => [p.child, p.parent]));
  const { duplicateNames, byId } = duplicateContext(result.root);
  const spanMax = Number.isFinite(opts.span?.max) ? Math.max(1, Math.floor(opts.span.max)) : null;
  const spanMin = Number.isFinite(opts.span?.min) ? Math.max(0, Math.floor(opts.span.min)) : null;
  const flagList = toFlagList(opts.flags);
  const flagged = new Set(flagList.map((f) => f.name));
  const flagComments = new Map(flagList.filter((f) => f.comment).map((f) => [f.name, f.comment]));
  return { errorIds, warnIds, errorMsgs, hooks, pinnedChildren, duplicateNames, byId, flagged, flagComments, collapsed: new Set(opts.collapsed ?? []), spanMax, spanMin };
}

function messagesByNode(errors) {
  const errorMsgs = new Map();
  for (const e of errors) {
    if (!errorMsgs.has(e.nodeId)) errorMsgs.set(e.nodeId, []);
    errorMsgs.get(e.nodeId).push(e.message);
  }
  return errorMsgs;
}

function duplicateContext(root) {
  const nameCounts = new Map();
  const byId = new Map();
  walk(root, (n) => {
    nameCounts.set(n.person.name, (nameCounts.get(n.person.name) ?? 0) + 1);
    byId.set(n.id, n);
  });
  const duplicateNames = new Set([...nameCounts].filter(([, c]) => c > 1).map(([name]) => name));
  return { duplicateNames, byId };
}

function renderList(root, ctx) {
  const list = el("ul", { class: "list" });
  const addRows = (node, depth) => {
    list.appendChild(renderListRow(node, ctx, depth));
    if (node.children.length && !ctx.collapsed.has(node.person.name)) {
      for (const child of sortedChildren(node)) addRows(child, depth + 1);
    }
  };
  addRows(root, 0);
  return list;
}

function renderListRow(node, ctx, depth) {
  const li = el("li", { class: "list-row" });
  appendListGuides(li, depth);
  const rail = buildListRail(node, ctx);
  li.appendChild(rail);
  li.appendChild(renderCard(node, ctx));
  return li;
}

function appendListGuides(li, depth) {
  if (depth <= 0) return;
  const guides = el("div", { class: "list-guides" });
  for (let i = 0; i < depth; i++) {
    guides.appendChild(el("span", { class: `list-guide lvl-${i % 6}` }));
  }
  li.appendChild(guides);
}

function buildListRail(node, ctx) {
  const rail = el("div", { class: "list-rail" });
  rail.appendChild(node.children.length > 0
    ? buildListToggle(node, ctx)
    : el("span", { class: "list-toggle spacer" }));
  return rail;
}

function buildListToggle(node, ctx) {
  const collapsed = ctx.collapsed.has(node.person.name);
  const toggle = el("button", {
    type: "button",
    class: `list-toggle ${collapsed ? "collapsed" : ""}`,
    title: collapsed ? `Expand ${node.person.name}` : `Collapse ${node.person.name}`,
    "aria-label": collapsed ? "Expand" : "Collapse",
    "aria-expanded": String(!collapsed),
  }, collapsed ? "▸" : "▾");
  toggle.draggable = false;
  toggle.addEventListener("pointerdown", (e) => e.stopPropagation());
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    ctx.hooks.onToggleCollapse?.(node);
  });
  return toggle;
}

function renderNode(node, ctx) {
  const li = el("li", { class: "node" });
  li.appendChild(renderCard(node, ctx));
  appendChildren(li, node, ctx);
  return li;
}

function appendChildren(li, node, ctx) {
  if (!node.children.length) return;
  const kids = sortedChildren(node);
  const branches = kids.filter((c) => c.children.length > 0);
  const leaves = kids.filter((c) => c.children.length === 0);
  const stackLeaves = leaves.length >= LEAF_STACK_MIN;

  if (branches.length === 0 && stackLeaves) {
    const ul = el("ul", { class: "children stacked" });
    for (const lf of leaves) ul.appendChild(renderLeafItem(lf, ctx));
    li.appendChild(ul);
    return;
  }

  const ul = el("ul", { class: "children" });
  for (const b of branches) ul.appendChild(renderNode(b, ctx));
  if (stackLeaves) ul.appendChild(renderLeafSlot(leaves, ctx));
  else for (const lf of leaves) ul.appendChild(renderNode(lf, ctx));
  li.appendChild(ul);
}

function renderLeafItem(node, ctx) {
  const item = el("li", { class: "leaf-item" });
  item.appendChild(renderCard(node, ctx));
  return item;
}

function renderLeafSlot(leaves, ctx) {
  const slot = el("li", { class: "node leaf-slot" });
  const stack = el("ul", { class: "leaf-stack" });
  for (const lf of leaves) stack.appendChild(renderLeafItem(lf, ctx));
  slot.appendChild(stack);
  return slot;
}

function renderCard(node, ctx) {
  const cardState = getCardState(node, ctx);
  const { p, hasError, errorMsgs, isFlagged } = cardState;
  const card = el("div", { class: cardClasses(p, cardState).join(" "), draggable: "true", "data-id": node.id });

  appendErrorBadge(card, hasError, errorMsgs);
  appendCardControls(card, node, ctx, cardState);
  appendCardHeader(card, node, ctx, cardState);
  appendCardByline(card, node, cardState);
  appendFlagNote(card, isFlagged, ctx.flagComments?.get(p.name));

  const realDirects = node.children.filter((c) => !isMarked(c.person)).length;
  if (p.isPeopleLeader === true && p.role !== "VP" && ctx.spanMax != null) {
    card.appendChild(buildCapacityStrip(node, ctx, realDirects));
  }

  appendCardError(card, hasError, errorMsgs);
  card.addEventListener("click", () => ctx.hooks.onStartEdit?.(node.id));
  wireDrag(card, node, ctx.hooks);
  return card;
}

function getCardState(node, ctx) {
  const p = node.person;
  const pinnedTo = ctx.pinnedChildren?.get(p.name);
  const isDuplicate = ctx.duplicateNames?.has(p.name);
  const isFlagged = ctx.flagged?.has(p.name);
  const hasError = ctx.errorIds.has(node.id);
  const hasWarn = ctx.warnIds.has(node.id);
  const errorMsgs = hasError ? (ctx.errorMsgs?.get(node.id) ?? ["Constraint violation."]) : null;
  return { p, bu: buOf(p.location), locColor: colorOf(p.location), pinnedTo, isDuplicate, isFlagged, hasError, hasWarn, errorMsgs };
}

function cardClasses(p, cardState) {
  const classes = ["card", `role-${p.role}`];
  if (cardState.hasError) classes.push("has-error");
  else if (cardState.hasWarn) classes.push("has-warn");
  if (cardState.pinnedTo) classes.push("pinned");
  if (cardState.isDuplicate) classes.push("dup");
  if (cardState.isFlagged) classes.push("flagged");
  return classes;
}

function appendErrorBadge(card, hasError, errorMsgs) {
  if (!hasError) return;
  card.appendChild(el("span", { class: "error-badge", title: errorMsgs.join("\n"), "aria-label": "Constraint error" }, "!"));
}

function appendCardControls(card, node, ctx, cardState) {
  const { p, pinnedTo, isFlagged } = cardState;
  const flagComment = ctx.flagComments?.get(p.name);
  card.appendChild(cardControl(card, {
    class: `flag-btn ${isFlagged ? "on" : ""}`,
    title: isFlagged
      ? `Flagged${flagComment ? `: ${flagComment}` : ""} — click to unflag ${p.name}`
      : `Flag / highlight ${p.name}`,
    ariaLabel: "Toggle flag",
    text: isFlagged ? "🚩" : "⚑",
    onActivate: () => ctx.hooks.onToggleFlag?.(p.name),
  }));

  const parentName = parentNameOf(node, ctx);
  if (parentName) {
    const locked = pinnedTo != null;
    card.appendChild(cardControl(card, {
      class: `edge-lock ${locked ? "locked" : ""}`,
      title: locked ? `Fixed to ${parentName} — click to unfix` : `Click to fix ${p.name} under ${parentName}`,
      ariaLabel: "Toggle fixed link",
      text: locked ? "🔒" : "🔓",
      onActivate: () => ctx.hooks.onToggleLock?.(p.name, parentName),
    }));
  }

  if (p.isPeopleLeader) {
    card.appendChild(cardControl(card, {
      class: "add-report",
      title: `Add a report under ${p.name}`,
      ariaLabel: "Add report",
      text: "＋",
      onActivate: () => ctx.hooks.onStartAdd?.(node.id),
    }));
  }

  card.appendChild(cardControl(card, {
    class: "card-menu-btn",
    title: `Actions for ${p.name}`,
    ariaLabel: "Open actions menu",
    text: "⋯",
    onActivate: () => {
      const r = card.getBoundingClientRect();
      openCardMenu(node, ctx, r.right - 6, r.bottom - 6);
    },
  }));
  card.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openCardMenu(node, ctx, e.clientX, e.clientY);
  });
}

function appendCardHeader(card, node, ctx, cardState) {
  const { p, pinnedTo, isDuplicate } = cardState;
  const lvl = levelOf(p);
  const marked = isMarked(p);
  const roleText = marked ? "Non-SE" : (lvl ? `${p.role} L${lvl}` : p.role);
  const roleSuffix = marked ? "for deletion" : (p.isPeopleLeader ? "leader" : "IC");
  const kicker = el("div", { class: "kicker" }, `${roleText} · ${roleSuffix}`);
  const flags = el("span", { class: "flags" });
  if (pinnedTo) flags.appendChild(el("span", { class: "pin-flag", title: `Fixed to ${pinnedTo}` }, "📌 fixed"));
  if (isDuplicate) flags.appendChild(el("span", { class: "dup-flag", title: "Duplicate name — another person shares this name" }, "⚠ dup"));
  if (flags.childNodes.length) kicker.appendChild(flags);
  card.appendChild(kicker);
  card.appendChild(el("div", { class: "headline" }, p.name));
}

function appendCardByline(card, node, cardState) {
  const { p, bu, locColor } = cardState;
  const byline = el("div", { class: "byline" });
  const chip = el("span", {
    class: "loc-chip",
    title: `${labelOf(p.location)} · ${bu ?? "?"}`,
    style: `--loc:${locColor}`,
  }, labelOf(p.location));
  byline.appendChild(chip);
  const parts = [bu ?? "?"];
  const realDirects = node.children.filter((c) => !isMarked(c.person)).length;
  if (realDirects) parts.push(`${realDirects} directs`);
  parts.forEach((text) => {
    byline.appendChild(el("span", { class: "sep" }, "·"));
    byline.appendChild(el("span", { class: "meta" }, text));
  });
  card.appendChild(byline);
}

function appendFlagNote(card, isFlagged, flagComment) {
  if (!isFlagged || !flagComment) return;
  card.appendChild(el("div", { class: "card-flag-note", title: "Flag note" }, [
    el("span", { class: "card-flag-note-icon" }, "⚑"),
    el("span", { class: "card-flag-note-text" }, flagComment),
  ]));
}

// Filled capacity pips stay amber below min, green within max, and only excess reports turn red; open pips are drop targets equivalent to dropping on the leader card.
function buildCapacityStrip(node, ctx, realDirects) {
  const max = ctx.spanMax;
  const min = ctx.spanMin;
  const d = realDirects;
  const filled = Math.min(d, max);
  const over = Math.max(0, d - max);
  const open = Math.max(0, max - d);
  const under = min != null && d < min;
  const fillTier = under ? "under" : "ok";

  const title = over
    ? `${d}/${max} direct reports · ${over} over capacity`
    : `${d}/${max} direct reports${open ? ` · ${open} open slot${open > 1 ? "s" : ""}` : " · at capacity"}`;
  const strip = el("div", {
    class: "capacity",
    title,
    "aria-label": `${d} of ${max} slots filled${over ? `, ${over} over capacity` : ""}`,
  });
  for (let i = 0; i < filled; i++) strip.appendChild(el("span", { class: `slot filled ${fillTier}` }));
  for (let i = 0; i < over; i++) strip.appendChild(el("span", { class: "slot over" }));
  for (let i = 0; i < open; i++) {
    const slot = el("span", { class: "slot open", "aria-label": "Open slot — drop a person here" });
    wireSlotDrop(slot, node, ctx.hooks);
    strip.appendChild(slot);
  }
  return strip;
}

function appendCardError(card, hasError, errorMsgs) {
  if (!hasError) return;
  card.appendChild(el("div", { class: "card-error" }, errorMsgs.join(" ")));
}

function drawLocationGroups(treeEl, root, ctx) {
  const { fills, labels } = insertLocationOverlay(treeEl);
  const boxById = collectCardBoxes(treeEl);
  const allBoxes = [...boxById.entries()];
  const drawBox = makeLocationBoxDrawer(boxById, allBoxes, fills, labels);

  walk(root, (node) => {
    if (ctx.collapsed?.has(node.person.name)) return;
    if (node.children.length < 2) return;
    // Display-only ordering mirrors renderNode. Branches and leaves are boxed separately so a run never spans across another row/subtree.
    const kids = sortedChildren(node);
    boxLocationRuns(kids.filter((c) => c.children.length > 0), node, drawBox);
    boxLocationRuns(kids.filter((c) => c.children.length === 0), node, drawBox);
  });
}

function insertLocationOverlay(treeEl) {
  const overlay = el("div", { class: "loc-overlay", "aria-hidden": "true" });
  const fills = el("div", { class: "loc-fills" });
  const labels = el("div", { class: "loc-labels" });
  overlay.appendChild(fills);
  overlay.appendChild(labels);
  treeEl.insertBefore(overlay, treeEl.firstChild);
  return { fills, labels };
}

function collectCardBoxes(treeEl) {
  const boxById = new Map();
  for (const card of treeEl.querySelectorAll(".card[data-id]")) {
    const { x, y } = offsetIn(card, treeEl);
    boxById.set(card.getAttribute("data-id"), { minX: x, minY: y, maxX: x + card.offsetWidth, maxY: y + card.offsetHeight });
  }
  return boxById;
}

function offsetIn(elem, treeEl) {
  let x = 0, y = 0, cur = elem;
  while (cur && cur !== treeEl) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    cur = cur.offsetParent;
  }
  return { x, y };
}

function makeLocationBoxDrawer(boxById, allBoxes, fills, labels) {
  const PAD = 8;
  const TOL = 4;
  const union = (a, b) => ({ minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY) });
  const pad = (b, p) => ({ minX: b.minX - p, minY: b.minY - p, maxX: b.maxX + p, maxY: b.maxY + p });
  const overlaps = (a, b) => Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX) > TOL && Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY) > TOL;

  return (loc, members, manager) => {
    const memberBoxes = members.map((m) => boxById.get(m.id)).filter(Boolean);
    if (!memberBoxes.length) return;
    let box = memberBoxes.reduce(union);
    let count = memberBoxes.length;

    const mbox = manager && boxById.get(manager.id);
    if (mbox) {
      const enlarged = pad(union(box, mbox), PAD);
      const exempt = new Set([...members.map((m) => m.id), manager.id]);
      // The padded emptiness test covers rows and offset leaf columns, and prevents a same-location box from enclosing unrelated cards.
      if (!allBoxes.some(([id, b]) => !exempt.has(id) && overlaps(enlarged, b))) {
        box = union(box, mbox);
        count += 1;
      }
    }
    if (count < 2) return;

    const o = pad(box, PAD);
    const style = `--loc:${colorOf(loc)};left:${o.minX}px;width:${o.maxX - o.minX}px`;
    fills.appendChild(el("div", { class: "loc-box", style: `${style};top:${o.minY}px;height:${o.maxY - o.minY}px` }));
    labels.appendChild(el("div", { class: "loc-label-row", style: `${style};top:${o.minY - 9}px` }, [el("span", { class: "loc-box-label" }, labelOf(loc))]));
  };
}

function boxLocationRuns(region, manager, drawBox) {
  const runs = [];
  for (const child of region) {
    const last = runs[runs.length - 1];
    if (last && last.loc === child.person.location) last.members.push(child);
    else runs.push({ loc: child.person.location, members: [child] });
  }
  for (const r of runs) {
    drawBox(r.loc, r.members, manager && manager.person.location === r.loc ? manager : null);
  }
}

function buildNameInput(init) {
  return el("input", { type: "text", class: "inl-input", value: init.name || "", placeholder: "Name", required: "required", autocomplete: "off" });
}

function buildLevelSelect(role, init) {
  const level = el("select", { class: "inl-select inl-level", title: "Level" });
  function syncLevels() {
    const opts = levelsFor(role.value);
    const wanted = opts.includes(init.level) ? init.level : 1;
    level.innerHTML = "";
    for (const n of opts) level.appendChild(el("option", { value: String(n) }, `L${n}`));
    level.hidden = opts.length === 0;
    if (opts.length) level.value = String(wanted);
  }
  syncLevels();
  role.addEventListener("change", syncLevels);
  return level;
}

function buildLeaderCheckbox(init) {
  const leader = el("input", { type: "checkbox", class: "inl-leader" });
  if (init.isPeopleLeader) leader.checked = true;
  const check = el("label", { class: "inl-check" }, [leader, el("span", {}, "People leader")]);
  return { leader, check };
}

function syncMarkedLeader(role, leader, check) {
  const marked = role.value === MARKED_ROLE;
  if (marked) leader.checked = false;
  leader.disabled = marked;
  check.classList.toggle("disabled", marked);
}

function appendFormNotes(form, notes) {
  if (!notes?.length) return;
  const box = el("div", { class: "inl-notes" });
  box.appendChild(el("div", { class: "inl-notes-title" }, "Status"));
  for (const n of notes) {
    box.appendChild(el("div", { class: `inl-note ${n.kind}` }, n.text));
  }
  form.appendChild(box);
}

function buildFormActions(isEdit, handlers) {
  const actions = el("div", { class: "inl-actions" });
  actions.appendChild(el("button", { type: "submit", class: "inl-btn primary" }, isEdit ? "Save" : "Add"));
  if (isEdit && handlers.onDelete) {
    const del = el("button", { type: "button", class: "inl-btn danger" }, "Delete");
    del.addEventListener("click", () => handlers.onDelete());
    actions.appendChild(del);
  }
  const cancel = el("button", { type: "button", class: "inl-btn" }, "Cancel");
  cancel.addEventListener("click", () => handlers.onCancel());
  actions.appendChild(cancel);
  return actions;
}

function buildCapacityNeed(n) {
  const lvl = n.level != null ? ` at level ${n.level}` : "";
  return el("li", {
    class: "capacity-need",
    title: `Open ${n.count} new ${n.role} people-leader role(s)${lvl} in ${n.bu}`,
  }, [
    el("span", { class: "capacity-need-count" }, `add ${n.count}`),
    el("span", {}, ` ${n.role}${n.level != null ? ` (L${n.level})` : ""} in ${n.bu}`),
  ]);
}

function buildCapacityBU(b) {
  const det = el("details", { class: "capacity-bu" });
  det.setAttribute("open", "");
  det.appendChild(el("summary", {}, `${b.bu} — add ${b.add} leader(s) for ${b.total} stream people`));
  const ul = el("ul", {});
  for (const r of b.roles) appendCapacityRole(ul, r);
  det.appendChild(ul);
  return det;
}

function appendCapacityRole(ul, r) {
  if (r.add === 0) return;
  ul.appendChild(el("li", { class: "capacity-role" },
    `${r.role}: ${r.people} people need ${r.needed} leader(s) — you have ${r.leaders}, add ${r.add}:`));
  for (const pos of r.positions) {
    ul.appendChild(el("li", { class: "capacity-position" }, [
      el("span", { class: "capacity-position-role" }, `New ${pos.role}${pos.level != null ? ` (L${pos.level})` : ""}`),
      el("span", {}, ` → reports to ${pos.reportsTo}`),
    ]));
  }
}

function renderSummary(summaryEl, result, hooks = {}, flagsRaw = []) {
  summaryEl.innerHTML = "";
  summaryEl.appendChild(buildStats(result.metrics));
  appendSummaryIssues(summaryEl, result, hooks);
  appendSummaryFlags(summaryEl, result.root, flagsRaw, hooks.onFocusNode);
}

function buildStats(m) {
  const stats = el("div", { class: "stats" });
  const add = (label, value, title) => stats.appendChild(el("div", { class: "stat", title }, [el("span", { class: "stat-value" }, String(value)), el("span", { class: "stat-label" }, label)]));
  add("people", m.people, "Total number of people in the org (people leaders and individual contributors combined).");
  add("leaders", m.leaders, "People leaders — nodes that may have direct reports (VP, HOs and stream leads).");
  add("ICs", m.ics, "Individual contributors — leaf nodes with no direct reports.");
  if (m.marked) add("Non-SE", m.marked, "Non-SE people (role NSE), kept in the tree but excluded from constraints and span metrics — distinct from flagged (⚑) people.");
  add("depth", m.depth, "Depth of the tree: the number of levels from the VP at the top down to the deepest report.");
  add("span min/max", `${m.span.min}/${m.span.max}`, "Smallest and largest number of direct reports across all leaders (their span of control).");
  add("span mean", m.span.mean, "Average number of direct reports per leader.");
  add("imbalance (var)", m.span.variance, "Variance of leaders' spans of control — lower means reports are spread more evenly across leaders.");
  return stats;
}

function appendSummaryIssues(summaryEl, result, hooks) {
  const byPriority = (a, b) => priorityRank(a.code) - priorityRank(b.code);
  const errors = [...result.constraints.errors].sort(byPriority);
  const warnings = [...result.constraints.warnings, ...result.notes.map((n) => ({ message: n.message }))].sort(byPriority);
  if (errors.length) summaryEl.appendChild(issueList("Constraint errors", errors, "error", false, "Hard-constraint violations that must be fixed — e.g. broken stream/BU/level rules, span over max, or an IC with reports.", hooks.onFocusNode));
  if (warnings.length) summaryEl.appendChild(issueList("Warnings & relaxations", warnings, "warn", false, "Soft preferences and build notes that don't block anything — e.g. a leader below the minimum span, or balancer relaxations.", hooks.onFocusNode));
  if (!errors.length && !warnings.length && result.root) {
    summaryEl.appendChild(el("p", { class: "all-good" }, "✓ All constraints satisfied."));
  }
}

function appendSummaryFlags(summaryEl, root, flagsRaw, onFocusNode) {
  const flags = toFlagList(flagsRaw);
  if (!flags.length || !root) return;
  const nodeIdByName = new Map();
  walk(root, (n) => { if (!nodeIdByName.has(n.person.name)) nodeIdByName.set(n.person.name, n.id); });
  summaryEl.appendChild(flagOverview(flags, nodeIdByName, onFocusNode));
}

function buildDiffHeading(aName, bName) {
  return el("div", { class: "diff-heading" }, [
    el("span", { class: "diff-snap" }, aName),
    el("span", { class: "diff-arrow big" }, "→"),
    el("span", { class: "diff-snap" }, bName),
  ]);
}

function appendDiffChips(root, c) {
  const chips = [];
  if (c.added) chips.push(diffChip(`+${c.added} ${c.added === 1 ? "person" : "people"}`, "add"));
  if (c.removed) chips.push(diffChip(`−${c.removed} ${c.removed === 1 ? "person" : "people"}`, "remove"));
  if (c.changed) chips.push(diffChip(`${c.changed} changed`, "change"));
  if (c.reporting) chips.push(diffChip(`${c.reporting} reporting ${c.reporting === 1 ? "move" : "moves"}`, "report"));
  if (c.configChanged) chips.push(diffChip("config changed", "config"));
  if (chips.length) root.appendChild(el("div", { class: "diff-chips" }, chips));
}

function appendPeopleDiffGroup(root, p) {
  if (!p.added.length && !p.removed.length && !p.changed.length) return;
  const rows = [];
  for (const person of p.added) rows.push(diffSimpleRow("＋", "add", `${person.name} · ${diffPersonSummary(person)}`));
  for (const person of p.removed) rows.push(diffSimpleRow("−", "remove", `${person.name} · ${diffPersonSummary(person)}`));
  for (const chg of p.changed) {
    rows.push(el("div", { class: "diff-card change" }, [
      el("div", { class: "diff-card-name" }, [el("span", { class: "diff-icon" }, "~"), chg.name]),
      el("div", { class: "diff-card-lines" }, chg.fields.map(diffFieldLine)),
    ]));
  }
  root.appendChild(diffGroup(`People (${p.added.length + p.removed.length + p.changed.length})`, rows));
}

function appendReportingDiffGroup(root, reporting) {
  if (!reporting.changed.length) return;
  const rows = reporting.changed.map((r) =>
    el("div", { class: "diff-line report" }, [
      el("span", { class: "diff-icon" }, "↳"),
      el("span", { class: "diff-field" }, `${r.name}: `),
      el("span", { class: "diff-before" }, diffManagerLabel(r.before)),
      el("span", { class: "diff-arrow" }, "→"),
      el("span", { class: "diff-after" }, diffManagerLabel(r.after)),
    ])
  );
  root.appendChild(diffGroup(`Reporting lines (${reporting.changed.length})`, rows));
}

function appendConfigDiffGroup(root, cfg) {
  const cfgRows = [];
  if (cfg.span.changed) cfgRows.push(diffChangeLine("Span", `${cfg.span.before.min}–${cfg.span.before.max}`, `${cfg.span.after.min}–${cfg.span.after.max}`));
  for (const pin of cfg.pins.added) cfgRows.push(diffSimpleRow("＋", "add", `${pin.child} → ${pin.parent}`));
  for (const pin of cfg.pins.removed) cfgRows.push(diffSimpleRow("−", "remove", `${pin.child} → ${pin.parent}`));
  for (const f of cfg.flags.added) cfgRows.push(diffSimpleRow("＋", "add", `flag ${f}`));
  for (const f of cfg.flags.removed) cfgRows.push(diffSimpleRow("−", "remove", `flag ${f}`));
  if (cfgRows.length) root.appendChild(diffGroup(`Config (${cfgRows.length})`, cfgRows));
}

function buildDiffTreeHeader(aName, bName) {
  const head = el("div", { class: "diff-tree-head" });
  head.appendChild(buildDiffHeading(aName, bName));
  head.appendChild(buildDiffLegend());
  head.appendChild(buildDiffZoomControls());
  return head;
}

function buildDiffLegend() {
  return el("div", { class: "diff-legend" },
    DIFF_LEGEND.map(([status, label]) =>
      el("span", { class: `diff-legend-key diff-node-${status}` }, [
        el("span", { class: "diff-legend-swatch" }),
        el("span", {}, label),
      ])
    )
  );
}

function buildDiffZoomControls() {
  return el("div", { class: "zoom diff-zoom" }, [
    el("button", { type: "button", class: "icon-btn diff-zoom-out", title: "Zoom out" }, "−"),
    el("input", { type: "range", class: "diff-zoom-range", min: "40", max: "150", step: "5", value: "100", "aria-label": "Zoom" }),
    el("button", { type: "button", class: "icon-btn diff-zoom-in", title: "Zoom in" }, "+"),
    el("span", { class: "zoom-label diff-zoom-label" }, "100%"),
    el("button", { type: "button", class: "secondary small-btn diff-zoom-reset", title: "Reset zoom" }, "Reset"),
  ]);
}

function buildExportDataPane(jsonName, jsonFormat) {
  return el("div", { class: "export-pane" }, [
    dialogField("File name", jsonName),
    dialogField("Format", jsonFormat),
    el("p", { class: "hint" }, "Exports the current people as a JSON array."),
  ]);
}

function buildExportImagePane(imgName, bgSel, fmtSel, scaleField) {
  return el("div", { class: "export-pane", hidden: "hidden" }, [
    dialogField("File name", imgName),
    el("div", { class: "export-grid" }, [dialogField("Background", bgSel), dialogField("Format", fmtSel), scaleField]),
    el("p", { class: "hint" }, "Captures the whole tree/list at 100% zoom. SVG is vector (no size cap); PNG is capped for import tools like Miro."),
  ]);
}

function buildExportActions(spec, currentKind, controls) {
  const { jsonName, jsonFormat, imgName, bgSel, scaleSel, fmtSel } = controls;
  const actions = el("div", { class: "confirm-actions" });
  const cancel = el("button", { type: "button", class: "inl-btn confirm-cancel" }, "Cancel");
  cancel.addEventListener("click", () => spec.onCancel?.());
  const go = el("button", { type: "button", class: "inl-btn primary export-go" }, "Export");
  go.addEventListener("click", () => {
    if (currentKind() === "json") {
      spec.onExport?.({ kind: "json", filename: jsonName.value.trim(), minified: jsonFormat.value === "minified" });
    } else {
      spec.onExport?.({
        kind: "image",
        filename: imgName.value.trim(),
        background: bgSel.value,
        scale: Number(scaleSel.value) || 1,
        format: fmtSel.value,
      });
    }
  });
  actions.appendChild(cancel);
  actions.appendChild(go);
  return actions;
}

function parentNameOf(node, ctx) {
  return node.parentId ? ctx.byId?.get(node.parentId)?.person.name ?? null : null;
}

function ensureCardMenu() {
  if (cardMenuEl) return cardMenuEl;
  cardMenuEl = el("div", { class: "card-menu", role: "menu" });
  cardMenuEl.hidden = true;
  document.body.appendChild(cardMenuEl);
  document.addEventListener("pointerdown", (e) => {
    if (!cardMenuEl.hidden && !cardMenuEl.contains(e.target)) closeCardMenu();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCardMenu(); });
  window.addEventListener("scroll", closeCardMenu, true);
  window.addEventListener("resize", closeCardMenu);
  return cardMenuEl;
}

function closeCardMenu() {
  if (!cardMenuEl || cardMenuEl.hidden) return;
  cardMenuEl.hidden = true;
  cardMenuEl.innerHTML = "";
}

function openCardMenu(node, ctx, x, y) {
  const p = node.person;
  const menu = ensureCardMenu();
  menu.innerHTML = "";

  const items = [{ label: "✎ Edit / delete…", act: () => ctx.hooks.onStartEdit?.(node.id) }];
  if (p.isPeopleLeader) items.push({ label: "＋ Add report", act: () => ctx.hooks.onStartAdd?.(node.id) });
  const flagged = ctx.flagged?.has(p.name);
  items.push({ label: flagged ? "⚑ Unflag" : "⚑ Flag", act: () => ctx.hooks.onToggleFlag?.(p.name) });
  if (flagged) items.push({ label: "✎ Edit flag note…", act: () => ctx.hooks.onEditFlagComment?.(p.name) });
  const parentName = parentNameOf(node, ctx);
  if (parentName) {
    const locked = ctx.pinnedChildren?.get(p.name) != null;
    items.push({
      label: locked ? "🔓 Unfix link" : "🔒 Fix link",
      act: () => ctx.hooks.onToggleLock?.(p.name, parentName),
    });
  }

  for (const it of items) {
    const b = el("button", { type: "button", class: "card-menu-item", role: "menuitem" }, it.label);
    b.addEventListener("click", () => { closeCardMenu(); it.act(); });
    menu.appendChild(b);
  }

  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 8);
  const py = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, px)}px`;
  menu.style.top = `${Math.max(8, py)}px`;
  menu.querySelector("button")?.focus();
}

function toFlagList(flags) {
  return (flags ?? []).map((f) => (typeof f === "string" ? { name: f } : f)).filter((f) => f && f.name);
}

function sortedChildren(node) {
  return [...node.children].sort((a, b) => compareForDisplay(a.person, b.person));
}

function buildSelect(pairs, value) {
  const sel = el("select", { class: "inl-select" });
  for (const [val, label] of pairs) sel.appendChild(el("option", { value: val }, label));
  if (value != null) sel.value = value;
  return sel;
}

function cardControl(card, spec) {
  const btn = el("button", {
    type: "button",
    class: spec.class,
    title: spec.title,
    "aria-label": spec.ariaLabel,
  }, spec.text);
  btn.draggable = false;
  btn.addEventListener("pointerdown", (e) => { e.stopPropagation(); card.draggable = false; });
  btn.addEventListener("dragstart", (e) => { e.preventDefault(); e.stopPropagation(); });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    card.draggable = true;
    spec.onActivate();
  });
  return btn;
}

function wireDrag(card, node, hooks) {
  card.addEventListener("dragstart", (e) => {
    if (e.target.closest && e.target.closest(".flag-btn, .edge-lock, .add-report, .card-menu-btn")) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData("text/plain", node.id);
    e.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));
  card.addEventListener("dragover", (e) => {
    e.preventDefault();
    card.classList.add("drop-target");
  });
  card.addEventListener("dragleave", () => card.classList.remove("drop-target"));
  card.addEventListener("drop", (e) => {
    e.preventDefault();
    card.classList.remove("drop-target");
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId && draggedId !== node.id && hooks.onDrop) hooks.onDrop(draggedId, node.id);
  });
}

function wireSlotDrop(slot, node, hooks) {
  slot.draggable = false;
  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.add("slot-hover");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("slot-hover"));
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.remove("slot-hover");
    const draggedId = e.dataTransfer.getData("text/plain");
    if (draggedId && draggedId !== node.id && hooks.onDrop) hooks.onDrop(draggedId, node.id);
  });
}

function issueList(title, items, kind, open, hint, onFocusNode) {
  const wrap = el("details", { class: `issues ${kind}` });
  if (open) wrap.setAttribute("open", "");
  wrap.appendChild(el("summary", { title: hint }, `${title} (${items.length})`));
  const ul = el("ul", {});
  for (const it of items) {
    if (onFocusNode && it.nodeId) {
      const li = el("li", {
        class: "issue-focusable",
        role: "button",
        tabindex: "0",
        "data-node-id": it.nodeId,
        title: "Show this node in the tree",
      }, it.message);
      const focus = () => onFocusNode(it.nodeId);
      li.addEventListener("click", focus);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focus(); }
      });
      ul.appendChild(li);
    } else {
      ul.appendChild(el("li", {}, it.message));
    }
  }
  wrap.appendChild(ul);
  return wrap;
}

function flagOverview(flags, nodeIdByName, onFocusNode) {
  const wrap = el("details", { class: "issues flags-overview" });
  wrap.appendChild(el("summary", { title: "Flagged / highlighted people and their notes (display-only)." }, `Flags (${flags.length})`));
  const ul = el("ul", {});
  for (const f of flags) {
    const children = [el("span", { class: "flag-name" }, `⚑ ${f.name}`)];
    if (f.comment) children.push(el("span", { class: "flag-comment" }, f.comment));
    const nodeId = nodeIdByName.get(f.name);
    if (onFocusNode && nodeId) {
      const li = el("li", {
        class: "issue-focusable flag-item",
        role: "button",
        tabindex: "0",
        "data-node-id": nodeId,
        title: "Show this node in the tree",
      }, children);
      const focus = () => onFocusNode(nodeId);
      li.addEventListener("click", focus);
      li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); focus(); } });
      ul.appendChild(li);
    } else {
      ul.appendChild(el("li", { class: "flag-item" }, children));
    }
  }
  wrap.appendChild(ul);
  return wrap;
}

function diffPersonSummary(p) {
  const parts = [p.role, `${labelOf(p.location)} (${buOf(p.location)})`];
  const lvl = levelOf(p);
  if (lvl !== undefined) parts.push(`L${lvl}`);
  if (p.isPeopleLeader) parts.push("leader");
  return parts.join(" · ");
}

function diffManagerLabel(name) {
  return name == null ? "— (top)" : name;
}

function diffChangeLine(label, before, after) {
  return el("div", { class: "diff-line" }, [
    label ? el("span", { class: "diff-field" }, `${label}: `) : null,
    el("span", { class: "diff-before" }, String(before)),
    el("span", { class: "diff-arrow" }, "→"),
    el("span", { class: "diff-after" }, String(after)),
  ].filter(Boolean));
}

function diffFieldLine(f) {
  if (f.field === "location") {
    return diffChangeLine("location", `${labelOf(f.before)} (${f.beforeBu})`, `${labelOf(f.after)} (${f.afterBu})`);
  }
  if (f.field === "isPeopleLeader") {
    return diffChangeLine("leader", f.before ? "yes" : "no", f.after ? "yes" : "no");
  }
  return diffChangeLine(f.field, f.before, f.after);
}

function diffSimpleRow(icon, cls, text) {
  return el("div", { class: `diff-line ${cls}` }, [
    el("span", { class: "diff-icon" }, icon),
    el("span", {}, text),
  ]);
}

function diffChip(text, cls) {
  return el("span", { class: `diff-chip ${cls}` }, text);
}

function diffGroup(title, children) {
  return el("section", { class: "diff-group" }, [
    el("h4", { class: "diff-group-title" }, title),
    el("div", { class: "diff-rows" }, children),
  ]);
}

const DIFF_STATUS_BADGE = {
  added: "＋ added",
  removed: "− removed",
  changed: "~ changed",
  moved: "↳ moved",
};

const DIFF_LEGEND = [
  ["added", "Added"],
  ["removed", "Removed"],
  ["changed", "Changed"],
  ["moved", "Moved"],
];

function renderDiffCard(node) {
  const p = node.person;
  const classes = ["card", `role-${p.role}`, `diff-node-${node.status}`];
  if (node.alsoMoved) classes.push("diff-node-moved");
  const card = el("div", { class: classes.join(" ") });

  const badgeLabel = DIFF_STATUS_BADGE[node.status];
  if (badgeLabel) card.appendChild(el("span", { class: `diff-node-badge ${node.status}` }, badgeLabel));

  const lvl = levelOf(p);
  const roleLabel = lvl ? `${p.role} L${lvl}` : p.role;
  card.appendChild(el("div", { class: "kicker" }, `${roleLabel} · ${p.isPeopleLeader ? "leader" : "IC"}`));
  card.appendChild(el("div", { class: "headline" }, p.name));

  const byline = el("div", { class: "byline" });
  byline.appendChild(el("span", { class: "loc-dot", style: `background:${colorOf(p.location)}` }));
  [labelOf(p.location), buOf(p.location) ?? "?"].forEach((text, i) => {
    if (i > 0) byline.appendChild(el("span", { class: "sep" }, "·"));
    byline.appendChild(el("span", { class: "meta" }, text));
  });
  card.appendChild(byline);

  if ((node.status === "moved" || node.alsoMoved) && node.movedFrom !== undefined) {
    card.appendChild(el("div", { class: "diff-node-movedfrom" }, `moved from ${diffManagerLabel(node.movedFrom)}`));
  }
  if (node.changes?.length) {
    card.appendChild(el("div", { class: "diff-node-changes" }, node.changes.map(diffFieldLine)));
  }
  return card;
}

function renderDiffTreeNode(node) {
  const li = el("li", { class: "node" });
  li.appendChild(renderDiffCard(node));
  if (node.children && node.children.length) {
    const ul = el("ul", { class: "children" });
    for (const c of node.children) ul.appendChild(renderDiffTreeNode(c));
    li.appendChild(ul);
  }
  return li;
}

function dialogField(labelText, control) {
  return el("label", { class: "field" }, [el("span", {}, labelText), control]);
}

function dialogSelect(id, pairs, value) {
  const sel = el("select", { id, class: "inl-select" });
  for (const [val, text] of pairs) {
    const opt = el("option", { value: val }, text);
    if (val === value) opt.setAttribute("selected", "selected");
    sel.appendChild(opt);
  }
  return sel;
}
