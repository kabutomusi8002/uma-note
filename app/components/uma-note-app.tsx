"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  BET_METHOD_LABELS,
  BET_TYPE_LABELS,
  BET_TYPES,
  PREDICTION_MARKS,
  PURCHASE_DECISION_LABELS,
  REFLECTION_CATEGORY_LABELS,
  type BetMethod,
  type BetPlan,
  type BetType,
  type PredictionRuleVersion,
  type RaceDataScope,
  type RaceRecord,
  type ReflectionCategory,
  type SelectedHorse,
} from "@/lib/types";
import {
  calculateBetSummary,
  calculateRaceSettlement,
  normalizeBetMethod,
} from "@/lib/calculations";
import {
  createDemoRaces,
  DEMO_RACE_IDS,
  DEMO_RULE_VERSION,
} from "@/lib/demo-data";
import {
  exportRaces,
  parseRaces,
  RACE_FORMAT_SPECIFICATION,
} from "@/lib/race-format";
import {
  getSupabaseClient,
  isSupabaseConfigured,
} from "@/lib/supabase/client";
import {
  loadRaceRecords,
  saveRaceRecord,
} from "@/lib/supabase/race-repository";
import {
  activateRuleVersion,
  loadRuleVersions,
  saveRuleVersion,
} from "@/lib/supabase/rule-repository";
import { lockRacePrediction } from "@/lib/prediction-lock";
import {
  getRaceDataScope,
  isRaceIncludedInPerformance,
  normalizeKnownDemoRaceScopes,
  RACE_DATA_SCOPE_LABELS,
} from "@/lib/race-scope";

type AppView = "home" | "race" | "analysis" | "rules" | "settings";
type RaceStage = "prediction" | "bets" | "result" | "review";

const LOCAL_RACES_KEY = "uma-note:races:v1";
const LOCAL_RULES_KEY = "uma-note:rules:v1";
const LOCAL_ACTIVE_RACE_KEY = "uma-note:active-race:v1";
const LOCAL_DIRTY_RACES_KEY = "uma-note:dirty-races:v1";
const CLOUD_SAVE_DELAY_MS = 700;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NAV_ITEMS: readonly {
  id: AppView;
  label: string;
  shortLabel: string;
  icon: string;
}[] = [
  { id: "home", label: "レース一覧", shortLabel: "ホーム", icon: "⌂" },
  { id: "race", label: "予想ノート", shortLabel: "予想", icon: "✎" },
  { id: "analysis", label: "収支分析", shortLabel: "分析", icon: "↗" },
  { id: "rules", label: "予想ルール", shortLabel: "ルール", icon: "§" },
  { id: "settings", label: "データ設定", shortLabel: "設定", icon: "••" },
] as const;

const COURSE_COLORS: Record<string, string> = {
  東京: "blue",
  中山: "orange",
  京都: "purple",
  阪神: "gold",
  福島: "red",
  函館: "teal",
  札幌: "teal",
  新潟: "blue",
  中京: "purple",
  小倉: "red",
};

function yen(value: number): string {
  return new Intl.NumberFormat("ja-JP", {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(value);
}

function signedYen(value: number): string {
  return `${value > 0 ? "+" : ""}${yen(value)}`;
}

function dateInJapan(date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
  }).format(date);
}

function todayInJapan(): string {
  return dateInJapan();
}

function newRaceScheduleInJapan(): { date: string; startTime: string } {
  const fiveMinutes = 5 * 60 * 1000;
  const atLeastTwoHoursAhead = Date.now() + 2 * 60 * 60 * 1000;
  const rounded = new Date(Math.ceil(atLeastTwoHoursAhead / fiveMinutes) * fiveMinutes);
  const startTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(rounded);
  return { date: dateInJapan(rounded), startTime };
}

function dateLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Tokyo",
  }).format(parsed);
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cloneRule(rule: PredictionRuleVersion | null): PredictionRuleVersion | null {
  return rule ? JSON.parse(JSON.stringify(rule)) as PredictionRuleVersion : null;
}

function makeBlankRace(rule: PredictionRuleVersion | null): RaceRecord {
  const now = new Date().toISOString();
  const schedule = newRaceScheduleInJapan();
  return {
    id: makeId("race"),
    dataScope: "live",
    date: schedule.date,
    course: "東京",
    raceNumber: 11,
    startTime: schedule.startTime,
    name: "新しいレース",
    prediction: {
      selectedHorses: [],
      paceScenario: "",
      trackView: "",
      dangerousFavorites: [],
      longshots: [],
      decision: "pending",
      note: "",
    },
    proposedBets: [],
    purchasedBets: [],
    lock: { isLocked: false, lockedAt: null, revisions: [] },
    result: null,
    reflection: null,
    ruleVersion: cloneRule(rule),
    createdAt: now,
    updatedAt: now,
  };
}

function safeSummary(plans: readonly BetPlan[]) {
  try {
    return calculateBetSummary(plans);
  } catch {
    return { points: 0, investment: 0 };
  }
}

function isOfficialResult(race: RaceRecord): boolean {
  return Boolean(race.result && race.result.status !== "provisional");
}

function safeSettlement(race: RaceRecord) {
  try {
    return calculateRaceSettlement(
      race.purchasedBets,
      isOfficialResult(race) ? (race.result?.payouts ?? []) : [],
    );
  } catch {
    const summary = safeSummary(race.purchasedBets);
    return {
      ...summary,
      payout: 0,
      profit: -summary.investment,
      recoveryRate: 0,
    };
  }
}

function safeSettlementPreview(race: RaceRecord) {
  try {
    return calculateRaceSettlement(
      race.purchasedBets,
      race.result?.payouts ?? [],
    );
  } catch {
    const summary = safeSummary(race.purchasedBets);
    return {
      ...summary,
      payout: 0,
      profit: -summary.investment,
      recoveryRate: 0,
    };
  }
}

function isPastPostTime(race: RaceRecord, now = Date.now()): boolean {
  const postTime = new Date(`${race.date}T${race.startTime}:00+09:00`).getTime();
  return Number.isFinite(postTime) && postTime <= now;
}

function nextRuleVersion(version: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return version;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function isRaceRecordArray(value: unknown): value is RaceRecord[] {
  return Array.isArray(value) && value.every((item) => (
    item !== null &&
    typeof item === "object" &&
    typeof (item as Partial<RaceRecord>).id === "string" &&
    typeof (item as Partial<RaceRecord>).date === "string"
  ));
}

function isRuleVersionArray(value: unknown): value is PredictionRuleVersion[] {
  return Array.isArray(value) && value.every((item) => (
    item !== null &&
    typeof item === "object" &&
    typeof (item as Partial<PredictionRuleVersion>).id === "string" &&
    Array.isArray((item as Partial<PredictionRuleVersion>).rules)
  ));
}

function mergeCloudById<T extends { id: string }>(
  localItems: readonly T[],
  cloudItems: readonly T[],
): T[] {
  const cloudIds = new Set(cloudItems.map((item) => item.id));
  return [...cloudItems, ...localItems.filter((item) => !cloudIds.has(item.id))];
}

function mergeCloudRaces(
  localRaces: readonly RaceRecord[],
  cloudRaces: readonly RaceRecord[],
  dirtyIds: ReadonlySet<string>,
): RaceRecord[] {
  const dirtyLocal = localRaces.filter((race) => dirtyIds.has(race.id));
  const dirtyById = new Map(dirtyLocal.map((race) => [race.id, race]));
  const naturalKey = (race: RaceRecord) =>
    `${race.date}|${race.course}|${race.raceNumber}`;
  const dirtyByNaturalKey = new Map(
    dirtyLocal.map((race) => [naturalKey(race), race]),
  );
  const usedLocalIds = new Set<string>();
  const merged = cloudRaces.map((cloudRace) => {
    const localRace = dirtyById.get(cloudRace.id) ??
      dirtyByNaturalKey.get(naturalKey(cloudRace));
    if (!localRace) return cloudRace;
    usedLocalIds.add(localRace.id);
    return localRace;
  });
  return [
    ...merged,
    ...dirtyLocal.filter((race) => !usedLocalIds.has(race.id)),
  ];
}

function persistDirtyIds(key: string, ids: ReadonlySet<string>) {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // The race/rule payload save reports storage failures in the UI.
  }
}

