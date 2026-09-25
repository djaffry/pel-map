import { DEFAULT_SPAN } from "./model.js";

export const WORKING_DRAFT_NAME = "Working draft";

let idCounter = 0;

export function newSnapshotId() {
  idCounter += 1;
  return `snap-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

export function cloneState(state) {
  const s = state || {};
  return {
    people: clonePeople(s.people),
    span: cloneSpan(s.span),
    pins: clonePins(s.pins),
    flags: normalizeFlags(s.flags),
    tree: cloneTree(s.tree),
  };
}

export function normalizeFlags(raw) {
  return Array.isArray(raw) ? raw.map(normalizeFlag).filter(Boolean) : [];
}

export function makeSnapshot(name, state, opts = {}) {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? newSnapshotId(),
    name: String(name ?? "").trim() || "Untitled",
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
    state: cloneState(state),
  };
}

export function restoreState(snapshot) {
  return cloneState(snapshot?.state || {});
}

export function sanitizeSnapshots(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeSnapshotRecord).filter(Boolean);
}

export function migratePersisted(current, legacy) {
  const src = current || legacy;
  if (!src) return null;
  return {
    ...src,
    snapshots: sanitizeSnapshots(src.snapshots),
    activeSnapshotId: typeof src.activeSnapshotId === "string" ? src.activeSnapshotId : null,
  };
}

function clonePeople(people) {
  return Array.isArray(people) ? people.map((p) => ({ ...p })) : [];
}

function cloneSpan(span) {
  if (span && Number.isFinite(span.min) && Number.isFinite(span.max)) {
    return { min: span.min, max: span.max };
  }
  return { ...DEFAULT_SPAN };
}

function clonePins(pins) {
  if (!Array.isArray(pins)) return [];
  return pins
    .filter((p) => p && p.parent && p.child)
    .map((p) => ({ parent: p.parent, child: p.child }));
}

function cloneTree(tree) {
  if (!tree || typeof tree !== "object" || !tree.person) return null;
  return {
    person: { ...tree.person },
    children: Array.isArray(tree.children) ? tree.children.map(cloneTree).filter(Boolean) : [],
  };
}

function normalizeFlag(f) {
  if (typeof f === "string") return f ? { name: f } : null;
  if (f && typeof f === "object" && typeof f.name === "string" && f.name) {
    const comment = typeof f.comment === "string" ? f.comment.trim() : "";
    return comment ? { name: f.name, comment } : { name: f.name };
  }
  return null;
}

function sanitizeSnapshotRecord(s) {
  if (!s || typeof s !== "object") return null;
  if (typeof s.name !== "string" || !s.state) return null;
  const now = Date.now();
  return {
    id: typeof s.id === "string" && s.id ? s.id : newSnapshotId(),
    name: s.name.trim() || "Untitled",
    createdAt: Number.isFinite(s.createdAt) ? s.createdAt : now,
    updatedAt: Number.isFinite(s.updatedAt) ? s.updatedAt : now,
    state: cloneState(s.state),
  };
}
