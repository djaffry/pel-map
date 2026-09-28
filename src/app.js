import { DEFAULT_SPAN, compareBySeniority } from "./model.js";
import { validatePeople } from "./validate.js";
import { computeMetrics, emptyMetrics } from "./balance.js";
import { checkTree, checkMove } from "./constraints.js";
import { planCapacity } from "./capacity.js";
import {
  toPeople, findById, isAncestor, makeNode, attach, reparent, walk,
  serializeTree, deserializeTree, removeReassigningChildren,
} from "./tree.js";
import { render, renderCapacity, el, buildPersonForm, defaultChild, renderSnapshotDiff, renderDiffTree, buildConfirmDialog, buildExportDialog } from "./render.js";
import { exportElementAsImage, exportElementAsSvg } from "./export-image.js";
import {
  makeSnapshot,
  restoreState,
  migratePersisted,
  normalizeFlags,
  WORKING_DRAFT_NAME,
} from "./snapshots.js";
import { diffSnapshots, buildDiffTree } from "./diff.js";

const byId = (id) => document.getElementById(id);

const targets = {
  treeEl: byId("tree"),
  summaryEl: byId("summary"),
  capacityEl: byId("capacity"),
};

const state = {
  people: [],
  span: { ...DEFAULT_SPAN },
  balancePriority: "evenness",
  hardLocation: false,
  pins: [],
  flags: [],
  view: "tree",
  collapsed: new Set(),
  snapshots: [],
  activeSnapshotId: null,
  dirty: false,
  renamingId: null,
  exportPrefs: {
    json: { filename: "people.json", minified: false },
    image: { filename: "", background: "white", scale: 2, format: "png" },
  },
  result: null,
  history: [],
  future: [],
};

function snapshot() {
  return {
    tree: serializeTree(state.result?.root ?? null),
    span: { ...state.span },
    pins: state.pins.map((p) => ({ ...p })),
    flags: state.flags.map((f) => ({ ...f })),
  };
}
function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  state.future = [];
  markDirty();
}
function syncSpanInputs() {
  const min = byId("spanMin");
  const max = byId("spanMax");
  if (min) min.value = String(state.span.min);
  if (max) max.value = String(state.span.max);
}
function restoreSnapshot(snap) {
  state.span = snap.span ? { ...snap.span } : { ...state.span };
  state.pins = (snap.pins ?? []).map((p) => ({ ...p }));
  state.flags = normalizeFlags(snap.flags);
  state.result = resultFor(deserializeTree(snap.tree));
  syncSpanInputs();
}

// The live editable state is the TREE plus {span,pins,flags}; a named snapshot is
// a deep copy of it (a serialized tree + config). The people list is included as
// a derived mirror for the diff view. All snapshot data logic is pure and lives
// in ./snapshots.js — here we only manage state + DOM.
function findSnapshot(id) {
  return state.snapshots.find((s) => s.id === id) || null;
}
function captureLiveState() {
  return {
    people: state.people,
    span: state.span,
    pins: state.pins,
    flags: state.flags,
    tree: serializeTree(state.result?.root ?? null),
  };
}
function markDirty() {
  state.dirty = true;
  refreshSnapshotUI();
}
function applyState(snapState) {
  const clone = restoreState({ state: snapState });
  state.span = clone.span;
  state.pins = clone.pins;
  state.flags = clone.flags;
  state.dirty = false;
  syncSpanInputs();
  if (clone.tree) {
    // Restore the exact stored structure — snapshots never rebalance.
    state.result = resultFor(deserializeTree(clone.tree));
    present();
    return;
  }
  const { people } = validatePeople(clone.people);
  state.people = people;
  buildFromPeople();
}
function backupWorkingDraft() {
  const existing = state.snapshots.find((s) => s.name === WORKING_DRAFT_NAME);
  const fresh = makeSnapshot(
    WORKING_DRAFT_NAME,
    captureLiveState(),
    existing ? { id: existing.id, createdAt: existing.createdAt } : {}
  );
  if (existing) Object.assign(existing, fresh);
  else state.snapshots.push(fresh);
}
function saveSnapshot(name) {
  const clean = String(name || "").trim();
  if (!clean) return flash("Give the snapshot a name first.", "warn");
  const snap = makeSnapshot(clean, captureLiveState());
  state.snapshots.push(snap);
  state.activeSnapshotId = snap.id;
  state.dirty = false;
  byId("snapshotName").value = "";
  flash(`Saved snapshot "${snap.name}".`, "ok");
  refreshSnapshotUI();
  persist();
}
function updateActiveSnapshot() {
  const snap = findSnapshot(state.activeSnapshotId);
  if (!snap) return flash("No active snapshot to update — use Save.", "warn");
  Object.assign(snap, makeSnapshot(snap.name, captureLiveState(), { id: snap.id, createdAt: snap.createdAt }));
  state.dirty = false;
  flash(`Updated snapshot "${snap.name}".`, "ok");
  refreshSnapshotUI();
  persist();
}
function switchSnapshot(id) {
  const snap = findSnapshot(id);
  if (!snap) return;
  if (snap.id === state.activeSnapshotId && !state.dirty) {
    return flash(`"${snap.name}" is already active.`, "warn");
  }
  // Deep-clone the target's stored state BEFORE any backup runs: backing up the
  // Working draft below overwrites that slot in place, so if the draft is the
  // switch target we'd otherwise re-apply the current work and the auto-backup
  // would be impossible to select. Skip the self-backup when switching TO the
  // draft (it IS the recovery slot; loading it discards current unsaved work,
  // which stays recoverable via Undo).
  const targetState = restoreState(snap);
  const targetIsDraft = snap.name === WORKING_DRAFT_NAME;
  // Lossless: preserve current unsaved work (Working draft slot for full-state
  // recovery incl. span) and keep the swap undoable via the history stack.
  if (!targetIsDraft && (state.dirty || state.activeSnapshotId === null)) backupWorkingDraft();
  pushHistory();
  applyState(targetState);
  state.activeSnapshotId = snap.id;
  refreshSnapshotUI();
  persist();
  flash(`Switched to "${snap.name}".`, "ok");
}
function renameSnapshot(id, name) {
  const snap = findSnapshot(id);
  if (!snap) return;
  const clean = String(name || "").trim();
  if (!clean) return flash("Snapshot name can't be empty.", "warn");
  snap.name = clean;
  snap.updatedAt = Date.now();
  refreshSnapshotUI();
  persist();
  flash(`Renamed snapshot to "${clean}".`, "ok");
}
function deleteSnapshot(id) {
  const snap = findSnapshot(id);
  if (!snap) return;
  state.snapshots = state.snapshots.filter((s) => s.id !== id);
  if (state.activeSnapshotId === id) {
    state.activeSnapshotId = null;
    state.dirty = true;
  }
  refreshSnapshotUI();
  persist();
  flash(`Deleted snapshot "${snap.name}".`, "ok");
}
async function confirmDeleteSnapshot(snap) {
  const ok = await confirmDialog({
    title: "Delete snapshot?",
    message: `"${snap.name}" will be permanently removed. This can't be undone.`,
    confirmLabel: "Delete",
    cancelLabel: "Keep",
    danger: true,
  });
  if (ok) deleteSnapshot(snap.id);
}

