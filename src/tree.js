let _id = 0;

export function resetIds() {
  _id = 0;
}

export function makeNode(person) {
  return { id: nextId(), person, parentId: null, children: [] };
}

export function attach(parent, child) {
  child.parentId = parent.id;
  parent.children.push(child);
  return parent;
}

export function walk(root, fn, depth = 0) {
  fn(root, depth);
  for (const child of root.children) walk(child, fn, depth + 1);
}

export function findById(root, id) {
  let found;
  walk(root, (n) => {
    if (n.id === id) found = n;
  });
  return found;
}

export function isAncestor(root, ancestorId, nodeId) {
  const index = indexById(root);
  let cur = index.get(nodeId);
  while (cur) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? index.get(cur.parentId) : undefined;
  }
  return false;
}

export function reparent(root, nodeId, newParentId) {
  const invalidMove = getInvalidReparentMove(root, nodeId, newParentId);
  if (invalidMove) return invalidMove;

  const newParent = findById(root, newParentId);
  if (!newParent) return { ok: false, reason: "Target parent not found." };

  const node = detach(root, nodeId);
  if (!node) return { ok: false, reason: "Node not found." };
  attach(newParent, node);
  return { ok: true };
}

export function toPeople(root) {
  const people = [];
  walk(root, (n) => people.push({ ...n.person }));
  return people;
}

export function span(node) {
  return node.children.length;
}

export function serializeTree(root) {
  if (!root) return null;
  return {
    person: { ...root.person },
    children: root.children.map((child) => serializeTree(child)),
  };
}

export function deserializeTree(data) {
  if (!data || !data.person) return null;
  const node = makeNode({ ...data.person });
  for (const child of data.children ?? []) {
    const childNode = deserializeTree(child);
    if (!childNode) continue;
    attach(node, childNode);
  }
  return node;
}

export function removeReassigningChildren(root, nodeId) {
  const node = findById(root, nodeId);
  if (!node || !node.parentId) return { ok: false };
  const manager = findById(root, node.parentId);
  if (!manager) return { ok: false };

  const reports = replaceNodeWithReports(manager, node);
  return { ok: true, manager, reports };
}

function nextId() {
  return `n${++_id}`;
}

function indexById(root) {
  const map = new Map();
  walk(root, (n) => map.set(n.id, n));
  return map;
}

function getInvalidReparentMove(root, nodeId, newParentId) {
  if (nodeId === root.id) return { ok: false, reason: "Cannot move the root node." };
  if (nodeId === newParentId) return { ok: false, reason: "Cannot make a node its own parent." };
  if (isAncestor(root, nodeId, newParentId)) {
    return { ok: false, reason: "Cannot move a node into its own subtree." };
  }
  return undefined;
}

function detach(root, nodeId) {
  const node = findById(root, nodeId);
  if (!node || !node.parentId) return node;
  const parent = findById(root, node.parentId);
  if (parent) {
    parent.children = parent.children.filter((child) => child.id !== node.id);
  }
  node.parentId = null;
  return node;
}

function replaceNodeWithReports(manager, node) {
  const idx = manager.children.indexOf(node);
  const reports = node.children;
  for (const report of reports) report.parentId = manager.id;
  manager.children.splice(idx, 1, ...reports);
  node.children = [];
  node.parentId = null;
  return reports;
}
