// Node test runner (no deps): run with `node --test test/diff.test.mjs`
import { test } from "node:test";
import assert from "node:assert/strict";

import { diffSnapshots, buildDiffTree } from "../src/diff.js";
import { makeSnapshot } from "../src/snapshots.js";

function snap(name, people, extra = {}) {
  return makeSnapshot(name, {
    people,
    span: extra.span || { min: 3, max: 8 },
    pins: extra.pins || [],
    flags: extra.flags || [],
  });
}

// A small org that builds cleanly: 1 VP, 1 HO, a couple of stream ICs.
function baseOrg() {
  return [
    { name: "Ada", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Bjorn", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Cara", isPeopleLeader: false, role: "SE", location: "VIE", level: 2 },
    { name: "Dora", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
  ];
}

test("identical snapshots produce an empty diff", () => {
  const a = snap("A", baseOrg());
  const b = snap("B", baseOrg());
  const d = diffSnapshots(a, b);
  assert.equal(d.empty, true);
  assert.equal(d.people.added.length, 0);
  assert.equal(d.people.removed.length, 0);
  assert.equal(d.people.changed.length, 0);
  assert.equal(d.reporting.changed.length, 0);
  assert.equal(d.counts.configChanged, false);
});

test("people added and removed are detected by name", () => {
  const before = baseOrg();
  const after = baseOrg().filter((p) => p.name !== "Dora");
  after.push({ name: "Eli", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 });
  const d = diffSnapshots(snap("A", before), snap("B", after));
  assert.deepEqual(d.people.added.map((p) => p.name), ["Eli"]);
  assert.deepEqual(d.people.removed.map((p) => p.name), ["Dora"]);
  assert.equal(d.empty, false);
});

test("attribute change surfaces per-field before/after incl. derived BU on relocation", () => {
  const before = baseOrg();
  const after = baseOrg().map((p) =>
    p.name === "Cara" ? { ...p, location: "KAR", level: 3, role: "SE" } : p
  );
  const d = diffSnapshots(snap("A", before), snap("B", after));
  const cara = d.people.changed.find((c) => c.name === "Cara");
  assert.ok(cara, "Cara should be reported as changed");
  const loc = cara.fields.find((f) => f.field === "location");
  assert.equal(loc.before, "VIE");
  assert.equal(loc.after, "KAR");
  assert.equal(loc.beforeBu, "AT");
  assert.equal(loc.afterBu, "DE");
  const lvl = cara.fields.find((f) => f.field === "level");
  assert.equal(lvl.before, 2);
  assert.equal(lvl.after, 3);
});

test("level falls back to 1 via levelOf when unset (no false change)", () => {
  const before = baseOrg().map((p) => (p.name === "Dora" ? { name: "Dora", isPeopleLeader: false, role: "TA", location: "VIE" } : p));
  const after = baseOrg().map((p) => (p.name === "Dora" ? { ...p, level: 1 } : p));
  const d = diffSnapshots(snap("A", before), snap("B", after));
  assert.equal(d.people.changed.find((c) => c.name === "Dora"), undefined);
});

test("config diff reports span, pins and flags changes", () => {
  const a = snap("A", baseOrg(), { span: { min: 3, max: 8 }, pins: [], flags: [] });
  const b = snap("B", baseOrg(), {
    span: { min: 2, max: 6 },
    pins: [{ parent: "Bjorn", child: "Cara" }],
    flags: ["Ada"],
  });
  const d = diffSnapshots(a, b);
  assert.equal(d.config.span.changed, true);
  assert.deepEqual(d.config.span.after, { min: 2, max: 6 });
  assert.deepEqual(d.config.pins.added, [{ parent: "Bjorn", child: "Cara" }]);
  assert.equal(d.config.pins.removed.length, 0);
  assert.deepEqual(d.config.flags.added, ["Ada"]);
  assert.equal(d.counts.configChanged, true);
});

test("reporting diff detects a manager change from a pin", () => {
  // Two HOs; pin Cara under the second HO in B so her manager changes.
  const people = [
    { name: "Ada", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Bjorn", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Cara", isPeopleLeader: false, role: "SE", location: "VIE", level: 2 },
  ];
  const a = snap("A", people);
  const b = snap("B", people, { pins: [{ parent: "Ada", child: "Cara" }] });
  const d = diffSnapshots(a, b);
  const move = d.reporting.changed.find((r) => r.name === "Cara");
  assert.ok(move, "Cara's reporting line should change");
  assert.equal(move.after, "Ada");
  assert.notEqual(move.before, "Ada");
});

test("counts and empty flag reflect the aggregate change set", () => {
  const before = baseOrg();
  const after = baseOrg().map((p) => (p.name === "Cara" ? { ...p, role: "TA", level: 1 } : p));
  const d = diffSnapshots(snap("A", before), snap("B", after));
  assert.equal(d.empty, false);
  assert.equal(d.counts.changed, 1);
});

// ---- buildDiffTree (visual tree) ----

/** Find the first annotated node with a given name (depth-first). */
function findDiffNode(node, name) {
  if (!node) return undefined;
  if (node.person && node.person.name === name) return node;
  for (const c of node.children ?? []) {
    const hit = findDiffNode(c, name);
    if (hit) return hit;
  }
  return undefined;
}

test("buildDiffTree: identical snapshots yield all-unchanged, no ghosts", () => {
  const { tree, counts } = buildDiffTree(snap("A", baseOrg()), snap("B", baseOrg()));
  assert.ok(tree, "tree should exist");
  let removed = 0;
  let nonUnchanged = 0;
  const walkT = (n) => {
    if (n.status === "removed") removed += 1;
    if (n.status !== "unchanged") nonUnchanged += 1;
    (n.children ?? []).forEach(walkT);
  };
  walkT(tree);
  assert.equal(removed, 0);
  assert.equal(nonUnchanged, 0);
  assert.deepEqual(counts, { added: 0, removed: 0, changed: 0, moved: 0 });
});

test("buildDiffTree: an added person is flagged 'added'", () => {
  const after = baseOrg();
  after.push({ name: "Eli", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 });
  const { tree, counts } = buildDiffTree(snap("A", baseOrg()), snap("B", after));
  const eli = findDiffNode(tree, "Eli");
  assert.ok(eli, "Eli should be in the diff tree");
  assert.equal(eli.status, "added");
  assert.equal(counts.added, 1);
});

test("buildDiffTree: a removed person appears as a ghost under its old manager", () => {
  const before = baseOrg();
  const after = baseOrg().filter((p) => p.name !== "Dora");
  const { tree, counts } = buildDiffTree(snap("A", before), snap("B", after));
  const dora = findDiffNode(tree, "Dora");
  assert.ok(dora, "removed Dora should still appear as a ghost");
  assert.equal(dora.status, "removed");
  assert.equal(counts.removed, 1);
  // Ghost hangs under Dora's former manager (Bjorn, the HO in the sample build).
  const bjorn = findDiffNode(tree, "Bjorn");
  assert.ok(bjorn.children.some((c) => c.person.name === "Dora"), "ghost sits under old manager");
});

test("buildDiffTree: an attribute change is flagged 'changed' with field deltas", () => {
  const before = baseOrg();
  const after = baseOrg().map((p) => (p.name === "Cara" ? { ...p, location: "KAR", level: 3 } : p));
  const { tree, counts } = buildDiffTree(snap("A", before), snap("B", after));
  const cara = findDiffNode(tree, "Cara");
  assert.ok(cara);
  assert.equal(cara.status, "changed");
  assert.ok(cara.changes.find((f) => f.field === "location"), "location delta present");
  assert.ok(cara.changes.find((f) => f.field === "level"), "level delta present");
  assert.equal(counts.changed, 1);
});

test("buildDiffTree: a manager change is flagged 'moved' with movedFrom", () => {
  const people = [
    { name: "Ada", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Bjorn", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Cara", isPeopleLeader: false, role: "SE", location: "VIE", level: 2 },
  ];
  const a = snap("A", people);
  const b = snap("B", people, { pins: [{ parent: "Ada", child: "Cara" }] });
  const { tree, counts } = buildDiffTree(a, b);
  const cara = findDiffNode(tree, "Cara");
  assert.ok(cara);
  assert.equal(cara.status, "moved");
  assert.notEqual(cara.movedFrom, "Ada");
  assert.equal(counts.moved, 1);
  // Cara now hangs directly under Ada in the after-tree.
  const ada = findDiffNode(tree, "Ada");
  assert.ok(ada.children.some((c) => c.person.name === "Cara"));
});
