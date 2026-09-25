// Node test runner (no deps): run with `node --test test/balance.test.mjs`
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buOf, LOCATION_TO_BU, LOCATIONS, compareBySeniority, roleRank, compareForDisplay, locationRank } from "../src/model.js";
import { validatePeople } from "../src/validate.js";
import { buildHierarchy } from "../src/balance.js";
import { checkTree, checkMove, priorityRank, CONSTRAINT_PRIORITY } from "../src/constraints.js";
import { walk, findById, reparent, resetIds, toPeople, makeNode, attach, removeReassigningChildren, serializeTree, deserializeTree } from "../src/tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sample = JSON.parse(readFileSync(join(__dirname, "..", "sample-data.json"), "utf8"));

const SPAN = { min: 3, max: 8 };

function buildSample() {
  resetIds();
  const { people, ok } = validatePeople(sample);
  assert.ok(ok, "sample data should validate");
  return { people, result: buildHierarchy(people, { span: SPAN }) };
}

test("BU derivation covers all locations, each in exactly one BU", () => {
  for (const loc of LOCATIONS) {
    const bu = buOf(loc);
    assert.ok(["AT", "DE", "RO"].includes(bu), `${loc} -> ${bu}`);
  }
  assert.equal(LOCATION_TO_BU.VIE, "AT");
  assert.equal(LOCATION_TO_BU.MUN, "DE");
  assert.equal(LOCATION_TO_BU.CLU, "RO");
  // each BU has a remote location
  assert.equal(LOCATION_TO_BU.ATR, "AT");
  assert.equal(LOCATION_TO_BU.DER, "DE");
  assert.equal(LOCATION_TO_BU.ROR, "RO");
});

test("compareBySeniority: role high→low (NSE last), then level, then leaders", () => {
  // Role rank ascending: VP < HO < TA < SE < NSE.
  assert.ok(roleRank("VP") < roleRank("HO"));
  assert.ok(roleRank("HO") < roleRank("TA"));
  assert.ok(roleRank("TA") < roleRank("SE"));
  assert.ok(roleRank("SE") < roleRank("NSE"));

  const P = (role, level, leader = false) => ({ name: `${role}${level ?? ""}`, role, location: "VIE", isPeopleLeader: leader, ...(level ? { level } : {}) });
  const shuffled = [
    P("SE", 2), P("NSE"), P("TA", 1), P("VP"), P("TA", 3, true), P("HO", undefined, true), P("TA", 3), P("SE", 4),
  ];
  const order = [...shuffled].sort(compareBySeniority).map((p) => p.name);
  // VP, HO, then TA (L3 leader before L3 IC before L1), then SE (L4 before L2), then NSE last.
  assert.deepEqual(order, ["VP", "HO", "TA3", "TA3", "TA1", "SE4", "SE2", "NSE"]);
  // The two TA L3 entries: the leader must come before the IC.
  const sorted = [...shuffled].sort(compareBySeniority);
  const firstTA3 = sorted.find((p) => p.role === "TA" && p.level === 3);
  assert.equal(firstTA3.isPeopleLeader, true, "leader sorts before same role+level IC");
});

test("compareBySeniority is stable for equal keys", () => {
  const a = { name: "A", role: "TA", location: "VIE", isPeopleLeader: false, level: 2 };
  const b = { name: "B", role: "TA", location: "LNZ", isPeopleLeader: false, level: 2 };
  const c = { name: "C", role: "TA", location: "GRZ", isPeopleLeader: false, level: 2 };
  assert.deepEqual([a, b, c].sort(compareBySeniority).map((p) => p.name), ["A", "B", "C"]);
});

test("compareForDisplay groups by location first, then seniority within a location", () => {
  // locationRank follows the LOCATIONS (BU-grouped) order: VIE before LNZ before GRZ.
  assert.ok(locationRank("VIE") < locationRank("LNZ"));
  assert.ok(locationRank("LNZ") < locationRank("GRZ"));
  assert.equal(locationRank("ZZZ"), LOCATIONS.length); // unknown last

  const P = (name, role, location, level, leader = false) => ({ name, role, location, isPeopleLeader: leader, ...(level ? { level } : {}) });
  const people = [
    P("lnzTA1", "TA", "LNZ", 1),
    P("vieSE2", "SE", "VIE", 2),
    P("vieTA3", "TA", "VIE", 3),
    P("lnzTA3", "TA", "LNZ", 3),
    P("vieNSE", "NSE", "VIE"),
    P("grzTA1", "TA", "GRZ", 1),
  ];
  const order = [...people].sort(compareForDisplay).map((p) => p.name);
  // VIE group first (TA3 > SE2 > marked NSE last-in-group), then LNZ (TA3 > TA1), then GRZ.
  assert.deepEqual(order, ["vieTA3", "vieSE2", "vieNSE", "lnzTA3", "lnzTA1", "grzTA1"]);
});

test("validation rejects bad roles/locations and non-arrays", () => {
  assert.equal(validatePeople({}).ok, false);
  const bad = validatePeople([
    { name: "X", isPeopleLeader: true, role: "CEO", location: "VIE" },
    { name: "", isPeopleLeader: false, role: "SE", location: "ZZZ" },
    { name: "Ok", isPeopleLeader: false, role: "SE", location: "VIE" },
  ]);
  assert.equal(bad.ok, false);
  assert.equal(bad.people.length, 1);
  assert.ok(bad.errors.length >= 3);
});

test("sample builds a tree rooted at the VP with no constraint errors", () => {
  const { result } = buildSample();
  assert.ok(result.root, "root exists");
  assert.equal(result.root.person.role, "VP");
  assert.deepEqual(result.constraints.errors, [], "no hard-constraint errors");
});