function subscribeToConnection(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getConnectionSnapshot(): boolean {
  return navigator.onLine;
}

function getServerConnectionSnapshot(): boolean {
  return true;
}

function parseHorseNumbers(value: string): number[] {
  if (!value.trim()) return [];
  const values = value
    .split(/[、,\s]+/)
    .filter(Boolean)
    .map(Number);
  if (values.some((number) => !Number.isInteger(number) || number < 1 || number > 99)) {
    throw new Error("馬番はカンマ区切りの1〜99の整数で入力してください。");
  }
  return [...new Set(values)];
}

export function UmaNoteApp() {
  const [view, setView] = useState<AppView>("home");
  const [races, setRaces] = useState<RaceRecord[]>(() => createDemoRaces());
  const [activeRaceId, setActiveRaceId] = useState(() => createDemoRaces()[0]?.id ?? "");
  const [rules, setRules] = useState<PredictionRuleVersion[]>([
    { ...DEMO_RULE_VERSION },
  ]);
  const [toast, setToast] = useState<string | null>(null);
  const [storageReady, setStorageReady] = useState(false);
  const supabaseConfigured = isSupabaseConfigured();
  const cloudUserIdRef = useRef<string | null>(null);
  const loadedCloudUserRef = useRef<string | null>(null);
  const dirtyRaceIdsRef = useRef(new Set<string>());
  const racesRef = useRef(races);
  const cloudRaceIdsRef = useRef(new Map<string, string>());
  const cloudRuleIdsRef = useRef(new Map<string, string>());
  const raceSaveTimersRef = useRef(new Map<string, number>());
  const ruleSaveTimersRef = useRef(new Map<string, number>());
  const raceSaveChainsRef = useRef(new Map<string, Promise<void>>());
  const ruleSaveChainRef = useRef<Promise<void>>(Promise.resolve());
  const latestRuleActivationRef = useRef(0);
  const online = useSyncExternalStore(
    subscribeToConnection,
    getConnectionSnapshot,
    getServerConnectionSnapshot,
  );

  useEffect(() => {
    racesRef.current = races;
  }, [races]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const storedRaces = JSON.parse(localStorage.getItem(LOCAL_RACES_KEY) ?? "null") as unknown;
        const storedRules = JSON.parse(localStorage.getItem(LOCAL_RULES_KEY) ?? "null") as unknown;
        const storedActiveRaceId = localStorage.getItem(LOCAL_ACTIVE_RACE_KEY);
        const storedDirtyRaceIds = JSON.parse(
          localStorage.getItem(LOCAL_DIRTY_RACES_KEY) ?? "[]",
        ) as unknown;

        if (Array.isArray(storedDirtyRaceIds)) {
          dirtyRaceIdsRef.current = new Set(
            storedDirtyRaceIds.filter((id): id is string => typeof id === "string"),
          );
        }

        if (!cancelled && isRaceRecordArray(storedRaces)) {
          const hydratedRaces = normalizeKnownDemoRaceScopes(
            storedRaces,
            DEMO_RACE_IDS,
          );
          setRaces(hydratedRaces);
          setActiveRaceId(
            storedActiveRaceId && hydratedRaces.some((race) => race.id === storedActiveRaceId)
              ? storedActiveRaceId
              : (hydratedRaces[0]?.id ?? ""),
          );
        }
        if (!cancelled && isRuleVersionArray(storedRules) && storedRules.length) {
          setRules(storedRules);
        }
      } catch {
        if (!cancelled) setToast("端末内データを読み込めなかったため、デモデータで開始しました");
      } finally {
        if (!cancelled) setStorageReady(true);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    try {
      localStorage.setItem(LOCAL_RACES_KEY, JSON.stringify(races));
      localStorage.setItem(LOCAL_RULES_KEY, JSON.stringify(rules));
      localStorage.setItem(LOCAL_ACTIVE_RACE_KEY, activeRaceId);
    } catch {
      const timer = window.setTimeout(
        () => setToast("端末内への自動保存に失敗しました。空き容量を確認してください"),
        0,
      );
      return () => window.clearTimeout(timer);
    }
  }, [activeRaceId, races, rules, storageReady]);

  useEffect(() => {
    if (!storageReady || !supabaseConfigured) return;
    const client = getSupabaseClient();
    let cancelled = false;

    async function loadForUser(userId: string) {
      if (cancelled || loadedCloudUserRef.current === userId) return;
      loadedCloudUserRef.current = userId;
      cloudUserIdRef.current = userId;
      const [raceResult, ruleResult] = await Promise.allSettled([
        loadRaceRecords(client),
        loadRuleVersions(client),
      ]);
      if (cancelled || cloudUserIdRef.current !== userId) return;

      if (raceResult.status === "fulfilled" && raceResult.value.length) {
        for (const race of raceResult.value) cloudRaceIdsRef.current.set(race.id, race.id);
        setRaces((current) => mergeCloudRaces(
          current,
          raceResult.value,
          dirtyRaceIdsRef.current,
        ));
        setActiveRaceId((current) => (
          dirtyRaceIdsRef.current.has(current) ||
          raceResult.value.some((race) => race.id === current)
            ? current
            : (raceResult.value[0]?.id ?? "")
        ));
      } else if (raceResult.status === "fulfilled") {
        setRaces((current) => current.filter((race) =>
          dirtyRaceIdsRef.current.has(race.id),
        ));
        setActiveRaceId((current) =>
          dirtyRaceIdsRef.current.has(current) ? current : "",
        );
      }
      if (ruleResult.status === "fulfilled" && ruleResult.value.length) {
        for (const rule of ruleResult.value) cloudRuleIdsRef.current.set(rule.id, rule.id);
        const cloudActiveId = ruleResult.value.find((rule) => rule.isActive)?.id;
        setRules((current) => mergeCloudById(current, ruleResult.value).map((rule) => ({
          ...rule,
          isActive: cloudActiveId ? rule.id === cloudActiveId : rule.isActive,
        })));
      }

      const failures = [raceResult, ruleResult].filter((result) => result.status === "rejected");
      if (failures.length) {
        setToast("Supabaseの一部データを読み込めませんでした。端末内データは利用できます");
      }
    }

    void client.auth.getUser().then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setToast("Supabaseのログイン状態を確認できませんでした");
        return;
      }
      if (data.user) void loadForUser(data.user.id);
    });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      window.setTimeout(() => {
        if (cancelled) return;
        if (session?.user) {
          void loadForUser(session.user.id);
        } else {
          cloudUserIdRef.current = null;
          loadedCloudUserRef.current = null;
        }
      }, 0);
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [storageReady, supabaseConfigured]);

  useEffect(() => () => {
    for (const timer of raceSaveTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of ruleSaveTimersRef.current.values()) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" });
  }, [view, activeRaceId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const activeRace = races.find((race) => race.id === activeRaceId) ?? races[0];
  const activeRule = rules.find((rule) => rule.isActive) ?? rules[0] ?? null;

  function markRaceDirty(id: string) {
    dirtyRaceIdsRef.current.add(id);
    persistDirtyIds(LOCAL_DIRTY_RACES_KEY, dirtyRaceIdsRef.current);
  }

  function clearRaceDirty(localId: string, cloudId?: string) {
    dirtyRaceIdsRef.current.delete(localId);
    if (cloudId) dirtyRaceIdsRef.current.delete(cloudId);
    persistDirtyIds(LOCAL_DIRTY_RACES_KEY, dirtyRaceIdsRef.current);
  }

  const queueRaceCloudSave = useCallback((race: RaceRecord) => {
    const userId = cloudUserIdRef.current;
    if (!supabaseConfigured || !userId) return;
    const localId = race.id;
    const existingTimer = raceSaveTimersRef.current.get(localId);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      raceSaveTimersRef.current.delete(localId);
      const previous = raceSaveChainsRef.current.get(localId) ?? Promise.resolve();
      const job = previous
        .catch(() => undefined)
        .then(async () => {
          if (cloudUserIdRef.current !== userId) return;
          const mappedId = cloudRaceIdsRef.current.get(localId);
          const client = getSupabaseClient();
          let source = mappedId ? { ...race, id: mappedId } : race;
          if (source.ruleVersion && !UUID_PATTERN.test(source.ruleVersion.id)) {
            const mappedRuleId = cloudRuleIdsRef.current.get(source.ruleVersion.id);
            const savedRule = mappedRuleId
              ? { ...source.ruleVersion, id: mappedRuleId }
              : await saveRuleVersion(client, {
                  ...source.ruleVersion,
                  isActive: false,
                });
            cloudRuleIdsRef.current.set(source.ruleVersion.id, savedRule.id);
            cloudRuleIdsRef.current.set(savedRule.id, savedRule.id);
            source = { ...source, ruleVersion: savedRule };
          }
          const saved = await saveRaceRecord(client, source);
          const latest = racesRef.current.find((item) =>
            item.id === localId || item.id === mappedId,
          );
          const hasNewerLocalEdit = Boolean(
            latest && latest.updatedAt !== race.updatedAt,
          );
          cloudRaceIdsRef.current.set(localId, saved.id);
          cloudRaceIdsRef.current.set(saved.id, saved.id);
          setRaces((current) => current.map((item) => {
            if (item.id !== localId && item.id !== mappedId) return item;
            return item.updatedAt === race.updatedAt ? saved : { ...item, id: saved.id };
          }));
          setActiveRaceId((current) => (
            current === localId || current === mappedId ? saved.id : current
          ));
          if (hasNewerLocalEdit) {
            dirtyRaceIdsRef.current.delete(localId);
            dirtyRaceIdsRef.current.add(saved.id);
            persistDirtyIds(LOCAL_DIRTY_RACES_KEY, dirtyRaceIdsRef.current);
          } else {
            clearRaceDirty(localId, saved.id);
          }
        })
        .catch(() => {
          setToast("Supabaseへの自動保存に失敗しました。端末内には保存されています");
        });
      raceSaveChainsRef.current.set(localId, job);
    }, CLOUD_SAVE_DELAY_MS);
    raceSaveTimersRef.current.set(localId, timer);
  }, [supabaseConfigured]);

  const queueRuleCloudAction = useCallback((
    rule: PredictionRuleVersion,
    action: "save" | "activate",
  ) => {
    const userId = cloudUserIdRef.current;
    if (!supabaseConfigured || !userId) return;
    const localId = rule.id;
    const activationSequence = action === "activate"
      ? ++latestRuleActivationRef.current
      : latestRuleActivationRef.current;
    const existingTimer = ruleSaveTimersRef.current.get(localId);
    if (existingTimer) window.clearTimeout(existingTimer);

    const timer = window.setTimeout(() => {
      ruleSaveTimersRef.current.delete(localId);
      const previous = ruleSaveChainRef.current;
      const job = previous
        .catch(() => undefined)
        .then(async () => {
          if (cloudUserIdRef.current !== userId) return;
          if (
            action === "activate" &&
            activationSequence !== latestRuleActivationRef.current
          ) return;
          const mappedId = cloudRuleIdsRef.current.get(localId);
          const cloudId = mappedId ?? (UUID_PATTERN.test(localId) ? localId : null);
          if (action === "activate" && cloudId) {
            await activateRuleVersion(getSupabaseClient(), cloudId);
            return;
          }

          const saved = await saveRuleVersion(getSupabaseClient(), {
            ...rule,
            id: cloudId ?? rule.id,
            isActive: action === "activate" ? true : rule.isActive,
          });
          cloudRuleIdsRef.current.set(localId, saved.id);
          cloudRuleIdsRef.current.set(saved.id, saved.id);
          setRules((current) => current.map((item) => (
            item.id === localId
              ? { ...saved, isActive: item.isActive }
              : item
          )));
        })
        .catch(() => {
          setToast("予想ルールをSupabaseへ保存できませんでした。端末内には保存されています");
        });
      ruleSaveChainRef.current = job;
    }, CLOUD_SAVE_DELAY_MS);
    ruleSaveTimersRef.current.set(localId, timer);
  }, [supabaseConfigured]);

  const loadCloudManually = useCallback(async () => {
    const client = getSupabaseClient();
    const [cloudRaces, cloudRules] = await Promise.all([
      loadRaceRecords(client),
      loadRuleVersions(client),
    ]);
    if (cloudRaces.length) {
      for (const race of cloudRaces) cloudRaceIdsRef.current.set(race.id, race.id);
      setRaces(cloudRaces);
      setActiveRaceId(cloudRaces[0]?.id ?? "");
      dirtyRaceIdsRef.current.clear();
      persistDirtyIds(LOCAL_DIRTY_RACES_KEY, dirtyRaceIdsRef.current);
    }
    if (cloudRules.length) {
      for (const rule of cloudRules) cloudRuleIdsRef.current.set(rule.id, rule.id);
      setRules(cloudRules);
    }
    return { races: cloudRaces.length, rules: cloudRules.length };
  }, []);

  const syncCloudManually = useCallback(async () => {
    for (const timer of raceSaveTimersRef.current.values()) window.clearTimeout(timer);
    for (const timer of ruleSaveTimersRef.current.values()) window.clearTimeout(timer);
    raceSaveTimersRef.current.clear();
    ruleSaveTimersRef.current.clear();
    await Promise.allSettled(raceSaveChainsRef.current.values());
    await ruleSaveChainRef.current.catch(() => undefined);
    const client = getSupabaseClient();
    const savedRuleByLocalId = new Map<string, PredictionRuleVersion>();
    const orderedRules = [...rules].sort((a, b) => Number(a.isActive) - Number(b.isActive));
    for (const rule of orderedRules) {
      const saved = await saveRuleVersion(client, rule);
      cloudRuleIdsRef.current.set(rule.id, saved.id);
      cloudRuleIdsRef.current.set(saved.id, saved.id);
      savedRuleByLocalId.set(rule.id, saved);
    }
    const savedRules = rules.map((rule) => savedRuleByLocalId.get(rule.id) ?? rule);
    const savedRaces: RaceRecord[] = [];
    const savedRaceIdByLocalId = new Map<string, string>();
    const racesToSave = races.filter((race) =>
      !DEMO_RACE_IDS.has(race.id) || dirtyRaceIdsRef.current.has(race.id),
    );
    for (const race of racesToSave) {
      const localId = race.id;
      const mappedId = cloudRaceIdsRef.current.get(localId);
      const mappedRuleId = race.ruleVersion
        ? cloudRuleIdsRef.current.get(race.ruleVersion.id)
        : undefined;
      const source = {
        ...race,
        ...(mappedId ? { id: mappedId } : {}),
        ...(race.ruleVersion && mappedRuleId
          ? { ruleVersion: { ...race.ruleVersion, id: mappedRuleId } }
          : {}),
      };
      const saved = await saveRaceRecord(client, source);
      cloudRaceIdsRef.current.set(localId, saved.id);
      cloudRaceIdsRef.current.set(saved.id, saved.id);
      savedRaceIdByLocalId.set(localId, saved.id);
      savedRaces.push(saved);
      clearRaceDirty(localId, saved.id);
    }
    setRaces(savedRaces);
    setActiveRaceId((current) => (
      savedRaceIdByLocalId.get(current) ??
      (savedRaces.some((race) => race.id === current) ? current : (savedRaces[0]?.id ?? ""))
    ));
    if (savedRules.length) setRules(savedRules);
    return { races: savedRaces.length, rules: savedRules.length };
  }, [races, rules]);

  function openRace(id: string) {
    setActiveRaceId(id);
    setView("race");
  }

  function createRace() {
    const race = makeBlankRace(activeRule);
    markRaceDirty(race.id);
    setRaces((current) => [race, ...current]);
    queueRaceCloudSave(race);
    setActiveRaceId(race.id);
    setView("race");
    setToast("新しいレースを作成しました");
  }

  function updateRace(updated: RaceRecord, message?: string) {
    const next = { ...updated, updatedAt: new Date().toISOString() };
    markRaceDirty(next.id);
    setRaces((current) =>
      current.map((race) => (race.id === next.id ? next : race)),
    );
    queueRaceCloudSave(next);
    if (message) setToast(message);
  }

  function importRaces(imported: RaceRecord[]) {
    for (const race of imported) markRaceDirty(race.id);
    setRaces((current) => {
      const ids = new Set(imported.map((race) => race.id));
      return [...imported, ...current.filter((race) => !ids.has(race.id))];
    });
    for (const race of imported) queueRaceCloudSave(race);
  }

  function activateRule(id: string) {
    const selected = rules.find((rule) => rule.id === id);
    if (!selected) return;
    setRules((current) => current.map((rule) => ({ ...rule, isActive: rule.id === id })));
    queueRuleCloudAction({ ...selected, isActive: true }, "activate");
    setToast("使用するルール版を切り替えました");
  }

  function createRule(rule: PredictionRuleVersion) {
    setRules((current) => [rule, ...current.map((item) => ({ ...item, isActive: false }))]);
    queueRuleCloudAction(rule, "save");
    setToast(`ルール v${rule.version} を作成しました`);
  }

  const allSettlement = useMemo(
    () => races
      .filter(isRaceIncludedInPerformance)
      .filter(isOfficialResult)
      .map(safeSettlement),
    [races],
  );
  const totalInvestment = allSettlement.reduce(
    (total, settlement) => total + settlement.investment,
    0,
  );
  const totalPayout = allSettlement.reduce(
    (total, settlement) => total + settlement.payout,
    0,
  );

  return (
    <div className="app-shell">
      <aside className="desktop-rail" aria-label="メインメニュー">
        <button className="brand-lockup" type="button" onClick={() => setView("home")}>
          <span className="brand-mark" aria-hidden="true">U</span>
          <span>
            <strong>UMA NOTE</strong>
            <small>Race thinking, recorded.</small>
          </span>
        </button>
        <nav className="rail-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={view === item.id ? "is-active" : ""}
              aria-current={view === item.id ? "page" : undefined}
              onClick={() => setView(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="rail-status">
          <span className={online ? "status-dot online" : "status-dot"} />
          <div>
            <strong>{online ? "オンライン" : "オフライン"}</strong>
            <small>Supabase 同期対応</small>
          </div>
        </div>
      </aside>

      <main className="main-canvas">
        <header className="mobile-header">
          <button className="brand-lockup compact" type="button" onClick={() => setView("home")}>
            <span className="brand-mark" aria-hidden="true">U</span>
            <span><strong>UMA NOTE</strong><small>予想と収支の記録</small></span>
          </button>
          <span className={`connection-badge ${online ? "" : "offline"}`}>
            {online ? (supabaseConfigured ? "SYNC" : "LOCAL") : "OFFLINE"}
          </span>
        </header>

        {view === "home" && (
          <Dashboard
            races={races}
            activeRule={activeRule}
            investment={totalInvestment}
            payout={totalPayout}
            onOpenRace={openRace}
            onCreateRace={createRace}
          />
        )}
        {view === "race" && activeRace && (
          <RaceWorkspace
            race={activeRace}
            onChange={updateRace}
            onBack={() => setView("home")}
          />
        )}
        {view === "analysis" && <AnalysisView races={races} />}
        {view === "rules" && (
          <RulesView
            rules={rules}
            onActivate={activateRule}
            onCreate={createRule}
          />
        )}
        {view === "settings" && (
          <SettingsView
            races={races}
            onImportRaces={importRaces}
            onLoadFromCloud={loadCloudManually}
            onSyncToCloud={syncCloudManually}
            onNotify={setToast}
          />
        )}
      </main>

      <nav className="bottom-nav" aria-label="メインメニュー">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={view === item.id ? "is-active" : ""}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => setView(item.id)}
          >
            <span aria-hidden="true">{item.icon}</span>
            {item.shortLabel}
          </button>
        ))}
      </nav>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function Dashboard({
  races,
  activeRule,
  investment,
  payout,
  onOpenRace,
  onCreateRace,
}: {
  races: RaceRecord[];
  activeRule: PredictionRuleVersion | null;
  investment: number;
  payout: number;
  onOpenRace: (id: string) => void;
  onCreateRace: () => void;
}) {
  const recovery = investment === 0 ? 0 : (payout / investment) * 100;
  const planned = races.reduce(
    (total, race) => total + (
      isRaceIncludedInPerformance(race)
        ? safeSummary(race.proposedBets).investment
        : 0
    ),
    0,
  );
  const sorted = [...races].sort((a, b) =>
    `${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`),
  );

  return (
    <div className="page dashboard-page">
      <section className="dashboard-hero">
        <div className="hero-copy">
          <p className="eyebrow">RACE DAY CONTROL</p>
          <h1>読みを残す。<br />買いを分ける。</h1>
          <p>思いつきではなく、発走前の判断を記録するための競馬ノート。</p>
        </div>
        <div className="hero-rule-card">
          <span>ACTIVE RULE</span>
          <strong>{activeRule ? `${activeRule.name} v${activeRule.version}` : "ルール未設定"}</strong>
          <small>{activeRule ? `${activeRule.rules.length}項目を適用中` : "ルール版を作成してください"}</small>
        </div>
      </section>

      <section className="metric-strip" aria-label="収支サマリー">
        <article>
          <span>実投資</span>
          <strong>{yen(investment)}</strong>
          <small>実収支区分の購入券面のみ</small>
        </article>
        <article>
          <span>払戻</span>
          <strong>{yen(payout)}</strong>
          <small className={payout - investment >= 0 ? "positive" : "negative"}>
            収支 {signedYen(payout - investment)}
          </small>
        </article>
        <article>
          <span>回収率</span>
          <strong>{recovery.toFixed(1)}%</strong>
          <small>DEMO / TEST は集計対象外</small>
        </article>
        <article className="desktop-only-metric">
          <span>予想案</span>
          <strong>{yen(planned)}</strong>
          <small>実投資とは別管理</small>
        </article>
      </section>

      <div className="section-heading">
        <div>
          <p className="eyebrow dark">RACE FILES</p>
          <h2>レースノート</h2>
        </div>
        <button className="primary-button" type="button" onClick={onCreateRace}>
          <span aria-hidden="true">＋</span> レースを追加
        </button>
      </div>

      <section className="race-grid" aria-label="登録レース">
        {sorted.map((race) => (
          <RaceCard key={race.id} race={race} onOpen={() => onOpenRace(race.id)} />
        ))}
      </section>
    </div>
  );
}

