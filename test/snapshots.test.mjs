// Node test runner (no deps): run with `node --test test/snapshots.test.mjs`
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeSnapshot,
  cloneState,
  restoreState,
  sanitizeSnapshots,
  migratePersisted,
  newSnapshotId,
  normalizeFlags,
  WORKING_DRAFT_NAME,
} from "../src/snapshots.js";
import { DEFAULT_SPAN } from "../src/model.js";

function sampleState() {
  return {
    people: [
      { name: "Ada", isPeopleLeader: true, role: "VP", location: "VIE" },
      { name: "Grace", isPeopleLeader: false, role: "SE", location: "KAR", level: 2 },
    ],
    span: { min: 3, max: 8 },
    pins: [{ parent: "Ada", child: "Grace" }],
    flags: [{ name: "Ada" }],
    tree: {
      person: { name: "Ada", isPeopleLeader: true, role: "VP", location: "VIE" },
      children: [
        { person: { name: "Grace", isPeopleLeader: false, role: "SE", location: "KAR", level: 2 }, children: [] },
      ],
    },
  };
}

test("cloneState deep-copies people, pins and flags (no shared refs)", () => {
  const src = sampleState();
  const clone = cloneState(src);
  assert.deepEqual(clone, src);
  assert.notEqual(clone.people, src.people);
  assert.notEqual(clone.people[0], src.people[0]);
  assert.notEqual(clone.pins, src.pins);
  assert.notEqual(clone.pins[0], src.pins[0]);
  assert.notEqual(clone.flags, src.flags);
  assert.notEqual(clone.span, src.span);
  // the serialized tree is deep-cloned too (no shared refs)
  assert.deepEqual(clone.tree, src.tree);
  assert.notEqual(clone.tree, src.tree);
  assert.notEqual(clone.tree.children[0], src.tree.children[0]);
});

test("cloneState falls back to DEFAULT_SPAN and empty arrays for malformed input", () => {
  const clone = cloneState({});
  assert.deepEqual(clone.span, { ...DEFAULT_SPAN });
  assert.deepEqual(clone.people, []);
  assert.deepEqual(clone.pins, []);
  assert.deepEqual(clone.flags, []);
  // bad pins/flags entries are dropped
  const clone2 = cloneState({ pins: [{ parent: "A" }, { parent: "A", child: "B" }], flags: ["ok", 5, null] });
  assert.deepEqual(clone2.pins, [{ parent: "A", child: "B" }]);
  assert.deepEqual(clone2.flags, [{ name: "ok" }]);
});

test("normalizeFlags migrates legacy names and keeps optional comments", () => {
  // Legacy bare strings become {name}; objects keep a trimmed comment; blank
  // comments are dropped; invalid entries are removed.
  assert.deepEqual(
    normalizeFlags(["Ada", { name: "Bo", comment: "  watch span  " }, { name: "Cy", comment: "   " }, { name: "" }, 5, null]),
    [{ name: "Ada" }, { name: "Bo", comment: "watch span" }, { name: "Cy" }]
  );
  assert.deepEqual(normalizeFlags(undefined), []);
  assert.deepEqual(normalizeFlags("nope"), []);
});

test("editing live state after save never mutates a stored snapshot", () => {
  const live = sampleState();
  const snap = makeSnapshot("baseline", live);
  // mutate the live objects
  live.people[0].name = "Changed";
  live.pins.push({ parent: "X", child: "Y" });
  live.flags.push("Changed");
  live.span.max = 99;
  assert.equal(snap.state.people[0].name, "Ada");
  assert.equal(snap.state.pins.length, 1);
  assert.deepEqual(snap.state.flags, [{ name: "Ada" }]);
  assert.equal(snap.state.span.max, 8);
});

test("restoreState yields a fresh, independent copy of the snapshot state", () => {
  const snap = makeSnapshot("baseline", sampleState());
  const restored = restoreState(snap);
  restored.people[0].name = "Mutated";
  restored.flags.push("z");
  assert.equal(snap.state.people[0].name, "Ada");
  assert.equal(snap.state.flags.length, 1);
  // round-trip preserves data
  const again = restoreState(makeSnapshot("x", sampleState()));
  assert.deepEqual(again, sampleState());
});

test("makeSnapshot stamps id/name/timestamps and trims/falls back the name", () => {
  const s = makeSnapshot("  Q3 plan  ", sampleState(), { now: 1000 });
  assert.equal(s.name, "Q3 plan");
  assert.equal(s.createdAt, 1000);
  assert.equal(s.updatedAt, 1000);
  assert.match(s.id, /^snap-/);
  assert.equal(makeSnapshot("", sampleState()).name, "Untitled");
});

test("newSnapshotId returns unique ids", () => {
  const ids = new Set(Array.from({ length: 50 }, () => newSnapshotId()));
  assert.equal(ids.size, 50);
});

test("sanitizeSnapshots drops malformed entries and repairs fields", () => {
  const out = sanitizeSnapshots([
    { name: "good", state: sampleState() },
    { state: sampleState() },        // missing name -> dropped
    { name: "no-state" },            // missing state -> dropped
    null,                            // dropped
    { name: "  ", state: {} },       // blank name -> "Untitled", empty state ok
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, "good");
  assert.ok(out[0].id);
  assert.equal(out[1].name, "Untitled");
});

test("migratePersisted carries a legacy v1 payload forward with empty snapshots", () => {
  const v1 = { people: sampleState().people, span: { min: 3, max: 8 }, pins: [], flags: [] };
  const migrated = migratePersisted(null, v1);
  assert.deepEqual(migrated.snapshots, []);
  assert.equal(migrated.activeSnapshotId, null);
  assert.deepEqual(migrated.people, v1.people);
  assert.equal(migratePersisted(null, null), null);
});

test("migratePersisted prefers v2 and sanitizes its snapshots + activeSnapshotId", () => {
  const v2 = {
    people: [], span: { min: 2, max: 5 }, pins: [], flags: [],
    snapshots: [{ name: "s1", state: sampleState() }, { bogus: true }],
    activeSnapshotId: "snap-abc",
  };
  const migrated = migratePersisted(v2, { people: [{ name: "old" }] });
  assert.equal(migrated.snapshots.length, 1);
  assert.equal(migrated.activeSnapshotId, "snap-abc");
  assert.deepEqual(migrated.people, []); // v2 wins over v1
});

test("lossless switch: capturing live work into the Working draft preserves full state", () => {
  // Simulate: user has unsaved edits; before switching we back them up.
  const live = sampleState();
  live.span = { min: 1, max: 4 };
  const draft = makeSnapshot(WORKING_DRAFT_NAME, live);
  // switching then editing further must not affect the backup
  live.people.push({ name: "New", isPeopleLeader: false, role: "TA", location: "CLU" });
  live.span.max = 8;
  const recovered = restoreState(draft);
  assert.equal(recovered.people.length, 2);
  assert.deepEqual(recovered.span, { min: 1, max: 4 });
  assert.equal(draft.name, WORKING_DRAFT_NAME);
});