test("clean stream: SE never leads TA; at most one TA->SE break per branch", () => {
  const { result } = buildSample();
  const streamOf = (r) => (r === "TA" || r === "SE" ? r : undefined);
  walk(result.root, (n) => {
    const ps = streamOf(n.person.role);
    for (const c of n.children) {
      const cs = streamOf(c.person.role);
      if (ps === "SE" && cs === "TA") assert.fail(`SE ${n.person.name} leads TA ${c.person.name}`);
    }
  });
  // count breaks along every root-to-leaf path
  const path = [];
  const dfs = (n) => {
    path.push(n.person.role);
    let breaks = 0;
    for (let i = 1; i < path.length; i++) if (path[i - 1] === "TA" && path[i] === "SE") breaks++;
    assert.ok(breaks <= 1, `>1 TA→SE break on path to ${n.person.name}`);
    n.children.forEach(dfs);
    path.pop();
  };
  dfs(result.root);
});

test("clean BU at the stream level: each stream subtree is single-BU (HO is cross-BU)", () => {
  const { result } = buildSample();
  const dfs = (n, streamBU) => {
    let childBU; // undefined under VP/HO (cross-BU)
    if (n.person.role === "TA" || n.person.role === "SE") {
      const own = buOf(n.person.location);
      if (streamBU === undefined) childBU = own;
      else {
        assert.equal(own, streamBU, `${n.person.name} BU matches its stream branch`);
        childBU = streamBU;
      }
    }
    n.children.forEach((c) => dfs(c, childBU));
  };
  dfs(result.root, undefined);
});

test("node/leaf rule: only people leaders have reports", () => {
  const { result } = buildSample();
  walk(result.root, (n) => {
    if (n.children.length > 0) assert.equal(n.person.isPeopleLeader, true, `${n.person.name} is a leader`);
  });
});

test("PARENT_NOT_LEADER: a report hanging off a non-leader is flagged on the child too", () => {
  resetIds();
  const span = { min: 3, max: 8 };
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho = makeNode({ name: "H", role: "HO", location: "VIE", isPeopleLeader: true });
  const x = makeNode({ name: "X", role: "TA", location: "VIE", isPeopleLeader: false, level: 3 }); // demoted (IC)
  const ann = makeNode({ name: "Ann", role: "TA", location: "VIE", isPeopleLeader: false, level: 1 });
  const marked = makeNode({ name: "M", role: "NSE", location: "VIE", isPeopleLeader: false });
  attach(vp, ho); attach(ho, x); attach(x, ann); attach(x, marked);

  const { errors } = checkTree(vp, { span });
  // The non-leader parent keeps its own NODE_LEAF error…
  assert.ok(errors.some((e) => e.code === "NODE_LEAF" && e.nodeId === x.id), "parent NODE_LEAF");
  // …and the report hanging off it is flagged on the child node.
  const childErr = errors.find((e) => e.code === "PARENT_NOT_LEADER" && e.nodeId === ann.id);
  assert.ok(childErr, "child PARENT_NOT_LEADER");
  assert.match(childErr.message, /reports to X/);
  // A marked (NSE) child hanging off the non-leader is NOT flagged (outside the hierarchy).
  assert.ok(!errors.some((e) => e.nodeId === marked.id), "marked child not flagged");
  // PARENT_NOT_LEADER ranks alongside the structural cluster (just after NODE_LEAF).
  assert.ok(priorityRank("PARENT_NOT_LEADER") < priorityRank("SPAN_MAX"));
});

test("span-of-control: no internal node exceeds max", () => {
  const { result } = buildSample();
  walk(result.root, (n) => {
    assert.ok(n.children.length <= SPAN.max, `${n.person.name} span ${n.children.length} <= ${SPAN.max}`);
  });
});

test("tree preserves the full population", () => {
  const { people, result } = buildSample();
  assert.equal(toPeople(result.root).length, people.length);
});

test("checkTree agrees the built sample is clean", () => {
  const { result } = buildSample();
  const report = checkTree(result.root, { span: SPAN });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
});

test("checkMove blocks illegal re-parents and allows legal ones", () => {
  const { result } = buildSample();
  const root = result.root;

  // find an AT TA leaf and a DE TA leader -> cross-BU stream move must be rejected
  let atTA, deTAlead;
  walk(root, (n) => {
    if (!atTA && n.person.role === "TA" && buOf(n.person.location) === "AT" && n.children.length === 0) atTA = n;
    if (!deTAlead && n.person.role === "TA" && n.person.isPeopleLeader && buOf(n.person.location) === "DE") deTAlead = n;
  });
  assert.ok(atTA && deTAlead);
  const bad = checkMove(root, atTA.id, deTAlead.id, { span: SPAN });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /BU/.test(r)));

  // moving onto a non-leader (an IC leaf) must be rejected
  let ic;
  walk(root, (n) => {
    if (!ic && n.person.isPeopleLeader === false) ic = n;
  });
  const bad2 = checkMove(root, atTA.id, ic.id, { span: SPAN });
  assert.equal(bad2.ok, false);
});

test("reparent prevents cycles", () => {
  resetIds();
  const { people } = buildSample();
  const { root } = buildHierarchy(people, { span: SPAN });
  const ho = root.children.find((c) => c.person.role === "HO");
  const res = reparent(root, ho.id, findById(root, ho.children[0]?.id ?? ho.id).id);
  assert.equal(res.ok, false, "cannot move a node into its own subtree");
});

