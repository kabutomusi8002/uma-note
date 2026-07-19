/**
 * Shared domain types for the horse-racing prediction application.
 *
 * The values stored here deliberately contain no Supabase-specific types so
 * the same model can be used by the UI, import/export and database adapters.
 */

export const BET_TYPES = [
  "win",
  "quinella",
  "wide",
  "trio",
  "trifecta",
] as const;

/** win=single, quinella=馬連, wide=ワイド, trio=3連複, trifecta=3連単 */
export type BetType = (typeof BET_TYPES)[number];

export const BET_TYPE_LABELS: Readonly<Record<BetType, string>> = {
  win: "単勝",
  quinella: "馬連",
  wide: "ワイド",
  trio: "3連複",
  trifecta: "3連単",
};

export const BET_METHODS = ["normal", "box", "formation"] as const;
export type BetMethod = (typeof BET_METHODS)[number];

export const BET_METHOD_LABELS: Readonly<Record<BetMethod, string>> = {
  normal: "通常",
  box: "BOX",
  formation: "フォーメーション",
};

export type NormalBetSelection = {
  /** Explicit combinations. Each inner array represents one ticket point. */
  method: "normal";
  combinations: number[][];
};

export type BoxBetSelection = {
  /** All valid combinations/permutations made from these horse numbers. */
  method: "box";
  horses: number[];
};

export type FormationBetSelection = {
  /** Candidate horses for each leg/order position. */
  method: "formation";
  positions: number[][];
};

export type BetSelection =
  | NormalBetSelection
  | BoxBetSelection
  | FormationBetSelection;

export interface BetPlan {
  id: string;
  betType: BetType;
  selection: BetSelection;
  /** Yen placed on every unique point. Japanese tickets normally use ¥100 units. */
  stakePerPoint: number;
  memo?: string;
}

export type BetCombination = number[];

export const PREDICTION_MARKS = ["◎", "○", "▲", "△", "☆", "注", "消"] as const;
export type PredictionMark = (typeof PREDICTION_MARKS)[number];

export interface SelectedHorse {
  horseNumber: number;
  horseName: string;
  mark: PredictionMark;
  comment?: string;
}

export const PURCHASE_DECISIONS = ["buy", "skip", "pending"] as const;
export type PurchaseDecision = (typeof PURCHASE_DECISIONS)[number];

export const PURCHASE_DECISION_LABELS: Readonly<
  Record<PurchaseDecision, string>
> = {
  buy: "買い",
  skip: "見送り",
  pending: "未定",
};

export interface RacePrediction {
  selectedHorses: SelectedHorse[];
  /** Expected pace/development, stored as free text. */
  paceScenario: string;
  /** Track bias and going assessment, stored as free text. */
  trackView: string;
  dangerousFavorites: number[];
  longshots: number[];
  decision: PurchaseDecision;
  note: string;
}

export interface PredictionRevision {
  id: string;
  revision: number;
  changedAt: string;
  summary: string;
  /** Immutable prediction snapshot at this revision. */
  snapshot: RacePrediction;
}

/**
 * Complete, immutable proof of what was decided before post time.
 * Actual purchases and results deliberately remain outside this snapshot.
 */
export interface PredictionLockedSnapshot {
  schemaVersion: 1;
  /** How this client snapshot was produced; absent on older/cloud canonical rows. */
  provenance?: "explicit_lock" | "legacy_local_upgrade";
  race: Pick<
    RaceRecord,
    "id" | "date" | "course" | "raceNumber" | "startTime" | "name" | "dataScope"
  >;
  prediction: RacePrediction;
  proposedBets: BetPlan[];
  ruleVersion: PredictionRuleVersion | null;
  lockedAt: string;
}

export interface PredictionLock {
  isLocked: boolean;
  lockedAt: string | null;
  /** Persisted client-side boundary once the scheduled post time is reached. */
  postTimeLockedAt?: string;
  /** Stored separately from the editable/current race aggregate. */
  lockedSnapshot?: PredictionLockedSnapshot;
  revisions: PredictionRevision[];
}

