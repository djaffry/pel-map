import { buOf, isNode, DEFAULT_SPAN, isMarked, levelOf, compareBySeniority, locationRank, streamRoleOf } from "./model.js";
import { makeNode, attach, walk, reparent } from "./tree.js";
import { checkTree, checkMove } from "./constraints.js";

const SAME_LOC_SLACK = 1;

export function buildHierarchy(people, opts = {}) {
  const span = normalizeSpan(opts.span);
  const pins = opts.pins ?? [];
  const keepInPlace = opts.keepInPlace ?? {};
  const mode = balanceMode(opts.balancePriority);
  const hardLocation = opts.hardLocation === true;
  const notes = [];

  if (!people.length) {
    return { root: null, metrics: emptyMetrics(), constraints: { ok: true, errors: [], warnings: [] }, notes };
  }

  const ordered = copyInDeterministicBalancingOrder(people);
  const groups = splitBalancingPopulation(ordered);
  const rootPerson = chooseRootPerson(groups, ordered, notes);
  const root = createRootWithExtraVPs(rootPerson, groups.vps);
  const hoNode = electSingleHO(root, groups.hos, groups.stream, notes);
  const streamManager = hoNode ?? root;

  attachStreamSubtreesGroupedByActivePurityBoundary(streamManager, groups.stream, span, notes, mode, hardLocation);
  optimizeDepthUnderHO(root, hoNode, span, hardLocation, mode, notes);

  if (pins.length) enforcePins(root, pins, notes);
  if (groups.marked.length) keepMarkedNSELeavesUnderPriorManagers(root, rootPerson, groups.marked, keepInPlace, notes);

  const constraints = checkTree(root, { span });
  const metrics = computeMetrics(root);
  return { root, metrics, constraints, notes };
}

function enforcePins(root, pins, notes) {
  for (const pin of pins) {
    if (!pin || !pin.parent || !pin.child || pin.parent === pin.child) continue;

    const byName = indexNodesByFirstName(root);
    const parent = byName[pin.parent];
    const child = byName[pin.child];
    if (!parent || !child) {
      notes.push({ code: "PIN_MISSING", message: `Fixed link "${pin.parent}" → "${pin.child}": person not found.` });
      continue;
    }
    if (child.parentId === parent.id) continue;
    const res = reparent(root, child.id, parent.id);
    if (!res.ok) {
      notes.push({ code: "PIN_SKIPPED", message: `Fixed link "${pin.parent}" → "${pin.child}" not applied: ${res.reason}` });
    } else {
      notes.push({ code: "PIN_APPLIED", message: `Fixed link kept: "${pin.child}" reports to "${pin.parent}".` });
    }
  }
}

export function computeMetrics(root) {
  let nodes = 0;
  let leaders = 0;
  let ics = 0;
  let marked = 0;
  let maxDepth = 0;
  const spans = [];

  walk(root, (n, depth) => {
    nodes++;
    if (isMarked(n.person)) {
      marked++;
    } else if (n.person.isPeopleLeader) {
      leaders++;
    } else {
      ics++;
    }
    if (depth > maxDepth) maxDepth = depth;
    if (isMarked(n.person)) return;

    const realChildren = realChildCount(n);
    if (realChildren > 0) spans.push(realChildren);
  });

  const spanCount = spans.length;
  const spanMin = spanCount ? Math.min(...spans) : 0;
  const spanMax = spanCount ? Math.max(...spans) : 0;
  const mean = spanCount ? spans.reduce((a, b) => a + b, 0) / spanCount : 0;
  const variance = spanCount ? spans.reduce((a, b) => a + (b - mean) ** 2, 0) / spanCount : 0;
  return {
    people: nodes,
    leaders,
    ics,
    marked,
    depth: maxDepth,
    internalNodes: spanCount,
    span: { min: spanMin, max: spanMax, mean: round(mean), variance: round(variance) },
  };
}

export function emptyMetrics() {
  return { people: 0, leaders: 0, ics: 0, marked: 0, depth: 0, internalNodes: 0, span: { min: 0, max: 0, mean: 0, variance: 0 } };
}

function copyInDeterministicBalancingOrder(people) {
  return [...people].sort(compareCanonical);
}

function compareCanonical(a, b) {
  return compareBySeniority(a, b)
    || (locationRank(a.location) - locationRank(b.location))
    || String(a.name).localeCompare(String(b.name));
}