test("fixed link (pin) keeps a report under its manager across a rebuild", () => {
  resetIds();
  const { people } = buildSample();
  // Pin a DE SE IC ("Selin DE") directly under the single HO ("Hanna (HO)").
  const pins = [{ parent: "Hanna (HO)", child: "Selin DE" }];
  const { root } = buildHierarchy(people, { span: SPAN, pins });
  let hanna;
  walk(root, (n) => { if (n.person.name === "Hanna (HO)") hanna = n; });
  assert.ok(hanna, "manager present");
  assert.ok(hanna.children.some((c) => c.person.name === "Selin DE"), "pinned report is a direct child of its manager");
});

test("checkMove blocks tearing apart a fixed link", () => {
  resetIds();
  const { people } = buildSample();
  const pins = [{ parent: "Hanna (HO)", child: "Selin DE" }];
  const { root } = buildHierarchy(people, { span: SPAN, pins });
  let selin, otherLeader;
  walk(root, (n) => {
    if (n.person.name === "Selin DE") selin = n;
    if (!otherLeader && n.person.isPeopleLeader && n.person.name !== "Hanna (HO)" && buOf(n.person.location) === "DE" && n.person.role !== "TA") otherLeader = n;
  });
  assert.ok(selin && otherLeader);
  const res = checkMove(root, selin.id, otherLeader.id, { span: SPAN, pins });
  assert.equal(res.ok, false);
  assert.ok(res.reasons.some((r) => /fixed to/.test(r)));
});

