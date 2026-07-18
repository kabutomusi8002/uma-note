import type { SupabaseClient } from "@supabase/supabase-js";
import { expandBetCombinations } from "@/lib/calculations";
import { RACE_DATA_SCOPES } from "@/lib/types";
import type {
  BetPlan,
  BetType,
  PredictionMark,
  RacePrediction,
  RaceDataScope,
  RaceRecord,
  RaceStatus,
  ReflectionCategory,
} from "@/lib/types";

type JsonObject = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MARK_TO_DATABASE: Record<PredictionMark, string> = {
  "◎": "honmei",
  "○": "taikou",
  "▲": "tanana",
  "△": "renka",
  "☆": "hoshi",
  "注": "chu",
  "消": "keshi",
};

const MARK_FROM_DATABASE: Record<string, PredictionMark> = {
  honmei: "◎",
  taikou: "○",
  tanana: "▲",
  renka: "△",
  hoshi: "☆",
  chu: "注",
  keshi: "消",
};

const REFLECTION_TO_DATABASE: Record<ReflectionCategory, string> = {
  pace: "pace",
  track: "track",
  keyHorse: "key_horse",
  opponents: "opponents",
  betConstruction: "bet_construction",
  staking: "staking",
  decision: "decision",
  other: "other",
};

const REFLECTION_FROM_DATABASE: Record<string, ReflectionCategory> = {
  pace: "pace",
  track: "track",
  key_horse: "keyHorse",
  opponents: "opponents",
  bet_construction: "betConstruction",
  staking: "staking",
  decision: "decision",
  other: "other",
};

const COURSE_CODES: Record<string, string> = {
  札幌: "SAPPORO",
  函館: "HAKODATE",
  福島: "FUKUSHIMA",
  新潟: "NIIGATA",
  東京: "TOKYO",
  中山: "NAKAYAMA",
  中京: "CHUKYO",
  京都: "KYOTO",
  阪神: "HANSHIN",
  小倉: "KOKURA",
};

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function dataScopeValue(value: unknown): RaceDataScope {
  const candidate = text(value) as RaceDataScope;
  return RACE_DATA_SCOPES.includes(candidate) ? candidate : "live";
}

function predictionSnapshot(
  value: unknown,
  fallback: RacePrediction,
): RacePrediction {
  const snapshot = object(value);
  const marks = new Set<PredictionMark>(["◎", "○", "▲", "△", "☆", "注", "消"]);
  const decision = text(snapshot.decision);
  return {
    selectedHorses: array(snapshot.selectedHorses).map((item) => {
      const horse = object(item);
      const mark = text(horse.mark) as PredictionMark;
      return {
        horseNumber: numberValue(horse.horseNumber),
        horseName: text(horse.horseName),
        mark: marks.has(mark) ? mark : "△",
        comment: text(horse.comment) || undefined,
      };
    }),
    paceScenario: text(snapshot.paceScenario, fallback.paceScenario),
    trackView: text(snapshot.trackView, fallback.trackView),
    dangerousFavorites: array(snapshot.dangerousFavorites).filter(
      (item): item is number => typeof item === "number",
    ),
    longshots: array(snapshot.longshots).filter(
      (item): item is number => typeof item === "number",
    ),
    decision:
      decision === "buy" || decision === "skip" || decision === "pending"
        ? decision
        : fallback.decision,
    note: text(snapshot.note, fallback.note),
  };
}

function ticketNumbers(ticket: JsonObject): number[] {
  return [
    ticket.first_horse_number,
    ticket.second_horse_number,
    ticket.third_horse_number,
  ].filter((value): value is number => typeof value === "number");
}

function plansToSlip(kind: "proposal" | "actual", plan: BetPlan): JsonObject {
  return {
    ...(UUID_PATTERN.test(plan.id) ? { id: plan.id } : {}),
    kind,
    client_key: plan.id,
    title: plan.id,
    memo: plan.memo ?? null,
    tickets: expandBetCombinations(plan).map((selections) => ({
      bet_type: plan.betType,
      selections,
      stake_yen: plan.stakePerPoint,
      memo: plan.memo ?? null,
    })),
  };
}

function slipToPlan(raw: unknown): BetPlan | null {
  const slip = object(raw);
  const tickets = array(slip.tickets).map(object);
  if (!tickets.length) return null;
  const firstTicket = tickets[0];
  const betType = text(firstTicket.bet_type) as BetType;
  if (!(["win", "quinella", "wide", "trio", "trifecta"] as string[]).includes(betType)) {
    return null;
  }
  return {
    id: text(slip.id, text(slip.title, `bet-${Date.now()}`)),
    betType,
    selection: {
      method: "normal",
      combinations: tickets.map(ticketNumbers),
    },
    stakePerPoint: numberValue(firstTicket.stake_yen, 100),
    memo: text(slip.memo) || undefined,
  };
}

