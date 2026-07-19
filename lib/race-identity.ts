export interface RaceIdentityInput {
  id?: string;
  date: string;
  course: string;
  raceNumber: number | string;
}

export interface NormalizedRaceIdentity {
  date: string;
  course: string;
  raceNumber: number;
}

export interface DuplicateRaceIdentity {
  naturalKey: string;
  indexes: number[];
  ids: string[];
}

export class RaceIdentityError extends Error {
  readonly duplicates: readonly DuplicateRaceIdentity[];

  constructor(
    message: string,
    duplicates: readonly DuplicateRaceIdentity[] = [],
  ) {
    super(message);
    this.name = "RaceIdentityError";
    this.duplicates = duplicates;
  }
}

function normalizeText(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new RaceIdentityError(`${field} must be a string`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (normalized === "") {
    throw new RaceIdentityError(`${field} must not be empty`);
  }
  return normalized;
}

/** Normalize supported date spellings to the RACE/1 YYYY-MM-DD form. */
export function normalizeRaceDate(value: string): string {
  const normalized = normalizeText(value, "date");
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(normalized);
  if (!match) {
    throw new RaceIdentityError("date must use YYYY-MM-DD format");
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new RaceIdentityError("date must be a real calendar date");
  }
  return date;
}

/** Course names are compared independent of width, surrounding whitespace and case. */
export function normalizeRaceCourse(value: string): string {
  return normalizeText(value, "course")
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

export function normalizeRaceNumber(value: number | string): number {
  const candidate =
    typeof value === "string" ? normalizeText(value, "raceNumber") : value;
  const raceNumber = typeof candidate === "string" ? Number(candidate) : candidate;
  if (!Number.isInteger(raceNumber) || raceNumber < 1 || raceNumber > 12) {
    throw new RaceIdentityError("raceNumber must be an integer from 1 to 12");
  }
  return raceNumber;
}

export function normalizeRaceIdentity(
  race: RaceIdentityInput,
): NormalizedRaceIdentity {
  return {
    date: normalizeRaceDate(race.date),
    course: normalizeRaceCourse(race.course),
    raceNumber: normalizeRaceNumber(race.raceNumber),
  };
}

/** Stable natural key shared by local and cloud records. */
export function raceNaturalKey(race: RaceIdentityInput): string {
  const identity = normalizeRaceIdentity(race);
  return JSON.stringify([identity.date, identity.course, identity.raceNumber]);
}

export function findDuplicateRaces(
  races: readonly RaceIdentityInput[],
): DuplicateRaceIdentity[] {
  const grouped = new Map<
    string,
    { indexes: number[]; ids: string[] }
  >();

  races.forEach((race, index) => {
    const key = raceNaturalKey(race);
    const group = grouped.get(key) ?? { indexes: [], ids: [] };
    group.indexes.push(index);
    if (race.id !== undefined) group.ids.push(race.id);
    grouped.set(key, group);
  });

  return [...grouped.entries()]
    .filter(([, group]) => group.indexes.length > 1)
    .map(([naturalKey, group]) => ({ naturalKey, ...group }));
}

/**
 * Refuse ambiguous imports before any upsert is attempted. In particular,
 * records with different IDs but the same date/course/race number are unsafe.
 */
export function assertNoDuplicateRaces(
  races: readonly RaceIdentityInput[],
): void {
  const duplicates = findDuplicateRaces(races);
  if (duplicates.length === 0) return;

  const details = duplicates
    .map((duplicate) => {
      const ids = duplicate.ids.length > 0 ? duplicate.ids.join(", ") : "(no id)";
      return `${duplicate.naturalKey}: ${ids}`;
    })
    .join("; ");
  throw new RaceIdentityError(
    `Duplicate race natural keys are not allowed: ${details}`,
    duplicates,
  );
}
