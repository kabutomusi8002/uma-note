export interface RaceIdentityInput {
  id?: string;
  date: string;
  course: string;
  raceNumber: number | string;
}

export interface RaceClientKeyInput {
  id: string;
  clientKey?: unknown;
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

function nonEmptyIdentity(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function validClientKey(value: unknown): string | null {
  const normalized = nonEmptyIdentity(value);
  if (normalized && normalized.length > 160) {
    throw new RaceIdentityError("race clientKey must be at most 160 characters");
  }
  return normalized;
}

/**
 * Returns the immutable cloud client key while accepting pre-clientKey local
 * records. Older releases used `id` as the server client_key, so that value is
 * the only safe fallback; generating a replacement would create a duplicate.
 */
export function raceClientKey(race: RaceClientKeyInput): string {
  const persisted = validClientKey(race.clientKey);
  if (persisted) return persisted;
  const legacyId = validClientKey(race.id);
  if (legacyId) return legacyId;
  throw new RaceIdentityError("race clientKey and legacy id must not be empty");
}

/**
 * Completes one legacy record without changing records that already carry an
 * explicit key. An Outbox entity key is authoritative because it is the durable
 * identity of a write that may already have been attempted.
 */
export function backfillRaceClientKey<T extends RaceClientKeyInput>(
  race: T,
  outboxEntityKey?: string | null,
): T & { clientKey: string } {
  const persisted = validClientKey(race.clientKey);
  if (persisted) {
    return (
      persisted === race.clientKey
        ? race
        : { ...race, clientKey: persisted }
    ) as T & { clientKey: string };
  }
  const queued = validClientKey(outboxEntityKey);
  return {
    ...race,
    clientKey: queued ?? raceClientKey(race),
  };
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
  const clientKeyGroups = new Map<string, string[]>();
  for (const race of races) {
    const candidate = race as RaceIdentityInput & { clientKey?: unknown };
    const key = nonEmptyIdentity(candidate.clientKey) ??
      nonEmptyIdentity(candidate.id);
    if (!key) continue;
    const ids = clientKeyGroups.get(key) ?? [];
    ids.push(candidate.id ?? "(no id)");
    clientKeyGroups.set(key, ids);
  }
  const duplicateClientKeys = [...clientKeyGroups.entries()]
    .filter(([, ids]) => ids.length > 1);
  if (duplicates.length === 0 && duplicateClientKeys.length === 0) return;

  const naturalDetails = duplicates
    .map((duplicate) => {
      const ids = duplicate.ids.length > 0 ? duplicate.ids.join(", ") : "(no id)";
      return `${duplicate.naturalKey}: ${ids}`;
    })
    .join("; ");
  const clientKeyDetails = duplicateClientKeys
    .map(([clientKey, ids]) => `${clientKey}: ${ids.join(", ")}`)
    .join("; ");
  const details = [
    naturalDetails ? `natural keys: ${naturalDetails}` : "",
    clientKeyDetails ? `client keys: ${clientKeyDetails}` : "",
  ].filter(Boolean).join("; ");
  const prefix = duplicates.length > 0
    ? "Duplicate race natural keys are not allowed"
    : "Duplicate race client keys are not allowed";
  throw new RaceIdentityError(
    `${prefix}: ${details}`,
    duplicates,
  );
}