const STORAGE_KEY = "orgBalancer:v4";
const LEGACY_STORAGE_KEYS = ["orgBalancer:v3", "orgBalancer:v2", "orgBalancer:v1"];
function persist() {
  try {
    const layout = byId("layout");
    const data = {
      tree: serializeTree(state.result?.root ?? null),
      span: state.span,
      balancePriority: state.balancePriority,
      hardLocation: state.hardLocation,
      pins: state.pins,
      flags: state.flags,
      view: state.view,
      collapsed: [...state.collapsed],
      snapshots: state.snapshots,
      activeSnapshotId: state.activeSnapshotId,
      exportPrefs: state.exportPrefs,
      zoom: zoom.value,
      collapsedPanel: layout ? layout.classList.contains("collapsed") : false,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch { /* storage unavailable — ignore */ }
}
function loadPersisted() {
  try {
    const rawV4 = localStorage.getItem(STORAGE_KEY);
    const rawLegacy = rawV4 ? null : (
      localStorage.getItem(LEGACY_STORAGE_KEYS[0]) ||
      localStorage.getItem(LEGACY_STORAGE_KEYS[1]) ||
      localStorage.getItem(LEGACY_STORAGE_KEYS[2])
    );
    const v4 = rawV4 ? JSON.parse(rawV4) : null;
    const legacy = rawLegacy ? JSON.parse(rawLegacy) : null;
    return migratePersisted(v4, legacy);
  } catch { return null; }
}

// The TREE (state.result.root) is the editable source of truth for structure.
// `state.people` is a synced, read-only mirror (toPeople) kept for the pin
// dropdowns, duplicate detection, export, etc. Imports restore the tree stored
// in the JSON; a structure-less people list is placed in a flat tree once. Every
// edit mutates the tree in place and calls `refresh()` — nothing rebalances.

function syncPeople() {
  state.people = state.result?.root ? toPeople(state.result.root) : [];
}

function present() {
  syncPeople();
  renderAll();
  refreshSnapshotUI();
  persist();
}
// Build a flat, unbalanced tree from a bare people list (one with no stored
// structure): the most senior person (VP → HO → …) becomes the root and everyone
// else is a direct report. No balancing — the user arranges the tree manually.
function flatTreeFrom(people) {
  if (!people?.length) return null;
  const [rootPerson, ...rest] = [...people].sort(compareBySeniority);
  const root = makeNode({ ...rootPerson });
  for (const p of rest) attach(root, makeNode({ ...p }));
  return root;
}
function buildFromPeople() {
  closePopup();
  state.result = resultFor(flatTreeFrom(state.people));
  present();
  centerViewport();
}
function resultFor(root) {
  const metrics = root ? computeMetrics(root) : emptyMetrics();
  const constraints = root
    ? checkTree(root, { span: state.span, hardLocation: state.hardLocation })
    : { ok: true, errors: [], warnings: [] };
  return {
    root,
    metrics,
    constraints,
    notes: [],
  };
}
function refresh() {
  state.result = resultFor(state.result?.root ?? null);
  present();
}

function renderAll() {
  render(
    targets,
    state.result,
    { onDrop, onToggleLock, onStartEdit, onStartAdd, onToggleFlag, onEditFlagComment, onToggleCollapse, onFocusNode },
    { pins: state.pins, flags: state.flags, view: state.view, collapsed: state.collapsed, span: state.span }
  );
  renderCapacity(targets.capacityEl, planCapacity(state.people, { span: state.span, pins: state.pins }));
  refreshHistoryButtons();
  refreshViewUI();
}

// Presentation-only state: switching view or collapsing a node re-renders the
// current tree (refresh) — it never rebalances, is not an undoable content edit,
// and does not mark the draft dirty (matches zoom / controls-panel collapse).
function setView(view) {
  const next = view === "list" ? "list" : "tree";
  if (state.view === next) return;
  state.view = next;
  refresh();
  if (next === "tree") centerViewport();
}

function onToggleCollapse(node) {
  const name = node.person.name;
  if (state.collapsed.has(name)) state.collapsed.delete(name);
  else state.collapsed.add(name);
  refresh();
}

function setAllCollapsed(collapsed) {
  state.collapsed = new Set();
  if (collapsed && state.result?.root) {
    walk(state.result.root, (n) => { if (n.children.length) state.collapsed.add(n.person.name); });
  }
  refresh();
}
function onFocusNode(nodeId) {
  const root = state.result?.root;
  if (!nodeId || !root) return;
  const node = findById(root, nodeId);
  if (!node) return;

  expandCollapsedAncestorsForFocus(root, node);
  pulseFocusedCard(nodeId);
}

function expandCollapsedAncestorsForFocus(root, node) {
  if (state.view !== "list" || !state.collapsed.size) return;
  let changed = false;
  let cur = node.parentId ? findById(root, node.parentId) : null;
  while (cur) {
    if (state.collapsed.delete(cur.person.name)) changed = true;
    cur = cur.parentId ? findById(root, cur.parentId) : null;
  }
  if (changed) refresh();
}

function pulseFocusedCard(nodeId) {
  requestAnimationFrame(() => {
    const card = document.querySelector(`#tree [data-id="${nodeId}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    card.classList.remove("focus-pulse");
    void card.offsetWidth; // restart the animation if it's still applied
    card.classList.add("focus-pulse");
    setTimeout(() => card.classList.remove("focus-pulse"), 1600);
  });
}

function refreshViewUI() {
  const isList = state.view === "list";
  byId("viewTree")?.setAttribute("aria-pressed", String(!isList));
  byId("viewList")?.setAttribute("aria-pressed", String(isList));
  // Expand/Collapse only apply to the list view — hide the whole group in tree
  // view so the toolbar shows only relevant actions.
  const collapseGroup = byId("collapseGroup");
  if (collapseGroup) collapseGroup.hidden = !isList;
}

// A flag highlights a node and carries an optional free-text comment shown in the
// Summary overview. Flagging prompts for the comment; an already-flagged node can
// have its comment edited or be unflagged.
function flagFor(name) {
  return state.flags.find((f) => f.name === name) || null;
}
async function onToggleFlag(name) {
  if (flagFor(name)) {
    pushHistory();
    state.flags = state.flags.filter((f) => f.name !== name);
    refresh();
    return;
  }
  const comment = await promptFlagComment(name, "");
  if (comment === null) return;
  pushHistory();
  const trimmed = comment.trim();
  state.flags.push(trimmed ? { name, comment: trimmed } : { name });
  refresh();
}
async function onEditFlagComment(name) {
  const flag = flagFor(name);
  if (!flag) return;
  const comment = await promptFlagComment(name, flag.comment ?? "");
  if (comment === null) return;
  pushHistory();
  const trimmed = comment.trim();
  if (trimmed) flag.comment = trimmed;
  else delete flag.comment;
  refresh();
}

function nodeById(id) {
  if (!state.result?.root) return null;
  return findById(state.result.root, id);
}

// A person has at most one fixed manager; replace any existing link.
function setPin(parent, child) {
  state.pins = state.pins.filter((p) => p.child !== child);
  state.pins.push({ parent, child });
}

function onStartEdit(nodeId) {
  const node = nodeById(nodeId);
  if (!node) return;
  openPopup({
    spec: { mode: "edit", title: `Edit ${node.person.name}`, initial: { ...node.person }, notes: nodeIssues(node) },
    anchorId: nodeId,
    onSave: (values) => saveEdit(nodeId, values),
    onDelete: () => deleteNode(nodeId),
  });
}

function nodeIssues(node) {
  const notes = [];
  const c = state.result?.constraints;
  for (const e of c?.errors ?? []) if (e.nodeId === node.id) notes.push({ kind: "error", text: e.message });
  for (const w of c?.warnings ?? []) if (w.nodeId === node.id) notes.push({ kind: "warn", text: w.message });
  const flag = flagFor(node.person.name);
  if (flag) notes.push({ kind: "flag", text: flag.comment ? `Flagged: ${flag.comment}` : "Flagged / highlighted." });
  if (state.people.filter((p) => p.name === node.person.name).length > 1) {
    notes.push({ kind: "warn", text: "Duplicate name — another person shares this name." });
  }
  return notes;
}

function onStartAdd(parentId) {
  const parent = parentId ? nodeById(parentId) : null;
  const parentName = parent?.person.name ?? null;
  openPopup({
    spec: {
      mode: "add",
      title: parentName ? `New report under ${parentName}` : "New person",
      initial: defaultChild(parent?.person ?? null),
    },
    anchorId: parentId,
    onSave: (values) => saveAdd(values, parentId),
  });
}

function saveEdit(nodeId, values) {
  const { people, errors } = validatePeople([values]);
  if (errors.length) return flash(errors.map((e) => e.message).join(" "), "error");
  const node = nodeById(nodeId);
  if (!node) { closePopup(); return; }
  pushHistory();
  const person = node.person;
  const oldName = person.name;
  Object.assign(person, people[0]);
  if (oldName !== person.name) {
    for (const pin of state.pins) {
      if (pin.parent === oldName) pin.parent = person.name;
      if (pin.child === oldName) pin.child = person.name;
    }
    state.flags = state.flags.map((f) => (f.name === oldName ? { ...f, name: person.name } : f));
  }
  flash(`Updated ${person.name}.`, "ok");
  closePopup();
  refresh();
}

// Add a person directly into the tree (no rebalance). With a parent it becomes
// that leader's report; at the top level it attaches under the root (or becomes
// the root when the tree is empty).
function saveAdd(values, parentId) {
  const { people, errors } = validatePeople([values]);
  if (errors.length) return flash(errors.map((e) => e.message).join(" "), "error");
  const clean = people[0];
  pushHistory();
  const node = makeNode(clean);
  const parent = parentId ? nodeById(parentId) : state.result?.root ?? null;
  if (parent) {
    attach(parent, node);
    flash(`Added ${clean.name} under ${parent.person.name}.`, "ok");
  } else {
    state.result = resultFor(node);
    flash(`Added ${clean.name}.`, "ok");
  }
  closePopup();
  refresh();
}

function deleteNode(nodeId) {
  const node = nodeById(nodeId);
  if (!node) { closePopup(); return; }
  const root = state.result?.root ?? null;
  pushHistory();
  const name = node.person.name;
  const reportCount = node.children.length;

  // Surgical delete (no rebalance): the node's direct reports take its slot
  // under its manager, one level up, as normal UNLOCKED connections. Any fixed
  // link that referenced the deleted person is dropped.
  const movedTo = node === root ? deleteRootNode(node) : deleteNonRootNode(root, node, reportCount);
  state.pins = state.pins.filter((pin) => pin.parent !== name && pin.child !== name);
  state.flags = state.flags.filter((f) => f.name !== name);

  const message = movedTo && reportCount
    ? `Deleted ${name}; moved ${reportCount} report(s) up to ${movedTo}.`
    : `Deleted ${name}.`;
  flash(message, "ok");
  closePopup();
  refresh();
}

function deleteRootNode(node) {
  const [first, ...rest] = node.children;
  if (!first) {
    state.result.root = null;
    return null;
  }
  first.parentId = null;
  for (const c of rest) {
    c.parentId = first.id;
    first.children.push(c);
  }
  node.children = [];
  state.result.root = first;
  return first.person.name;
}

function deleteNonRootNode(root, node, reportCount) {
  const res = removeReassigningChildren(root, node.id);
  return res.ok && reportCount ? res.manager.person.name : null;
}

function openPopup({ spec, anchorId, onSave, onDelete }) {
  const popup = byId("inlinePopup");
  const backdrop = byId("popupBackdrop");
  popup.innerHTML = "";
  const form = buildPersonForm(spec, {
    onSave,
    onDelete,
    onCancel: closePopup,
  });
  popup.appendChild(form);
  popup.hidden = false;
  backdrop.hidden = false;
  positionPopup(popup, anchorId);
}

function closePopup() {
  const popup = byId("inlinePopup");
  const backdrop = byId("popupBackdrop");
  popup.hidden = true;
  popup.innerHTML = "";
  backdrop.hidden = true;
}

function positionPopup(popup, anchorId) {
  const anchor = anchorId ? document.querySelector(`.card[data-id="${anchorId}"]`) : null;
  preparePopupForMeasurement(popup);
  const pr = popup.getBoundingClientRect();
  const margin = 10;
  let left, top;
  if (anchor) {
    const a = anchor.getBoundingClientRect();
    left = a.right + margin;
    top = a.top;
    if (left + pr.width > window.innerWidth - margin) left = a.left - pr.width - margin;
    if (left < margin) left = Math.max(margin, (window.innerWidth - pr.width) / 2);
  } else {
    left = (window.innerWidth - pr.width) / 2;
    top = (window.innerHeight - pr.height) / 2;
  }
  top = Math.min(Math.max(margin, top), window.innerHeight - pr.height - margin);
  popup.style.left = `${Math.round(left)}px`;
  popup.style.top = `${Math.round(top)}px`;
  popup.style.visibility = "";
}

function preparePopupForMeasurement(popup) {
  popup.style.visibility = "hidden";
  popup.style.left = "0px";
  popup.style.top = "0px";
}

// A lock records that this edge should be preserved on the next Auto-rebalance.
// It does not move the node (structure is edited directly via drag/add/delete).
function onToggleLock(childName, parentName) {
  if (!parentName) return;
  pushHistory();
  const existing = state.pins.find((p) => p.child === childName);
  if (existing && existing.parent === parentName) {
    state.pins = state.pins.filter((p) => p !== existing);
    flash(`Unfixed: ${childName} is no longer locked to ${parentName}.`, "ok");
  } else {
    setPin(parentName, childName);
    flash(`Fixed: ${childName} is locked under ${parentName}.`, "ok");
  }
  refresh();
}

// Drag a person onto a people leader to MOVE them under that leader. The move is
// applied to the tree directly (no rebalance) and pinned so it also survives a
// future Auto-rebalance.
function onDrop(draggedId, targetId) {
  const dragged = nodeById(draggedId);
  const target = nodeById(targetId);
  if (!dragged || !target || draggedId === targetId) return;
  if (!dragged.parentId) return flash("The top node can't be moved.", "warn");
  if (target.person.isPeopleLeader !== true) {
    return flash(`${target.person.name} is not a people leader, so reports can't be appended there.`, "error");
  }
  if (isAncestor(state.result.root, draggedId, targetId)) {
    return flash("Can't append a node into its own subtree.", "error");
  }
  if (target.children.some((c) => c.id === draggedId)) {
    return flash(`${dragged.person.name} already reports to ${target.person.name}.`, "warn");
  }
  pushHistory();
  const res = reparent(state.result.root, draggedId, targetId);
  if (!res.ok) return flash(res.reason ?? "Move rejected.", "error");
  setPin(target.person.name, dragged.person.name);
  flash(`Moved ${dragged.person.name} under ${target.person.name}.`, "ok");
  refresh();
}

// Importing fresh data (sample or file) preserves the current hierarchy as a
// snapshot first (so nothing is silently lost), then adopts the imported data as
// a new, active snapshot named after the source file. A structured export (one
// carrying a serialized `tree`) is restored EXACTLY and never rebalanced; only a
// bare people list — which has no structure to preserve — is built (§6/§8).
function loadPeople(raw, sourceLabel) {
  // A structured export (one carrying a serialized `tree`) is restored exactly;
  // anything else is built from its people list (bare array, or the `people`
  // mirror of a structured export whose tree is missing/unusable).
  const structured = structuredPayload(raw);
  if (structured) return loadStructured(structured, sourceLabel);
  return loadFlatPeople(peopleListFrom(raw), sourceLabel);
}

// A structured import is an object carrying a serialized `tree` (plus optional
// span/pins/flags). Returns it when recognised, otherwise null (bare array etc.).
function structuredPayload(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!raw.tree || typeof raw.tree !== "object" || !raw.tree.person) return null;
  return raw;
}

// Extract a flat people list from anything importable: a bare array, or the
// `people` mirror of a structured export. Unknown shapes pass through so
// `validatePeople` can report a clear "not a JSON array" error.
function peopleListFrom(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.people)) return raw.people;
  return raw;
}

// Shared import lifecycle: snapshot the outgoing work, then clear undo history
// and any open popup before the incoming data replaces the tree.
function beginImport() {
  preserveWorkBeforeImport();
  state.history = [];
  state.future = [];
  closePopup();
}
// Adopt the imported data as a new active snapshot and show it.
function finishImport(sourceLabel) {
  const name = adoptImportedSnapshot(sourceLabel);
  present();
  centerViewport();
  return name;
}

// Restore an exported hierarchy as-is. This is the fix for "autobalance on
// import": importing a structured export must NOT run buildHierarchy (§6/§8).
function loadStructured(payload, sourceLabel) {
  const root = deserializeTree(payload.tree);
  if (!root) return flash(`No hierarchy found in ${sourceLabel}.`, "error");

  beginImport();
  if (payload.span && Number.isFinite(payload.span.min) && Number.isFinite(payload.span.max)) {
    state.span = { min: payload.span.min, max: payload.span.max };
  }
  if (Array.isArray(payload.pins)) {
    state.pins = payload.pins
      .filter((p) => p && typeof p.parent === "string" && typeof p.child === "string")
      .map((p) => ({ parent: p.parent, child: p.child }));
  }
  if (payload.flags !== undefined) state.flags = normalizeFlags(payload.flags);

  // Restore the stored structure exactly — no buildHierarchy on import.
  state.result = resultFor(root);
  syncPeople();
  syncSpanInputs();

  const name = finishImport(sourceLabel);
  flash(`Imported "${name}" — structure preserved.`, "ok");
}

// A bare people list has no reporting structure, so it is placed once in a flat
// tree (most-senior person as root, everyone else a direct report). No
// balancing — the user arranges it manually afterwards.
function loadFlatPeople(raw, sourceLabel) {
  const { people, errors, warnings } = validatePeople(raw);
  if (errors.length) {
    flash(`${errors.length} invalid record(s) skipped from ${sourceLabel}.`, "warn");
  }
  if (warnings.length) flash(`${warnings.length} warning(s).`, "warn");

  beginImport();
  state.people = people;
  state.result = resultFor(flatTreeFrom(people));

  const name = finishImport(sourceLabel);
  if (!errors.length && !warnings.length) {
    flash(`Imported ${people.length} people into snapshot "${name}".`, "ok");
  }
}

function snapshotNameFromSource(sourceLabel) {
  const base = String(sourceLabel || "Imported").replace(/\.json$/i, "").trim();
  return base || "Imported";
}
function preserveWorkBeforeImport() {
  if (!state.result?.root) return;
  const active = state.activeSnapshotId ? findSnapshot(state.activeSnapshotId) : null;
  if (!active) {
    // Unsaved, unnamed work → keep it recoverable under the Working-draft slot.
    backupWorkingDraft();
    return;
  }
  if (!state.dirty) return;
  Object.assign(active, makeSnapshot(active.name, captureLiveState(), { id: active.id, createdAt: active.createdAt }));
}

function adoptImportedSnapshot(sourceLabel) {
  const name = snapshotNameFromSource(sourceLabel);
  const snap = makeSnapshot(name, captureLiveState());
  state.snapshots.push(snap);
  state.activeSnapshotId = snap.id;
  state.dirty = false;
  return name;
}

async function onFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    loadPeople(raw, file.name);
  } catch (e) {
    flash(`Could not parse ${file.name}: ${e.message}`, "error");
  }
  ev.target.value = "";
}

