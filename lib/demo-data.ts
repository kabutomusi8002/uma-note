import type {
  PredictionRuleVersion,
  RacePrediction,
  RaceRecord,
} from "./types";

export const DEMO_RULE_VERSION: PredictionRuleVersion = {
  id: "rule-balanced-v2-1",
  name: "バランス型・期待値ルール",
  version: "2.1.0",
  rules: [
    "単勝期待値が100%を超える馬を軸候補にする",
    "危険人気馬を含む買い目はオッズ妙味を再確認する",
    "1レースの投資上限は当日予算の20%とする",
    "根拠が2項目未満のレースは見送る",
  ],
  createdAt: "2026-06-01T09:00:00+09:00",
  note: "資金配分と見送り条件をv2.0から明文化。",
  isActive: true,
};

const completedPrediction: RacePrediction = {
  selectedHorses: [
    {
      horseNumber: 2,
      horseName: "サクラフェザー",
      mark: "◎",
      comment: "内枠と先行力を評価。",
    },
    {
      horseNumber: 5,
      horseName: "グランドノヴァ",
      mark: "○",
      comment: "長く脚を使える。",
    },
    {
      horseNumber: 7,
      horseName: "ミッドナイトベル",
      mark: "▲",
      comment: "展開が向けば差し切りまで。",
    },
    {
      horseNumber: 10,
      horseName: "ブルーアーク",
      mark: "△",
    },
    {
      horseNumber: 12,
      horseName: "オーロラライン",
      mark: "☆",
      comment: "人気薄だが道悪実績あり。",
    },
  ],
  paceScenario:
    "2番が内から主張し、前半は平均。3コーナーから5番が早めに進出する。",
  trackView: "稍重。内2頭分が伸び、先行馬を優先。",
  dangerousFavorites: [3],
  longshots: [12],
  decision: "buy",
  note: "◎から相手を広げすぎず、ワイドで下振れを抑える。",
};

export const DEMO_RACE: RaceRecord = {
  id: "race-2026-07-12-fukushima-11",
  clientKey: "race-2026-07-12-fukushima-11",
  dataScope: "demo",
  date: "2026-07-12",
  course: "福島",
  raceNumber: 11,
  startTime: "15:45",
  name: "サマーリーフステークス",
  prediction: completedPrediction,
  proposedBets: [
    {
      id: "proposal-trio-formation",
      betType: "trio",
      selection: {
        method: "formation",
        positions: [[2], [5, 7, 10], [5, 7, 10, 12]],
      },
      stakePerPoint: 100,
      memo: "◎1頭軸の3連複。",
    },
    {
      id: "proposal-trifecta-normal",
      betType: "trifecta",
      selection: {
        method: "normal",
        combinations: [
          [2, 5, 7],
          [2, 7, 5],
        ],
      },
      stakePerPoint: 100,
    },
  ],
  purchasedBets: [
    {
      id: "purchase-win-2",
      betType: "win",
      selection: { method: "normal", combinations: [[2]] },
      stakePerPoint: 500,
    },
    {
      id: "purchase-wide-key",
      betType: "wide",
      selection: {
        method: "normal",
        combinations: [
          [2, 7],
          [2, 10],
        ],
      },
      stakePerPoint: 200,
    },
    {
      id: "purchase-trio-formation",
      betType: "trio",
      selection: {
        method: "formation",
        positions: [[2], [5, 7], [5, 7, 10]],
      },
      stakePerPoint: 100,
    },
  ],
  lock: {
    isLocked: true,
    lockedAt: "2026-07-12T15:35:00+09:00",
    revisions: [
      {
        id: "revision-fukushima-11-1",
        revision: 1,
        changedAt: "2026-07-12T13:10:00+09:00",
        summary: "初回予想を保存",
        snapshot: completedPrediction,
      },
      {
        id: "revision-fukushima-11-2",
        revision: 2,
        changedAt: "2026-07-12T15:30:00+09:00",
        summary: "稍重の内有利を反映し、12番を穴馬に追加",
        snapshot: completedPrediction,
      },
    ],
  },
  result: {
    status: "official",
    finishOrder: [
      { position: 1, horseNumber: 2, horseName: "サクラフェザー" },
      { position: 2, horseNumber: 5, horseName: "グランドノヴァ" },
      { position: 3, horseNumber: 7, horseName: "ミッドナイトベル" },
    ],
    payouts: [
      { betType: "win", combination: [2], payoutPer100: 480 },
      { betType: "quinella", combination: [2, 5], payoutPer100: 1_280 },
      { betType: "wide", combination: [2, 7], payoutPer100: 720 },
      { betType: "trio", combination: [2, 5, 7], payoutPer100: 3_450 },
      { betType: "trifecta", combination: [2, 5, 7], payoutPer100: 18_640 },
    ],
    confirmedAt: "2026-07-12T16:05:00+09:00",
  },
  reflection: {
    categories: ["pace", "betConstruction"],
    note:
      "展開の読みは合っていた。3連単案も的中形だったが、購入を絞った判断は予算ルールどおり。",
    nextAction: "フォーメーションの重複点を保存前に必ず確認する。",
  },
  ruleVersion: DEMO_RULE_VERSION,
  createdAt: "2026-07-12T13:10:00+09:00",
  updatedAt: "2026-07-12T17:20:00+09:00",
};

