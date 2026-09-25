export const ROLES = ["VP", "HO", "TA", "SE", "NSE"];

export const STREAM_ROLES = new Set(["TA", "SE"]);

export const MARKED_ROLE = "NSE";

export const ROLE_MAX_LEVEL = { TA: 3, SE: 4 };

export const DEFAULT_LEVEL = 1;

export function levelsFor(role) {
  const max = maxLevelFor(role);
  return max ? Array.from({ length: max }, (_, i) => i + 1) : [];
}

export function levelOf(person) {
  const max = maxLevelFor(person.role);
  if (!max) return undefined;
  return isValidLevel(person.level, max) ? person.level : DEFAULT_LEVEL;
}

export const LOCATION_TO_BU = {
  VIE: "AT", LNZ: "AT", RIE: "AT", AMS: "AT", STP: "AT", GRZ: "AT", INS: "AT", ATR: "AT",
  KIE: "DE", KAR: "DE", HAM: "DE", MUN: "DE", FRA: "DE", KOL: "DE", DER: "DE",
  CLU: "RO", ROR: "RO",
};

const LOCATION_LABEL = { ATR: "Remote", DER: "Remote", ROR: "Remote" };

export function labelOf(location) {
  return LOCATION_LABEL[location] ?? location;
}

export const LOCATIONS = Object.keys(LOCATION_TO_BU);

export const DEFAULT_SPAN = { min: 3, max: 8 };

const LOCATION_COLOR_HUE_MIN = 30;
const LOCATION_COLOR_HUE_MAX = 320;

// Location colors use an orange-to-magenta spectrum that avoids red because red
// is reserved for constraint errors. Lightness/saturation compensation plus a
// parity zig-zag keep nearby BU-grouped locations visually distinct.
export const LOCATION_COLOR = buildLocationColorMap();

export function colorOf(location) {
  return LOCATION_COLOR[location] ?? "hsl(220 10% 60%)";
}

export function buOf(location) {
  return LOCATION_TO_BU[location];
}

export function streamRoleOf(person) {
  return STREAM_ROLES.has(person.role) ? person.role : undefined;
}

export function isNode(person) {
  return person.isPeopleLeader === true;
}

export function isMarked(person) {
  return person?.role === MARKED_ROLE;
}

const ROLE_RANK = Object.fromEntries(ROLES.map((role, index) => [role, index]));

export function roleRank(role) {
  return rankOrUnknown(ROLE_RANK, role, ROLES.length);
}

export function compareBySeniority(a, b) {
  return (
    compareRoleRank(a, b)
    || compareStreamLevel(a, b)
    || compareLeadershipStatus(a, b)
  );
}

const LOCATION_RANK = Object.fromEntries(LOCATIONS.map((location, index) => [location, index]));

export function locationRank(location) {
  return rankOrUnknown(LOCATION_RANK, location, LOCATIONS.length);
}

export function compareForDisplay(a, b) {
  return compareLocationRank(a, b) || compareBySeniority(a, b);
}

function maxLevelFor(role) {
  return ROLE_MAX_LEVEL[role];
}

function isValidLevel(level, max) {
  return Number.isInteger(level) && level >= 1 && level <= max;
}

function buildLocationColorMap() {
  const locationCount = LOCATIONS.length;
  return Object.fromEntries(LOCATIONS.map((location, index) => {
    const hue = locationColorHue(index, locationCount);
    const colorBalance = locationColorBalance(hue);
    const lightness = locationColorLightness(colorBalance, index);
    const saturation = locationColorSaturation(colorBalance);
    return [location, `hsl(${hue} ${saturation}% ${lightness}%)`];
  }));
}

function locationColorHue(index, locationCount) {
  if (locationCount <= 1) return LOCATION_COLOR_HUE_MIN;
  const hueRange = LOCATION_COLOR_HUE_MAX - LOCATION_COLOR_HUE_MIN;
  return Math.round(LOCATION_COLOR_HUE_MIN + (index * hueRange) / (locationCount - 1));
}

function locationColorBalance(hue) {
  return Math.cos(((hue - 60) * Math.PI) / 180);
}

function locationColorLightness(colorBalance, index) {
  return Math.round(50 - colorBalance * 9 - (index % 2 ? 4 : 0));
}

function locationColorSaturation(colorBalance) {
  return Math.round(80 - colorBalance * 6);
}

function rankOrUnknown(rankByValue, value, unknownRank) {
  return value in rankByValue ? rankByValue[value] : unknownRank;
}

function compareRoleRank(a, b) {
  return roleRank(a.role) - roleRank(b.role);
}

function compareStreamLevel(a, b) {
  return (levelOf(b) ?? 0) - (levelOf(a) ?? 0);
}

function compareLeadershipStatus(a, b) {
  if (a.isPeopleLeader === b.isPeopleLeader) return 0;
  return a.isPeopleLeader ? -1 : 1;
}

function compareLocationRank(a, b) {
  return locationRank(a.location) - locationRank(b.location);
}