function onEmptyStateAction(e) {
  const btn = e.target.closest?.("[data-empty-action]");
  if (!btn) return;
  // Upload lives in the controls panel — make sure it's visible first.
  if (byId("layout").classList.contains("collapsed")) togglePanel();
  const target = byId("file");
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.focus();
}

// Span bounds feed the constraint checks (SPAN_MAX/MIN). Changing them re-checks
// constraints against the current tree — it never rebalances.
function onSpanChange() {
  const min = parseInt(byId("spanMin").value, 10);
  const max = parseInt(byId("spanMax").value, 10);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
    return flash("Span must satisfy 1 ≤ min ≤ max.", "warn");
  }
  pushHistory();
  state.span = { min, max };
  state.dirty = true;
  refresh();
}

// Undo/redo restores the exact prior tree and never rebalances.
function onUndo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  restoreSnapshot(state.history.pop());
  state.dirty = true;
  present();
}
function onRedo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restoreSnapshot(state.future.pop());
  state.dirty = true;
  present();
}
function refreshHistoryButtons() {
  byId("undo").disabled = state.history.length === 0;
  byId("redo").disabled = state.future.length === 0;
}

// A single Export… dialog offers JSON (data) and Image (PNG/SVG) with options.
// None of these paths rebalance or mutate the tree (§8/§9).
function openExportDialog() {
  if (!state.result?.root) return flash("Nothing to export yet.", "warn");
  const host = byId("exportModal");
  host.innerHTML = "";
  host.appendChild(buildExportDialog({
    prefs: state.exportPrefs,
    onExport: (opts) => { closeModal("export"); runExport(opts); },
    onCancel: () => closeModal("export"),
  }));
  openModal("export", { initialFocus: ".export-tabs .diff-tab" });
}