function collectEntries(race: RaceRecord): JsonObject[] {
  const entries = new Map<number, string>();
  const add = (horseNumber: number, horseName?: string) => {
    if (!Number.isInteger(horseNumber) || horseNumber < 1) return;
    const current = entries.get(horseNumber);
    const normalizedName = horseName?.trim();
    const placeholder = `${horseNumber}番`;

    // A concrete name may replace an earlier placeholder, but a placeholder
    // must never erase a name that was loaded from the database.
    if (normalizedName && normalizedName !== placeholder) {
      entries.set(horseNumber, normalizedName);
    } else if (!current) {
      entries.set(horseNumber, placeholder);
    }
  };

  race.entries?.forEach((entry) => add(entry.horseNumber, entry.horseName));
  race.prediction.selectedHorses.forEach((horse) => add(horse.horseNumber, horse.horseName));
  race.prediction.dangerousFavorites.forEach((horseNumber) => add(horseNumber));
  race.prediction.longshots.forEach((horseNumber) => add(horseNumber));
  [...race.proposedBets, ...race.purchasedBets].forEach((plan) =>
    expandBetCombinations(plan).flat().forEach((horseNumber) => add(horseNumber)),
  );
  race.result?.finishOrder.forEach((finisher) => add(finisher.horseNumber, finisher.horseName));
  race.result?.payouts.forEach((payout) => payout.combination.forEach((horseNumber) => add(horseNumber)));

  return [...entries.entries()]
    .sort(([left], [right]) => left - right)
    .map(([horse_number, horse_name]) => ({ horse_number, horse_name }));
}

export function raceToDatabasePayload(race: RaceRecord): JsonObject {
  const selectedByNumber = new Map(
    race.prediction.selectedHorses.map((horse) => [horse.horseNumber, horse]),
  );
  const selectionNumbers = new Set([
    ...selectedByNumber.keys(),
    ...race.prediction.dangerousFavorites,
    ...race.prediction.longshots,
  ]);
  const startsAt = `${race.date}T${race.startTime}:00+09:00`;
  const resultIsOfficial = Boolean(
    race.result && race.result.status !== "provisional",
  );

  return {
    ...(UUID_PATTERN.test(race.id) ? { id: race.id } : {}),
    change_source: "uma_note_pwa",
    meeting: {
      meeting_date: race.date,
      meeting_number: 1,
      racecourse: { code: COURSE_CODES[race.course] ?? race.course },
    },
    race: {
      race_number: race.raceNumber,
      data_scope: race.dataScope ?? "live",
      starts_at: startsAt,
      name: race.name,
      surface: "other",
      status: race.status ?? (resultIsOfficial ? "resulted" : "scheduled"),
    },
    entries: collectEntries(race),
    prediction: {
      ...(race.ruleVersion && UUID_PATTERN.test(race.ruleVersion.id)
        ? { rule_version_id: race.ruleVersion.id }
        : { rule_snapshot: race.ruleVersion ?? {} }),
      status:
        race.lock.isLocked || race.lock.postTimeLockedAt ? "locked" : "draft",
      pace: "unknown",
      pace_scenario: race.prediction.paceScenario,
      observed_going: "unknown",
      track_bias: race.prediction.trackView,
      decision:
        race.prediction.decision === "skip"
          ? "pass"
          : race.prediction.decision === "pending"
            ? "undecided"
            : "buy",
      summary: race.prediction.note,
      locked_at: race.lock.lockedAt,
      revisions: race.lock.revisions.map((revision) => ({
        revision: revision.revision,
        changed_at: revision.changedAt,
        summary: revision.summary,
        snapshot: revision.snapshot,
      })),
      selections: [...selectionNumbers].map((horseNumber) => {
        const horse = selectedByNumber.get(horseNumber);
        return {
          horse_number: horseNumber,
          mark: horse ? MARK_TO_DATABASE[horse.mark] : "none",
          is_selected: Boolean(horse),
          is_key: horse?.mark === "◎",
          is_dangerous_favorite: race.prediction.dangerousFavorites.includes(horseNumber),
          is_longshot: race.prediction.longshots.includes(horseNumber),
          evaluation: horse?.comment ?? null,
        };
      }),
    },
    bet_slips: [
      ...race.proposedBets.map((plan) => plansToSlip("proposal", plan)),
      ...race.purchasedBets.map((plan) => plansToSlip("actual", plan)),
    ],
    ...(race.result
      ? {
          result: {
            status: race.result.status ?? "official",
            ...(race.result.status === "provisional"
              ? {}
              : {
                  official_at:
                    race.result.confirmedAt ?? new Date().toISOString(),
                }),
            finishers: race.result.finishOrder.map((finisher) => ({
              horse_number: finisher.horseNumber,
              finish_position: finisher.position,
            })),
            payouts: race.result.payouts.map((payout) => ({
              bet_type: payout.betType,
              selections: payout.combination,
              payout_per_100_yen: payout.payoutPer100,
            })),
          },
        }
      : {}),
    ...(race.reflection
      ? {
          reflection: {
            grade: "neutral",
            memo: race.reflection.note,
            next_action: race.reflection.nextAction ?? null,
            categories: race.reflection.categories.map(
              (category) => REFLECTION_TO_DATABASE[category],
            ),
          },
        }
      : {}),
  };
}