export interface RaceFinish {
  position: number;
  horseNumber: number;
  horseName?: string;
}

export interface Payout {
  betType: BetType;
  combination: BetCombination;
  /** Official payout in yen for a ¥100 winning ticket. */
  payoutPer100: number;
}

export interface RaceResult {
  /** Supabase keeps preliminary and officially confirmed results distinct. */
  status?: "provisional" | "official";
  finishOrder: RaceFinish[];
  payouts: Payout[];
  confirmedAt?: string;
}

export const REFLECTION_CATEGORIES = [
  "pace",
  "track",
  "keyHorse",
  "opponents",
  "betConstruction",
  "staking",
  "decision",
  "other",
] as const;

export type ReflectionCategory = (typeof REFLECTION_CATEGORIES)[number];

export const REFLECTION_CATEGORY_LABELS: Readonly<
  Record<ReflectionCategory, string>
> = {
  pace: "展開読み",
  track: "馬場読み",
  keyHorse: "軸馬選び",
  opponents: "相手選び",
  betConstruction: "買い目構成",
  staking: "資金配分",
  decision: "買い／見送り判断",
  other: "その他",
};

export interface RaceReflection {
  categories: ReflectionCategory[];
  note: string;
  nextAction?: string;
}

/**
 * A compact race-entry reference retained by the persistence adapter.
 *
 * The editor does not need a full runners table yet, but keeping every name
 * returned by Supabase prevents an unrelated prediction edit from replacing
 * a known horse name with a generated placeholder such as `4番`.
 */
export interface RaceEntryReference {
  horseNumber: number;
  horseName: string;
}

export type RaceStatus = "scheduled" | "closed" | "resulted" | "cancelled";

export const RACE_DATA_SCOPES = ["live", "demo", "test"] as const;
export type RaceDataScope = (typeof RACE_DATA_SCOPES)[number];

export interface PredictionRuleVersion {
  id: string;
  name: string;
  /** Human-readable version, for example "2.1.0". */
  version: string;
  rules: string[];
  createdAt: string;
  note?: string;
  isActive: boolean;
}

export interface UserSettings {
  timezone: "Asia/Tokyo";
  defaultStakePerPoint: number;
  defaultDataScope: RaceDataScope;
  activeRuleVersionId: string | null;
}

export const DEFAULT_USER_SETTINGS: Readonly<UserSettings> = {
  timezone: "Asia/Tokyo",
  defaultStakePerPoint: 100,
  defaultDataScope: "live",
  activeRuleVersionId: null,
};

/**
 * One self-contained race record.
 *
 * `proposedBets` and `purchasedBets` are intentionally separate. The former
 * records the prediction idea while the latter is the source of truth for
 * settlement and bankroll calculations.
 */
export interface RaceRecord {
  id: string;
  /**
   * Controls whether this record contributes to bankroll/performance totals.
   * Older records without this field are treated as `live`.
   */
  dataScope?: RaceDataScope;
  /** Preserves cancelled/closed state when a cloud record is read and saved again. */
  status?: RaceStatus;
  date: string;
  course: string;
  raceNumber: number;
  startTime: string;
  name: string;
  /** Known runners returned by the database, including unselected horses. */
  entries?: RaceEntryReference[];
  prediction: RacePrediction;
  proposedBets: BetPlan[];
  purchasedBets: BetPlan[];
  lock: PredictionLock;
  result: RaceResult | null;
  reflection: RaceReflection | null;
  ruleVersion: PredictionRuleVersion | null;
  createdAt: string;
  updatedAt: string;
}

export interface BetSummary {
  points: number;
  investment: number;
}

export interface RaceSettlement extends BetSummary {
  payout: number;
  profit: number;
  /** Percentage, rounded to one decimal. Zero when investment is zero. */
  recoveryRate: number;
}
