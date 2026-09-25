import { buOf, levelOf } from "./model.js";
import { buildHierarchy } from "./balance.js";
import { walk, serializeTree } from "./tree.js";
import { cloneState } from "./snapshots.js";

export function diffSnapshots(aSnap, bSnap) {
  const aState = clonedSnapshotState(aSnap);
  const bState = clonedSnapshotState(bSnap);

  const people = diffPeople(peopleOf(aState), peopleOf(bState));
  const reporting = diffReporting(aState, bState);
  const config = diffConfig(aState, bState);

  const counts = diffCounts(people, reporting, config);
  const empty = diffIsEmpty(counts);

  return { people, reporting, config, counts, empty };
}

export function buildDiffTree(aSnap, bSnap) {
  const aState = clonedSnapshotState(aSnap);
  const bState = clonedSnapshotState(bSnap);
  const context = diffTreeContext(aState, bState);
  const counts = { added: 0, removed: 0, changed: 0, moved: 0 };

  const base = serializedTreeOf(bState);
  if (!base || !base.person) return missingAfterTree(context, counts);

  const tree = annotateAfterNode(base, context, counts);
  attachTopLevelOrphanGhosts(tree.children, context, counts);

  return { tree, counts };
}

const PERSON_FIELDS = ["role", "location", "isPeopleLeader", "level"];

function clonedSnapshotState(snapshot) {
  return cloneState(snapshot?.state ? snapshot.state : {});
}

function diffCounts(people, reporting, config) {
  const pinsChanged = config.pins.added.length > 0 || config.pins.removed.length > 0;
  const flagsChanged = config.flags.added.length > 0 || config.flags.removed.length > 0;

  return {
    added: people.added.length,
    removed: people.removed.length,
    changed: people.changed.length,
    reporting: reporting.changed.length,
    configChanged: config.span.changed || pinsChanged || flagsChanged,
  };
}

function diffIsEmpty(counts) {
  return (
    counts.added === 0 &&
    counts.removed === 0 &&
    counts.changed === 0 &&
    counts.reporting === 0 &&
    !counts.configChanged
  );
}

function diffPeople(aPeople, bPeople) {
  const a = byName(aPeople);
  const b = byName(bPeople);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [name, person] of b) if (!a.has(name)) added.push({ ...person });
  for (const [name, person] of a) if (!b.has(name)) removed.push({ ...person });
  for (const [name, before] of a) {
    const after = b.get(name);
    if (!after) continue;
    const fields = changedFields(before, after);
    if (fields.length) changed.push({ name, fields });
  }
  added.sort((x, y) => x.name.localeCompare(y.name));
  removed.sort((x, y) => x.name.localeCompare(y.name));
  changed.sort((x, y) => x.name.localeCompare(y.name));
  return { added, removed, changed };
}

function diffReporting(aState, bState) {
  const a = managerMap(aState);
  const b = managerMap(bState);
  const changed = [];
  for (const [name, beforeMgr] of a) {
    if (!b.has(name)) continue;
    const before = beforeMgr ?? null;
    const after = b.get(name) ?? null;
    if (before !== after) changed.push({ name, before, after });
  }
  changed.sort((x, y) => x.name.localeCompare(y.name));
  return { changed };
}

function diffConfig(aState, bState) {
  const span = {
    changed: aState.span.min !== bState.span.min || aState.span.max !== bState.span.max,
    before: { ...aState.span },
    after: { ...bState.span },
  };

  const pinKey = (p) => `${p.parent}\u0000${p.child}`;
  const aPins = new Map(aState.pins.map((p) => [pinKey(p), p]));
  const bPins = new Map(bState.pins.map((p) => [pinKey(p), p]));
  const pinsAdded = [];
  const pinsRemoved = [];
  for (const [k, p] of bPins) if (!aPins.has(k)) pinsAdded.push({ parent: p.parent, child: p.child });
  for (const [k, p] of aPins) if (!bPins.has(k)) pinsRemoved.push({ parent: p.parent, child: p.child });

  const aFlagNames = new Set(aState.flags.map((f) => f.name));
  const bFlagNames = new Set(bState.flags.map((f) => f.name));
  const flagsAdded = bState.flags.filter((f) => !aFlagNames.has(f.name)).map((f) => f.name);
  const flagsRemoved = aState.flags.filter((f) => !bFlagNames.has(f.name)).map((f) => f.name);

  return {
    span,
    pins: { added: pinsAdded, removed: pinsRemoved },
    flags: { added: flagsAdded, removed: flagsRemoved },
  };
}

function diffTreeContext(aState, bState) {
  const aMap = byName(peopleOf(aState));
  const bMap = byName(peopleOf(bState));
  const aMgr = managerMap(aState);
  const bMgr = managerMap(bState);
  const { removedNames, removedByManager } = removedPeopleByManager(aMap, bMap, aMgr);

  return { aMap, bMap, aMgr, bMgr, removedNames, removedByManager };
}

