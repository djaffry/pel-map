// Capacity planner tests: node --test test/capacity.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

import { planCapacity } from "../src/capacity.js";
import { buildHierarchy } from "../src/balance.js";
import { walk, resetIds } from "../src/tree.js";
import { isMarked, buOf } from "../src/model.js";

const SPAN = { min: 3, max: 8 };

function P(name, role, location, opts = {}) {
  return { name, role, location, isPeopleLeader: opts.leader ?? false, ...(opts.level ? { level: opts.level } : {}) };
}

/** Make `n` ICs of a role/location with descending levels (capped at max level). */
function ics(prefix, role, location, n, maxLevel) {
  return Array.from({ length: n }, (_, i) => P(`${prefix}${i}`, role, location, { level: ((i % maxLevel) + 1) }));
}

/**
 * Apply a capacity plan: for each BU/role, promote `add` of its ICs (most senior
 * first, so a leader out-ranks its reports). The plan names roles & placements,
 * not people, so the test picks the concrete ICs to open each position.
 */
function applyPlan(people, plan) {
  /** @type {Map<string, number>} bu|role -> leaders to open */
  const need = new Map();
  for (const b of plan.byBU) for (const r of b.roles) if (r.add > 0) need.set(`${b.bu}|${r.role}`, r.add);

  /** @type {Map<string, object[]>} bu|role -> candidate ICs */
  const byKey = new Map();
  for (const p of people) {
    if (p.isPeopleLeader || (p.role !== "TA" && p.role !== "SE")) continue;
    const key = `${buOf(p.location)}|${p.role}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }

  const promote = new Set();
  for (const [key, count] of need) {
    const cands = (byKey.get(key) ?? [])
      .slice()
      .sort((a, b) => (b.level ?? 0) - (a.level ?? 0) || a.name.localeCompare(b.name));
    for (let i = 0; i < count && i < cands.length; i++) promote.add(cands[i].name);
  }
  return people.map((p) => (promote.has(p.name) ? { ...p, isPeopleLeader: true } : p));
}

/** Assert a built tree distributes everyone with no capacity shortfall. */
function assertFeasible(people, span) {
  const { root, notes } = buildHierarchy(people, { span });
  const shortfall = notes.filter((n) => ["SE_OVERFLOW", "NO_LEADERS", "NO_TA_LEADER"].includes(n.code));
  assert.equal(shortfall.length, 0, `no capacity shortfall notes, got: ${shortfall.map((n) => n.code).join(",")}`);
  // Every non-marked internal node stays within max span.
  walk(root, (node) => {
    if (isMarked(node.person)) return;
    const real = node.children.filter((c) => !isMarked(c.person)).length;
    assert.ok(real <= span.max, `${node.person.name} has ${real} directs (> max ${span.max})`);
  });
  return { root, notes };
}

test("empty / non-stream input yields an empty plan", () => {
  assert.equal(planCapacity(null).addLeaders, 0);
  assert.equal(planCapacity([]).totalStream, 0);
  const plan = planCapacity([P("V", "VP", "VIE", { leader: true }), P("H", "HO", "VIE", { leader: true })], { span: SPAN });
  assert.equal(plan.totalStream, 0);
  assert.equal(plan.addLeaders, 0);
});

test("already enough leaders => no additions", () => {
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    P("TL", "TA", "VIE", { leader: true, level: 3 }),
    P("s1", "SE", "VIE", { level: 1 }),
    P("s2", "SE", "VIE", { level: 1 }),
    P("t1", "TA", "VIE", { level: 1 }),
  ];
  const plan = planCapacity(people, { span: SPAN });
  assert.equal(plan.addLeaders, 0, "one TA leader can hold 5 stream people within max 8");
});

test("tricky 9 TA + 9 SE (max 8): needs 2 TA + 1 SE and is then feasible", () => {
  resetIds();
  const base = [P("V", "VP", "VIE", { leader: true }), P("H", "HO", "VIE", { leader: true })];
  const people = [...base, ...ics("t", "TA", "VIE", 9, 3), ...ics("s", "SE", "VIE", 9, 4)];
  const plan = planCapacity(people, { span: SPAN });

  const at = plan.byBU.find((b) => b.bu === "AT");
  assert.ok(at, "AT plan present");
  const ta = at.roles.find((r) => r.role === "TA");
  const se = at.roles.find((r) => r.role === "SE");
  assert.equal(ta.add, 2, "needs 2 TA leaders");
  assert.equal(se.add, 1, "needs 1 SE leader");
  assert.equal(plan.addLeaders, 3);

  // The plan opens role positions (not named people), each with a level.
  assert.equal(ta.positions.length, 2);
  assert.equal(se.positions.length, 1);
  for (const pos of [...ta.positions, ...se.positions]) assert.ok(pos.level >= 1);

  // Applying the plan makes the tree feasible; leaving it unbalanced does not.
  assertFeasible(applyPlan(people, plan), SPAN);
});

test("separates demand by BU (a TA/SE only ever led inside its own BU)", () => {
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    ...ics("at", "SE", "VIE", 20, 4), // AT: 20 SE ICs
    ...ics("de", "SE", "MUN", 12, 4), // DE: 12 SE ICs
  ];
  const plan = planCapacity(people, { span: SPAN });
  const at = plan.byBU.find((b) => b.bu === "AT");
  const de = plan.byBU.find((b) => b.bu === "DE");
  // Both BUs are too big to report straight to the HO, so each needs its own
  // SE leaders: AT ceil(19/8)=3, DE ceil(11/8)=2.
  assert.equal(at.roles.find((r) => r.role === "SE").add, 3);
  // DE: 4 SE => root SE head holds 3 => 1 SE leader.
  assert.equal(de.roles.find((r) => r.role === "SE").add, 2);
  assertFeasible(applyPlan(people, plan), SPAN);
});

test("large mixed org across BUs is feasible after applying the plan", () => {
  resetIds();
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    ...ics("atta", "TA", "VIE", 15, 3),
    ...ics("atse", "SE", "LNZ", 22, 4),
    ...ics("deta", "TA", "MUN", 7, 3),
    ...ics("dese", "SE", "KAR", 18, 4),
    ...ics("rota", "TA", "CLU", 2, 3),
    ...ics("rose", "SE", "CLU", 3, 4),
  ];
  const plan = planCapacity(people, { span: SPAN });
  assert.ok(plan.addLeaders > 0);
  assertFeasible(applyPlan(people, plan), SPAN);
});

test("positions describe role, level and placement — never named people", () => {
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    ...ics("t", "TA", "VIE", 9, 3), // AT TA: needs TA leaders
    ...ics("s", "SE", "VIE", 9, 4), // AT SE: placed under a TA lead
  ];
  const plan = planCapacity(people, { span: SPAN });
  const at = plan.byBU.find((b) => b.bu === "AT");
  const ta = at.roles.find((r) => r.role === "TA");
  const se = at.roles.find((r) => r.role === "SE");

  for (const pos of [...ta.positions, ...se.positions]) {
    assert.ok(!("name" in pos), "positions must not name individuals");
    assert.equal(typeof pos.reportsTo, "string");
    assert.equal(pos.bu, "AT");
    assert.ok(pos.level >= 1);
  }
  // Suggested level = the role's most-senior member so it can't be out-ranked.
  assert.equal(ta.positions[0].level, 3);
  assert.equal(se.positions[0].level, 4);

  // Placement mirrors the balancer: the BU has no TA leader yet, so the first TA
  // position heads the BU under the HO; further TA leads sit under the TA head.
  assert.equal(ta.positions[0].reportsTo, "the HO");
  assert.equal(ta.positions[1].reportsTo, "the AT TA lead");
  // SE positions sit under a TA lead (the BU has TA).
  assert.equal(se.positions[0].reportsTo, "a TA lead in AT");
});

test("small BUs report to the HO instead of needing a leader", () => {
  // RO has just 2 stream people (no leaders): they fit directly under the HO, so
  // no leader is required — while the big AT BU still needs its own leaders.
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    P("ta", "TA", "CLU", { level: 2 }), // RO
    P("se", "SE", "CLU", { level: 3 }), // RO
    ...ics("at", "SE", "VIE", 20, 4), // AT: genuinely needs leaders
  ];
  const plan = planCapacity(people, { span: SPAN });
  const ro = plan.byBU.find((b) => b.bu === "RO");
  const at = plan.byBU.find((b) => b.bu === "AT");
  assert.equal(ro.add, 0, "2-person RO reports to HO, no leader needed");
  assert.ok(at.add > 0, "20-person AT still needs leaders");
  // The whole thing must actually build cleanly once AT's leaders are promoted.
  assertFeasible(applyPlan(people, plan), SPAN);
});

test("a whole tiny org (everyone fits under the HO) needs no leaders", () => {
  const people = [
    P("V", "VP", "VIE", { leader: true }),
    P("H", "HO", "VIE", { leader: true }),
    P("a", "TA", "VIE", { level: 2 }),
    P("b", "SE", "VIE", { level: 3 }),
    P("c", "SE", "MUN", { level: 2 }),
    P("d", "TA", "CLU", { level: 1 }),
  ];
  const plan = planCapacity(people, { span: SPAN });
  assert.equal(plan.addLeaders, 0, "4 stream people fit directly under the HO");
});

test("locked relations: a pinned parent does NOT count as a leader", () => {
  // 9 SE ICs in AT need 1 SE leader. Locking one IC to lead another keeps the
  // reporting line, but a lock never confers leadership — only isNode does — so
  // the plan still needs the same new leader.
  const base = [P("V", "VP", "VIE", { leader: true }), P("H", "HO", "VIE", { leader: true })];
  const people = [...base, ...ics("s", "SE", "VIE", 9, 4)];

  const noPins = planCapacity(people, { span: SPAN });
  assert.equal(noPins.byBU.find((b) => b.bu === "AT").roles.find((r) => r.role === "SE").add, 1);

  // Lock s0 (an IC) to lead s1: s0 is still an IC, not a leader.
  const withPins = planCapacity(people, { span: SPAN, pins: [{ parent: "s0", child: "s1" }] });
  const se = withPins.byBU.find((b) => b.bu === "AT").roles.find((r) => r.role === "SE");
  assert.equal(se.leaders, 0, "a pinned parent is not counted as a leader");
  assert.equal(se.add, 1, "a new SE leader is still needed — the lock adds no capacity");
});

test("a non-leader that still has directs does not provide capacity", () => {
  // X is a demoted leader (isPeopleLeader:false) with 8 unlocked directs. Its
  // reports must still be placed, so demand is computed as if X leads no one.
  const base = [P("V", "VP", "VIE", { leader: true }), P("H", "HO", "VIE", { leader: true })];
  const people = [...base, P("X", "SE", "VIE", { level: 4 }), ...ics("s", "SE", "VIE", 8, 4)];

  const plan = planCapacity(people, { span: SPAN });
  const se = plan.byBU.find((b) => b.bu === "AT").roles.find((r) => r.role === "SE");
  assert.equal(se.leaders, 0, "a non-people-leader is not counted as a leader");
  // 9 SE people, no leaders => the plan opens an SE leader to place them.
  assert.ok(se.add >= 1, "the unled reports drive leadership demand");

  // Locking the reports under X keeps the reporting line but does NOT make X a
  // leader — X is still an IC, so demand is unchanged.
  const locked = planCapacity(people, {
    span: SPAN,
    pins: [{ parent: "X", child: "s0" }],
  });
  const seLocked = locked.byBU.find((b) => b.bu === "AT").roles.find((r) => r.role === "SE");
  assert.equal(seLocked.leaders, 0, "locking a report under X does not make X a leader");
});

test("locked relations: a stream IC pinned under the HO is pre-placed at the top", () => {
  // AT has 9 SE (needs 1 leader). Pinning one SE IC directly under the HO places
  // it above the stream, so it no longer needs a BU leader.
  const base = [P("V", "VP", "VIE", { leader: true }), P("H", "HO", "VIE", { leader: true })];
  const people = [...base, ...ics("s", "SE", "VIE", 9, 4)];

  const plan = planCapacity(people, { span: SPAN, pins: [{ parent: "H", child: "s0" }] });
  const at = plan.byBU.find((b) => b.bu === "AT");
  const se = at.roles.find((r) => r.role === "SE");
  // Only 8 SE remain in the BU (one is under the HO) — they fit under one leader.
  assert.equal(se.people, 8, "the HO-pinned IC left the BU pool");
});