function splitBalancingPopulation(ordered) {
  return {
    vps: ordered.filter((p) => p.role === "VP"),
    hos: ordered.filter((p) => p.role === "HO"),
    stream: ordered.filter((p) => p.role === "TA" || p.role === "SE"),
    marked: ordered.filter((p) => isMarked(p)),
  };
}

function chooseRootPerson(groups, ordered, notes) {
  const { vps, hos, stream } = groups;
  if (vps.length) {
    if (vps.length > 1) {
      notes.push({ code: "MULTI_VP", message: `${vps.length} VPs found; using "${vps[0].name}" as root, others attached under it.` });
    }
    return vps[0];
  }

  const rootPerson = hos[0] || stream[0] || ordered.find((p) => !isMarked(p)) || ordered[0];
  notes.push({ code: "NO_VP", message: `No VP found; using "${rootPerson.name}" as a stand-in root.` });
  return rootPerson;
}

function createRootWithExtraVPs(rootPerson, vps) {
  const root = makeNode(rootPerson);
  for (const extra of vps.slice(1)) attach(root, makeNode(extra));
  return root;
}

function electSingleHO(root, hos, stream, notes) {
  if (hos.length) {
    const hoNode = makeNode(hos[0]);
    attach(root, hoNode);
    attachExtraHOsToSurfaceConstraint(root, hos, notes);
    return hoNode;
  }

  if (stream.length) {
    notes.push({ code: "NO_HO", message: `No HO found; stream members attach under the VP (an HO is required to lead them).` });
  }
  return undefined;
}

function attachExtraHOsToSurfaceConstraint(root, hos, notes) {
  if (hos.length <= 1) return;
  notes.push({ code: "MULTI_HO", message: `${hos.length} HOs found; "${hos[0].name}" leads the stream, extras attached under the VP (flagged).` });
  for (const extra of hos.slice(1)) attach(root, makeNode(extra));
}

function attachStreamSubtreesGroupedByActivePurityBoundary(streamManager, stream, span, notes, mode, hardLocation) {
  const streamGroups = groupBy(stream, activeStreamPurityBoundaryKey(hardLocation));
  for (const [, members] of streamGroups) {
    buildBU(streamManager, members, span, notes, mode);
  }
}

function activeStreamPurityBoundaryKey(hardLocation) {
  return hardLocation ? streamLocationBoundaryKey : streamBUBoundaryKey;
}

function streamLocationBoundaryKey(person) {
  return person.location;
}

function streamBUBoundaryKey(person) {
  return buOf(person.location);
}

function optimizeDepthUnderHO(root, hoNode, span, hardLocation, mode, notes) {
  if (!hoNode) return;

  flattenDepthUnderHO(root, hoNode, span, notes);
  refillSlotsFreedByDepthFlattening(root, span, hardLocation, mode, notes);
}

function keepMarkedNSELeavesUnderPriorManagers(root, rootPerson, marked, keepInPlace, notes) {
  const byName = indexNodesByFirstName(root);
  for (const person of marked) {
    if (person.name === rootPerson.name) continue;
    if (byName[person.name]) continue;
    const parentName = keepInPlace[person.name];
    const parent = (parentName && byName[parentName]) || root;
    const node = makeNode(person);
    attach(parent, node);
    byName[person.name] = node;
  }
  if (marked.length) {
    notes.push({ code: "MARKED_KEPT", message: `${marked.length} non-SE (marked) person(s) kept in place, excluded from balancing.` });
  }
}

function buildBU(manager, buPeople, span, notes, mode = "evenness") {
  if (!buPeople.length) return;

  const { ta, se, taLeaders, seLeaders } = splitStreamRoles(buPeople);
  if (taLeaders.length) {
    buildTaLedSubtree(manager, ta, se, taLeaders, span, notes, mode);
    return;
  }
  if (seLeaders.length) {
    buildSeLedSubtree(manager, ta, se, seLeaders, span, notes, mode);
    return;
  }
  attachLeaderlessStreamPeople(manager, buPeople, span, notes);
}

function splitStreamRoles(people) {
  const ta = people.filter((p) => p.role === "TA");
  const se = people.filter((p) => p.role === "SE");
  return {
    ta,
    se,
    taLeaders: ta.filter(isNode),
    seLeaders: se.filter(isNode),
  };
}