export function databaseRecordToRace(raw: unknown): RaceRecord {
  const record = object(raw);
  const meeting = object(record.meeting);
  const race = object(record.race);
  const racecourse = object(meeting.racecourse);
  const prediction = object(record.prediction);
  const selections = array(prediction.selections).map(object);
  const result = record.result ? object(record.result) : null;
  const reflection = record.reflection ? object(record.reflection) : null;
  const startsAt = text(race.starts_at);
  const started = startsAt ? new Date(startsAt) : new Date();
  const date = text(meeting.meeting_date) || startsAt.slice(0, 10);
  const startTime = startsAt
    ? new Intl.DateTimeFormat("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZone: "Asia/Tokyo",
      }).format(started)
    : "00:00";
  const slips = array(record.bet_slips).map(object);
  const ruleSnapshot = object(prediction.rule_snapshot);
  const ruleParameters = object(ruleSnapshot.parameters);
  const raceStatusText = text(race.status);
  const raceStatus = (["scheduled", "closed", "resulted", "cancelled"] as const)
    .includes(raceStatusText as RaceStatus)
    ? (raceStatusText as RaceStatus)
    : undefined;
  const dataScope = dataScopeValue(race.data_scope ?? record.data_scope);
  const entries = array(record.entries)
    .map(object)
    .map((entry) => ({
      horseNumber: numberValue(entry.horse_number),
      horseName: text(entry.horse_name),
    }))
    .filter((entry) => entry.horseNumber > 0 && entry.horseName.trim().length > 0);

  const selectedHorses = selections
    .filter((selection) => MARK_FROM_DATABASE[text(selection.mark)])
    .map((selection) => ({
      horseNumber: numberValue(selection.horse_number),
      horseName: text(selection.horse_name),
      mark: MARK_FROM_DATABASE[text(selection.mark)],
      comment: text(selection.evaluation) || undefined,
    }));

  const mappedPrediction: RacePrediction = {
    selectedHorses,
    paceScenario: text(prediction.pace_scenario),
    trackView: text(prediction.track_bias),
    dangerousFavorites: selections.filter((selection) => booleanValue(selection.is_dangerous_favorite)).map((selection) => numberValue(selection.horse_number)),
    longshots: selections.filter((selection) => booleanValue(selection.is_longshot)).map((selection) => numberValue(selection.horse_number)),
    decision:
      text(prediction.decision) === "pass"
        ? "skip"
        : text(prediction.decision) === "buy"
          ? "buy"
          : "pending",
    note: text(prediction.summary),
  };

  return {
    id: text(record.id),
    dataScope,
    ...(raceStatus ? { status: raceStatus } : {}),
    date,
    course: text(racecourse.name_ja, text(racecourse.code)),
    raceNumber: numberValue(race.race_number),
    startTime,
    name: text(race.name, "名称未設定レース"),
    entries,
    prediction: mappedPrediction,
    proposedBets: slips
      .filter((slip) => text(slip.kind) === "proposal")
      .map(slipToPlan)
      .filter((plan): plan is BetPlan => plan !== null),
    purchasedBets: slips
      .filter((slip) => text(slip.kind) === "actual")
      .map(slipToPlan)
      .filter((plan): plan is BetPlan => plan !== null),
    lock: {
      isLocked:
        text(prediction.effective_status) === "locked" ||
        text(prediction.status) === "locked",
      lockedAt: text(prediction.locked_at) || null,
      ...(text(prediction.locked_at) &&
      text(prediction.effective_status) === "locked" &&
      text(prediction.status) !== "locked"
        ? { postTimeLockedAt: text(prediction.locked_at) }
        : {}),
      revisions: array(prediction.revisions).map((item, index) => {
        const revision = object(item);
        return {
          id: text(revision.id, `revision-${index + 1}`),
          revision: numberValue(revision.revision, index + 1),
          changedAt: text(revision.changed_at, new Date().toISOString()),
          summary: text(revision.summary, "予想内容を更新"),
          snapshot: predictionSnapshot(revision.snapshot, mappedPrediction),
        };
      }),
    },
    result: result
      ? {
          status:
            text(result.status) === "provisional" ? "provisional" : "official",
          finishOrder: array(result.finishers).map((item) => {
            const finisher = object(item);
            return {
              position: numberValue(finisher.finish_position),
              horseNumber: numberValue(finisher.horse_number),
              horseName: text(finisher.horse_name) || undefined,
            };
          }),
          payouts: array(result.payouts).map((item) => {
            const payout = object(item);
            return {
              betType: text(payout.bet_type) as BetType,
              combination: ticketNumbers(payout),
              payoutPer100: numberValue(payout.payout_per_100_yen),
            };
          }),
          confirmedAt: text(result.official_at) || undefined,
        }
      : null,
    reflection: reflection
      ? {
          categories: array(reflection.categories)
            .map((item) => REFLECTION_FROM_DATABASE[text(object(item).code)])
            .filter((category): category is ReflectionCategory => Boolean(category)),
          note:
            text(reflection.memo) ||
            [text(reflection.what_worked), text(reflection.what_failed)]
              .filter(Boolean)
              .join("\n"),
          nextAction: text(reflection.next_action) || undefined,
        }
      : null,
    ruleVersion:
      (typeof ruleSnapshot.version === "string" &&
        typeof ruleSnapshot.name === "string") ||
      typeof ruleSnapshot.rule_set_name === "string"
        ? {
            id: text(
              prediction.rule_version_id,
              text(
                ruleSnapshot.id,
                `snapshot-${text(
                  ruleParameters.semantic_version,
                  text(ruleSnapshot.version, String(ruleSnapshot.version_number ?? "1")),
                )}`,
              ),
            ),
            name: text(
              ruleParameters.display_name,
              text(ruleSnapshot.name, text(ruleSnapshot.rule_set_name)),
            ),
            version: text(
              ruleParameters.semantic_version,
              text(ruleSnapshot.version, String(ruleSnapshot.version_number ?? "1")),
            ),
            rules: (() => {
              const storedRules = array(
                ruleParameters.rules ?? ruleSnapshot.rules,
              ).filter((item): item is string => typeof item === "string");
              if (storedRules.length) return storedRules;
              return text(ruleSnapshot.content)
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean);
            })(),
            createdAt: text(
              ruleSnapshot.createdAt,
              text(
                ruleSnapshot.published_at,
                text(race.created_at, new Date().toISOString()),
              ),
            ),
            note: text(ruleSnapshot.note) || undefined,
            isActive: booleanValue(ruleSnapshot.isActive),
          }
        : null,
    createdAt: text(race.created_at, new Date().toISOString()),
    updatedAt: text(race.updated_at, new Date().toISOString()),
  };
}