function runExport(opts) {
  if (opts.kind === "json") exportJson(opts);
  else exportImage(opts);
}

// Shape of a structured JSON export: a serialized `tree` (so re-import restores
// the structure without rebalancing — §8) plus a flat `people` mirror and config.
function buildExportPayload({ tree, people, span, pins, flags }) {
  return {
    format: "pel-map",
    version: 1,
    tree: tree ?? null,
    people: people ?? [],
    span: span ? { ...span } : { ...DEFAULT_SPAN },
    pins: Array.isArray(pins) ? pins.map((p) => ({ ...p })) : [],
    flags: normalizeFlags(flags),
  };
}

function exportJson({ filename, minified }) {
  const root = state.result?.root ?? null;
  const name = safeFilename(filename, "people.json", ".json");
  state.exportPrefs.json = { filename: name, minified: !!minified };
  const payload = buildExportPayload({
    tree: serializeTree(root),
    people: root ? toPeople(root) : state.people,
    span: state.span,
    pins: state.pins,
    flags: state.flags,
  });
  const json = JSON.stringify(payload, null, minified ? 0 : 2);
  const blob = new Blob([json], { type: "application/json" });
  triggerDownload(blob, name);
  persist();
  flash(`Exported ${name}.`, "ok");
}

function canvasColor() {
  try {
    const c = getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim();
    return c || "#ffffff";
  } catch { return "#ffffff"; }
}

