import {
  calculateRaceSettlement,
  expandBetCombinations,
} from "./calculations";
import {
  BET_METHODS,
  BET_TYPES,
  PREDICTION_MARKS,
  PURCHASE_DECISIONS,
  RACE_DATA_SCOPES,
  REFLECTION_CATEGORIES,
  type BetPlan,
  type PredictionRuleVersion,
  type RacePrediction,
  type RaceRecord,
} from "./types";

export const RACE_FORMAT_VERSION = 1 as const;
export const RACE_BLOCK_START = "---RACE---";
export const RACE_BLOCK_END = "---END RACE---";

/**
 * RACE/1 is UTF-8 line-oriented text. A file contains one or more blocks:
 *
 * ---RACE---
 * FORMAT_VERSION: 1
 * ID: "race-id"
 * ...
 * ---END RACE---
 *
 * Every value after `KEY:` is a JSON literal on one line. That keeps strings,
 * newlines and Japanese text lossless while remaining easy to read and edit.
 * Blank lines and lines beginning with `#` are ignored. Keys are fixed,
 * case-sensitive and may appear only once. DATA_SCOPE, STATUS and ENTRIES are optional
 * RACE/1 extensions so documents written before those fields existed remain
 * importable.
 */
export const RACE_FORMAT_SPECIFICATION = `RACE/1 (UTF-8)
各レースは ${RACE_BLOCK_START} と ${RACE_BLOCK_END} で囲みます。
各項目は KEY: JSON値 の1行形式です。空行と # から始まるコメントは無視されます。
キーは大文字・固定で、DATA_SCOPE、STATUS、ENTRIES 以外は必須です。
DATA_SCOPE、STATUS、ENTRIES、および LOCK 内の postTimeLockedAt は任意です。
文字列はJSON文字列としてダブルクォートで囲みます。`;

const REQUIRED_FIELD_KEYS = [
  "FORMAT_VERSION",
  "ID",
  "DATE",
  "COURSE",
  "RACE_NUMBER",
  "START_TIME",
  "NAME",
  "PREDICTION",
  "PROPOSED_BETS",
  "PURCHASED_BETS",
  "LOCK",
  "RESULT",
  "REFLECTION",
  "RULE_VERSION",
  "CREATED_AT",
  "UPDATED_AT",
] as const;

const OPTIONAL_FIELD_KEYS = ["DATA_SCOPE", "STATUS", "ENTRIES"] as const;
const FIELD_KEYS = [...REQUIRED_FIELD_KEYS, ...OPTIONAL_FIELD_KEYS] as const;

type RequiredFieldKey = (typeof REQUIRED_FIELD_KEYS)[number];
type OptionalFieldKey = (typeof OPTIONAL_FIELD_KEYS)[number];
type FieldKey = RequiredFieldKey | OptionalFieldKey;
type FieldValues = Readonly<
  Record<RequiredFieldKey, unknown> &
  Partial<Record<OptionalFieldKey, unknown>>
>;
const FIELD_KEY_SET = new Set<string>(FIELD_KEYS);

export class RaceFormatError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(
      line === undefined
        ? `RACE形式エラー: ${message}`
        : `RACE形式エラー（${line}行目）: ${message}`,
    );
    this.name = "RaceFormatError";
    this.line = line;
  }
}

type UnknownRecord = Record<string, unknown>;

function objectAt(value: unknown, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RaceFormatError(`${path} はオブジェクトである必要があります`);
  }
  return value as UnknownRecord;
}

function arrayAt(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RaceFormatError(`${path} は配列である必要があります`);
  }
  return value;
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new RaceFormatError(
      `${path} は${allowEmpty ? "文字列" : "空でない文字列"}である必要があります`,
    );
  }
  return value;
}

function optionalStringAt(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return stringAt(value, path, true);
}

function integerAt(
  value: unknown,
  path: string,
  minimum = Number.MIN_SAFE_INTEGER,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RaceFormatError(
      `${path} は${minimum}〜${maximum}の整数である必要があります`,
    );
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new RaceFormatError(`${path} は真偽値である必要があります`);
  }
  return value;
}