function buildTaLedSubtree(manager, ta, se, taLeaders, span, notes, mode) {
  const [head] = pickHeads(taLeaders, 1);
  const headNode = makeNode(head);
  attach(manager, headNode);
  layoutSameRole(headNode, ta.filter((p) => p !== head), span, notes, mode);
  if (se.length) attachSEThroughSingleBreakAtTAHead(headNode, se, span, notes, mode);
}

function buildSeLedSubtree(manager, ta, se, seLeaders, span, notes, mode) {
  const [head] = pickHeads(seLeaders, 1);
  const headNode = makeNode(head);
  attach(manager, headNode);
  layoutSameRole(headNode, se.filter((p) => p !== head), span, notes, mode);

  attachAll(manager, ta);
  if (ta.length) {
    notes.push({ nodeId: manager.id, code: "NO_TA_LEADER", message: `${ta.length} TA(s) have no TA leader in their BU; attached under ${manager.person.name}.` });
  }
}

function attachLeaderlessStreamPeople(manager, buPeople, span, notes) {
  for (const p of buPeople) attach(manager, makeNode(p));
  if (buPeople.length > span.max) {
    notes.push({ nodeId: manager.id, code: "NO_LEADERS", message: `${manager.person.name}: ${buPeople.length} stream reports but no people leaders to layer them.` });
  }
}

function flattenDepthUnderHO(root, ho, span, notes) {
  let lifted = 0;
  while (realChildCount(ho) < span.max) {
    const best = deepestLiftableGrandchild(ho, span);
    if (!best) break;
    if (!reparent(root, best.node.id, ho.id).ok) break;
    lifted++;
  }
  if (lifted) {
    notes.push({ nodeId: ho.id, code: "DEPTH_FLATTENED", message: `${lifted} lead(s) lifted directly under ${ho.person.name} to reduce depth (HO span now ${realChildCount(ho)}/${span.max}).` });
  }
}

function deepestLiftableGrandchild(ho, span) {
  let best = null;
  for (const parent of ho.children) {
    if (!canLoseLiftedChildWithoutDroppingBelowMinSpan(parent, span)) continue;
    for (const grandchild of parent.children) {
      if (!canLiftSameRoleSubLeadWithoutRemovingTaSeBreak(parent, grandchild)) continue;
      const cand = { node: grandchild, height: subtreeHeight(grandchild), load: realChildCount(grandchild) };
      if (!best || betterLift(cand, best)) best = cand;
    }
  }
  return best;
}

function canLoseLiftedChildWithoutDroppingBelowMinSpan(parent, span) {
  return !isMarked(parent.person) && realChildCount(parent) - 1 >= span.min;
}

function canLiftSameRoleSubLeadWithoutRemovingTaSeBreak(parent, grandchild) {
  return !isMarked(grandchild.person)
    && isNode(grandchild.person)
    && grandchild.person.role === parent.person.role
    && realChildCount(grandchild) !== 0;
}

function betterLift(a, b) {
  if (a.height !== b.height) return a.height > b.height;
  if (a.load !== b.load) return a.load > b.load;
  return String(a.node.person.name) < String(b.node.person.name);
}

function subtreeHeight(node) {
  let h = 0;
  for (const c of node.children) {
    if (isMarked(c.person)) continue;
    h = Math.max(h, 1 + subtreeHeight(c));
  }
  return h;
}

function refillSlotsFreedByDepthFlattening(root, span, hardLocation, mode, notes) {
  let moves = 0;
  for (;;) {
    const move = findSpanEveningLeafMove(root, span, hardLocation, mode);
    if (!move) break;
    reparent(root, move.leaf.id, move.to.id);
    moves++;
  }
  if (moves) {
    notes.push({ code: "EVENED", message: `${moves} report(s) rebalanced to even spans after depth flattening.` });
  }
}

function findSpanEveningLeafMove(root, span, hardLocation, mode) {
  const leaders = collectStreamRoleLeadersByDescendingLoad(root);
  for (let i = 0; i < leaders.length; i++) {
    const from = leaders[i];
    const fromLoad = realChildCount(from);
    for (let j = leaders.length - 1; j > i; j--) {
      const to = leaders[j];
      if (fromLoad - realChildCount(to) < 2) break;
      const leaf = firstMovableLeaf(from, to, root, span, hardLocation, mode);
      if (leaf) return { leaf, to };
    }
  }
  return null;
}