export async function loadRaceRecords(client: SupabaseClient): Promise<RaceRecord[]> {
  const { data, error } = await client.rpc("get_race_records");
  if (error) throw new Error(`レースの読み込みに失敗しました: ${error.message}`);
  const records = array(data).map(object);
  if (!records.length) return [];

  // The separate scope read also supports databases upgraded from a schema
  // whose build_race_record RPC did not yet expose data_scope.
  const ids = records.map((record) => text(record.id)).filter(Boolean);
  const scopeResult = await client
    .from("races")
    .select("id,data_scope")
    .in("id", ids);
  if (scopeResult.error) {
    throw new Error(`レース区分の読み込みに失敗しました: ${scopeResult.error.message}`);
  }
  const scopeById = new Map(
    array(scopeResult.data).map((item) => {
      const row = object(item);
      return [text(row.id), dataScopeValue(row.data_scope)] as const;
    }),
  );
  return records.map((record) => databaseRecordToRace({
    ...record,
    data_scope: scopeById.get(text(record.id)) ?? record.data_scope,
  }));
}

export async function saveRaceRecord(
  client: SupabaseClient,
  race: RaceRecord,
): Promise<RaceRecord> {
  const { data, error } = await client.rpc("upsert_race_record", {
    payload: raceToDatabasePayload(race),
  });
  if (error) throw new Error(`レースの保存に失敗しました: ${error.message}`);
  const saved = databaseRecordToRace(data);
  const dataScope = race.dataScope ?? "live";
  const scopeResult = await client
    .from("races")
    .update({ data_scope: dataScope })
    .eq("id", saved.id);
  if (scopeResult.error) {
    throw new Error(`レース区分の保存に失敗しました: ${scopeResult.error.message}`);
  }
  return { ...saved, dataScope };
}