function enumAt<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new RaceFormatError(
      `${path} は ${values.join(" / ")} のいずれかである必要があります`,
    );
  }
  return value as T;
}

function timestampAt(value: unknown, path: string): string {
  const timestamp = stringAt(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new RaceFormatError(`${path} は有効な日時である必要があります`);
  }
  return timestamp;
}

function isoDateAt(value: unknown, path: string): string {
  const date = stringAt(value, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RaceFormatError(`${path} は YYYY-MM-DD 形式で指定してください`);
  }
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== date
  ) {
    throw new RaceFormatError(`${path} は実在する日付で指定してください`);
  }
  return date;
}

function startTimeAt(value: unknown, path: string): string {
  const time = stringAt(value, path);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new RaceFormatError(`${path} は HH:mm 形式で指定してください`);
  }
  return time;
}

function uniqueIntegerArrayAt(
  value: unknown,
  path: string,
  minimum = 1,
  maximum = 99,
): number[] {
  const numbers = arrayAt(value, path).map((item, index) =>
    integerAt(item, `${path}[${index}]`, minimum, maximum),
  );
  if (new Set(numbers).size !== numbers.length) {
    throw new RaceFormatError(`${path} に重複があります`);
  }
  return numbers;
}

function validatePrediction(value: unknown, path: string): RacePrediction {
  const prediction = objectAt(value, path);
  const selectedHorses = arrayAt(
    prediction.selectedHorses,
    `${path}.selectedHorses`,
  ).map((item, index) => {
    const horsePath = `${path}.selectedHorses[${index}]`;
    const horse = objectAt(item, horsePath);
    return {
      horseNumber: integerAt(horse.horseNumber, `${horsePath}.horseNumber`, 1, 99),
      horseName: stringAt(horse.horseName, `${horsePath}.horseName`),
      mark: enumAt(horse.mark, PREDICTION_MARKS, `${horsePath}.mark`),
      ...(horse.comment === undefined
        ? {}
        : { comment: optionalStringAt(horse.comment, `${horsePath}.comment`) }),
    };
  });
  if (
    new Set(selectedHorses.map((horse) => horse.horseNumber)).size !==
    selectedHorses.length
  ) {
    throw new RaceFormatError(`${path}.selectedHorses の馬番に重複があります`);
  }

  return {
    selectedHorses,
    paceScenario: stringAt(prediction.paceScenario, `${path}.paceScenario`, true),
    trackView: stringAt(prediction.trackView, `${path}.trackView`, true),
    dangerousFavorites: uniqueIntegerArrayAt(
      prediction.dangerousFavorites,
      `${path}.dangerousFavorites`,
    ),
    longshots: uniqueIntegerArrayAt(prediction.longshots, `${path}.longshots`),
    decision: enumAt(
      prediction.decision,
      PURCHASE_DECISIONS,
      `${path}.decision`,
    ),
    note: stringAt(prediction.note, `${path}.note`, true),
  };
}

