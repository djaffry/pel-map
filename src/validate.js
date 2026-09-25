import { ROLES, LOCATION_TO_BU, STREAM_ROLES, ROLE_MAX_LEVEL, levelOf, MARKED_ROLE } from "./model.js";

const ROLE_SET = new Set(ROLES);

export function validatePeople(raw) {
  const errors = [];
  const warnings = [];
  const people = [];

  if (!Array.isArray(raw)) {
    return invalidRootResult();
  }

  const seenNames = new Set();

  raw.forEach((row, index) => {
    validateAndCollectPerson(row, index, { errors, warnings, people, seenNames });
  });

  return { ok: errors.length === 0, people, errors, warnings };
}

export function validatePerson(row, index) {
  const issues = [];
  if (typeof row !== "object" || row === null) {
    return [{ index, field: "root", message: "Person must be an object." }];
  }
  const r = row;

  validateName(r, index, issues);
  validateLeaderFlag(r, index, issues);
  validateRole(r, index, issues);
  validateLocation(r, index, issues);
  validateStreamLevelWhenPresent(r, index, issues);

  return issues;
}

export function normalizePerson(row) {
  const marked = row.role === MARKED_ROLE;
  const person = {
    name: row.name.trim(),
    isPeopleLeader: marked ? false : row.isPeopleLeader,
    role: row.role,
    location: row.location,
  };
  if (STREAM_ROLES.has(row.role)) person.level = levelOf(row);
  return person;
}

function invalidRootResult() {
  return {
    ok: false,
    people: [],
    errors: [{ index: -1, field: "root", message: "Input must be a JSON array of people." }],
    warnings: [],
  };
}

function validateAndCollectPerson(row, index, { errors, warnings, people, seenNames }) {
  const rowErrors = validatePerson(row, index);
  if (rowErrors.length) {
    errors.push(...rowErrors);
    return;
  }

  const person = normalizePerson(row);
  if (seenNames.has(person.name)) {
    warnings.push({ index, field: "name", message: `Duplicate name "${person.name}".` });
  }
  seenNames.add(person.name);
  people.push(person);
}

function validateName(row, index, issues) {
  if (typeof row.name !== "string" || row.name.trim() === "") {
    issues.push({ index, field: "name", message: "name must be a non-empty string." });
  }
}

function validateLeaderFlag(row, index, issues) {
  if (typeof row.isPeopleLeader !== "boolean") {
    issues.push({ index, field: "isPeopleLeader", message: "isPeopleLeader must be a boolean." });
  }
}

function validateRole(row, index, issues) {
  if (typeof row.role !== "string" || !ROLE_SET.has(row.role)) {
    issues.push({ index, field: "role", message: `role must be one of ${ROLES.join(", ")}.` });
  }
}

function validateLocation(row, index, issues) {
  if (typeof row.location !== "string" || !(row.location in LOCATION_TO_BU)) {
    issues.push({
      index,
      field: "location",
      message: `location must be a known location (got ${JSON.stringify(row.location)}).`,
    });
  }
}

function validateStreamLevelWhenPresent(row, index, issues) {
  const { role, level } = row;
  if (typeof role !== "string" || !STREAM_ROLES.has(role) || level == null) return;

  const max = ROLE_MAX_LEVEL[role];
  if (Number.isInteger(level) && level >= 1 && level <= max) return;

  issues.push({ index, field: "level", message: `level for ${role} must be an integer 1–${max}.` });
}