function RaceCard({ race, onOpen }: { race: RaceRecord; onOpen: () => void }) {
  const proposed = safeSummary(race.proposedBets);
  const actual = safeSummary(race.purchasedBets);
  const settlement = safeSettlementPreview(race);
  const mainHorse = race.prediction.selectedHorses.find((horse) => horse.mark === "◎");
  const locked = race.lock.isLocked || isPastPostTime(race);
  const dataScope = getRaceDataScope(race);

  return (
    <button className="race-card" type="button" onClick={onOpen}>
      <div className="race-card-topline">
        <span className={`course-chip ${COURSE_COLORS[race.course] ?? "green"}`}>
          {race.course}
        </span>
        <span className="race-number">{race.raceNumber}<small>R</small></span>
        <time>{dateLabel(race.date)} {race.startTime}</time>
        {dataScope !== "live" && (
          <span className={`data-scope-chip ${dataScope}`}>{dataScope.toUpperCase()}</span>
        )}
        <span className={`lock-chip ${locked ? "locked" : ""}`}>
          {locked ? "LOCK" : "DRAFT"}
        </span>
      </div>
      <h3>{race.name}</h3>
      <div className="race-card-body">
        <div className="key-horse">
          <span className="prediction-mark">◎</span>
          <span className="horse-number">{mainHorse?.horseNumber ?? "–"}</span>
          <div>
            <strong>{mainHorse?.horseName ?? "本命未選択"}</strong>
            <small>{race.prediction.trackView || "馬場メモを入力"}</small>
          </div>
        </div>
        <span className={`decision-pill ${race.prediction.decision}`}>
          {PURCHASE_DECISION_LABELS[race.prediction.decision]}
        </span>
      </div>
      <div className="race-card-footer">
        <span><small>予想案</small><strong>{proposed.points}点 / {yen(proposed.investment)}</strong></span>
        <span><small>実購入</small><strong>{actual.points}点 / {yen(actual.investment)}</strong></span>
        {isOfficialResult(race) && (
          <span className={settlement.profit >= 0 ? "positive" : "negative"}>
            <small>確定収支</small><strong>{signedYen(settlement.profit)}</strong>
          </span>
        )}
        <span className="card-arrow" aria-hidden="true">→</span>
      </div>
    </button>
  );
}

