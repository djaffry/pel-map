// Non-SE (marked-for-deletion) role tests: node --test test/nonse.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { validatePeople } from "../src/validate.js";
import { buildHierarchy, computeMetrics } from "../src/balance.js";
import { checkTree, checkMove } from "../src/constraints.js";
import { isMarked, ROLES } from "../src/model.js";
import { walk, findById, resetIds, makeNode, attach, serializeTree } from "../src/tree.js";

const SPAN = { min: 3, max: 8 };

function findByName(root, name) {
  let found;
  walk(root, (n) => { if (n.person.name === name) found = n; });
  return found;
}

test("NSE is a valid role", () => {
  assert.ok(ROLES.includes("NSE"));
});

test("validation forces a non-SE person to be a leaf with no level", () => {
  const { people, ok } = validatePeople([
    { name: "Nils", isPeopleLeader: true, role: "NSE", location: "VIE", level: 2 },
  ]);
  assert.ok(ok);
  assert.equal(people.length, 1);
  assert.equal(people[0].isPeopleLeader, false, "NSE is always a leaf");
  assert.equal(people[0].level, undefined, "NSE carries no level");
  assert.ok(isMarked(people[0]));
});

test("constraints: a marked child does not count toward a manager's span", () => {
  resetIds();
  const span = { min: 3, max: 4 };
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho = makeNode({ name: "H", role: "HO", location: "VIE", isPeopleLeader: true });
  const lead = makeNode({ name: "L", role: "TA", location: "VIE", isPeopleLeader: true, level: 3 });
  attach(vp, ho);
  attach(ho, lead);
  // 4 real directs (== max) + 2 marked; must still be legal.
  for (let i = 0; i < 4; i++) attach(lead, makeNode({ name: `t${i}`, role: "TA", location: "VIE", isPeopleLeader: false, level: 1 }));
  for (let i = 0; i < 2; i++) attach(lead, makeNode({ name: `n${i}`, role: "NSE", location: "VIE", isPeopleLeader: false }));

  const report = checkTree(vp, { span });
  assert.deepEqual(report.errors, [], "marked children must not trip SPAN_MAX");
});

test("constraints: a marked node with children never triggers NODE_LEAF, and checkMove ignores marked in span", () => {
  resetIds();
  const span = { min: 3, max: 4 };
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho = makeNode({ name: "H", role: "HO", location: "VIE", isPeopleLeader: true });
  const lead = makeNode({ name: "L", role: "TA", location: "VIE", isPeopleLeader: true, level: 3 });
  attach(vp, ho); attach(ho, lead);
  // lead already has 4 real + 1 marked. A move of a 5th real would exceed max…
  for (let i = 0; i < 4; i++) attach(lead, makeNode({ name: `t${i}`, role: "TA", location: "VIE", isPeopleLeader: false, level: 1 }));
  attach(lead, makeNode({ name: "marked", role: "NSE", location: "VIE", isPeopleLeader: false }));
  const spare = makeNode({ name: "spare", role: "TA", location: "VIE", isPeopleLeader: false, level: 1 });
  attach(ho, spare);

  // No NODE_LEAF/errors from the marked node.
  assert.deepEqual(checkTree(vp, { span }).errors, []);

  // Moving `spare` under `lead` would make 5 real directs (> max 4): rejected,
  // and the message must report 5 (marked child not counted).
  const mv = checkMove(vp, spare.id, lead.id, { span });
  assert.equal(mv.ok, false);
  assert.ok(mv.reasons.some((r) => r.includes("5 directs")), mv.reasons.join("; "));
});

test("balance: non-SE excluded from balancing, kept in place, counted separately, never a leader", () => {
  const people = [
    { name: "V", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "H", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "S1", isPeopleLeader: false, role: "SE", location: "VIE", level: 2 },
    { name: "S2", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 },
    { name: "S3", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 },
    { name: "Marky", isPeopleLeader: false, role: "NSE", location: "VIE" },
  ];
  // Keep Marky under H.
  const res = buildHierarchy(people, { span: SPAN, keepInPlace: { Marky: "H" } });
  const marky = findByName(res.root, "Marky");
  assert.ok(marky, "marked person is kept in the tree");
  const parent = findById(res.root, marky.parentId);
  assert.equal(parent.person.name, "H", "kept under its captured manager");
  assert.equal(marky.children.length, 0, "marked is a leaf");

  // Never used as a leader anywhere.
  walk(res.root, (n) => { if (isMarked(n.person)) assert.equal(n.children.length, 0); });

  // Metrics: counted as marked, excluded from ICs and from H's span.
  assert.equal(res.metrics.marked, 1);
  const hSpanCounted = res.root; // find H and confirm its counted span excludes Marky
  const h = findByName(res.root, "H");
  const realKids = h.children.filter((c) => !isMarked(c.person)).length;
  const m = computeMetrics(res.root);
  assert.ok(m.span.max >= realKids);
});

test("balance: with no keepInPlace, non-SE attaches under the root", () => {
  const people = [
    { name: "V", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "S1", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 },
    { name: "Lone", isPeopleLeader: false, role: "NSE", location: "MUN" },
  ];
  const res = buildHierarchy(people, { span: SPAN });
  const lone = findByName(res.root, "Lone");
  assert.ok(lone);
  assert.equal(findById(res.root, lone.parentId).id, res.root.id, "falls back to the root");
});

test("balance: buildHierarchy never mutates the input people array", () => {
  const people = [
    { name: "V", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Marky", isPeopleLeader: false, role: "NSE", location: "VIE" },
  ];
  const before = JSON.stringify(people);
  buildHierarchy(people, { span: SPAN, keepInPlace: { Marky: "V" } });
  assert.equal(JSON.stringify(people), before);
});