function collectStreamRoleLeadersByDescendingLoad(root) {
  const leaders = [];
  walk(root, (n) => { if (isNode(n.person) && !isMarked(n.person) && streamRoleOf(n.person)) leaders.push(n); });
  leaders.sort((a, b) => realChildCount(b) - realChildCount(a) || cmpByName(a, b));
  return leaders;
}

function firstMovableLeaf(from, to, root, span, hardLocation, mode) {
  let leaves = from.children.filter((c) => !isNode(c.person) && !isMarked(c.person));
  if (mode === "location") leaves = leaves.filter((leaf) => leaf.person.location === to.person.location);
  leaves.sort((a, b) => sameLoc(b, to) - sameLoc(a, to) || cmpByName(a, b));
  return leaves.find((leaf) => checkMove(root, leaf.id, to.id, { span, pins: [], hardLocation }).ok);
}

function attachSEThroughSingleBreakAtTAHead(taRoot, se, span, notes, mode = "evenness") {
  const seLeaders = se.filter(isNode).sort(compareByLevelDesc);
  const seICs = se.filter((p) => !isNode(p));
  const seLeaderNodes = attachSELeadersToTAHosts(taRoot, seLeaders, span);
  distributeSEICs(taRoot, seICs, seLeaderNodes, span, notes, mode);
}

function attachSELeadersToTAHosts(taRoot, seLeaders, span) {
  const seLeaderNodes = [];
  for (const leader of seLeaders) {
    const host = taHostWithRoom(taRoot, span) ?? taRoot;
    const node = makeNode(leader);
    attach(host, node);
    seLeaderNodes.push(node);
  }
  return seLeaderNodes;
}

function distributeSEICs(taRoot, seICs, seLeaderNodes, span, notes, mode) {
  const taHosts = collectTAHosts(taRoot);
  let overflowed = false;
  for (const ic of seICs) {
    const best = pickSEManagerForIC(taRoot, ic, seLeaderNodes, taHosts, span, mode);
    if (best === taRoot && realChildCount(taRoot) >= span.max) overflowed = true;
    attach(best, makeNode(ic));
  }
  if (overflowed) {
    notes.push({ nodeId: taRoot.id, code: "SE_OVERFLOW", message: `${taRoot.person.name}'s BU has more SE reports than its leaders can hold within max span.` });
  }
}

function pickSEManagerForIC(taRoot, ic, seLeaderNodes, taHosts, span, mode) {
  const icLevel = levelOf(ic) ?? 0;
  const seLeadersAtOrAboveICLevel = seLeaderNodes.filter((m) => (levelOf(m.person) ?? 0) >= icLevel);
  const taHostsWithBreakLevelExemption = taHosts;
  const managers = [
    ...seLeadersAtOrAboveICLevel,
    ...taHostsWithBreakLevelExemption,
  ];
  const slots = managers.map((m) => ({ load: realChildCount(m), cap: span.max, loc: m.person.location }));
  const idx = pickSlot(slots, ic.location, { mode });
  return idx < 0 ? taRoot : managers[idx];
}

function taHostWithRoom(root, span) {
  for (const n of collectTAHosts(root)) {
    if (realChildCount(n) < span.max) return n;
  }
  return undefined;
}

function collectTAHosts(root) {
  const hosts = [];
  const queue = [root];
  while (queue.length) {
    const n = queue.shift();
    if (n.person.role === "TA" && n.person.isPeopleLeader === true) hosts.push(n);
    for (const c of n.children) queue.push(c);
  }
  return hosts;
}

function layoutSameRole(manager, people, span, notes, mode = "evenness") {
  if (!people.length) return;
  if (people.length <= span.max) {
    attachAll(manager, people);
    return;
  }

  const leaders = people.filter(isNode).sort(compareByLevelDesc);
  if (!leaders.length) {
    attachAll(manager, people);
    notes.push({ nodeId: manager.id, code: "NO_LEADERS", message: `${manager.person.name}: ${people.length} reports but no sub-leaders available (span relaxed).` });
    return;
  }

  const k = chooseSubLeaderCount(leaders, people.length, span);
  const subs = leaders.slice(0, k);
  const rest = people.filter((p) => !subs.includes(p));
  const subNodes = attachSubLeaders(manager, subs);
  const buckets = distributeSameRoleReports(manager, rest, subs, k, span, mode);

  attachAll(manager, buckets[0]);
  for (let i = 0; i < k; i++) layoutSameRole(subNodes[i], buckets[i + 1], span, notes, mode);
}

