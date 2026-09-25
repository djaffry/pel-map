import { buOf, streamRoleOf, STREAM_ROLES, DEFAULT_SPAN, levelOf, isMarked } from "./model.js";
import { walk, isAncestor } from "./tree.js";

export function checkTree(root, opts = {}) {
  const span = opts.span ?? DEFAULT_SPAN;
  const errors = [];
  const warnings = [];

  checkOnlyPeopleLeadersHaveReports(root, errors);
  checkDirectReportSpan(root, span, errors, warnings);
  checkStreamRoleOrder(root, errors);
  checkStreamBuPurity(root, errors);
  if (opts.hardLocation) checkHardLocationEdges(root, errors);
  checkSameRoleLevelOrder(root, errors);
  checkTopOfOrgStructure(root, errors);

  return { ok: errors.length === 0, errors, warnings };
}

export function checkMove(root, nodeId, newParentId, opts = {}) {
  const span = opts.span ?? DEFAULT_SPAN;
  const pins = opts.pins ?? [];
  const hardLocation = opts.hardLocation === true;
  const reasons = [];
  const index = indexTreeById(root);

  const node = index.get(nodeId);
  const parent = index.get(newParentId);
  if (!node) return { ok: false, reasons: ["Node not found."] };
  if (!parent) return { ok: false, reasons: ["Target parent not found."] };

  addMoveCycleReasons(root, nodeId, newParentId, reasons);
  addTargetLeaderReason(parent, reasons);
  addTopOfOrgMoveReasons(node, parent, reasons);
  addSpanMoveReason(node, parent, span, reasons);
  addStreamMoveReasons(index, node, parent, newParentId, reasons);
  addBuMoveReason(node, parent, reasons);
  addHardLocationMoveReason(node, parent, hardLocation, reasons);
  addFixedLinkMoveReason(node, parent, pins, reasons);

  return { ok: reasons.length === 0, reasons };
}

export function priorityRank(code) {
  const i = code ? CONSTRAINT_PRIORITY.indexOf(code) : -1;
  return i < 0 ? CONSTRAINT_PRIORITY.length : i;
}

export const CONSTRAINT_PRIORITY = [
  "BU_MISMATCH",
  "LOCATION_MISMATCH",
  "STREAM_SE_LEADS_TA",
  "STREAM_SECOND_BREAK",
  "LEVEL_INVERSION",
  "NODE_LEAF",
  "PARENT_NOT_LEADER",
  "VP_LEADS_STREAM",
  "MULTI_HO",
  "HO_NOT_UNDER_VP",
  "SPAN_MAX",
  "SPAN_MIN",
];

function checkOnlyPeopleLeadersHaveReports(root, errors) {
  walk(root, (node) => {
    if (isMarked(node.person)) return;
    const realChildren = realChildrenOf(node);
    if (realChildren.length === 0 || node.person.isPeopleLeader === true) return;

    errors.push(violation(node, "NODE_LEAF", `${node.person.name} has reports but is not a people leader.`));
    addParentNotLeaderViolations(node, realChildren, errors);
  });
}

function addParentNotLeaderViolations(parent, children, errors) {
  for (const child of children) {
    errors.push(violation(child, "PARENT_NOT_LEADER", `${child.person.name} reports to ${parent.person.name}, who is not a people leader.`));
  }
}

function checkDirectReportSpan(root, span, errors, warnings) {
  walk(root, (node) => {
    if (isMarked(node.person)) return;
    const count = realChildrenOf(node).length;
    if (count === 0) return;
    if (exceedsMaxSpan(count, span)) {
      errors.push(violation(node, "SPAN_MAX", `${node.person.name} has ${count} directs (> max ${span.max}).`));
    } else if (fallsBelowMinSpan(count, span)) {
      // Small BUs can be valid below min, so SPAN_MIN stays a warning.
      warnings.push(violation(node, "SPAN_MIN", `${node.person.name} has ${count} directs (< min ${span.min}).`));
    }
  });
}

function exceedsMaxSpan(count, span) {
  return count > span.max;
}

function fallsBelowMinSpan(count, span) {
  return count < span.min;
}

function checkStreamRoleOrder(root, errors) {
  const recur = (node, breakUsed) => {
    const parentRole = streamRoleOf(node.person);
    for (const child of node.children) {
      if (isMarked(child.person)) continue;
      const childBreakUsed = addStreamRoleOrderViolations(node, child, parentRole, breakUsed, errors);
      recur(child, childBreakUsed);
    }
  };
  recur(root, false);
}