async function exportImage({ filename, background, scale, format }) {
  if (!state.result?.root) return flash("Nothing to export yet.", "warn");
  const view = state.view === "list" ? "list" : "tree";
  const ext = format === "svg" ? ".svg" : ".png";
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = safeFilename(filename, `org-${view}-${stamp}${ext}`, ext);
  let bg = "#ffffff";
  if (background === "transparent") bg = "transparent";
  else if (background === "canvas") bg = canvasColor();
  const exportScale = Number(scale) || 2;
  state.exportPrefs.image = {
    filename: filename?.trim() || "",
    background: background || "white",
    scale: exportScale,
    format: format === "svg" ? "svg" : "png",
  };
  persist();
  try {
    const treeEl = byId("tree");
    if (format === "svg") await exportElementAsSvg(treeEl, { filename: name, background: bg });
    else await exportElementAsImage(treeEl, { filename: name, background: bg, scale: exportScale });
    flash(`Exported ${name}.`, "ok");
  } catch (err) {
    flash(`Image export failed: ${err?.message ?? err}`, "error");
  }
}

function safeFilename(name, fallback, ext) {
  let n = String(name || "").trim();
  if (!n) return fallback;
  n = n.replace(/[\\/:*?"<>|]+/g, "-");
  if (ext && !n.toLowerCase().endsWith(ext)) n += ext;
  return n;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Pins are created/removed directly in the tree/list (drag onto a leader, or
// toggle a connector's lock). Lock all / Unlock all manage them in bulk.

// Lock every current parent→child edge in the tree (pins them, so the whole
// structure is preserved on the next Auto-rebalance). Does not move anything.
function onLockAll() {
  if (!state.result?.root) return flash("Nothing to lock yet.", "warn");
  pushHistory();
  const pins = [];
  walk(state.result.root, (n) => {
    if (n.parentId) {
      const parent = findById(state.result.root, n.parentId);
      if (parent) pins.push({ parent: parent.person.name, child: n.person.name });
    }
  });
  state.pins = pins;
  refresh();
  flash(`Locked all ${pins.length} links.`, "ok");
}

function onUnlockAll() {
  if (!state.pins.length) return flash("There are no locked links.", "warn");
  pushHistory();
  const count = state.pins.length;
  state.pins = [];
  refresh();
  flash(`Unlocked all ${count} links.`, "ok");
}

function formatSnapTime(ms) {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return ""; }
}

function relativeTime(ms) {
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 45_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days} d ago`;
  return formatSnapTime(ms);
}
function snapshotNodeCount(snap) {
  const tree = snap?.state?.tree;
  if (!tree?.person) return Array.isArray(snap?.state?.people) ? snap.state.people.length : 0;

  let n = 0;
  const visit = (t) => {
    if (!t?.person) return;
    n += 1;
    (t.children || []).forEach(visit);
  };
  visit(tree);
  return n;
}

function exportSnapshotJson(snap) {
  if (!snap) return;
  const tree = snap.state?.tree && snap.state.tree.person ? snap.state.tree : null;
  const fallbackPeople = Array.isArray(snap.state?.people) ? snap.state.people : [];
  let people = fallbackPeople;
  if (tree) {
    try { people = toPeople(deserializeTree(tree)); }
    catch { people = fallbackPeople; }
  }
  const payload = buildExportPayload({
    tree,
    people,
    span: snap.state?.span,
    pins: snap.state?.pins,
    flags: snap.state?.flags,
  });
  const name = safeFilename(snap.name, "snapshot", ".json");
  triggerDownload(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), name);
  flash(`Exported "${snap.name}" as ${name}.`, "ok");
}

function discardChanges() {
  const snap = findSnapshot(state.activeSnapshotId);
  if (!snap) return flash("No active snapshot to revert to.", "warn");
  pushHistory();
  applyState(snap.state);
  state.activeSnapshotId = snap.id;
  refreshSnapshotUI();
  persist();
  flash(`Reverted to "${snap.name}".`, "ok");
}

function buildDirtyBanner() {
  const active = findSnapshot(state.activeSnapshotId);
  const banner = el("div", { class: "snap-dirty" });
  banner.appendChild(el("span", { class: "snap-dirty-dot", "aria-hidden": "true" }));
  banner.appendChild(el("span", { class: "snap-dirty-text" },
    active ? `Unsaved changes since "${active.name}"` : "Unsaved changes — not yet saved as a snapshot"));
  const acts = el("div", { class: "snap-dirty-actions" });
  if (active) acts.appendChild(actionBtn("Update", `Overwrite "${active.name}" with the current hierarchy`, () => updateActiveSnapshot()));
  acts.appendChild(actionBtn("Save as new", "Save the current hierarchy as a new snapshot", () => byId("snapshotName").focus()));
  if (active) acts.appendChild(actionBtn("Discard", "Revert to the active snapshot, dropping unsaved edits", () => discardChanges(), "snap-delete"));
  banner.appendChild(acts);
  return banner;
}

function refreshSnapshotUI() {
  const list = byId("snapshotList");
  if (!list) return;
  list.innerHTML = "";

  if (state.dirty && state.result?.root) list.appendChild(buildDirtyBanner());

  if (!state.snapshots.length) {
    list.appendChild(el("p", { class: "hint" }, "No snapshots yet. Save the current hierarchy to switch back to it later."));
    syncSaveButton();
    refreshCompareUI();
    return;
  }

  list.appendChild(el("p", { class: "snap-count" },
    `${state.snapshots.length} snapshot${state.snapshots.length === 1 ? "" : "s"}`));

  for (const snap of state.snapshots) {
    list.appendChild(buildSnapshotRow(snap));
  }
  if (state.snapshots.length === 1) {
    list.appendChild(el("p", { class: "hint snap-compare-hint" }, "Save a second snapshot to unlock Compare changes."));
  }
  syncSaveButton();
  refreshCompareUI();
}

function buildSnapshotRow(snap) {
  const isActive = snap.id === state.activeSnapshotId;
  const isDraft = snap.name === WORKING_DRAFT_NAME;
  const head = state.renamingId === snap.id
    ? buildSnapshotRenameHead(snap)
    : buildSnapshotDisplayHead(snap, buildSnapshotBadges(isActive, isDraft));

  return el("div", { class: `snap-row${isActive ? " active" : ""}${isDraft ? " draft" : ""}` }, [
    head,
    buildSnapshotActions(snap, isActive),
  ]);
}

function buildSnapshotBadges(isActive, isDraft) {
  const badges = [];
  if (isActive) {
    badges.push(el("span", { class: `snap-badge${state.dirty ? " modified" : ""}` }, state.dirty ? "active • modified" : "active"));
  }
  if (isDraft) {
    badges.push(el("span", { class: "snap-badge draft", title: "Auto-saved backup of your unsaved work when you switch snapshots" }, "auto backup"));
  }
  return badges;
}

function buildSnapshotRenameHead(snap) {
  const input = el("input", { type: "text", class: "snap-rename-input", value: snap.name, "aria-label": "Snapshot name" });
  let done = false;
  const commit = () => {
    if (done) return;
    done = true;
    state.renamingId = null;
    const val = input.value.trim();
    if (!val || val === snap.name) refreshSnapshotUI();
    else renameSnapshot(snap.id, val);
  };
  const cancel = () => { if (done) return; done = true; state.renamingId = null; refreshSnapshotUI(); };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return el("div", { class: "snap-head" }, [input]);
}

function buildSnapshotDisplayHead(snap, badges) {
  const nameBtn = el("button", { type: "button", class: "snap-name", title: "Switch to this snapshot" }, snap.name);
  nameBtn.addEventListener("click", () => switchSnapshot(snap.id));
  const timeLabel = el("span", { class: "snap-time", title: formatSnapTime(snap.updatedAt) }, relativeTime(snap.updatedAt));
  const countLabel = el("span", { class: "snap-nodecount", title: "People in this snapshot" }, `${snapshotNodeCount(snap)} ppl`);
  const meta = el("div", { class: "snap-meta" }, [...badges, countLabel, timeLabel]);
  return el("div", { class: "snap-head" }, [nameBtn, meta]);
}

function buildSnapshotActions(snap, isActive) {
  return el("div", { class: "snap-actions" }, [
    isActive ? actionBtn("Update", "Overwrite this snapshot with the current hierarchy", () => updateActiveSnapshot()) : null,
    actionBtn("Rename", "Rename this snapshot", () => startRename(snap.id)),
    actionBtn("Export", "Download this snapshot's people as JSON", () => exportSnapshotJson(snap)),
    actionBtn("✕", "Delete this snapshot", () => confirmDeleteSnapshot(snap), "snap-delete"),
  ].filter(Boolean));
}

function startRename(id) {
  state.renamingId = id;
  refreshSnapshotUI();
}

function syncSaveButton() {
  const btn = byId("saveSnapshot");
  const input = byId("snapshotName");
  if (!btn || !input) return;
  btn.disabled = input.value.trim().length === 0;
}

function refreshCompareUI() {
  const wrap = byId("snapshotCompare");
  const fromSel = byId("diffFrom");
  const toSel = byId("diffTo");
  if (!wrap || !fromSel || !toSel) return;
  wrap.hidden = state.snapshots.length < 2;
  const ids = state.snapshots.map((s) => s.id);
  const keepFrom = fromSel.value;
  const keepTo = toSel.value;
  fillSnapshotOptions(fromSel);
  fillSnapshotOptions(toSel);
  fromSel.value = ids.includes(keepFrom) ? keepFrom : (ids[0] || "");
  toSel.value = ids.includes(keepTo) ? keepTo : (ids[ids.length - 1] || "");
}

function fillSnapshotOptions(sel) {
  sel.innerHTML = "";
  for (const s of state.snapshots) sel.appendChild(el("option", { value: s.id }, s.name));
}

function onCompareSnapshots() {
  const a = findSnapshot(byId("diffFrom").value);
  const b = findSnapshot(byId("diffTo").value);
  if (!a || !b) return flash("Pick two snapshots to compare.", "warn");
  openDiff(a, b);
}

function openDiff(a, b) {
  const summaryPane = byId("diffSummaryPane");
  const treePane = byId("diffTreePane");
  summaryPane.innerHTML = "";
  treePane.innerHTML = "";
  summaryPane.appendChild(renderSnapshotDiff(diffSnapshots(a, b), { aName: a.name, bName: b.name }));
  treePane.appendChild(renderDiffTree(buildDiffTree(a, b), { aName: a.name, bName: b.name }));
  wireDiffTree(treePane);
  setDiffTab("summary");
  openModal("diff", {
    initialFocus: "#diffClose",
    onClose: () => {
      byId("diffSummaryPane").innerHTML = "";
      byId("diffTreePane").innerHTML = "";
      setDiffTab("summary");
    },
  });
}

// Pan + zoom for the visual diff tree — reuses the main canvas model: the
// generic `wirePan` for drag-to-pan and the shared `--zoom` custom property that
// `.tree` reads. Wired fresh on each open (the pane's DOM is rebuilt each time).
const diffZoom = { value: 100, min: 40, max: 150 };
function wireDiffTree(pane) {
  const viewport = pane.querySelector(".diff-tree-viewport");
  if (!viewport) return;
  const range = pane.querySelector(".diff-zoom-range");
  const label = pane.querySelector(".diff-zoom-label");

  diffZoom.value = 100;
  const apply = () => {
    viewport.style.setProperty("--zoom", String(diffZoom.value / 100));
    if (label) label.textContent = `${diffZoom.value}%`;
    if (range) range.value = String(diffZoom.value);
  };
  const setZ = (v) => {
    diffZoom.value = Math.min(diffZoom.max, Math.max(diffZoom.min, Math.round(v)));
    apply();
  };

  pane.querySelector(".diff-zoom-in")?.addEventListener("click", () => setZ(diffZoom.value + 10));
  pane.querySelector(".diff-zoom-out")?.addEventListener("click", () => setZ(diffZoom.value - 10));
  pane.querySelector(".diff-zoom-reset")?.addEventListener("click", () => setZ(100));
  range?.addEventListener("input", (e) => setZ(parseInt(e.target.value, 10)));
  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZ(diffZoom.value + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });

  wirePan(viewport);
  apply();
}

function setDiffTab(which) {
  const isTree = which === "tree";
  const tabSummary = byId("diffTabSummary");
  const tabTree = byId("diffTabTree");
  const paneSummary = byId("diffSummaryPane");
  const paneTree = byId("diffTreePane");
  if (!tabSummary || !tabTree) return;
  tabSummary.classList.toggle("is-active", !isTree);
  tabTree.classList.toggle("is-active", isTree);
  tabSummary.setAttribute("aria-selected", String(!isTree));
  tabTree.setAttribute("aria-selected", String(isTree));
  paneSummary.hidden = isTree;
  paneTree.hidden = !isTree;
}

function closeDiff() {
  closeModal("diff");
}

// A small helper generalizing the old setModal: it shows `<name>Modal` +
// `<name>Backdrop`, traps Tab focus inside the dialog, restores focus to the
// opener on close, and stacks so Esc closes the topmost. Used by the diff, help,
// export and confirm dialogs.
const WELCOME_KEY = "orgBalancer:welcomeSeen";
const modalStack = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapFocus(modal) {
  return (e) => {
    if (e.key !== "Tab") return;
    const items = [...modal.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
}

function openModal(name, { onClose, initialFocus } = {}) {
  const modal = byId(`${name}Modal`);
  if (!modal) return;
  const backdrop = byId(`${name}Backdrop`);
  const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const handler = trapFocus(modal);
  modal.addEventListener("keydown", handler);
  modalStack.push({ name, modal, backdrop, restore, handler, onClose });
  modal.hidden = false;
  if (backdrop) backdrop.hidden = false;
  const focusTarget = (initialFocus && modal.querySelector(initialFocus)) || modal.querySelector(FOCUSABLE) || modal;
  setTimeout(() => focusTarget.focus?.(), 0);
}

function closeModal(name) {
  const idx = name ? modalStack.map((e) => e.name).lastIndexOf(name) : modalStack.length - 1;
  if (idx < 0) return;
  const [entry] = modalStack.splice(idx, 1);
  entry.modal.removeEventListener("keydown", entry.handler);
  entry.modal.hidden = true;
  if (entry.backdrop) entry.backdrop.hidden = true;
  entry.onClose?.();
  entry.restore?.focus?.();
}

function isModalOpen() { return modalStack.length > 0; }

function closeTopModal() { if (modalStack.length) closeModal(modalStack[modalStack.length - 1].name); }
function confirmDialog(spec = {}) {
  return new Promise((resolve) => {
    const host = byId("confirmModal");
    host.innerHTML = "";
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; closeModal("confirm"); resolve(val); };
    host.appendChild(buildConfirmDialog({
      ...spec,
      onConfirm: () => finish(true),
      onCancel: () => finish(false),
    }));
    openModal("confirm", {
      onClose: () => { if (!settled) { settled = true; resolve(false); } },
      initialFocus: spec.danger ? ".confirm-cancel" : ".confirm-ok",
    });
  });
}
function promptFlagComment(name, initial = "") {
  return new Promise((resolve) => {
    const host = byId("confirmModal");
    host.innerHTML = "";
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; closeModal("confirm"); resolve(val); };
    const input = el("textarea", {
      class: "inl-input flag-comment-input",
      rows: "3",
      placeholder: "Optional note shown in the overview…",
    });
    input.value = initial;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(input.value); }
    });
    const body = el("div", { class: "flag-comment-field" }, [
      el("p", { class: "confirm-msg-lead" }, `Add a note for the flag on ${name} (optional):`),
      input,
    ]);
    host.appendChild(buildConfirmDialog({
      title: `Flag ${name}`,
      message: body,
      confirmLabel: "Save flag",
      cancelLabel: "Cancel",
      onConfirm: () => finish(input.value),
      onCancel: () => finish(null),
    }));
    openModal("confirm", {
      onClose: () => { if (!settled) { settled = true; resolve(null); } },
      initialFocus: ".flag-comment-input",
    });
  });
}

function openHelp() {
  dismissWelcome();
  openModal("help", { initialFocus: "#helpClose" });
}
function closeHelp() {
  closeModal("help");
}

function dismissWelcome() {
  byId("welcomeHint").hidden = true;
  try { localStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
}
function maybeShowWelcome() {
  let seen = false;
  try { seen = localStorage.getItem(WELCOME_KEY) === "1"; } catch { /* ignore */ }
  if (!seen) byId("welcomeHint").hidden = false;
}


function actionBtn(label, title, onClick, extraClass = "") {
  const b = el("button", { type: "button", class: `snap-btn ${extraClass}`.trim(), title }, label);
  b.addEventListener("click", onClick);
  return b;
}

function onSaveSnapshot() {
  saveSnapshot(byId("snapshotName").value);
}

function togglePanel() {
  const layout = byId("layout");
  const collapsed = layout.classList.toggle("collapsed");
  const btn = byId("togglePanel");
  btn.textContent = collapsed ? "Controls ›" : "‹ Hide";
  btn.setAttribute("aria-expanded", String(!collapsed));
  persist();
}

function wirePan(viewport) {
  let panning = false;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  let startTop = 0;
  let pointerId = null;

  viewport.addEventListener("pointerdown", (e) => {
    // Left-drag on empty canvas pans; left-drag on a card is reserved for
    // re-parenting. Middle-button pans anywhere.
    const onCard = e.target.closest?.(".card");
    if (e.button === 0 && onCard) return;
    if (e.button !== 0 && e.button !== 1) return;
    panning = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = viewport.scrollLeft;
    startTop = viewport.scrollTop;
    viewport.classList.add("panning");
    try { viewport.setPointerCapture(pointerId); } catch { /* ignore */ }
    e.preventDefault();
  });

  viewport.addEventListener("pointermove", (e) => {
    if (!panning) return;
    viewport.scrollLeft = startLeft - (e.clientX - startX);
    viewport.scrollTop = startTop - (e.clientY - startY);
  });

  const end = () => {
    if (!panning) return;
    panning = false;
    viewport.classList.remove("panning");
    try { viewport.releasePointerCapture(pointerId); } catch { /* ignore */ }
  };
  viewport.addEventListener("pointerup", end);
  viewport.addEventListener("pointercancel", end);
}

// Center the tree canvas in its viewport (the canvas has generous padding so
// there's room to pan in every direction). Called after a fresh layout — load
// and Auto-rebalance — never on an in-place edit, so editing won't jump the view.
function centerViewport() {
  const viewport = document.querySelector(".tree-viewport");
  if (!viewport) return;
  requestAnimationFrame(() => {
    viewport.scrollLeft = Math.max(0, (viewport.scrollWidth - viewport.clientWidth) / 2);
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2);
  });
}

// Miro-style edge auto-scroll while dragging a node near the viewport edges.
function wireDragAutoScroll(viewport) {
  const edgeScrollZonePx = 70;
  const maxScrollStepPx = 24;
  let vx = 0, vy = 0;
  let raf = null;

  const speed = (dist) => Math.min(maxScrollStepPx, Math.max(3, (dist / edgeScrollZonePx) * maxScrollStepPx));
  const step = () => {
    if (vx === 0 && vy === 0) { raf = null; return; }
    viewport.scrollLeft += vx;
    viewport.scrollTop += vy;
    raf = requestAnimationFrame(step);
  };
  const ensureLoop = () => { if (!raf) raf = requestAnimationFrame(step); };
  const stop = () => { vx = 0; vy = 0; };

  viewport.addEventListener("dragover", (e) => {
    // Allow dropping over empty canvas and get a continuous pointer position.
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    const x = e.clientX, y = e.clientY;
    vx = 0; vy = 0;
    if (x < r.left + edgeScrollZonePx) vx = -speed(r.left + edgeScrollZonePx - x);
    else if (x > r.right - edgeScrollZonePx) vx = speed(x - (r.right - edgeScrollZonePx));
    if (y < r.top + edgeScrollZonePx) vy = -speed(r.top + edgeScrollZonePx - y);
    else if (y > r.bottom - edgeScrollZonePx) vy = speed(y - (r.bottom - edgeScrollZonePx));
    if (vx || vy) ensureLoop();
  });
  viewport.addEventListener("drop", stop);
  viewport.addEventListener("dragend", stop, true);
  viewport.addEventListener("dragleave", (e) => {
    if (pointerOutsideWindow(e)) stop();
  });
  document.addEventListener("dragend", stop);
}

function pointerOutsideWindow(e) {
  return e.clientX <= 0 || e.clientY <= 0 || e.clientX >= window.innerWidth || e.clientY >= window.innerHeight;
}

// `min` is intentionally low so the user can zoom far out (fit a whole large
// tree on screen); `Fit` computes the exact zoom that frames all content.
const zoom = { value: 100, min: 5, max: 150 };
function applyZoom() {
  const tree = byId("tree");
  tree.style.setProperty("--zoom", String(zoom.value / 100));
  byId("zoomLabel").textContent = `${zoom.value}%`;
  byId("zoomRange").value = String(zoom.value);
}
function setZoom(v) {
  zoom.value = Math.min(zoom.max, Math.max(zoom.min, Math.round(v)));
  applyZoom();
  persist();
}
function contentScreenSize() {
  const tree = byId("tree");
  if (!tree) return null;
  const nodes = tree.querySelectorAll(".card, .list-row, .loc-box");
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.right);
    maxY = Math.max(maxY, r.bottom);
  }
  if (!Number.isFinite(minX)) return null;
  return { w: maxX - minX, h: maxY - minY };
}
function fitZoomPercent() {
  const viewport = document.querySelector(".tree-viewport");
  const size = contentScreenSize();
  if (!viewport || !size || size.w === 0 || size.h === 0) return null;
  const availW = viewport.clientWidth;
  const availH = viewport.clientHeight;
  if (!availW || !availH) return null;
  const fitMargin = 0.92;
  const currentFactor = zoom.value / 100;
  const targetFactor = currentFactor * Math.min(availW / size.w, availH / size.h) * fitMargin;
  const pct = Math.floor(targetFactor * 100);
  return Math.max(zoom.min, Math.min(100, pct));
}

function zoomToFit() {
  const pct = fitZoomPercent();
  if (pct == null) return flash("Nothing to fit yet.", "warn");
  setZoom(pct);
  centerViewport();
}

let flashTimer;
function flash(message, kind = "ok") {
  const box = byId("flash");
  const icon = kind === "error" || kind === "warn" ? "!" : "✓";
  box.innerHTML = "";
  box.appendChild(el("span", { class: "flash-icon", "aria-hidden": "true" }, icon));
  box.appendChild(el("span", { class: "flash-text" }, message));
  box.className = `flash ${kind} show`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => box.classList.remove("show"), 4000);
}

function wire() {
  wirePrimaryControls();
  wireSnapshotControls();
  wireDiffControls();
  wireHelpAndPanelControls();
  wireViewControls();
  wirePopupAndShortcuts();
  wireZoomControls();
  wireViewportControls();
  restoreInitialState();
  maybeShowWelcome();
}

function wirePrimaryControls() {
  byId("file").addEventListener("change", onFile);
  byId("tree").addEventListener("click", onEmptyStateAction);
  byId("spanMin").addEventListener("change", onSpanChange);
  byId("spanMax").addEventListener("change", onSpanChange);
  byId("undo").addEventListener("click", onUndo);
  byId("redo").addEventListener("click", onRedo);
  byId("export").addEventListener("click", openExportDialog);
  byId("lockAll").addEventListener("click", onLockAll);
  byId("unlockAll").addEventListener("click", onUnlockAll);
}

function wireSnapshotControls() {
  byId("saveSnapshot").addEventListener("click", onSaveSnapshot);
  byId("snapshotName").addEventListener("keydown", (e) => { if (e.key === "Enter") onSaveSnapshot(); });
  byId("snapshotName").addEventListener("input", syncSaveButton);
}

function wireDiffControls() {
  byId("compareSnapshots").addEventListener("click", onCompareSnapshots);
  byId("diffClose").addEventListener("click", closeDiff);
  byId("diffBackdrop").addEventListener("click", closeDiff);
  byId("diffTabSummary").addEventListener("click", () => setDiffTab("summary"));
  byId("diffTabTree").addEventListener("click", () => setDiffTab("tree"));
}

function wireHelpAndPanelControls() {
  byId("helpBtn").addEventListener("click", openHelp);
  byId("helpClose").addEventListener("click", closeHelp);
  byId("helpBackdrop").addEventListener("click", closeHelp);
  byId("welcomeDismiss").addEventListener("click", dismissWelcome);
  byId("togglePanel").addEventListener("click", togglePanel);
  byId("addPerson").addEventListener("click", () => onStartAdd(null));
}

function wireViewControls() {
  byId("viewTree").addEventListener("click", () => setView("tree"));
  byId("viewList").addEventListener("click", () => setView("list"));
  byId("expandAll").addEventListener("click", () => setAllCollapsed(false));
  byId("collapseAll").addEventListener("click", () => setAllCollapsed(true));
}

function wirePopupAndShortcuts() {
  byId("popupBackdrop").addEventListener("click", closePopup);
  document.addEventListener("keydown", onGlobalKeydown);
}

function onGlobalKeydown(e) {
  if (e.key === "Escape") { closePopup(); closeTopModal(); return; }

  const typing = eventTargetIsTyping(e.target);
  const mod = e.ctrlKey || e.metaKey;
  const plain = !mod && !e.altKey;
  if (mod && !typing && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) onRedo(); else onUndo();
    return;
  }
  if (mod && !typing && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    onRedo();
    return;
  }

  if (e.key === "?" && !typing && plain) {
    e.preventDefault();
    openHelp();
    return;
  }

  if ((e.key === "a" || e.key === "A") && plain) {
    const popupOpen = !byId("inlinePopup").hidden || isModalOpen();
    if (!typing && !popupOpen) {
      e.preventDefault();
      onStartAdd(null);
    }
  }
}

function eventTargetIsTyping(target) {
  return !!(target && (target.matches?.("input, textarea, select") || target.isContentEditable));
}

function wireZoomControls() {
  byId("zoomIn").addEventListener("click", () => setZoom(zoom.value + 10));
  byId("zoomOut").addEventListener("click", () => setZoom(zoom.value - 10));
  byId("zoomFit").addEventListener("click", zoomToFit);
  byId("zoomReset").addEventListener("click", () => setZoom(100));
  byId("exportBackdrop").addEventListener("click", () => closeModal("export"));
  byId("confirmBackdrop").addEventListener("click", () => closeModal("confirm"));
  byId("zoomRange").addEventListener("input", (e) => setZoom(parseInt(e.target.value, 10)));
}

function wireViewportControls() {
  const viewport = document.querySelector(".tree-viewport");
  viewport.addEventListener("wheel", (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(zoom.value + (e.deltaY < 0 ? 5 : -5));
  }, { passive: false });
  wirePan(viewport);
  wireDragAutoScroll(viewport);
}

function restoreInitialState() {
  const saved = loadPersisted();
  const restoredTree = saved ? applyPersistedState(saved) : null;

  syncControlValues();

  if (!saved) {
    // First run — nothing persisted. Render the empty state; the user uploads data.
    buildFromPeople();
    return;
  }

  if (restoredTree) {
    state.result = resultFor(restoredTree);
    present();
    centerViewport();
  } else {
    buildFromPeople();
  }
  flash(`Restored ${state.people.length} people from your last session.`, "ok");
}

function applyPersistedState(saved) {
  restoreSavedSpan(saved);
  restoreSavedCollections(saved);
  restoreSavedExportPrefs(saved);
  restoreSavedView(saved);
  restoreSavedPanelState(saved);
  return restoreSavedTreeOrPeople(saved);
}

function restoreSavedSpan(saved) {
  const { span } = saved;
  if (span && Number.isFinite(span.min) && Number.isFinite(span.max)) {
    state.span = { min: span.min, max: span.max };
  }
}

function restoreSavedCollections(saved) {
  if (Array.isArray(saved.pins)) state.pins = saved.pins.filter((p) => p && p.parent && p.child);
  if (Array.isArray(saved.flags)) state.flags = normalizeFlags(saved.flags);
  if (Array.isArray(saved.snapshots)) state.snapshots = saved.snapshots;
  state.activeSnapshotId = typeof saved.activeSnapshotId === "string" ? saved.activeSnapshotId : null;
}

function restoreSavedExportPrefs(saved) {
  if (!saved.exportPrefs || typeof saved.exportPrefs !== "object") return;
  const { json, image } = saved.exportPrefs;
  if (json && typeof json === "object") {
    state.exportPrefs.json = {
      filename: typeof json.filename === "string" ? json.filename : state.exportPrefs.json.filename,
      minified: !!json.minified,
    };
  }
  if (image && typeof image === "object") {
    const bg = ["white", "transparent", "canvas"].includes(image.background) ? image.background : "white";
    const fmt = image.format === "svg" ? "svg" : "png";
    const scale = Number(image.scale);
    state.exportPrefs.image = {
      filename: typeof image.filename === "string" ? image.filename : "",
      background: bg,
      scale: [1, 2, 3].includes(scale) ? scale : 2,
      format: fmt,
    };
  }
}

function restoreSavedView(saved) {
  if (Number.isFinite(saved.zoom)) zoom.value = saved.zoom;
  if (saved.view === "list" || saved.view === "tree") state.view = saved.view;
  if (Array.isArray(saved.collapsed)) {
    state.collapsed = new Set(saved.collapsed.filter((n) => typeof n === "string"));
  }
}

function restoreSavedPanelState(saved) {
  const panelCollapsed = typeof saved.collapsedPanel === "boolean"
    ? saved.collapsedPanel
    : saved.collapsed === true;
  if (panelCollapsed) {
    const layout = byId("layout");
    layout.classList.add("collapsed");
    const btn = byId("togglePanel");
    btn.textContent = "Controls ›";
    btn.setAttribute("aria-expanded", "false");
  }
}

function restoreSavedTreeOrPeople(saved) {
  if (saved.tree && saved.tree.person) {
    // Restore the exact saved structure — no rebalance.
    return deserializeTree(saved.tree);
  }
  const { people } = validatePeople(Array.isArray(saved.people) ? saved.people : []);
  state.people = people;
  return null;
}

function syncControlValues() {
  syncSpanInputs();
  applyZoom();
}

wire();
