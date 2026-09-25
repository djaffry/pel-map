import { buOf, streamRoleOf, DEFAULT_SPAN, levelOf, isMarked, isNode, ROLE_MAX_LEVEL } from "./model.js";
import { toPeople } from "./tree.js";

export function planCapacity(peopleOrRoot, opts = {}) {
  const span = normalizeSpan(opts.span);
  const people = toPeopleArray(peopleOrRoot);
  const pins = Array.isArray(opts.pins) ? opts.pins : [];

  const stream = streamPeople(people);
  const streamDemand = streamPeopleNeedingBULeadership(stream, people, pins);
  const consolidated = planBUs(streamDemand, span.max);
  const byBUPlans = spreadSmallBUs(consolidated, span.max);
  const needs = aggregateNeeds(byBUPlans);

  return {
    span,
    totalStream: stream.length,
    currentLeaders: stream.filter(isNode).length,
    addLeaders: byBUPlans.reduce((sum, b) => sum + b.add, 0),
    byBU: byBUPlans,
    needs,
  };
}

function normalizeSpan(span) {
  const s = span ?? DEFAULT_SPAN;
  const min = Math.max(1, Math.floor(s.min));
  const max = Math.max(min, Math.floor(s.max));
  return { min, max };
}

function toPeopleArray(peopleOrRoot) {
  if (!peopleOrRoot) return [];
  if (Array.isArray(peopleOrRoot)) return peopleOrRoot;
  if (typeof peopleOrRoot === "object" && "person" in peopleOrRoot) return toPeople(peopleOrRoot);
  return [];
}

function streamPeople(people) {
  return people.filter((p) => streamRoleOf(p) && !isMarked(p));
}

function streamPeopleNeedingBULeadership(stream, people, pins) {
  const childToParent = new Map(pins.filter((p) => p && p.child).map((p) => [p.child, p.parent]));
  const topNames = new Set(people.filter((p) => p.role === "HO" || p.role === "VP").map((p) => p.name));

  // Leadership is solely the isPeopleLeader flag; pins and demoted nodes do not add capacity.
  return stream.filter((p) => !isPrePlacedStreamIC(p, childToParent, topNames));
}

function planBUs(stream, max) {
  const byBU = groupByBU(stream);
  return [...byBU.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bu, members]) => planBU(bu, members, max));
}

function spreadSmallBUs(plans, max) {
  // Consolidating costs one HO slot per BU; spreading saves leaders but spends one HO slot per person.
  let roots = plans.length;
  const spread = new Set();

  for (const p of [...plans].sort((a, b) => a.total - b.total)) {
    if (p.add <= 0) continue;
    const extraRoots = p.total - 1;
    if (roots + extraRoots <= max) {
      spread.add(p.bu);
      roots += extraRoots;
    }
  }

  if (!spread.size) return plans;
  return plans.map((p) => (spread.has(p.bu) ? toSpreadPlan(p) : p));
}

function aggregateNeeds(byBUPlans) {
  const needMap = new Map();
  for (const b of byBUPlans) {
    for (const r of b.roles) {
      for (const pos of r.positions) {
        const key = `${b.bu}|${r.role}|${pos.level}`;
        let need = needMap.get(key);
        if (!need) {
          need = { bu: b.bu, role: r.role, level: pos.level, count: 0 };
          needMap.set(key, need);
        }
        need.count += 1;
      }
    }
  }
  return [...needMap.values()].sort(
    (a, b) => a.bu.localeCompare(b.bu) || a.role.localeCompare(b.role) || (b.level ?? 0) - (a.level ?? 0)
  );
}

function isPrePlacedStreamIC(person, childToParent, topNames) {
  return !isNode(person) && topNames.has(childToParent.get(person.name));
}

function groupByBU(stream) {
  const byBU = new Map();
  for (const person of stream) {
    const bu = buOf(person.location);
    if (!bu) continue;
    const members = byBU.get(bu);
    if (members) members.push(person);
    else byBU.set(bu, [person]);
  }
  return byBU;
}

function toSpreadPlan(p) {
  return {
    ...p,
    add: 0,
    roles: p.roles.map((r) => ({ ...r, needed: r.leaders, add: 0, positions: [] })),
  };
}

function planBU(bu, members, max) {
  const ta = members.filter((p) => p.role === "TA");
  const se = members.filter((p) => p.role === "SE");
  const nTA = ta.length;
  const nSE = se.length;
  const taLeadersCur = ta.filter(isNode).length;
  const seLeadersCur = se.filter(isNode).length;
  const { newTA, newSE } = findAdditionalLeaders(taLeadersCur, seLeadersCur, nTA, nSE, max);

  const roles = [
    makeRolePlan("TA", ta, taLeadersCur, taLeadersCur + newTA, newTA, bu, nTA > 0),
    makeRolePlan("SE", se, seLeadersCur, seLeadersCur + newSE, newSE, bu, nTA > 0),
  ].filter((r) => r.people > 0);

  return {
    bu,
    total: nTA + nSE,
    add: newTA + newSE,
    roles,
  };
}

function findAdditionalLeaders(taLeadersCur, seLeadersCur, nTA, nSE, max) {
  const addMax = nTA + nSE;
  for (let add = 0; add <= addMax; add++) {
    for (let nt = 0; nt <= add; nt++) {
      const ns = add - nt;
      const t = taLeadersCur + nt;
      const s = seLeadersCur + ns;
      if (t > nTA || s > nSE) continue;
      if (feasibleSplit(t, s, nTA, nSE, max)) return { newTA: nt, newSE: ns };
    }
  }
  return { newTA: 0, newSE: 0 };
}

function feasibleSplit(t, s, nTA, nSE, max) {
  const total = nTA + nSE;

  if (nTA === 0) {
    return s * max >= Math.max(0, nSE - 1);
  }

  if (t < 1 && total > 1) return false;

  // TA leaders host non-head TA nodes plus bridged SE leaders; all leaders cover the subtree.
  return t * max - s >= nTA - 1 && (t + s) * max >= total - 1;
}

function makeRolePlan(role, rolePeople, leadersCur, needed, add, bu, hasTA) {
  const level = rolePeople.reduce((m, p) => Math.max(m, levelOf(p) ?? 0), 0) || ROLE_MAX_LEVEL[role];
  const positions = Array.from({ length: add }, (_, i) => ({
    role,
    level,
    bu,
    reportsTo: placementFor(role, bu, leadersCur, i, hasTA),
  }));

  return {
    role,
    people: rolePeople.length,
    ics: rolePeople.filter((p) => !isNode(p)).length,
    leaders: leadersCur,
    needed,
    add,
    positions,
  };
}

function placementFor(role, bu, leadersCur, i, hasTA) {
  if (role === "TA") {
    return leadersCur === 0 && i === 0 ? "the HO" : `the ${bu} TA lead`;
  }
  if (hasTA) return `a TA lead in ${bu}`;
  return leadersCur === 0 && i === 0 ? "the HO" : `the ${bu} SE lead`;
}