function chooseSubLeaderCount(leaders, peopleCount, span) {
  const fits = (k) => (span.max - k) + k * span.max >= peopleCount - k;
  let k = 1;
  while (k < leaders.length && !fits(k)) k++;
  return k;
}

function attachSubLeaders(manager, subs) {
  return subs.map((sub) => {
    const node = makeNode(sub);
    attach(manager, node);
    return node;
  });
}

function distributeSameRoleReports(manager, rest, subs, k, span, mode) {
  const managerCapacityAfterSubLeaderSlots = Math.max(0, span.max - k);
  const caps = [managerCapacityAfterSubLeaderSlots, ...subs.map(() => span.max)];
  const locs = [manager.person.location, ...subs.map((s) => s.location)];
  const buckets = caps.map(() => []);
  distributeBalanced(rest, buckets, caps, locs, mode);
  return buckets;
}

function distributeBalanced(items, buckets, caps, locs = [], mode = "evenness") {
  for (const it of items) {
    const slots = buckets.map((b, i) => ({ load: b.length, cap: caps[i], loc: locs[i] }));
    let best = pickSlot(slots, it.location, { mode });
    if (best < 0) best = buckets.length - 1;
    buckets[best].push(it);
  }
}

function pickSlot(slots, itemLoc, opts = {}) {
  const mode = balanceMode(opts.mode);
  const slack = opts.slack ?? SAME_LOC_SLACK;
  let min = Infinity;
  for (const s of slots) if (s.load < s.cap && s.load < min) min = s.load;
  if (min === Infinity) return -1;

  const biased = pickSameLocationSlot(slots, itemLoc, mode, slack, min);
  return biased >= 0 ? biased : pickLeastLoadedSlot(slots, min);
}

function pickSameLocationSlot(slots, itemLoc, mode, slack, min) {
  let biased = -1;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.load >= s.cap) continue;
    if (s.loc === undefined || s.loc !== itemLoc) continue;
    if (mode !== "location" && s.load > min + slack) continue;
    if (biased < 0 || s.load < slots[biased].load) biased = i;
  }
  return biased;
}

function pickLeastLoadedSlot(slots, min) {
  for (let i = 0; i < slots.length; i++) {
    if (slots[i].load < slots[i].cap && slots[i].load === min) return i;
  }
  return -1;
}

function pickHeads(leaders, g) {
  const ranked = [...leaders].sort(compareByLevelDesc);
  const picked = [];
  const usedLoc = new Set();
  for (const leader of ranked) {
    if (picked.length >= g) break;
    if (!usedLoc.has(leader.location)) {
      picked.push(leader);
      usedLoc.add(leader.location);
    }
  }
  for (const leader of ranked) {
    if (picked.length >= g) break;
    if (!picked.includes(leader)) picked.push(leader);
  }
  return picked;
}

function attachAll(manager, people) {
  for (const person of people) attach(manager, makeNode(person));
}

function realChildCount(node) {
  return node.children.filter((c) => !isMarked(c.person)).length;
}

function sameLoc(a, b) {
  return a.person.location === b.person.location ? 1 : 0;
}

function cmpByName(a, b) {
  return String(a.person.name).localeCompare(String(b.person.name));
}

function compareByLevelDesc(a, b) {
  return (levelOf(b) ?? 0) - (levelOf(a) ?? 0);
}

function indexNodesByFirstName(root) {
  const byName = {};
  walk(root, (n) => { if (!(n.person.name in byName)) byName[n.person.name] = n; });
  return byName;
}

function balanceMode(mode) {
  return mode === "location" ? "location" : "evenness";
}

function normalizeSpan(span) {
  const s = span ?? DEFAULT_SPAN;
  const min = Math.max(1, Math.floor(s.min));
  const max = Math.max(min, Math.floor(s.max));
  return { min, max };
}

function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const k = keyOf(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(item);
  }
  return map;
}

function round(n) {
  return Math.round(n * 100) / 100;
}