function RaceWorkspace({
  race,
  onChange,
  onBack,
}: {
  race: RaceRecord;
  onChange: (race: RaceRecord, message?: string) => void;
  onBack: () => void;
}) {
  const [stage, setStage] = useState<RaceStage>("prediction");
  const [now, setNow] = useState(() => Date.now());
  const [lockDialogOpen, setLockDialogOpen] = useState(false);
  const lockDialogRef = useRef<HTMLDivElement>(null);
  const lockCancelButtonRef = useRef<HTMLButtonElement>(null);
  const lockTriggerRef = useRef<HTMLButtonElement | null>(null);
  const raceWorkspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const reachedPostTime = isPastPostTime(race, now);
  const locked =
    race.lock.isLocked || Boolean(race.lock.postTimeLockedAt) || reachedPostTime;
  const metadataLocked = race.lock.isLocked;
  const dataScope = getRaceDataScope(race);
  const planned = safeSummary(race.proposedBets);
  const actual = safeSummary(race.purchasedBets);

  useEffect(() => {
    if (!reachedPostTime || race.lock.isLocked || race.lock.postTimeLockedAt) return;
    onChange({
      ...race,
      lock: {
        ...race.lock,
        postTimeLockedAt: new Date(
          `${race.date}T${race.startTime}:00+09:00`,
        ).toISOString(),
      },
    });
  }, [onChange, race, reachedPostTime]);

  useEffect(() => {
    if (!lockDialogOpen) return;

    const workspace = raceWorkspaceRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusFrame = window.requestAnimationFrame(() => {
      lockCancelButtonRef.current?.focus();
    });

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setLockDialogOpen(false);
        return;
      }
      if (event.key !== "Tab") return;

      const dialog = lockDialogRef.current;
      const focusable = dialog?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      );
      if (!dialog || !focusable?.length) {
        event.preventDefault();
        dialog?.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !dialog.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      window.requestAnimationFrame(() => {
        const trigger = lockTriggerRef.current;
        if (trigger && document.contains(trigger) && !trigger.disabled) {
          trigger.focus();
        } else {
          workspace?.focus();
        }
      });
    };
  }, [lockDialogOpen]);

  function updateMetadata(patch: Partial<RaceRecord>) {
    const postTimeLockedAt = race.lock.postTimeLockedAt ?? (
      reachedPostTime
        ? new Date(`${race.date}T${race.startTime}:00+09:00`).toISOString()
        : undefined
    );
    onChange({
      ...race,
      ...patch,
      lock: postTimeLockedAt
        ? { ...race.lock, postTimeLockedAt }
        : race.lock,
    });
  }

  function updateDataScope(nextScope: RaceDataScope) {
    if (dataScope === "demo") return;
    onChange(
      { ...race, dataScope: nextScope },
      nextScope === "live"
        ? "実収支の集計対象に変更しました"
        : "テストデータへ変更し、収支集計から除外しました",
    );
  }

  function revisePrediction(summary = "予想内容を更新") {
    const revision = {
      id: makeId("revision"),
      revision: race.lock.revisions.length + 1,
      changedAt: new Date().toISOString(),
      summary,
      snapshot: JSON.parse(JSON.stringify(race.prediction)) as RaceRecord["prediction"],
    };
    onChange(
      { ...race, lock: { ...race.lock, revisions: [...race.lock.revisions, revision] } },
      `予想履歴 v${revision.revision} を保存しました`,
    );
  }

  function openLockDialog(trigger: HTMLButtonElement) {
    lockTriggerRef.current = trigger;
    setLockDialogOpen(true);
  }

  function confirmPredictionLock() {
    const changedAt = new Date().toISOString();
    const lockedAt = new Date().toISOString();
    setLockDialogOpen(false);
    onChange(
      lockRacePrediction(race, {
        revisionId: makeId("revision"),
        changedAt,
        lockedAt,
      }),
      "予想をロックしました。以後、予想欄は変更できません",
    );
  }

  return (
    <div className="page race-page" ref={raceWorkspaceRef} tabIndex={-1}>
      <div className="race-workspace-header">
        <button className="back-button" type="button" onClick={onBack} aria-label="レース一覧へ戻る">←</button>
        <div>
          <p className="eyebrow dark">{race.course} · {race.raceNumber}R · {race.startTime}</p>
          <h1>{race.name}</h1>
        </div>
        <span className={`lock-chip large ${locked ? "locked" : ""}`}>
          {locked ? "予想 LOCKED" : "編集中 DRAFT"}
        </span>
      </div>

      <div className="race-meta-grid">
        <Field label="開催日">
          <input type="date" value={race.date} disabled={metadataLocked} onChange={(event) => updateMetadata({ date: event.target.value })} />
        </Field>
        <Field label="競馬場">
          <select value={race.course} disabled={metadataLocked} onChange={(event) => updateMetadata({ course: event.target.value })}>
            {["札幌", "函館", "福島", "新潟", "東京", "中山", "中京", "京都", "阪神", "小倉"].map((course) => <option key={course}>{course}</option>)}
          </select>
        </Field>
        <Field label="レース番号">
          <input type="number" min="1" max="12" value={race.raceNumber} disabled={metadataLocked} onChange={(event) => updateMetadata({ raceNumber: Number(event.target.value) })} />
        </Field>
        <Field label="発走時刻">
          <input type="time" value={race.startTime} disabled={metadataLocked} onChange={(event) => updateMetadata({ startTime: event.target.value })} />
        </Field>
        <Field label="収支区分">
          <select
            aria-label="収支区分"
            value={dataScope}
            disabled={dataScope === "demo"}
            onChange={(event) => updateDataScope(event.target.value as RaceDataScope)}
          >
            <option value="live">{RACE_DATA_SCOPE_LABELS.live}</option>
            <option value="test">{RACE_DATA_SCOPE_LABELS.test}</option>
            {dataScope === "demo" && (
              <option value="demo">{RACE_DATA_SCOPE_LABELS.demo}</option>
            )}
          </select>
        </Field>
        <Field label="レース名" className="wide-field">
          <input value={race.name} disabled={metadataLocked} onChange={(event) => updateMetadata({ name: event.target.value })} />
        </Field>
      </div>

      <div className="stage-tabs" role="tablist" aria-label="レース入力ステップ">
        {([
          ["prediction", "01", "予想"],
          ["bets", "02", "買い目"],
          ["result", "03", "結果・払戻"],
          ["review", "04", "反省"],
        ] as const).map(([id, number, label]) => (
          <button key={id} type="button" role="tab" aria-selected={stage === id} className={stage === id ? "is-active" : ""} onClick={() => setStage(id)}>
            <span>{number}</span>{label}
          </button>
        ))}
      </div>

      {stage === "prediction" && (
        <PredictionEditor
          race={race}
          locked={locked}
          onChange={onChange}
          onSaveRevision={revisePrediction}
          onLock={openLockDialog}
        />
      )}
      {stage === "bets" && (
        <BetEditor race={race} locked={locked} onChange={onChange} />
      )}
      {stage === "result" && (
        <ResultEditor race={race} onChange={onChange} />
      )}
      {stage === "review" && (
        <ReflectionEditor race={race} onChange={onChange} />
      )}

      <div className="mobile-race-summary">
        <span><small>予想案</small>{planned.points}点 · {yen(planned.investment)}</span>
        <span><small>実購入</small>{actual.points}点 · {yen(actual.investment)}</span>
      </div>

      {lockDialogOpen && (
        <div
          className="lock-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setLockDialogOpen(false);
          }}
        >
          <div
            className="lock-dialog"
            ref={lockDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="lock-dialog-title"
            aria-describedby="lock-dialog-description"
            tabIndex={-1}
          >
            <span className="lock-dialog-mark" aria-hidden="true">◇</span>
            <p className="eyebrow dark">FINALIZE PREDICTION</p>
            <h2 id="lock-dialog-title">発走前予想をロックしますか？</h2>
            <p id="lock-dialog-description">
              {race.course} {race.raceNumber}R（{race.startTime}発走）の予想と予想案を固定します。
              ロック後は変更できません。
            </p>
            <div className="lock-dialog-actions">
              <button
                className="secondary-button"
                ref={lockCancelButtonRef}
                type="button"
                onClick={() => setLockDialogOpen(false)}
              >
                キャンセル
              </button>
              <button
                className="primary-button lock-button"
                type="button"
                disabled={locked}
                onClick={confirmPredictionLock}
              >
                予想をロック
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return <label className={`field ${className}`}><span>{label}</span>{children}</label>;
}

function HorseNumberListField({
  label,
  value,
  disabled,
  placeholder,
  onCommit,
}: {
  label: string;
  value: number[];
  disabled: boolean;
  placeholder: string;
  onCommit: (numbers: number[]) => void;
}) {
  const [draft, setDraft] = useState(value.join(", "));
  const [error, setError] = useState(false);

  function commit() {
    try {
      onCommit(parseHorseNumbers(draft));
      setError(false);
    } catch {
      setError(true);
    }
  }

  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span>{label}</span>
      <input
        value={draft}
        disabled={disabled}
        inputMode="numeric"
        placeholder={placeholder}
        aria-invalid={error}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {error && <small className="field-error">1〜99の馬番をカンマで区切ってください</small>}
    </label>
  );
}