function missingAfterTree(context, counts) {
  const orphans = [];
  attachTopLevelOrphanGhosts(orphans, context, counts);
  return { tree: orphans.length ? { person: null, status: "root", children: orphans } : null, counts };
}

function annotateAfterNode(node, context, counts) {
  const person = node.person;
  const name = person.name;
  const before = context.aMap.get(name);

  let status = "unchanged";
  let changes = [];
  let movedFrom;
  let alsoMoved = false;

  if (!before) {
    status = "added";
    counts.added += 1;
  } else {
    const beforeManager = context.aMgr.get(name) ?? null;
    const afterManager = context.bMgr.get(name) ?? null;
    const moved = beforeManager !== afterManager;

    changes = changedFields(before, person);
    if (changes.length) {
      status = "changed";
      counts.changed += 1;
      if (moved) {
        alsoMoved = true;
        movedFrom = beforeManager;
        counts.moved += 1;
      }
    } else if (moved) {
      status = "moved";
      movedFrom = beforeManager;
      counts.moved += 1;
    }
  }

  const children = (node.children ?? []).map((child) => annotateAfterNode(child, context, counts));
  appendRemovedGhosts(children, name, context, counts);

  const out = { person: { ...person }, status, changes, children };
  if (alsoMoved) out.alsoMoved = true;
  if (movedFrom !== undefined) out.movedFrom = movedFrom;
  return out;
}

function appendRemovedGhosts(children, managerName, context, counts) {
  for (const person of context.removedByManager.get(managerName) ?? []) {
    children.push(removedGhost(person, context, counts));
  }
}

function attachTopLevelOrphanGhosts(children, context, counts) {
  for (const [mgr, people] of context.removedByManager) {
    if (mgr !== null && (context.bMap.has(mgr) || context.removedNames.has(mgr))) continue;
    for (const person of people) children.push(removedGhost(person, context, counts));
  }
}

function removedPeopleByManager(aMap, bMap, aMgr) {
  const removedNames = new Set();
  const removedByManager = new Map();
  for (const [name, person] of aMap) {
    if (bMap.has(name)) continue;
    removedNames.add(name);
    const mgr = aMgr.get(name) ?? null;
    if (!removedByManager.has(mgr)) removedByManager.set(mgr, []);
    removedByManager.get(mgr).push(person);
  }
  return { removedNames, removedByManager };
}

// Removed people become ghosts so visual diffs preserve deleted subtrees.
function removedGhost(person, context, counts) {
  counts.removed += 1;
  const kids = context.removedByManager.get(person.name) ?? [];
  return {
    person: { ...person },
    status: "removed",
    changes: [],
    movedFrom: null,
    children: kids.map((child) => removedGhost(child, context, counts)),
  };
}

function peopleOf(state) {
  if (state.tree && state.tree.person) {
    const out = [];
    eachSerialized(state.tree, (person) => out.push({ ...person }));
    return out;
  }
  return state.people;
}

function eachSerialized(tree, fn, parentName = null) {
  if (!tree || !tree.person) return;
  fn(tree.person, parentName);
  for (const c of tree.children ?? []) eachSerialized(c, fn, tree.person.name);
}

function byName(people) {
  const map = new Map();
  for (const p of people) map.set(p.name, p);
  return map;
}

function changedFields(before, after) {
  const fields = [];
  for (const field of PERSON_FIELDS) {
    const b = field === "level" ? levelOf(before) : before[field];
    const a = field === "level" ? levelOf(after) : after[field];
    if (b === a) continue;
    if (field === "location") {
      fields.push({ field, before: b, after: a, beforeBu: buOf(b), afterBu: buOf(a) });
    } else {
      fields.push({ field, before: b, after: a });
    }
  }
  return fields;
}

// Reporting lines come from each snapshot's stored tree; tree-less snapshots fall back to the balancer.
function managerMap(state) {
  const map = new Map();
  if (state.tree && state.tree.person) {
    eachSerialized(state.tree, (person, parentName) => map.set(person.name, parentName ?? null));
    return map;
  }
  const { root } = buildHierarchy(state.people, { span: state.span, pins: state.pins });
  if (!root) return map;
  const namesById = new Map();
  walk(root, (node) => namesById.set(node.id, node.person.name));
  walk(root, (node) => {
    const managerName = node.parentId ? (namesById.get(node.parentId) ?? null) : null;
    map.set(node.person.name, managerName);
  });
  return map;
}

function serializedTreeOf(state) {
  if (state.tree && state.tree.person) return state.tree;
  const { root } = buildHierarchy(state.people, { span: state.span, pins: state.pins });
  return serializeTree(root);
}