export const DEMO_UPCOMING_RACE: RaceRecord = {
  id: "race-2026-07-19-hakodate-11",
  clientKey: "race-2026-07-19-hakodate-11",
  dataScope: "demo",
  date: "2026-07-19",
  course: "函館",
  raceNumber: 11,
  startTime: "15:25",
  name: "函館スプリントチャレンジ",
  prediction: {
    selectedHorses: [
      {
        horseNumber: 4,
        horseName: "ノースライト",
        mark: "◎",
        comment: "洋芝適性と枠順を評価。",
      },
      { horseNumber: 6, horseName: "シーサイドラン", mark: "○" },
      { horseNumber: 11, horseName: "ルミナスウェイ", mark: "▲" },
      { horseNumber: 13, horseName: "フォグダンサー", mark: "☆" },
    ],
    paceScenario: "逃げ候補が多く、前半3ハロンは速くなる想定。",
    trackView: "良。最終判断は当日午前の芝レースを確認して更新。",
    dangerousFavorites: [1],
    longshots: [13],
    decision: "pending",
    note: "馬場傾向の確認後に買い／見送りを確定する。",
  },
  proposedBets: [
    {
      id: "proposal-hakodate-wide-box",
      betType: "wide",
      selection: { method: "box", horses: [4, 6, 11, 13] },
      stakePerPoint: 100,
    },
  ],
  purchasedBets: [],
  lock: { isLocked: false, lockedAt: null, revisions: [] },
  result: null,
  reflection: null,
  ruleVersion: DEMO_RULE_VERSION,
  createdAt: "2026-07-17T20:00:00+09:00",
  updatedAt: "2026-07-17T20:00:00+09:00",
};

export const DEMO_RACES: readonly RaceRecord[] = [
  DEMO_UPCOMING_RACE,
  DEMO_RACE,
];

export const DEMO_RACE_IDS: ReadonlySet<string> = new Set(
  DEMO_RACES.map((race) => race.id),
);

/** Fresh mutable copies for client state and tests. */
export function createDemoRaces(): RaceRecord[] {
  return JSON.parse(JSON.stringify(DEMO_RACES)) as RaceRecord[];
}

export function createDemoRace(): RaceRecord {
  return JSON.parse(JSON.stringify(DEMO_RACE)) as RaceRecord;
}

export const demoRace = DEMO_RACE;
export const demoRaces = DEMO_RACES;
export const demoRuleVersion = DEMO_RULE_VERSION;

export default DEMO_RACES;