function addStreamRoleOrderViolations(parent, child, parentRole, breakUsed, errors) {
  const childRole = streamRoleOf(child.person);
  if (!parentRole || !childRole) return breakUsed;

  if (seLeadsTa(parentRole, childRole)) {
    errors.push(violation(child, "STREAM_SE_LEADS_TA", `${parent.person.name} (SE) cannot lead ${child.person.name} (TA).`));
    return breakUsed;
  }

  if (taLeadsSe(parentRole, childRole)) {
    if (breakUsed) {
      // Redundant for validity, but clearer for invalid pinned/manual branches.
      errors.push(violation(child, "STREAM_SECOND_BREAK", `Second TA→SE break under ${parent.person.name} (only one allowed per branch).`));
      return breakUsed;
    }
    return true;
  }

  return breakUsed;
}

function seLeadsTa(parentRole, childRole) {
  return parentRole === "SE" && childRole === "TA";
}

function taLeadsSe(parentRole, childRole) {
  return parentRole === "TA" && childRole === "SE";
}

function checkStreamBuPurity(root, errors) {
  const recur = (node, streamBU) => {
    const childBU = streamBuForDescendants(node, streamBU, errors);
    for (const child of node.children) {
      if (isMarked(child.person)) continue;
      recur(child, childBU);
    }
  };
  recur(root, undefined);
}

function streamBuForDescendants(node, streamBU, errors) {
  if (!STREAM_ROLES.has(node.person.role)) return undefined;

  const own = buOf(node.person.location);
  if (streamBU === undefined) return own;

  if (own !== streamBU) {
    errors.push(violation(node, "BU_MISMATCH", `${node.person.name} is in BU ${own} but its stream branch is BU ${streamBU}.`));
  }
  return streamBU;
}

function checkHardLocationEdges(root, errors) {
  walk(root, (node) => {
    if (isMarked(node.person)) return;
    if (!streamRoleOf(node.person)) return;
    for (const child of node.children) {
      if (isMarked(child.person)) continue;
      if (locationsDiffer(node, child)) {
        errors.push(violation(child, "LOCATION_MISMATCH", `${child.person.name} (${child.person.location}) reports to ${node.person.name} (${node.person.location}); a people leader may only lead their own location.`));
      }
    }
  });
}

function locationsDiffer(parent, child) {
  return child.person.location !== parent.person.location;
}

function checkSameRoleLevelOrder(root, errors) {
  walk(root, (node) => {
    const parentStreamRole = streamRoleOf(node.person);
    if (!parentStreamRole) return;
    const parentLevel = levelOf(node.person);
    for (const child of node.children) {
      if (isMarked(child.person)) continue;
      if (streamRoleOf(child.person) !== parentStreamRole) continue;
      const childLevel = levelOf(child.person);
      if (childOutranksSameRoleManager(childLevel, parentLevel)) {
        errors.push(violation(child, "LEVEL_INVERSION", `${node.person.name} (${parentStreamRole} L${parentLevel}) cannot lead higher-level ${child.person.name} (${parentStreamRole} L${childLevel}).`));
      }
    }
  });
}

function childOutranksSameRoleManager(childLevel, parentLevel) {
  return childLevel > parentLevel;
}

function checkTopOfOrgStructure(root, errors) {
  const hos = [];
  const byId = indexTreeById(root);

  walk(root, (node) => {
    if (isMarked(node.person)) return;
    if (node.person.role === "VP") addVpDirectStreamViolations(node, errors);
    if (node.person.role === "HO") addHoStructureViolations(node, byId, hos, errors);
  });

  addExtraHoViolations(hos, errors);
}

function addVpDirectStreamViolations(vp, errors) {
  for (const child of vp.children) {
    if (isMarked(child.person)) continue;
    if (streamRoleOf(child.person)) {
      errors.push(violation(child, "VP_LEADS_STREAM", `${child.person.name} (${child.person.role}) reports directly to VP ${vp.person.name}; an HO must lead the stream.`));
    }
  }
}

function addHoStructureViolations(ho, byId, hos, errors) {
  hos.push(ho);
  const parent = ho.parentId ? byId.get(ho.parentId) : undefined;
  if (!parent || parent.person.role !== "VP") {
    errors.push(violation(ho, "HO_NOT_UNDER_VP", `HO ${ho.person.name} must report directly to the VP.`));
  }
}

function addExtraHoViolations(hos, errors) {
  for (let i = 1; i < hos.length; i++) {
    const ho = hos[i];
    errors.push(violation(ho, "MULTI_HO", `Only one HO is allowed; ${ho.person.name} is an extra HO.`));
  }
}