function validateBetPlan(value: unknown, path: string): BetPlan {
  const plan = objectAt(value, path);
  const selection = objectAt(plan.selection, `${path}.selection`);
  const method = enumAt(
    selection.method,
    BET_METHODS,
    `${path}.selection.method`,
  );

  let normalizedSelection: BetPlan["selection"];
  if (method === "normal") {
    normalizedSelection = {
      method,
      combinations: arrayAt(
        selection.combinations,
        `${path}.selection.combinations`,
      ).map((combination, index) =>
        uniqueIntegerArrayAt(
          combination,
          `${path}.selection.combinations[${index}]`,
        ),
      ),
    };
  } else if (method === "box") {
    normalizedSelection = {
      method,
      horses: uniqueIntegerArrayAt(
        selection.horses,
        `${path}.selection.horses`,
      ),
    };
  } else {
    normalizedSelection = {
      method,
      positions: arrayAt(
        selection.positions,
        `${path}.selection.positions`,
      ).map((position, index) =>
        uniqueIntegerArrayAt(
          position,
          `${path}.selection.positions[${index}]`,
        ),
      ),
    };
  }

  const normalized: BetPlan = {
    id: stringAt(plan.id, `${path}.id`),
    betType: enumAt(plan.betType, BET_TYPES, `${path}.betType`),
    selection: normalizedSelection,
    stakePerPoint: integerAt(
      plan.stakePerPoint,
      `${path}.stakePerPoint`,
      100,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(plan.memo === undefined
      ? {}
      : { memo: optionalStringAt(plan.memo, `${path}.memo`) }),
  };

  try {
    expandBetCombinations(normalized);
  } catch (error) {
    throw new RaceFormatError(
      `${path} が不正です: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalized;
}

function validateRuleVersion(
  value: unknown,
  path: string,
): PredictionRuleVersion {
  const rule = objectAt(value, path);
  const rules = arrayAt(rule.rules, `${path}.rules`).map((item, index) =>
    stringAt(item, `${path}.rules[${index}]`),
  );

  return {
    id: stringAt(rule.id, `${path}.id`),
    name: stringAt(rule.name, `${path}.name`),
    version: stringAt(rule.version, `${path}.version`),
    rules,
    createdAt: timestampAt(rule.createdAt, `${path}.createdAt`),
    ...(rule.note === undefined
      ? {}
      : { note: optionalStringAt(rule.note, `${path}.note`) }),
    isActive: booleanAt(rule.isActive, `${path}.isActive`),
  };
}

/** Validate and normalize data at a trust boundary such as import or API input. */
export function validateRaceRecord(value: unknown): RaceRecord {
  const race = objectAt(value, "race");
  const dataScope = race.dataScope === undefined
    ? undefined
    : enumAt(race.dataScope, RACE_DATA_SCOPES, "race.dataScope");
  const status = race.status === undefined
    ? undefined
    : enumAt(
        race.status,
        ["scheduled", "closed", "resulted", "cancelled"] as const,
        "race.status",
      );
  const entries = race.entries === undefined
    ? undefined
    : arrayAt(race.entries, "race.entries").map((item, index) => {
        const entryPath = `race.entries[${index}]`;
        const entry = objectAt(item, entryPath);
        return {
          horseNumber: integerAt(
            entry.horseNumber,
            `${entryPath}.horseNumber`,
            1,
            99,
          ),
          horseName: stringAt(entry.horseName, `${entryPath}.horseName`),
        };
      });
  if (
    entries &&
    new Set(entries.map((entry) => entry.horseNumber)).size !== entries.length
  ) {
    throw new RaceFormatError("race.entries の馬番に重複があります");
  }
  const proposedBets = arrayAt(race.proposedBets, "race.proposedBets").map(
    (plan, index) => validateBetPlan(plan, `race.proposedBets[${index}]`),
  );
  const purchasedBets = arrayAt(race.purchasedBets, "race.purchasedBets").map(
    (plan, index) => validateBetPlan(plan, `race.purchasedBets[${index}]`),
  );
  const allBetIds = [...proposedBets, ...purchasedBets].map((plan) => plan.id);
  if (new Set(allBetIds).size !== allBetIds.length) {
    throw new RaceFormatError("race の買い目IDに重複があります");
  }

  const lock = objectAt(race.lock, "race.lock");
  const isLocked = booleanAt(lock.isLocked, "race.lock.isLocked");
  let lockedAt: string | null;
  if (lock.lockedAt === null) {
    lockedAt = null;
  } else {
    lockedAt = timestampAt(lock.lockedAt, "race.lock.lockedAt");
  }
  if (isLocked && lockedAt === null) {
    throw new RaceFormatError(
      "race.lock.isLocked が true の場合は lockedAt が必要です",
    );
  }
  if (!isLocked && lockedAt !== null) {
    throw new RaceFormatError(
      "race.lock.isLocked が false の場合は lockedAt を null にしてください",
    );
  }
  const postTimeLockedAt = lock.postTimeLockedAt === undefined
    ? undefined
    : timestampAt(lock.postTimeLockedAt, "race.lock.postTimeLockedAt");

  let lockedSnapshot: RaceRecord["lock"]["lockedSnapshot"];
  if (lock.lockedSnapshot !== undefined) {
    if (!isLocked || lockedAt === null) {
      throw new RaceFormatError(
        "race.lock.lockedSnapshot は明示ロック済みレースだけに保存できます",
      );
    }
    const snapshot = objectAt(
      lock.lockedSnapshot,
      "race.lock.lockedSnapshot",
    );
    const snapshotRace = objectAt(
      snapshot.race,
      "race.lock.lockedSnapshot.race",
    );
    const snapshotLockedAt = timestampAt(
      snapshot.lockedAt,
      "race.lock.lockedSnapshot.lockedAt",
    );
    if (snapshotLockedAt !== lockedAt) {
      throw new RaceFormatError(
        "race.lock.lockedSnapshot.lockedAt は lock.lockedAt と一致する必要があります",
      );
    }
    const snapshotBets = arrayAt(
      snapshot.proposedBets,
      "race.lock.lockedSnapshot.proposedBets",
    ).map((plan, index) =>
      validateBetPlan(
        plan,
        `race.lock.lockedSnapshot.proposedBets[${index}]`,
      ),
    );
    lockedSnapshot = {
      schemaVersion: integerAt(
        snapshot.schemaVersion,
        "race.lock.lockedSnapshot.schemaVersion",
        1,
        1,
      ) as 1,
      ...(snapshot.provenance === undefined
        ? {}
        : {
            provenance: enumAt(
              snapshot.provenance,
              ["explicit_lock", "legacy_local_upgrade"] as const,
              "race.lock.lockedSnapshot.provenance",
            ),
          }),
      race: {
        id: stringAt(snapshotRace.id, "race.lock.lockedSnapshot.race.id"),
        ...(snapshotRace.dataScope === undefined
          ? {}
          : {
              dataScope: enumAt(
                snapshotRace.dataScope,
                RACE_DATA_SCOPES,
                "race.lock.lockedSnapshot.race.dataScope",
              ),
            }),
        date: isoDateAt(
          snapshotRace.date,
          "race.lock.lockedSnapshot.race.date",
        ),
        course: stringAt(
          snapshotRace.course,
          "race.lock.lockedSnapshot.race.course",
        ),
        raceNumber: integerAt(
          snapshotRace.raceNumber,
          "race.lock.lockedSnapshot.race.raceNumber",
          1,
          12,
        ),
        startTime: startTimeAt(
          snapshotRace.startTime,
          "race.lock.lockedSnapshot.race.startTime",
        ),
        name: stringAt(
          snapshotRace.name,
          "race.lock.lockedSnapshot.race.name",
          true,
        ),
      },
      prediction: validatePrediction(
        snapshot.prediction,
        "race.lock.lockedSnapshot.prediction",
      ),
      proposedBets: snapshotBets,
      ruleVersion:
        snapshot.ruleVersion === null
          ? null
          : validateRuleVersion(
              snapshot.ruleVersion,
              "race.lock.lockedSnapshot.ruleVersion",
            ),
      lockedAt: snapshotLockedAt,
    };
  }

  const revisions = arrayAt(lock.revisions, "race.lock.revisions").map(
    (item, index) => {
      const revisionPath = `race.lock.revisions[${index}]`;
      const revision = objectAt(item, revisionPath);
      return {
        id: stringAt(revision.id, `${revisionPath}.id`),
        revision: integerAt(
          revision.revision,
          `${revisionPath}.revision`,
          1,
          Number.MAX_SAFE_INTEGER,
        ),
        changedAt: timestampAt(revision.changedAt, `${revisionPath}.changedAt`),
        summary: stringAt(revision.summary, `${revisionPath}.summary`, true),
        snapshot: validatePrediction(
          revision.snapshot,
          `${revisionPath}.snapshot`,
        ),
      };
    },
  );
  const revisionNumbers = revisions.map((revision) => revision.revision);
  if (new Set(revisionNumbers).size !== revisionNumbers.length) {
    throw new RaceFormatError("race.lock.revisions のrevision番号に重複があります");
  }

  let result: RaceRecord["result"] = null;
  if (race.result !== null) {
    const resultObject = objectAt(race.result, "race.result");
    const finishOrder = arrayAt(
      resultObject.finishOrder,
      "race.result.finishOrder",
    ).map((item, index) => {
      const finishPath = `race.result.finishOrder[${index}]`;
      const finish = objectAt(item, finishPath);
      return {
        position: integerAt(
          finish.position,
          `${finishPath}.position`,
          1,
          99,
        ),
        horseNumber: integerAt(
          finish.horseNumber,
          `${finishPath}.horseNumber`,
          1,
          99,
        ),
        ...(finish.horseName === undefined
          ? {}
          : {
              horseName: optionalStringAt(
                finish.horseName,
                `${finishPath}.horseName`,
              ),
            }),
      };
    });
    if (
      new Set(finishOrder.map((finish) => finish.position)).size !==
        finishOrder.length ||
      new Set(finishOrder.map((finish) => finish.horseNumber)).size !==
        finishOrder.length
    ) {
      throw new RaceFormatError(
        "race.result.finishOrder の着順または馬番に重複があります",
      );
    }

    const payouts = arrayAt(resultObject.payouts, "race.result.payouts").map(
      (item, index) => {
        const payoutPath = `race.result.payouts[${index}]`;
        const payout = objectAt(item, payoutPath);
        return {
          betType: enumAt(payout.betType, BET_TYPES, `${payoutPath}.betType`),
          combination: uniqueIntegerArrayAt(
            payout.combination,
            `${payoutPath}.combination`,
          ),
          payoutPer100: integerAt(
            payout.payoutPer100,
            `${payoutPath}.payoutPer100`,
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        };
      },
    );
    // Reuse settlement validation for arity and duplicate payout keys.
    try {
      calculateRaceSettlement([], payouts);
    } catch (error) {
      throw new RaceFormatError(
        `race.result.payouts が不正です: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    result = {
      ...(resultObject.status === undefined
        ? {}
        : {
            status: enumAt(
              resultObject.status,
              ["provisional", "official"] as const,
              "race.result.status",
            ),
          }),
      finishOrder,
      payouts,
      ...(resultObject.confirmedAt === undefined
        ? {}
        : {
            confirmedAt: timestampAt(
              resultObject.confirmedAt,
              "race.result.confirmedAt",
            ),
          }),
    };
  }

  let reflection: RaceRecord["reflection"] = null;
  if (race.reflection !== null) {
    const reflectionObject = objectAt(race.reflection, "race.reflection");
    const categories = arrayAt(
      reflectionObject.categories,
      "race.reflection.categories",
    ).map((category, index) =>
      enumAt(
        category,
        REFLECTION_CATEGORIES,
        `race.reflection.categories[${index}]`,
      ),
    );
    if (new Set(categories).size !== categories.length) {
      throw new RaceFormatError("race.reflection.categories に重複があります");
    }
    reflection = {
      categories,
      note: stringAt(reflectionObject.note, "race.reflection.note", true),
      ...(reflectionObject.nextAction === undefined
        ? {}
        : {
            nextAction: optionalStringAt(
              reflectionObject.nextAction,
              "race.reflection.nextAction",
            ),
          }),
    };
  }

  return {
    id: stringAt(race.id, "race.id"),
    ...(dataScope === undefined ? {} : { dataScope }),
    ...(status === undefined ? {} : { status }),
    date: isoDateAt(race.date, "race.date"),
    course: stringAt(race.course, "race.course"),
    raceNumber: integerAt(race.raceNumber, "race.raceNumber", 1, 12),
    startTime: startTimeAt(race.startTime, "race.startTime"),
    name: stringAt(race.name, "race.name", true),
    ...(entries === undefined ? {} : { entries }),
    prediction: validatePrediction(race.prediction, "race.prediction"),
    proposedBets,
    purchasedBets,
    lock: {
      isLocked,
      lockedAt,
      ...(postTimeLockedAt === undefined ? {} : { postTimeLockedAt }),
      ...(lockedSnapshot === undefined ? {} : { lockedSnapshot }),
      revisions,
    },
    result,
    reflection,
    ruleVersion:
      race.ruleVersion === null
        ? null
        : validateRuleVersion(race.ruleVersion, "race.ruleVersion"),
    createdAt: timestampAt(race.createdAt, "race.createdAt"),
    updatedAt: timestampAt(race.updatedAt, "race.updatedAt"),
  };
}

function fieldValues(race: RaceRecord): FieldValues {
  return {
    FORMAT_VERSION: RACE_FORMAT_VERSION,
    ID: race.id,
    ...(race.dataScope === undefined ? {} : { DATA_SCOPE: race.dataScope }),
    DATE: race.date,
    COURSE: race.course,
    RACE_NUMBER: race.raceNumber,
    START_TIME: race.startTime,
    NAME: race.name,
    PREDICTION: race.prediction,
    PROPOSED_BETS: race.proposedBets,
    PURCHASED_BETS: race.purchasedBets,
    LOCK: race.lock,
    RESULT: race.result,
    REFLECTION: race.reflection,
    RULE_VERSION: race.ruleVersion,
    CREATED_AT: race.createdAt,
    UPDATED_AT: race.updatedAt,
    ...(race.status === undefined ? {} : { STATUS: race.status }),
    ...(race.entries === undefined ? {} : { ENTRIES: race.entries }),
  };
}

function exportNormalizedRace(normalized: RaceRecord): string {
  const fields = fieldValues(normalized);
  return [
    RACE_BLOCK_START,
    ...FIELD_KEYS.flatMap((key) =>
      key in fields ? [`${key}: ${JSON.stringify(fields[key])}`] : [],
    ),
    RACE_BLOCK_END,
  ].join("\n");
}

export function exportRace(race: RaceRecord): string {
  return exportNormalizedRace(validateRaceRecord(race));
}

export function exportRaces(races: readonly RaceRecord[]): string {
  if (races.length === 0) {
    throw new RaceFormatError("エクスポートするレースがありません");
  }
  const normalized = races.map((race) => validateRaceRecord(race));
  const raceIds = new Set<string>();
  for (const race of normalized) {
    if (raceIds.has(race.id)) {
      throw new RaceFormatError(`レースID ${race.id} が重複しています`);
    }
    raceIds.add(race.id);
  }
  return normalized.map(exportNormalizedRace).join("\n\n");
}

function isIgnorable(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseFieldLine(
  line: string,
  lineNumber: number,
): readonly [FieldKey, unknown] {
  const separator = line.indexOf(":");
  if (separator <= 0) {
    throw new RaceFormatError("KEY: JSON値 の形式ではありません", lineNumber);
  }
  const key = line.slice(0, separator).trim();
  const json = line.slice(separator + 1).trim();
  if (!FIELD_KEY_SET.has(key)) {
    throw new RaceFormatError(`未定義のキーです: ${key}`, lineNumber);
  }
  if (json === "") {
    throw new RaceFormatError(`${key} のJSON値がありません`, lineNumber);
  }
  try {
    return [key as FieldKey, JSON.parse(json)] as const;
  } catch (error) {
    throw new RaceFormatError(
      `${key} のJSONが不正です: ${error instanceof Error ? error.message : String(error)}`,
      lineNumber,
    );
  }
}

function recordFromFields(fields: ReadonlyMap<FieldKey, unknown>): unknown {
  return {
    id: fields.get("ID"),
    ...(fields.has("DATA_SCOPE") ? { dataScope: fields.get("DATA_SCOPE") } : {}),
    ...(fields.has("STATUS") ? { status: fields.get("STATUS") } : {}),
    date: fields.get("DATE"),
    course: fields.get("COURSE"),
    raceNumber: fields.get("RACE_NUMBER"),
    startTime: fields.get("START_TIME"),
    name: fields.get("NAME"),
    ...(fields.has("ENTRIES") ? { entries: fields.get("ENTRIES") } : {}),
    prediction: fields.get("PREDICTION"),
    proposedBets: fields.get("PROPOSED_BETS"),
    purchasedBets: fields.get("PURCHASED_BETS"),
    lock: fields.get("LOCK"),
    result: fields.get("RESULT"),
    reflection: fields.get("REFLECTION"),
    ruleVersion: fields.get("RULE_VERSION"),
    createdAt: fields.get("CREATED_AT"),
    updatedAt: fields.get("UPDATED_AT"),
  };
}

export function parseRaces(text: string): RaceRecord[] {
  if (typeof text !== "string") {
    throw new RaceFormatError("入力は文字列である必要があります");
  }
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  const races: RaceRecord[] = [];
  const raceIds = new Set<string>();
  let index = 0;

  while (index < lines.length) {
    while (index < lines.length && isIgnorable(lines[index])) index += 1;
    if (index >= lines.length) break;
    if (lines[index].trim() !== RACE_BLOCK_START) {
      throw new RaceFormatError(
        `${RACE_BLOCK_START} でレースを開始してください`,
        index + 1,
      );
    }
    const blockStartLine = index + 1;
    index += 1;
    const fields = new Map<FieldKey, unknown>();

    while (
      index < lines.length &&
      lines[index].trim() !== RACE_BLOCK_END
    ) {
      const line = lines[index];
      if (line.trim() === RACE_BLOCK_START) {
        throw new RaceFormatError(
          `${RACE_BLOCK_END} がないまま次のレースが始まりました`,
          index + 1,
        );
      }
      if (!isIgnorable(line)) {
        const [key, value] = parseFieldLine(line, index + 1);
        if (fields.has(key)) {
          throw new RaceFormatError(`${key} が重複しています`, index + 1);
        }
        fields.set(key, value);
      }
      index += 1;
    }

    if (index >= lines.length) {
      throw new RaceFormatError(`${RACE_BLOCK_END} がありません`, blockStartLine);
    }
    index += 1;

    for (const key of REQUIRED_FIELD_KEYS) {
      if (!fields.has(key)) {
        throw new RaceFormatError(`必須キー ${key} がありません`, blockStartLine);
      }
    }
    if (fields.get("FORMAT_VERSION") !== RACE_FORMAT_VERSION) {
      throw new RaceFormatError(
        `FORMAT_VERSION は ${RACE_FORMAT_VERSION} のみ対応しています`,
        blockStartLine,
      );
    }

    try {
      const race = validateRaceRecord(recordFromFields(fields));
      if (raceIds.has(race.id)) {
        throw new RaceFormatError(`レースID ${race.id} が重複しています`);
      }
      raceIds.add(race.id);
      races.push(race);
    } catch (error) {
      if (error instanceof RaceFormatError) {
        throw new RaceFormatError(error.message.replace(/^RACE形式エラー: /, ""), blockStartLine);
      }
      throw error;
    }
  }

  if (races.length === 0) {
    throw new RaceFormatError("レースブロックがありません");
  }
  return races;
}

export function parseRace(text: string): RaceRecord {
  const races = parseRaces(text);
  if (races.length !== 1) {
    throw new RaceFormatError(
      `1レースだけ指定してください（${races.length}レースを検出）`,
    );
  }
  return races[0];
}

/** Backward-friendly names for UI event handlers. */
export const importRace = parseRace;
export const importRaces = parseRaces;