function PredictionEditor({
  race,
  locked,
  onChange,
  onSaveRevision,
  onLock,
}: {
  race: RaceRecord;
  locked: boolean;
  onChange: (race: RaceRecord, message?: string) => void;
  onSaveRevision: (summary?: string) => void;
  onLock: (trigger: HTMLButtonElement) => void;
}) {
  const prediction = race.prediction;

  function updatePrediction(patch: Partial<RaceRecord["prediction"]>) {
    onChange({ ...race, prediction: { ...prediction, ...patch } });
  }

  function updateHorse(index: number, patch: Partial<SelectedHorse>) {
    updatePrediction({
      selectedHorses: prediction.selectedHorses.map((horse, horseIndex) =>
        horseIndex === index ? { ...horse, ...patch } : horse,
      ),
    });
  }

  function addHorse() {
    updatePrediction({
      selectedHorses: [
        ...prediction.selectedHorses,
        { horseNumber: 1, horseName: "", mark: "△" },
      ],
    });
  }

  return (
    <section className="workspace-panel prediction-panel">
      <div className="panel-heading">
        <div><p className="eyebrow dark">PREDICTION SHEET</p><h2>印とレースの読み</h2></div>
        <span className="subtle-note">変更履歴 {race.lock.revisions.length}件</span>
      </div>

      {locked && (
        <div className="locked-banner">
          <span aria-hidden="true">◇</span>
          <div><strong>発走前予想は固定されています</strong><small>{race.lock.lockedAt ? `${new Date(race.lock.lockedAt).toLocaleString("ja-JP")} にロック` : "発走時刻を過ぎたため編集できません"}</small></div>
        </div>
      )}

      <div className="editor-columns">
        <div>
          <h3 className="mini-heading"><span>01</span> 選出馬と印</h3>
          <div className="horse-list">
            {prediction.selectedHorses.map((horse, index) => (
              <div className="horse-row" key={`${horse.horseNumber}-${index}`}>
                <select aria-label={`${index + 1}頭目の印`} value={horse.mark} disabled={locked} onChange={(event) => updateHorse(index, { mark: event.target.value as SelectedHorse["mark"] })}>
                  {PREDICTION_MARKS.map((mark) => <option key={mark}>{mark}</option>)}
                </select>
                <input className="number-input" aria-label={`${index + 1}頭目の馬番`} type="number" min="1" max="99" value={horse.horseNumber} disabled={locked} onChange={(event) => updateHorse(index, { horseNumber: Number(event.target.value) })} />
                <input aria-label={`${index + 1}頭目の馬名`} placeholder="馬名" value={horse.horseName} disabled={locked} onChange={(event) => updateHorse(index, { horseName: event.target.value })} />
                <button className="icon-button danger" type="button" aria-label={`${horse.horseName || `${index + 1}頭目`}を削除`} disabled={locked} onClick={() => updatePrediction({ selectedHorses: prediction.selectedHorses.filter((_, horseIndex) => horseIndex !== index) })}>×</button>
                <input className="horse-comment" aria-label={`${index + 1}頭目の評価メモ`} placeholder="評価メモ（任意）" value={horse.comment ?? ""} disabled={locked} onChange={(event) => updateHorse(index, { comment: event.target.value })} />
              </div>
            ))}
            {!prediction.selectedHorses.length && <p className="empty-state small">まだ選出馬がありません。</p>}
          </div>
          <button className="secondary-button full" type="button" onClick={addHorse} disabled={locked}>＋ 選出馬を追加</button>

          <h3 className="mini-heading spaced"><span>02</span> 人気評価</h3>
          <div className="two-fields">
            <HorseNumberListField label="危険人気（馬番）" value={prediction.dangerousFavorites} disabled={locked} placeholder="例: 1, 8" onCommit={(dangerousFavorites) => updatePrediction({ dangerousFavorites })} />
            <HorseNumberListField label="穴馬（馬番）" value={prediction.longshots} disabled={locked} placeholder="例: 12, 15" onCommit={(longshots) => updatePrediction({ longshots })} />
          </div>
        </div>

        <div>
          <h3 className="mini-heading"><span>03</span> 展開と馬場</h3>
          <Field label="展開想定">
            <textarea rows={4} value={prediction.paceScenario} disabled={locked} placeholder="逃げ・先行争い、ペース、勝負所を記録" onChange={(event) => updatePrediction({ paceScenario: event.target.value })} />
          </Field>
          <Field label="馬場・バイアス">
            <textarea rows={4} value={prediction.trackView} disabled={locked} placeholder="芝／ダート状態、内外、脚質傾向を記録" onChange={(event) => updatePrediction({ trackView: event.target.value })} />
          </Field>
          <Field label="予想メモ">
            <textarea rows={3} value={prediction.note} disabled={locked} placeholder="買い方につながる根拠を簡潔に" onChange={(event) => updatePrediction({ note: event.target.value })} />
          </Field>

          <h3 className="mini-heading spaced"><span>04</span> 最終判定</h3>
          <div className="decision-control" role="radiogroup" aria-label="買いまたは見送り判定">
            {(["buy", "skip", "pending"] as const).map((decision) => (
              <button key={decision} type="button" role="radio" aria-checked={prediction.decision === decision} className={prediction.decision === decision ? `is-active ${decision}` : ""} disabled={locked} onClick={() => updatePrediction({ decision })}>
                {PURCHASE_DECISION_LABELS[decision]}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-actions">
        <button className="secondary-button" type="button" disabled={locked} onClick={() => onSaveRevision()}>履歴として保存</button>
        <button className="primary-button lock-button" type="button" disabled={locked} onClick={(event) => onLock(event.currentTarget)}>◇ 発走前予想をロック</button>
      </div>

      {race.lock.revisions.length > 0 && (
        <details className="revision-history">
          <summary>変更履歴を表示（{race.lock.revisions.length}件）</summary>
          <ol>
            {[...race.lock.revisions].reverse().map((revision) => (
              <li key={revision.id}><span>v{revision.revision}</span><div><strong>{revision.summary}</strong><small>{new Date(revision.changedAt).toLocaleString("ja-JP")}</small></div></li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function BetEditor({
  race,
  locked,
  onChange,
}: {
  race: RaceRecord;
  locked: boolean;
  onChange: (race: RaceRecord, message?: string) => void;
}) {
  const [kind, setKind] = useState<"proposal" | "actual">("proposal");
  const plans = kind === "proposal" ? race.proposedBets : race.purchasedBets;
  const summary = safeSummary(plans);
  const editorDisabled = kind === "proposal" ? locked : false;

  function setPlans(next: BetPlan[], message?: string) {
    onChange(
      kind === "proposal"
        ? { ...race, proposedBets: next }
        : { ...race, purchasedBets: next },
      message,
    );
  }

  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div><p className="eyebrow dark">BET CONSTRUCTION</p><h2>買い目を組み立てる</h2></div>
        <div className="inline-total"><small>合計</small><strong>{summary.points}点</strong><strong>{yen(summary.investment)}</strong></div>
      </div>

      <div className="kind-switch" role="tablist" aria-label="買い目の区分">
        <button type="button" role="tab" aria-selected={kind === "proposal"} className={kind === "proposal" ? "is-active" : ""} onClick={() => setKind("proposal")}>
          <span>PLAN</span> 予想案 <small>{safeSummary(race.proposedBets).points}点</small>
        </button>
        <button type="button" role="tab" aria-selected={kind === "actual"} className={kind === "actual" ? "is-active actual" : ""} onClick={() => setKind("actual")}>
          <span>ACTUAL</span> 実購入券面 <small>{safeSummary(race.purchasedBets).points}点</small>
        </button>
      </div>
      <p className="context-note">
        {kind === "proposal"
          ? "予想段階の買い目。実際の収支には計上されません。"
          : "実際に購入した券面だけを登録。発走後も入力でき、ここを基準に収支を計算します。"}
      </p>

      <div className="ticket-layout">
        <div className="ticket-list">
          {plans.map((plan) => {
            const planSummary = safeSummary([plan]);
            return (
              <article className="ticket-card" key={plan.id}>
                <div className="ticket-type"><span>{BET_TYPE_LABELS[plan.betType]}</span><small>{BET_METHOD_LABELS[plan.selection.method]}</small></div>
                <div className="ticket-selection">{describeSelection(plan)}</div>
                <div className="ticket-money"><small>{planSummary.points}点 × {yen(plan.stakePerPoint)}</small><strong>{yen(planSummary.investment)}</strong></div>
                <button className="icon-button danger" type="button" aria-label="買い目を削除" disabled={editorDisabled} onClick={() => setPlans(plans.filter((item) => item.id !== plan.id), "買い目を削除しました")}>×</button>
              </article>
            );
          })}
          {!plans.length && <div className="empty-state"><strong>{kind === "proposal" ? "予想案" : "実購入券面"}は未登録です</strong><span>右の入力欄から買い目を追加してください。</span></div>}
        </div>
        <BetBuilder
          disabled={editorDisabled}
          onAdd={(plan) => setPlans([...plans, plan], `${BET_TYPE_LABELS[plan.betType]}の買い目を追加しました`)}
        />
      </div>
    </section>
  );
}

function describeSelection(plan: BetPlan): string {
  if (plan.selection.method === "normal") {
    return plan.selection.combinations.map((combination) => combination.join("–")).join(" / ");
  }
  if (plan.selection.method === "box") {
    return `${plan.selection.horses.join("・")} BOX`;
  }
  return plan.selection.positions.map((position) => position.join("・")).join(" → ");
}

function BetBuilder({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (plan: BetPlan) => void;
}) {
  const [betType, setBetType] = useState<BetType>("trio");
  const [method, setMethod] = useState<BetMethod>("formation");
  const [selectionText, setSelectionText] = useState("4 / 6,11 / 6,11,13");
  const [stake, setStake] = useState(100);
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const effectiveMethod = normalizeBetMethod(betType, method);

  function buildPlan(): BetPlan {
    const arity = betType === "win" ? 1 : betType === "quinella" || betType === "wide" ? 2 : 3;
    let selection: BetPlan["selection"];
    if (effectiveMethod === "normal") {
      const combinations = selectionText
        .split(/[\/\n]+/)
        .map((part) => parseHorseNumbers(part.replaceAll("-", ",")))
        .filter((part) => part.length > 0);
      if (combinations.some((combination) => combination.length !== arity)) {
        throw new Error(`通常買いは1点ごとに${arity}頭を指定してください。`);
      }
      selection = { method: "normal", combinations };
    } else if (effectiveMethod === "box") {
      selection = { method: "box", horses: parseHorseNumbers(selectionText) };
    } else {
      const positions = selectionText.split("/").map((part) => parseHorseNumbers(part));
      if (positions.length !== arity) {
        throw new Error(`${BET_TYPE_LABELS[betType]}は${arity}列のフォーメーションで入力してください。`);
      }
      selection = { method: "formation", positions };
    }
    const plan: BetPlan = { id: makeId("bet"), betType, selection, stakePerPoint: stake, memo: memo || undefined };
    const summary = calculateBetSummary([plan]);
    if (summary.points < 1) {
      throw new Error("1点以上になる買い目を入力してください。");
    }
    return plan;
  }

  const preview = useMemo(() => {
    try { return safeSummary([buildPlan()]); } catch { return { points: 0, investment: 0 }; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betType, method, selectionText, stake]);

  function submit() {
    try {
      const plan = buildPlan();
      onAdd(plan);
      setError(null);
      setMemo("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "買い目を確認してください。");
    }
  }

  return (
    <aside className="bet-builder">
      <h3>買い目を追加</h3>
      <Field label="券種">
        <select
          value={betType}
          disabled={disabled}
          onChange={(event) => {
            const nextBetType = event.target.value as BetType;
            setBetType(nextBetType);
            setMethod((current) => normalizeBetMethod(nextBetType, current));
            setError(null);
          }}
        >
          {BET_TYPES.map((type) => <option key={type} value={type}>{BET_TYPE_LABELS[type]}</option>)}
        </select>
      </Field>
      <Field label="方式">
        <div className="small-segmented">
          {(["normal", "box", "formation"] as BetMethod[]).map((value) => (
            <button
              key={value}
              type="button"
              disabled={disabled || (betType === "win" && value !== "normal")}
              className={effectiveMethod === value ? "is-active" : ""}
              onClick={() => setMethod(normalizeBetMethod(betType, value))}
            >
              {BET_METHOD_LABELS[value]}
            </button>
          ))}
        </div>
      </Field>
      <Field label="馬番">
        <textarea rows={3} value={selectionText} disabled={disabled} onChange={(event) => setSelectionText(event.target.value)} placeholder={effectiveMethod === "normal" ? (betType === "win" ? "例: 2 / 7" : "2-5 / 2-7") : effectiveMethod === "box" ? "2, 5, 7, 10" : "2 / 5,7 / 5,7,10"} />
      </Field>
      <p className="input-help">{effectiveMethod === "normal" ? "1点ごとに / で区切る" : effectiveMethod === "box" ? "対象馬をカンマで区切る" : "各列を /、馬番をカンマで区切る"}</p>
      <div className="two-fields">
        <Field label="1点金額">
          <select value={stake} disabled={disabled} onChange={(event) => setStake(Number(event.target.value))}>
            {[100, 200, 300, 500, 1000, 2000].map((value) => <option key={value} value={value}>{yen(value)}</option>)}
          </select>
        </Field>
        <div className="builder-preview"><span>自動計算</span><strong>{preview.points}点</strong><strong>{yen(preview.investment)}</strong></div>
      </div>
      <Field label="メモ（任意）"><input value={memo} disabled={disabled} onChange={(event) => setMemo(event.target.value)} placeholder="軸・資金配分の意図" /></Field>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="primary-button full" type="button" disabled={disabled} onClick={submit}>＋ この買い目を追加</button>
    </aside>
  );
}

function payoutIdentity(betType: BetType, numbers: readonly number[]): string {
  const normalized = betType === "trifecta"
    ? [...numbers]
    : [...numbers].sort((left, right) => left - right);
  return `${betType}:${normalized.join("-")}`;
}

function ResultEditor({
  race,
  onChange,
}: {
  race: RaceRecord;
  onChange: (race: RaceRecord, message?: string) => void;
}) {
  const [finishText, setFinishText] = useState(() => race.result?.finishOrder.map((entry) => entry.horseNumber).join(", ") ?? "");
  const [betType, setBetType] = useState<BetType>("win");
  const [combination, setCombination] = useState("");
  const [payout, setPayout] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const result = race.result ?? {
    status: "provisional" as const,
    finishOrder: [],
    payouts: [],
  };
  const official = result.status !== "provisional";
  const settlement = safeSettlementPreview(race);

  function toggleOfficialStatus() {
    if (official) {
      onChange({
        ...race,
        result: {
          status: "provisional",
          finishOrder: result.finishOrder,
          payouts: result.payouts,
        },
      }, "結果を暫定状態へ戻しました");
      return;
    }
    onChange({
      ...race,
      result: {
        ...result,
        status: "official",
        confirmedAt: new Date().toISOString(),
      },
    }, "結果を確定し、収支へ反映しました");
  }

  function saveFinishOrder() {
    try {
      const horses = parseHorseNumbers(finishText);
      const finishOrder = horses.map((horseNumber, index) => ({ position: index + 1, horseNumber }));
      onChange({ ...race, result: { ...result, finishOrder, confirmedAt: result.confirmedAt } }, "着順を保存しました");
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "着順を確認してください。");
    }
  }

  function addPayout() {
    try {
      const numbers = parseHorseNumbers(combination.replaceAll("-", ","));
      const arity = betType === "win" ? 1 : betType === "quinella" || betType === "wide" ? 2 : 3;
      if (numbers.length !== arity) throw new Error(`${BET_TYPE_LABELS[betType]}の組み合わせは${arity}頭です。`);
      if (!Number.isInteger(payout) || payout <= 0) throw new Error("払戻は100円あたりの正の整数で入力してください。");
      const nextPayoutIdentity = payoutIdentity(betType, numbers);
      if (result.payouts.some((item) => payoutIdentity(item.betType, item.combination) === nextPayoutIdentity)) {
        throw new Error("同じ券種・組み合わせの払戻は登録済みです。");
      }
      onChange({
        ...race,
        result: {
          ...result,
          payouts: [...result.payouts, { betType, combination: numbers, payoutPer100: payout }],
        },
      }, official ? "払戻を追加し、収支を再計算しました" : "払戻を暫定保存しました");
      setCombination("");
      setPayout(0);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "払戻を確認してください。");
    }
  }

  return (
    <section className="workspace-panel">
      <div className="panel-heading">
        <div><p className="eyebrow dark">SETTLEMENT</p><h2>着順・払戻・収支</h2></div>
        <div className="result-status-control">
          <span className={official ? "official" : "provisional"}>{official ? "公式確定" : "暫定"}</span>
          <button className="secondary-button" type="button" onClick={toggleOfficialStatus}>
            {official ? "暫定へ戻す" : "結果を確定"}
          </button>
        </div>
      </div>
      {!official && <p className="context-note">着順と払戻は暫定保存中です。「結果を確定」するまで累計収支には反映しません。</p>}
      <div className="settlement-cards">
        <article><span>実投資</span><strong>{yen(settlement.investment)}</strong><small>{settlement.points}点</small></article>
        <article><span>払戻</span><strong>{yen(settlement.payout)}</strong><small>登録払戻から計算</small></article>
        <article className={settlement.profit >= 0 ? "positive-card" : "negative-card"}><span>収支</span><strong>{signedYen(settlement.profit)}</strong><small>回収率 {settlement.recoveryRate.toFixed(1)}%</small></article>
        <article className={settlement.payout > 0 ? "positive-card" : "negative-card"}>
          <span>的中判定</span>
          <strong>{result.payouts.length ? (settlement.payout > 0 ? "的中" : "不的中") : "未判定"}</strong>
          <small>{settlement.payout > 0 ? "実購入券面と払戻が一致" : "実購入券面を基準に判定"}</small>
        </article>
      </div>
      <div className="result-layout">
        <div>
          <h3 className="mini-heading"><span>01</span> 着順</h3>
          <Field label="1着から順に馬番を入力">
            <input value={finishText} onChange={(event) => setFinishText(event.target.value)} placeholder="例: 2, 5, 7" />
          </Field>
          <button className="secondary-button" type="button" onClick={saveFinishOrder}>着順を保存</button>
          {result.finishOrder.length > 0 && <ol className="finish-list">{result.finishOrder.map((entry) => <li key={entry.position}><span>{entry.position}</span><strong>{entry.horseNumber}番</strong>{entry.horseName && <small>{entry.horseName}</small>}</li>)}</ol>}
        </div>
        <div>
          <h3 className="mini-heading"><span>02</span> 払戻（100円あたり）</h3>
          <div className="payout-form">
            <Field label="券種"><select value={betType} onChange={(event) => setBetType(event.target.value as BetType)}>{BET_TYPES.map((type) => <option key={type} value={type}>{BET_TYPE_LABELS[type]}</option>)}</select></Field>
            <Field label="的中組み合わせ"><input value={combination} onChange={(event) => setCombination(event.target.value)} placeholder="例: 2-5-7" /></Field>
            <Field label="払戻額"><input type="number" min="0" step="10" value={payout || ""} onChange={(event) => setPayout(Number(event.target.value))} placeholder="3450" /></Field>
            <button className="primary-button" type="button" onClick={addPayout}>追加</button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="payout-list">
            {result.payouts.map((item, index) => <div key={`${item.betType}-${item.combination.join("-")}-${index}`}><span>{BET_TYPE_LABELS[item.betType]}</span><strong>{item.combination.join("–")}</strong><b>{yen(item.payoutPer100)}</b><button type="button" aria-label="払戻を削除" onClick={() => onChange({ ...race, result: { ...result, payouts: result.payouts.filter((_, payoutIndex) => payoutIndex !== index) } })}>×</button></div>)}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReflectionEditor({
  race,
  onChange,
}: {
  race: RaceRecord;
  onChange: (race: RaceRecord, message?: string) => void;
}) {
  const reflection = race.reflection ?? { categories: [], note: "", nextAction: "" };

  function updateReflection(patch: Partial<NonNullable<RaceRecord["reflection"]>>) {
    onChange({ ...race, reflection: { ...reflection, ...patch } });
  }

  function toggleCategory(category: ReflectionCategory) {
    updateReflection({
      categories: reflection.categories.includes(category)
        ? reflection.categories.filter((item) => item !== category)
        : [...reflection.categories, category],
    });
  }

  return (
    <section className="workspace-panel">
      <div className="panel-heading"><div><p className="eyebrow dark">REVIEW LOOP</p><h2>レース後の反省</h2></div><span className="subtle-note">次の判断に使える粒度で残す</span></div>
      <div className="review-layout">
        <div>
          <h3 className="mini-heading"><span>01</span> 反省カテゴリ</h3>
          <div className="category-grid">
            {(Object.entries(REFLECTION_CATEGORY_LABELS) as [ReflectionCategory, string][]).map(([category, label]) => <button key={category} type="button" className={reflection.categories.includes(category) ? "is-active" : ""} aria-pressed={reflection.categories.includes(category)} onClick={() => toggleCategory(category)}><span aria-hidden="true">{reflection.categories.includes(category) ? "✓" : "+"}</span>{label}</button>)}
          </div>
        </div>
        <div>
          <Field label="何が合っていて、何がずれたか"><textarea rows={6} value={reflection.note} onChange={(event) => updateReflection({ note: event.target.value })} placeholder="結果論ではなく、発走前の仮説と実際の差を記録" /></Field>
          <Field label="次回のアクション"><textarea rows={3} value={reflection.nextAction ?? ""} onChange={(event) => updateReflection({ nextAction: event.target.value })} placeholder="次回、具体的に何を確認・変更するか" /></Field>
          <button className="primary-button full" type="button" onClick={() => onChange(race, "レース後反省を保存しました")}>反省を保存</button>
        </div>
      </div>
    </section>
  );
}

function AnalysisView({ races }: { races: RaceRecord[] }) {
  const performanceRaces = races.filter(isRaceIncludedInPerformance);
  const settled = performanceRaces.filter(isOfficialResult);
  const settlements = settled.map((race) => ({ race, ...safeSettlement(race) }));
  const investment = settlements.reduce((sum, row) => sum + row.investment, 0);
  const payout = settlements.reduce((sum, row) => sum + row.payout, 0);
  const categoryCounts = new Map<ReflectionCategory, number>();
  performanceRaces.forEach((race) => race.reflection?.categories.forEach((category) => categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1)));
  const maxCount = Math.max(1, ...categoryCounts.values());

  return (
    <div className="page analysis-page">
      <div className="page-title"><p className="eyebrow dark">PERFORMANCE REVIEW</p><h1>収支と判断を振り返る</h1><p>実収支区分の購入だけを集計します。DEMO / TEST は集計対象外です。</p></div>
      <section className="analysis-hero">
        <article><span>累計投資</span><strong>{yen(investment)}</strong><small>{settlements.reduce((sum, row) => sum + row.points, 0)}点</small></article>
        <article><span>累計払戻</span><strong>{yen(payout)}</strong><small>{settled.length}レース確定</small></article>
        <article className={payout - investment >= 0 ? "positive-card" : "negative-card"}><span>累計収支</span><strong>{signedYen(payout - investment)}</strong><small>回収率 {investment ? ((payout / investment) * 100).toFixed(1) : "0.0"}%</small></article>
      </section>
      <div className="analysis-grid">
        <section className="analysis-card">
          <div className="panel-heading"><div><p className="eyebrow dark">BY RACE</p><h2>レース別収支</h2></div></div>
          <div className="analysis-table">
            {settlements.map((row) => <div className="analysis-row" key={row.race.id}><span className={`course-chip ${COURSE_COLORS[row.race.course] ?? "green"}`}>{row.race.course}</span><div><strong>{row.race.raceNumber}R {row.race.name}</strong><small>{dateLabel(row.race.date)} · {row.points}点</small></div><span><small>投資</small>{yen(row.investment)}</span><span><small>払戻</small>{yen(row.payout)}</span><b className={row.profit >= 0 ? "positive" : "negative"}>{signedYen(row.profit)}</b></div>)}
            {!settlements.length && <p className="empty-state small">集計対象の結果確定済みレースがありません。</p>}
          </div>
        </section>
        <section className="analysis-card">
          <div className="panel-heading"><div><p className="eyebrow dark">REVIEW TAGS</p><h2>反省の傾向</h2></div></div>
          <div className="bar-chart">
            {(Object.entries(REFLECTION_CATEGORY_LABELS) as [ReflectionCategory, string][]).map(([category, label]) => {
              const count = categoryCounts.get(category) ?? 0;
              return <div key={category}><span>{label}</span><i><b style={{ width: `${(count / maxCount) * 100}%` }} /></i><strong>{count}</strong></div>;
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function RulesView({
  rules,
  onActivate,
  onCreate,
}: {
  rules: PredictionRuleVersion[];
  onActivate: (id: string) => void;
  onCreate: (rule: PredictionRuleVersion) => void;
}) {
  const [creating, setCreating] = useState(false);
  const active = rules.find((rule) => rule.isActive) ?? rules[0];
  const [version, setVersion] = useState(() => nextRuleVersion(active?.version ?? "1.0.0"));
  const [name, setName] = useState(active?.name ?? "期待値ルール");
  const [ruleText, setRuleText] = useState(active?.rules.join("\n") ?? "");
  const [error, setError] = useState<string | null>(null);

  function activate(id: string) {
    const selected = rules.find((rule) => rule.id === id);
    if (!selected) return;
    setName(selected.name);
    setRuleText(selected.rules.join("\n"));
    setVersion(nextRuleVersion(selected.version));
    setError(null);
    onActivate(id);
  }

  function startCreating() {
    setError(null);
    if (active) {
      setName(active.name);
      setRuleText(active.rules.join("\n"));
      setVersion(nextRuleVersion(active.version));
    }
    setCreating((current) => !current);
  }

  function addVersion() {
    const normalizedName = name.trim();
    const normalizedVersion = version.trim();
    const normalizedRules = ruleText.split("\n").map((item) => item.trim()).filter(Boolean);
    if (!normalizedName || !normalizedVersion || !normalizedRules.length) {
      setError("ルール名、バージョン、1件以上のルールを入力してください。");
      return;
    }
    if (rules.some((rule) => rule.name === normalizedName && rule.version === normalizedVersion)) {
      setError("同じルール名とバージョンがすでに存在します。");
      return;
    }
    const next: PredictionRuleVersion = {
      id: makeId("rule"),
      name: normalizedName,
      version: normalizedVersion,
      rules: normalizedRules,
      createdAt: new Date().toISOString(),
      note: `v${active?.version ?? "-"} から作成`,
      isActive: true,
    };
    setError(null);
    onCreate(next);
    setCreating(false);
  }

  return (
    <div className="page rules-page">
      <div className="page-title action-title"><div><p className="eyebrow dark">RULE VERSIONING</p><h1>予想ルールを版で残す</h1><p>結果に合わせて過去の基準を書き換えず、どのルールで判断したかを追跡します。</p></div><button className="primary-button" type="button" onClick={startCreating}>＋ 新しい版を作成</button></div>
      {creating && <section className="rule-create-card"><div className="two-fields"><Field label="バージョン"><input value={version} onChange={(event) => setVersion(event.target.value)} /></Field><Field label="ルール名"><input value={name} onChange={(event) => setName(event.target.value)} /></Field></div><Field label="ルール（1行に1項目）"><textarea rows={7} value={ruleText} onChange={(event) => setRuleText(event.target.value)} /></Field>{error && <p className="form-error" role="alert">{error}</p>}<div className="panel-actions"><button className="secondary-button" type="button" onClick={() => setCreating(false)}>キャンセル</button><button className="primary-button" type="button" onClick={addVersion}>版を保存して有効化</button></div></section>}
      <section className="rule-timeline">
        {rules.map((rule) => <article className={`rule-card ${rule.isActive ? "active" : ""}`} key={rule.id}><div className="rule-version"><span>VERSION</span><strong>v{rule.version}</strong><small>{new Date(rule.createdAt).toLocaleDateString("ja-JP")}</small></div><div className="rule-content"><div><h2>{rule.name}</h2>{rule.isActive && <span className="active-rule-badge">ACTIVE</span>}</div><ol>{rule.rules.map((item, index) => <li key={`${item}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ol>{rule.note && <p>{rule.note}</p>}</div><button className="secondary-button" type="button" disabled={rule.isActive} onClick={() => activate(rule.id)}>{rule.isActive ? "使用中" : "この版を使用"}</button></article>)}
      </section>
    </div>
  );
}

function SettingsView({
  races,
  onImportRaces,
  onLoadFromCloud,
  onSyncToCloud,
  onNotify,
}: {
  races: RaceRecord[];
  onImportRaces: (races: RaceRecord[]) => void;
  onLoadFromCloud: () => Promise<{ races: number; rules: number }>;
  onSyncToCloud: () => Promise<{ races: number; rules: number }>;
  onNotify: (message: string) => void;
}) {
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"idle" | "working" | "error">("idle");
  const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
  const supabaseConfigured = isSupabaseConfigured();

  useEffect(() => {
    if (!supabaseConfigured) return;
    const client = getSupabaseClient();
    void client.auth.getUser().then(({ data }) => {
      setUserEmail(data.user?.email ?? null);
    });
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      setUserEmail(session?.user.email ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, [supabaseConfigured]);

  async function sendMagicLink() {
    if (!email.trim()) {
      setConnectionMessage("メールアドレスを入力してください。");
      return;
    }
    setSyncState("working");
    try {
      const client = getSupabaseClient();
      const { error } = await client.auth.signInWithOtp({
        email: email.trim(),
        options: { emailRedirectTo: window.location.origin },
      });
      if (error) throw error;
      setConnectionMessage("ログイン用リンクを送信しました。メールからこのアプリへ戻ってください。");
      setSyncState("idle");
    } catch (cause) {
      setConnectionMessage(cause instanceof Error ? cause.message : "ログインリンクを送信できませんでした。");
      setSyncState("error");
    }
  }

  async function signOut() {
    const client = getSupabaseClient();
    await client.auth.signOut();
    setConnectionMessage("ログアウトしました。端末上の表示データはそのままです。");
  }

  async function loadFromCloud() {
    setSyncState("working");
    try {
      const loaded = await onLoadFromCloud();
      if (loaded.races || loaded.rules) {
        onNotify(`${loaded.races}レース・${loaded.rules}ルール版をSupabaseから読み込みました`);
      } else {
        onNotify("Supabaseに保存済みデータはありません");
      }
      setConnectionMessage(null);
      setSyncState("idle");
    } catch (cause) {
      setConnectionMessage(cause instanceof Error ? cause.message : "読み込みに失敗しました。");
      setSyncState("error");
    }
  }

  async function syncToCloud() {
    setSyncState("working");
    try {
      const saved = await onSyncToCloud();
      setConnectionMessage(null);
      setSyncState("idle");
      onNotify(`${saved.races}レース・${saved.rules}ルール版をSupabaseへ同期しました`);
    } catch (cause) {
      setConnectionMessage(cause instanceof Error ? cause.message : "同期に失敗しました。");
      setSyncState("error");
    }
  }

  async function copyExport() {
    const text = exportRaces(races);
    await navigator.clipboard.writeText(text);
    onNotify("---RACE--- 形式をクリップボードへコピーしました");
  }

  function downloadExport() {
    const blob = new Blob([exportRaces(races)], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `uma-note-${todayInJapan()}.race.txt`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    onNotify("レースデータを書き出しました");
  }

  function runImport() {
    try {
      const imported = parseRaces(importText);
      onImportRaces(imported);
      setImportError(null);
      setImportText("");
      onNotify(`${imported.length}レースを取り込みました`);
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "形式を確認してください。");
    }
  }

  return (
    <div className="page settings-page">
      <div className="page-title"><p className="eyebrow dark">DATA & CONNECTION</p><h1>データ設定</h1><p>Supabase接続、インポート、エクスポート、PWA状態を確認します。</p></div>
      <div className="settings-grid">
        <section className="settings-card connection-card">
          <div className="settings-icon" aria-hidden="true">DB</div>
          <div><p className="eyebrow dark">SUPABASE</p><h2>クラウド同期</h2><p>端末へ常時自動保存し、ログイン中はPostgreSQLへも変更を自動保存します。</p></div>
          <span className={`connection-state ${supabaseConfigured ? "ready" : ""}`}>{supabaseConfigured ? "接続設定済み" : "環境変数が未設定"}</span>
          <div className="config-list"><span>NEXT_PUBLIC_SUPABASE_URL <b>{supabaseConfigured ? "設定済み" : "未設定"}</b></span><span>NEXT_PUBLIC_SUPABASE_ANON_KEY <b>{supabaseConfigured ? "設定済み" : "未設定"}</b></span></div>
          {supabaseConfigured && !userEmail && (
            <div className="auth-panel">
              <Field label="同期に使うメールアドレス">
                <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" />
              </Field>
              <button className="primary-button full" type="button" disabled={syncState === "working"} onClick={sendMagicLink}>メールでログイン</button>
            </div>
          )}
          {supabaseConfigured && userEmail && (
            <div className="auth-panel signed-in">
              <div><span>ログイン中</span><strong>{userEmail}</strong></div>
              <div className="sync-actions">
                <button className="secondary-button" type="button" disabled={syncState === "working"} onClick={loadFromCloud}>クラウドから読込</button>
                <button className="primary-button" type="button" disabled={syncState === "working"} onClick={syncToCloud}>{syncState === "working" ? "同期中…" : "Supabaseへ同期"}</button>
              </div>
              <button className="text-button" type="button" onClick={signOut}>ログアウト</button>
            </div>
          )}
          {connectionMessage && <p className={syncState === "error" ? "form-error" : "connection-message"} role="status">{connectionMessage}</p>}
          <p className="security-note">秘密鍵（service_role）はブラウザに設定しません。行レベルセキュリティで本人のデータだけにアクセスします。</p>
        </section>

        <section className="settings-card">
          <div className="settings-icon" aria-hidden="true">PWA</div>
          <div><p className="eyebrow dark">INSTALLABLE</p><h2>スマートフォンへ追加</h2><p>ブラウザの「ホーム画面に追加」から、アプリのように起動できます。</p></div>
          <ul className="check-list"><li>レスポンシブ表示</li><li>アプリマニフェスト</li><li>静的画面のオフラインキャッシュ</li></ul>
          <p className="security-note">初回オンライン表示後は、端末保存データをオフラインでも開けます。通信断中の変更は、再接続後に全件同期または再編集してクラウド保存してください。</p>
        </section>

        <section className="settings-card import-export-card">
          <div className="panel-heading"><div><p className="eyebrow dark">PORTABLE FORMAT</p><h2>---RACE--- 入出力</h2></div><span className="subtle-note">UTF-8 · RACE/1</span></div>
          <p>バックアップや別環境への移行に使える、人が読めるテキスト形式です。</p>
          <div className="export-actions"><button className="secondary-button" type="button" onClick={copyExport}>コピー</button><button className="primary-button" type="button" onClick={downloadExport}>ファイルへ書き出す</button></div>
          <Field label="取り込むテキスト"><textarea rows={8} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder={`---RACE---\nFORMAT_VERSION: 1\n...`} /></Field>
          {importError && <p className="form-error" role="alert">{importError}</p>}
          <button className="primary-button full" type="button" disabled={!importText.trim()} onClick={runImport}>内容を検証して取り込む</button>
          <details className="format-details"><summary>フォーマット仕様を表示</summary><pre>{RACE_FORMAT_SPECIFICATION}</pre></details>
        </section>

        <section className="settings-card no-bet-card">
          <div className="settings-icon" aria-hidden="true">!</div>
          <div><p className="eyebrow dark">SCOPE</p><h2>自動投票は行いません</h2><p>このアプリは予想・購入記録・収支分析専用です。JRA等へのログイン、投票送信、決済処理は実装していません。</p></div>
        </section>
      </div>
    </div>
  );
}