function addMoveCycleReasons(root, nodeId, newParentId, reasons) {
  if (nodeId === root.id) reasons.push("Cannot move the root node.");
  if (nodeId === newParentId) reasons.push("Cannot make a node its own parent.");
  if (isAncestor(root, nodeId, newParentId)) reasons.push("Cannot move a node into its own subtree.");
}

function addTargetLeaderReason(parent, reasons) {
  if (parent.person.isPeopleLeader !== true) {
    reasons.push(`${parent.person.name} is not a people leader and cannot have reports.`);
  }
}

function addTopOfOrgMoveReasons(node, parent, reasons) {
  if (parent.person.role === "VP" && streamRoleOf(node.person)) {
    reasons.push(`${node.person.name} (${node.person.role}) cannot report directly to VP ${parent.person.name}; an HO must lead the stream.`);
  }
  if (node.person.role === "HO" && parent.person.role !== "VP") {
    reasons.push(`HO ${node.person.name} must report directly to the VP.`);
  }
}

function addSpanMoveReason(node, parent, span, reasons) {
  const projected = projectedDirectReportCount(parent, node);
  if (projected > span.max) {
    reasons.push(`${parent.person.name} would have ${projected} directs (> max ${span.max}).`);
  }
}

function projectedDirectReportCount(parent, movedNode) {
  const existing = parent.children.filter((child) => !isMarked(child.person) && child.id !== movedNode.id).length;
  return existing + (isMarked(movedNode.person) ? 0 : 1);
}

function addStreamMoveReasons(index, node, parent, newParentId, reasons) {
  const parentStreamRole = streamRoleOf(parent.person);
  const childStreamRole = streamRoleOf(node.person);
  if (!parentStreamRole || !childStreamRole) return;

  if (seLeadsTa(parentStreamRole, childStreamRole)) {
    reasons.push(`${parent.person.name} (SE) cannot lead ${node.person.name} (TA).`);
    return;
  }

  if (taLeadsSe(parentStreamRole, childStreamRole)) {
    if (pathHasTaToSeBreak(index, newParentId)) {
      reasons.push(`TA→SE break already used on this branch (only one allowed).`);
    }
    return;
  }

  addSameRoleLevelMoveReason(node, parent, childStreamRole, parentStreamRole, reasons);
}

function addSameRoleLevelMoveReason(node, parent, childStreamRole, parentStreamRole, reasons) {
  const parentLevel = levelOf(parent.person);
  const childLevel = levelOf(node.person);
  if (childOutranksSameRoleManager(childLevel, parentLevel)) {
    reasons.push(`${node.person.name} (${childStreamRole} L${childLevel}) cannot report to lower-level ${parent.person.name} (${parentStreamRole} L${parentLevel}).`);
  }
}

function addBuMoveReason(node, parent, reasons) {
  if (!STREAM_ROLES.has(node.person.role) || !STREAM_ROLES.has(parent.person.role)) return;

  const parentBU = buOf(parent.person.location);
  const own = buOf(node.person.location);
  if (own !== parentBU) {
    reasons.push(`${node.person.name} is BU ${own} but the target stream branch is BU ${parentBU}.`);
  }
}

function addHardLocationMoveReason(node, parent, hardLocation, reasons) {
  if (!hardLocation || !streamRoleOf(parent.person) || isMarked(node.person)) return;
  if (node.person.location === parent.person.location) return;

  reasons.push(`${node.person.name} is in ${node.person.location} but ${parent.person.name} may only lead ${parent.person.location} (hard-location).`);
}

function addFixedLinkMoveReason(node, parent, pins, reasons) {
  const pin = pins.find((p) => p.child === node.person.name);
  if (pin && pin.parent !== parent.person.name) {
    reasons.push(`"${node.person.name}" is fixed to report to "${pin.parent}".`);
  }
}

function pathHasTaToSeBreak(index, nodeId) {
  const chain = ancestryChain(index, nodeId);
  for (let i = 1; i < chain.length; i++) {
    if (taLeadsSe(streamRoleOf(chain[i - 1].person), streamRoleOf(chain[i].person))) return true;
  }
  return false;
}

function ancestryChain(index, nodeId) {
  const chain = [];
  let cur = index.get(nodeId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentId ? index.get(cur.parentId) : undefined;
  }
  return chain;
}

function realChildrenOf(node) {
  return node.children.filter((child) => !isMarked(child.person));
}

function indexTreeById(root) {
  const byId = new Map();
  walk(root, (node) => byId.set(node.id, node));
  return byId;
}

function violation(node, code, message) {
  return { nodeId: node.id, name: node.person.name, code, message };
}