test("level: fallback to 1 when unset; validates range per stream role", () => {
  const res = validatePeople([
    { name: "S no-level", isPeopleLeader: false, role: "SE", location: "VIE" },
    { name: "S lvl4", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
    { name: "T lvl3", isPeopleLeader: false, role: "TA", location: "VIE", level: 3 },
    { name: "V", isPeopleLeader: true, role: "VP", location: "VIE", level: 2 },
  ]);
  assert.ok(res.ok, "valid levels (and ignored VP level) pass");
  const byName = Object.fromEntries(res.people.map((p) => [p.name, p]));
  assert.equal(byName["S no-level"].level, 1, "SE without level defaults to 1");
  assert.equal(byName["S lvl4"].level, 4, "SE level 4 preserved");
  assert.equal(byName["T lvl3"].level, 3, "TA level 3 preserved");
  assert.equal("level" in byName["V"], false, "VP carries no level");

  const bad = validatePeople([
    { name: "T lvl4", isPeopleLeader: false, role: "TA", location: "VIE", level: 4 },
    { name: "S lvl5", isPeopleLeader: false, role: "SE", location: "VIE", level: 5 },
    { name: "S lvl0", isPeopleLeader: false, role: "SE", location: "VIE", level: 0 },
  ]);
  assert.equal(bad.ok, false, "out-of-range levels rejected");
  assert.equal(bad.people.length, 0);
  assert.ok(bad.errors.every((e) => e.field === "level"));
});

test("level: rides along through a rebuild", () => {
  resetIds();
  const raw = [
    { name: "Val (VP)", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Hanna AT (HO)", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Sven AT-lead", isPeopleLeader: true, role: "SE", location: "VIE", level: 4 },
    { name: "Sara AT", isPeopleLeader: false, role: "SE", location: "VIE", level: 2 },
  ];
  const { people } = validatePeople(raw);
  const { root } = buildHierarchy(people, { span: SPAN });
  let sara;
  walk(root, (n) => { if (n.person.name === "Sara AT") sara = n; });
  assert.ok(sara, "IC present after build");
  assert.equal(sara.person.level, 2, "level preserved through build");
});

test("level order: same-stream report may not outrank its manager (equal allowed)", () => {
  resetIds();
  const people = validatePeople([
    { name: "Val (VP)", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Hanna AT (HO)", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Lead SE1", isPeopleLeader: true, role: "SE", location: "VIE", level: 1 },
    { name: "Senior SE3", isPeopleLeader: false, role: "SE", location: "VIE", level: 3 },
    { name: "Peer SE1", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 },
  ]).people;
  const { root } = buildHierarchy(people, {
    span: SPAN,
    pins: [
      { parent: "Lead SE1", child: "Senior SE3" },
      { parent: "Lead SE1", child: "Peer SE1" },
    ],
  });
  const rep = checkTree(root, { span: SPAN });
  // The L1 leader outranked by an L3 report is a hard error...
  assert.ok(rep.errors.some((e) => e.code === "LEVEL_INVERSION" && e.name === "Senior SE3"),
    "L3 under L1 leader is a level inversion");
  // ...but an equal-level (L1) report under the L1 leader is fine.
  assert.ok(!rep.errors.some((e) => e.code === "LEVEL_INVERSION" && e.name === "Peer SE1"),
    "equal-level report is allowed");
});

test("level order: does not apply across the TA->SE break", () => {
  resetIds();
  const people = validatePeople([
    { name: "Val (VP)", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Hanna AT (HO)", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "TA lead", isPeopleLeader: true, role: "TA", location: "VIE", level: 1 },
    { name: "SE under TA", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
  ]).people;
  // Pin the SE directly under the TA lead to force a TA->SE break edge.
  const pins = [{ parent: "TA lead", child: "SE under TA" }];
  const { root } = buildHierarchy(people, { span: SPAN, pins });
  const rep = checkTree(root, { span: SPAN });
  assert.ok(!rep.errors.some((e) => e.code === "LEVEL_INVERSION"),
    "TA(L1)->SE(L4) break edge is exempt from level order");
});

test("autobalance: a TA leads higher SE that no SE leader can host (no LEVEL_INVERSION)", () => {
  // The only SE leader is low-level (L1); the SE ICs are high-level (L4). Nesting
  // them under the SE leader would invert levels — the balancer must instead let
  // the TA lead them (the TA→SE break carries no level rule).
  resetIds();
  const span = { min: 3, max: 8 };
  const people = validatePeople([
    { name: "Val (VP)", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Hanna (HO)", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "TA lead", isPeopleLeader: true, role: "TA", location: "VIE", level: 2 },
    { name: "SE lead low", isPeopleLeader: true, role: "SE", location: "VIE", level: 1 },
    { name: "SE hi 0", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
    { name: "SE hi 1", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
    { name: "SE hi 2", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
    { name: "SE hi 3", isPeopleLeader: false, role: "SE", location: "VIE", level: 4 },
  ]).people;
  const { root } = buildHierarchy(people, { span });

  const rep = checkTree(root, { span });
  assert.ok(!rep.errors.some((e) => e.code === "LEVEL_INVERSION"), JSON.stringify(rep.errors));

  // Every high SE IC is led by the TA (any-level via the break), never the low SE lead.
  const find = (name) => { let f; walk(root, (n) => { if (n.person.name === name) f = n; }); return f; };
  const ta = find("TA lead");
  const seLow = find("SE lead low");
  const taChildren = ta.children.map((c) => c.person.name);
  for (let i = 0; i < 4; i++) assert.ok(taChildren.includes(`SE hi ${i}`), `TA leads SE hi ${i}`);
  assert.ok(!seLow.children.some((c) => (c.person.level ?? 0) > (seLow.person.level ?? 0)),
    "the low SE lead never leads a higher-level SE");
});

test("checkMove blocks a higher-level report joining a lower-level same-stream manager", () => {
  resetIds();
  const people = validatePeople([
    { name: "Val (VP)", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Hanna AT (HO)", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "SE low", isPeopleLeader: true, role: "SE", location: "VIE", level: 2 },
    { name: "SE high", isPeopleLeader: true, role: "SE", location: "LNZ", level: 4 },
    { name: "SE ic", isPeopleLeader: false, role: "SE", location: "VIE", level: 1 },
  ]).people;
  const { root } = buildHierarchy(people, { span: SPAN });
  let low, high;
  walk(root, (n) => {
    if (n.person.name === "SE low") low = n;
    if (n.person.name === "SE high") high = n;
  });
  assert.ok(low && high);
  const bad = checkMove(root, high.id, low.id, { span: SPAN });
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.some((r) => /lower-level/.test(r)));
  const ok = checkMove(root, low.id, high.id, { span: SPAN });
  assert.equal(ok.ok, true, "lower-level joining higher-level manager is allowed");
});

test("surgical delete: reports move one level up into the node's slot, no rebalance", () => {
  resetIds();
  const P = (name, leader = true, role = "SE") => ({ name, isPeopleLeader: leader, role, location: "VIE", level: 1 });
  const root = makeNode(P("VP", true, "VP"));
  const ho = makeNode(P("HO", true, "HO")); attach(root, ho);
  const lead = makeNode(P("Lead")); attach(ho, lead);
  const a = makeNode(P("A", false)); const b = makeNode(P("B", false));
  attach(lead, a); attach(lead, b);
  const sib = makeNode(P("Sib", false)); attach(ho, sib);

  // Delete "Lead": A and B take Lead's slot under HO (before Sib); nothing else moves.
  const res = removeReassigningChildren(root, lead.id);
  assert.ok(res.ok);
  assert.equal(res.manager.person.name, "HO");
  assert.deepEqual(res.reports.map((r) => r.person.name), ["A", "B"]);
  assert.deepEqual(ho.children.map((c) => c.person.name), ["A", "B", "Sib"]);
  // Lead is gone; A and B are unlocked normal reports of HO.
  const names = [];
  walk(root, (n) => names.push(n.person.name));
  assert.ok(!names.includes("Lead"));
  assert.equal(findById(root, a.id).parentId, ho.id);

  // The whole tree survives a constraint check (structure is intact).
  const rep = checkTree(root, { span: SPAN });
  assert.ok(Array.isArray(rep.errors));
});

test("removeReassigningChildren refuses the root and reports missing nodes", () => {
  resetIds();
  const root = makeNode({ name: "VP", isPeopleLeader: true, role: "VP", location: "VIE" });
  assert.equal(removeReassigningChildren(root, root.id).ok, false, "cannot remove the root this way");
  assert.equal(removeReassigningChildren(root, "nope").ok, false, "missing node");
});

test("serializeTree/deserializeTree round-trips structure and person data", () => {
  resetIds();
  const root = makeNode({ name: "VP", isPeopleLeader: true, role: "VP", location: "VIE" });
  const ho = makeNode({ name: "HO", isPeopleLeader: true, role: "HO", location: "MUN" });
  attach(root, ho);
  attach(ho, makeNode({ name: "Ic", isPeopleLeader: false, role: "SE", location: "KAR", level: 3 }));
  const ser = serializeTree(root);
  const copy = deserializeTree(ser);
  const before = []; walk(root, (n) => before.push(`${n.person.name}:${n.person.location}`));
  const after = []; walk(copy, (n) => after.push(`${n.person.name}:${n.person.location}`));
  assert.deepEqual(after, before);
  // fresh ids, independent objects
  assert.notEqual(copy, root);
  assert.notEqual(copy.children[0].person, root.children[0].person);
});

test("VP leads only HOs; the single HO heads the streams (no VP→stream)", () => {
  const { result } = buildSample();
  const root = result.root;
  assert.equal(root.person.role, "VP");

  // Exactly one HO, reporting directly to the VP.
  const hos = [];
  walk(root, (n) => { if (n.person.role === "HO") hos.push(n); });
  assert.equal(hos.length, 1, "exactly one HO");
  assert.equal(hos[0].parentId, root.id, "HO reports to the VP");

  // The VP's (non-marked) children are all HOs — never a stream node.
  for (const c of root.children) {
    if (c.person.role === "NSE") continue;
    assert.equal(c.person.role, "HO", `VP child ${c.person.name} must be an HO`);
  }

  // No TA/SE node reports directly to the VP; every stream subtree top is a
  // direct child of the HO.
  walk(root, (n) => {
    for (const c of n.children) {
      if (c.person.role === "TA" || c.person.role === "SE") {
        assert.notEqual(n.person.role, "VP", `${c.person.name} must not report to the VP`);
      }
    }
  });
});

test("only one HO: a second HO is a hard error", () => {
  resetIds();
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho1 = makeNode({ name: "H1", role: "HO", location: "VIE", isPeopleLeader: true });
  const ho2 = makeNode({ name: "H2", role: "HO", location: "MUN", isPeopleLeader: true });
  attach(vp, ho1);
  attach(vp, ho2);
  const rep = checkTree(vp, { span: SPAN });
  assert.ok(rep.errors.some((e) => e.code === "MULTI_HO" && e.name === "H2"), "second HO is flagged");
});

test("VP_LEADS_STREAM: a stream node directly under the VP is an error (checkTree + checkMove)", () => {
  resetIds();
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const se = makeNode({ name: "S", role: "SE", location: "VIE", isPeopleLeader: false, level: 1 });
  attach(vp, se);
  const rep = checkTree(vp, { span: SPAN });
  assert.ok(rep.errors.some((e) => e.code === "VP_LEADS_STREAM" && e.name === "S"));

  // checkMove must also reject re-parenting a stream node directly under the VP.
  resetIds();
  const vp2 = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho = makeNode({ name: "H", role: "HO", location: "VIE", isPeopleLeader: true });
  const se2 = makeNode({ name: "S", role: "SE", location: "VIE", isPeopleLeader: false, level: 1 });
  attach(vp2, ho);
  attach(ho, se2);
  const mv = checkMove(vp2, se2.id, vp2.id, { span: SPAN });
  assert.equal(mv.ok, false);
  assert.ok(mv.reasons.some((r) => /HO must lead the stream/.test(r)));
});

test("HO_NOT_UNDER_VP: an HO not reporting to the VP is an error (checkTree + checkMove)", () => {
  resetIds();
  const vp = makeNode({ name: "V", role: "VP", location: "VIE", isPeopleLeader: true });
  const ho = makeNode({ name: "H", role: "HO", location: "VIE", isPeopleLeader: true });
  const ho2 = makeNode({ name: "H2", role: "HO", location: "MUN", isPeopleLeader: true });
  attach(vp, ho);
  attach(ho, ho2); // HO under an HO, not the VP
  const rep = checkTree(vp, { span: SPAN });
  assert.ok(rep.errors.some((e) => e.code === "HO_NOT_UNDER_VP" && e.name === "H2"));

  // checkMove rejects placing an HO under a non-VP.
  const mv = checkMove(vp, ho2.id, ho.id, { span: SPAN });
  assert.equal(mv.ok, false);
  assert.ok(mv.reasons.some((r) => /must report directly to the VP/.test(r)));
});

test("HO span excludes marked (NSE) children; sample HO stays within max", () => {
  const { result } = buildSample();
  let ho;
  walk(result.root, (n) => { if (n.person.role === "HO") ho = n; });
  assert.ok(ho);
  const realDirects = ho.children.filter((c) => c.person.role !== "NSE").length;
  assert.ok(realDirects <= SPAN.max, `HO real directs ${realDirects} <= ${SPAN.max}`);
});

test("balancer meets span bounds and uses the TA→SE break", () => {
  const { result } = buildSample();
  const root = result.root;

  // No hard errors (SPAN_MAX in particular), and every non-NSE internal node is
  // within [min,max] — except the VP, which by design leads exactly one HO.
  assert.deepEqual(result.constraints.errors, [], JSON.stringify(result.constraints.errors));
  walk(root, (n) => {
    if (n.person.role === "NSE") return;
    const real = n.children.filter((c) => c.person.role !== "NSE").length;
    if (real === 0) return; // leaf (or an unused leader) — nothing to bound
    assert.ok(real <= SPAN.max, `${n.person.name} span ${real} <= ${SPAN.max}`);
    if (n.person.role !== "VP") {
      assert.ok(real >= SPAN.min, `${n.person.name} span ${real} >= ${SPAN.min}`);
    }
  });

  // At least one TA→SE break is actually used (a TA leader directly leads an SE).
  let breaks = 0;
  walk(root, (n) => {
    if (n.person.role !== "TA") return;
    for (const c of n.children) if (c.person.role === "SE") breaks++;
  });
  assert.ok(breaks >= 1, "the balancer should use the TA→SE break to balance spans");
});

test("balancer: a BU with only ICs (no leaders) reports flat under the HO", () => {
  const { result } = buildSample();
  let ho;
  walk(result.root, (n) => { if (n.person.role === "HO") ho = n; });
  // RO has only ICs (Radu TA, Rares SE) — both land directly under the HO.
  const names = ho.children.map((c) => c.person.name);
  assert.ok(names.includes("Radu RO") && names.includes("Rares RO"), names.join(", "));
});

test("depth flattening: deep same-role sub-leads are lifted under the HO", () => {
  // One BU (AT), all SE: 4 SE leaders + 26 ICs. Nesting under one head would run
  // VP→HO→head→sub→IC (depth 4) with the HO holding a single direct. Flattening
  // lifts the sub-leads directly under the (cross-BU) HO to reduce depth.
  resetIds();
  const span = { min: 3, max: 8 };
  const P = (n, r, l, ldr, lv) => ({ name: n, role: r, location: l, isPeopleLeader: ldr, ...(lv ? { level: lv } : {}) });
  const people = [P("VP", "VP", "VIE", true), P("HO", "HO", "VIE", true)];
  for (let i = 0; i < 4; i++) people.push(P(`SL${i}`, "SE", "VIE", true, 4));
  for (let i = 0; i < 26; i++) people.push(P(`se${i}`, "SE", "VIE", false, 1));
  const { root, metrics, constraints, notes } = buildHierarchy(people, { span });

  assert.deepEqual(constraints.errors, [], JSON.stringify(constraints.errors));
  let ho;
  walk(root, (n) => { if (n.person.role === "HO") ho = n; });
  // The HO now holds several stream leads directly (not a single deep head).
  assert.ok(ho.children.length >= 3, `HO should hold several directs, got ${ho.children.length}`);
  assert.ok(ho.children.length <= span.max, `HO within max span`);
  // The tree is shallow: HO → lead → IC (VP=0, HO=1, lead=2, IC=3 → depth 3).
  assert.ok(metrics.depth <= 3, `depth should be flat, got ${metrics.depth}`);
  assert.ok(notes.some((n) => n.code === "DEPTH_FLATTENED"), "a DEPTH_FLATTENED note is recorded");

  // Every internal (non-VP) node stays within [min,max] — flattening never
  // pushes a former manager below min.
  walk(root, (n) => {
    const real = n.children.filter((c) => c.person.role !== "NSE").length;
    if (real === 0) return;
    assert.ok(real <= span.max, `${n.person.name} span ${real} <= ${span.max}`);
    if (n.person.role !== "VP") assert.ok(real >= span.min, `${n.person.name} span ${real} >= ${span.min}`);
  });

  // Flattening is "complete": the HO never idles below max while a liftable,
  // same-role grandchild lead sits under an above-min manager.
  if (ho.children.length < span.max) {
    for (const parent of ho.children) {
      const pReal = parent.children.filter((c) => c.person.role !== "NSE").length;
      if (pReal - 1 < span.min) continue;
      for (const g of parent.children) {
        const gReal = g.children.filter((c) => c.person.role !== "NSE").length;
        const liftable = g.person.isPeopleLeader === true && g.person.role === parent.person.role && gReal > 0;
        assert.ok(!liftable, `${g.person.name} should have been lifted under the HO`);
      }
    }
  }
});

test("depth flattening keeps spans even: no lifted peer sits ≥2 above a sibling with room", () => {
  // A TA head + two TA sub-leads + SE, sized so flattening lifts the subs to the
  // HO. Without a re-even pass the former head idles (e.g. 6) while the lifted
  // subs run at max (8). The evenness pass must move leaf reports back so no
  // stream leader sits 2+ above a same-BU sibling that could legally take one.
  resetIds();
  const span = { min: 3, max: 8 };
  const P = (n, r, l, ldr, lv) => ({ name: n, role: r, location: l, isPeopleLeader: ldr, ...(lv ? { level: lv } : {}) });
  const people = [
    P("VP", "VP", "VIE", true), P("HO", "HO", "VIE", true),
    P("Head", "TA", "VIE", true, 3), P("Sub1", "TA", "VIE", true, 2), P("Sub2", "TA", "LNZ", true, 2),
  ];
  for (let i = 0; i < 10; i++) people.push(P(`ta${i}`, "TA", "LNZ", false, 1));
  for (let i = 0; i < 12; i++) people.push(P(`se${i}`, "SE", "VIE", false, 2));

  const { root, constraints, notes } = buildHierarchy(people, { span, balancePriority: "evenness" });
  assert.deepEqual(constraints.errors, [], JSON.stringify(constraints.errors));
  assert.ok(notes.some((n) => n.code === "DEPTH_FLATTENED"), "flattening ran");

  // Collect the stream-role (TA/SE) leaders and their real spans.
  const streamLeaders = [];
  walk(root, (n) => {
    if (n.person.isPeopleLeader !== true) return;
    if (n.person.role !== "TA" && n.person.role !== "SE") return;
    streamLeaders.push(n);
  });
  const load = (n) => n.children.filter((c) => c.person.role !== "NSE").length;

  // The HO never absorbs individual contributors — it only leads leads.
  let ho;
  walk(root, (n) => { if (n.person.role === "HO") ho = n; });
  for (const c of ho.children) {
    assert.equal(c.person.isPeopleLeader, true, `HO child ${c.person.name} should be a leader, not an IC`);
  }

  // Evenness holds: no stream leader is 2+ fuller than a same-BU peer that has a
  // movable leaf it could legally take (i.e. the imbalance can't be improved).
  for (const hi of streamLeaders) {
    for (const lo of streamLeaders) {
      if (hi === lo || load(hi) - load(lo) < 2) continue;
      if (buOf(hi.person.location) !== buOf(lo.person.location)) continue;
      const leaf = hi.children.find((c) => c.person.isPeopleLeader !== true && c.person.role !== "NSE"
        && checkMove(root, c.id, lo.id, { span }).ok);
      assert.ok(!leaf, `${hi.person.name} (${load(hi)}) could shed ${leaf?.person.name} to ${lo.person.name} (${load(lo)})`);
    }
  }
});

test("balancer: same-location soft bias groups a leader's directs by location", () => {
  // One BU (AT), all TA, tuned so layoutSameRole elects two sub-leaders in
  // different locations (VIE, LNZ) and must distribute same-location ICs.
  resetIds();
  const span = { min: 2, max: 3 };
  const people = [
    { name: "Val VP", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Ho", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Head VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 3 },
    { name: "Sub VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 2 },
    { name: "Sub LNZ", isPeopleLeader: true, role: "TA", location: "LNZ", level: 2 },
    { name: "IC V1", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V2", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V3", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC L1", isPeopleLeader: false, role: "TA", location: "LNZ", level: 1 },
    { name: "IC L2", isPeopleLeader: false, role: "TA", location: "LNZ", level: 1 },
  ];
  const { people: valid, ok } = validatePeople(people);
  assert.ok(ok, "test people should validate");
  const result = buildHierarchy(valid, { span });

  const find = (name) => { let f; walk(result.root, (n) => { if (n.person.name === name) f = n; }); return f; };
  const subVie = find("Sub VIE");
  const subLnz = find("Sub LNZ");
  // The soft bias sends VIE ICs under the VIE sub-leader and LNZ ICs under the
  // LNZ sub-leader — same-location grouping with no span-max violation.
  assert.ok(subVie.children.length > 0 && subVie.children.every((c) => c.person.location === "VIE"),
    `Sub VIE directs should all be VIE: ${subVie.children.map((c) => c.person.location)}`);
  assert.ok(subLnz.children.length > 0 && subLnz.children.every((c) => c.person.location === "LNZ"),
    `Sub LNZ directs should all be LNZ: ${subLnz.children.map((c) => c.person.location)}`);
  walk(result.root, (n) => {
    const real = n.children.filter((c) => c.person.role !== "NSE").length;
    if (real > 0) assert.ok(real <= span.max, `${n.person.name} span ${real} <= ${span.max}`);
  });

  // Deterministic: a second build yields the same manager -> directs mapping.
  resetIds();
  const result2 = buildHierarchy(validatePeople(people).people, { span });
  const mapOf = (r) => {
    const m = {};
    walk(r, (n) => { if (n.children.length) m[n.person.name] = n.children.map((c) => c.person.name).sort(); });
    return m;
  };
  assert.deepEqual(mapOf(result2.root), mapOf(result.root));
});

test("priority order: structural cluster > SPAN_MAX > SPAN_MIN > unknown", () => {
  assert.ok(priorityRank("BU_MISMATCH") < priorityRank("SPAN_MAX"));
  assert.ok(priorityRank("STREAM_SE_LEADS_TA") < priorityRank("SPAN_MAX"));
  assert.ok(priorityRank("NODE_LEAF") < priorityRank("SPAN_MAX"));
  assert.ok(priorityRank("HO_NOT_UNDER_VP") < priorityRank("SPAN_MAX"));
  assert.ok(priorityRank("SPAN_MAX") < priorityRank("SPAN_MIN"));
  assert.ok(priorityRank("SPAN_MIN") < priorityRank("SOME_BUILD_NOTE"));
  assert.equal(priorityRank(undefined), CONSTRAINT_PRIORITY.length);

  const arr = [{ code: "SPAN_MIN" }, { code: undefined }, { code: "SPAN_MAX" }, { code: "BU_MISMATCH" }];
  arr.sort((a, b) => priorityRank(a.code) - priorityRank(b.code));
  assert.deepEqual(arr.map((x) => x.code), ["BU_MISMATCH", "SPAN_MAX", "SPAN_MIN", undefined]);
});

test("balancePriority: location-first groups by location where evenness-first mixes", () => {
  // BU AT, all TA, tuned (span 2/3) so layoutSameRole elects two sub-leaders
  // (VIE, LNZ). 4 VIE + 1 LNZ ICs: evenness spills a VIE IC onto the LNZ sub to
  // stay even; location-first keeps every sub-leader location-pure.
  const span = { min: 2, max: 3 };
  const people = [
    { name: "Val VP", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Ho", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Head VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 3 },
    { name: "Sub VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 2 },
    { name: "Sub LNZ", isPeopleLeader: true, role: "TA", location: "LNZ", level: 2 },
    { name: "IC V1", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V2", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V3", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V4", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC L1", isPeopleLeader: false, role: "TA", location: "LNZ", level: 1 },
  ];
  const build = (mode) => {
    resetIds();
    return buildHierarchy(validatePeople(people).people, { span, balancePriority: mode });
  };
  const find = (r, name) => { let f; walk(r, (n) => { if (n.person.name === name) f = n; }); return f; };
  const mapOf = (r) => { const m = {}; walk(r, (n) => { if (n.children.length) m[n.person.name] = n.children.map((c) => c.person.name).sort(); }); return m; };
  const maxRespected = (r) => { let ok = true; walk(r, (n) => { const real = n.children.filter((c) => c.person.role !== "NSE").length; if (real > span.max) ok = false; }); return ok; };

  const loc = build("location");
  const even = build("evenness");

  // Location-first: both sub-leaders are location-pure.
  assert.ok(find(loc.root, "Sub VIE").children.every((c) => c.person.location === "VIE"), "Sub VIE pure under location-first");
  assert.ok(find(loc.root, "Sub LNZ").children.every((c) => c.person.location === "LNZ"), "Sub LNZ pure under location-first");

  // Evenness-first: the LNZ sub-leader ends up with a non-LNZ direct (mixed).
  assert.ok(!find(even.root, "Sub LNZ").children.every((c) => c.person.location === "LNZ"), "Sub LNZ mixed under evenness-first");

  // The two modes produce different layouts, and neither exceeds span.max.
  assert.notDeepEqual(mapOf(loc.root), mapOf(even.root));
  assert.ok(maxRespected(loc.root) && maxRespected(even.root));

  // Deterministic per mode.
  assert.deepEqual(mapOf(build("location").root), mapOf(loc.root));
});

test("balancePriority: defaults to evenness for missing/invalid mode", () => {
  const span = { min: 2, max: 3 };
  const people = validatePeople([
    { name: "Val VP", isPeopleLeader: true, role: "VP", location: "VIE" },
    { name: "Ho", isPeopleLeader: true, role: "HO", location: "VIE" },
    { name: "Head VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 3 },
    { name: "Sub VIE", isPeopleLeader: true, role: "TA", location: "VIE", level: 2 },
    { name: "Sub LNZ", isPeopleLeader: true, role: "TA", location: "LNZ", level: 2 },
    { name: "IC V1", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V2", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V3", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC V4", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 },
    { name: "IC L1", isPeopleLeader: false, role: "TA", location: "LNZ", level: 1 },
  ]).people;
  const mapOf = (r) => { const m = {}; walk(r, (n) => { if (n.children.length) m[n.person.name] = n.children.map((c) => c.person.name).sort(); }); return m; };
  resetIds(); const dflt = buildHierarchy(people, { span });
  resetIds(); const evenn = buildHierarchy(people, { span, balancePriority: "evenness" });
  resetIds(); const bogus = buildHierarchy(people, { span, balancePriority: "nonsense" });
  assert.deepEqual(mapOf(dflt.root), mapOf(evenn.root));
  assert.deepEqual(mapOf(bogus.root), mapOf(evenn.root));
});

test("balancer is order-independent, idempotent, and never mutates its input", () => {
  const { people } = validatePeople(sample);
  const shape = (root) => { const m = {}; walk(root, (n) => { if (n.children.length) m[n.person.name] = n.children.map((c) => c.person.name).sort(); }); return JSON.stringify(m); };

  resetIds(); const base = buildHierarchy(people, { span: SPAN });
  // Order-independent: reversed input yields the same tree (canonical ordering).
  resetIds(); const rev = buildHierarchy([...people].reverse(), { span: SPAN });
  assert.equal(shape(rev.root), shape(base.root));
  // Idempotent: rebuilding from its own derived people is a fixed point.
  resetIds(); const again = buildHierarchy(toPeople(base.root), { span: SPAN });
  assert.equal(shape(again.root), shape(base.root));
  // Stable across repeated rebalances (no drift).
  let cur = toPeople(base.root);
  for (let i = 0; i < 4; i++) { resetIds(); const r = buildHierarchy(cur, { span: SPAN }); assert.equal(shape(r.root), shape(base.root)); cur = toPeople(r.root); }
  // Never mutates the caller's array.
  const snapshot = JSON.stringify(people);
  resetIds(); buildHierarchy(people, { span: SPAN });
  assert.equal(JSON.stringify(people), snapshot);
});

test("hard-location: balancer builds location-pure subtrees below the HO", () => {
  const { people } = validatePeople(sample);
  resetIds();
  const result = buildHierarchy(people, { span: SPAN, hardLocation: true });
  const streamRole = (r) => (r === "TA" || r === "SE");
  // Every stream-role leader's non-marked directs share the leader's location.
  walk(result.root, (n) => {
    if (!streamRole(n.person.role)) return;
    for (const c of n.children) {
      if (c.person.role === "NSE") continue;
      assert.equal(c.person.location, n.person.location, `${c.person.name} under ${n.person.name} must be same location`);
    }
  });
  // And checkTree with hardLocation finds no LOCATION_MISMATCH on the built tree.
  const rep = checkTree(result.root, { span: SPAN, hardLocation: true });
  assert.equal(rep.errors.filter((e) => e.code === "LOCATION_MISMATCH").length, 0);
});

test("hard-location: LOCATION_MISMATCH and checkMove only enforce when opted in", () => {
  resetIds();
  const root = makeNode({ name: "VP", isPeopleLeader: true, role: "VP", location: "VIE" });
  const ho = makeNode({ name: "HO", isPeopleLeader: true, role: "HO", location: "VIE" }); attach(root, ho);
  const lead = makeNode({ name: "Lead", isPeopleLeader: true, role: "TA", location: "VIE", level: 3 }); attach(ho, lead);
  attach(lead, makeNode({ name: "Same", isPeopleLeader: false, role: "TA", location: "VIE", level: 1 }));
  const cross = makeNode({ name: "Cross", isPeopleLeader: false, role: "TA", location: "RIE", level: 1 }); attach(lead, cross);

  // RIE and VIE share BU AT, so BU is clean — isolating the location rule.
  assert.equal(checkTree(root, { span: SPAN }).errors.filter((e) => e.code === "LOCATION_MISMATCH").length, 0);
  const hard = checkTree(root, { span: SPAN, hardLocation: true }).errors.filter((e) => e.code === "LOCATION_MISMATCH");
  assert.equal(hard.length, 1);
  assert.equal(hard[0].name, "Cross");

  // checkMove: a cross-location report is rejected only under hard-location.
  assert.equal(checkMove(root, cross.id, lead.id, { span: SPAN }).ok, true);
  const mv = checkMove(root, cross.id, lead.id, { span: SPAN, hardLocation: true });
  assert.equal(mv.ok, false);
  assert.ok(mv.reasons.some((r) => /hard-location/.test(r)));

  // The HO (cross-location) may still lead a different-location report.
  assert.equal(checkMove(root, cross.id, ho.id, { span: SPAN, hardLocation: true }).ok, true);
});
