import type {
  BetCombination,
  BetMethod,
  BetPlan,
  BetSummary,
  BetType,
  Payout,
  RaceSettlement,
} from "./types";

const BET_ARITY: Readonly<Record<BetType, 1 | 2 | 3>> = {
  win: 1,
  quinella: 2,
  wide: 2,
  trio: 3,
  trifecta: 3,
};

const UNORDERED_BETS = new Set<BetType>(["quinella", "wide", "trio"]);

/** A single-win ticket has no BOX or formation representation. */
export function normalizeBetMethod(
  betType: BetType,
  method: BetMethod,
): BetMethod {
  return betType === "win" ? "normal" : method;
}

export class BetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BetValidationError";
  }
}

function assertHorseNumber(value: number, context: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 99) {
    throw new BetValidationError(
      `${context}の馬番は1〜99の整数で指定してください（受け取った値: ${String(value)}）`,
    );
  }
}

function uniqueNumbers(values: number[], context: string): number[] {
  values.forEach((value) => assertHorseNumber(value, context));
  return [...new Set(values)];
}

function normalizeCombination(
  betType: BetType,
  combination: number[],
  context: string,
): BetCombination {
  const arity = BET_ARITY[betType];
  if (combination.length !== arity) {
    throw new BetValidationError(
      `${context}は${arity}頭で指定してください（受け取った頭数: ${combination.length}）`,
    );
  }
  combination.forEach((value) => assertHorseNumber(value, context));
  if (new Set(combination).size !== combination.length) {
    throw new BetValidationError(`${context}では同じ馬番を重複指定できません`);
  }

  return UNORDERED_BETS.has(betType)
    ? [...combination].sort((left, right) => left - right)
    : [...combination];
}

function combinationKey(combination: BetCombination): string {
  return combination.join("-");
}

function deduplicateCombinations(
  betType: BetType,
  combinations: number[][],
  context: string,
): BetCombination[] {
  const result = new Map<string, BetCombination>();
  combinations.forEach((combination, index) => {
    const normalized = normalizeCombination(
      betType,
      combination,
      `${context}${index + 1}点目`,
    );
    result.set(combinationKey(normalized), normalized);
  });
  return [...result.values()];
}

function combinations(values: number[], choose: number): number[][] {
  if (choose === 0) return [[]];
  if (values.length < choose) return [];

  const result: number[][] = [];
  values.forEach((value, index) => {
    for (const tail of combinations(values.slice(index + 1), choose - 1)) {
      result.push([value, ...tail]);
    }
  });
  return result;
}

function permutations(values: number[], choose: number): number[][] {
  if (choose === 0) return [[]];

  const result: number[][] = [];
  values.forEach((value, index) => {
    const remaining = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(remaining, choose - 1)) {
      result.push([value, ...tail]);
    }
  });
  return result;
}

function cartesianProduct(groups: number[][]): number[][] {
  return groups.reduce<number[][]>(
    (prefixes, group) =>
      prefixes.flatMap((prefix) =>
        group
          .filter((horseNumber) => !prefix.includes(horseNumber))
          .map((horseNumber) => [...prefix, horseNumber]),
      ),
    [[]],
  );
}

function assertStake(stakePerPoint: number, context: string): void {
  if (
    !Number.isInteger(stakePerPoint) ||
    stakePerPoint < 100 ||
    stakePerPoint % 100 !== 0
  ) {
    throw new BetValidationError(
      `${context}の1点金額は100円以上、100円単位の整数で指定してください`,
    );
  }
}

/**
 * Expand a normal, BOX or formation plan to unique concrete ticket points.
 * Unordered products are canonicalized, so `1-2` and `2-1` count once.
 */
export function expandBetCombinations(plan: BetPlan): BetCombination[] {
  if (!(plan.betType in BET_ARITY)) {
    throw new BetValidationError(`未対応の券種です: ${String(plan.betType)}`);
  }
  assertStake(plan.stakePerPoint, `買い目「${plan.id || "(IDなし)"}」`);

  const arity = BET_ARITY[plan.betType];
  const context = `買い目「${plan.id || "(IDなし)"}」の`;

  switch (plan.selection.method) {
    case "normal":
      return deduplicateCombinations(
        plan.betType,
        plan.selection.combinations,
        `${context}通常指定`,
      );

    case "box": {
      const horses = uniqueNumbers(plan.selection.horses, `${context}BOX指定`);
      const expanded =
        plan.betType === "trifecta"
          ? permutations(horses, arity)
          : combinations(horses, arity);
      return deduplicateCombinations(plan.betType, expanded, `${context}BOX指定`);
    }

    case "formation": {
      if (plan.selection.positions.length !== arity) {
        throw new BetValidationError(
          `${context}フォーメーションは${arity}列で指定してください（受け取った列数: ${plan.selection.positions.length}）`,
        );
      }
      const positions = plan.selection.positions.map((position, index) =>
        uniqueNumbers(position, `${context}フォーメーション${index + 1}列目`),
      );
      if (positions.some((position) => position.length === 0)) {
        throw new BetValidationError(
          `${context}フォーメーションの各列には1頭以上指定してください`,
        );
      }
      return deduplicateCombinations(
        plan.betType,
        cartesianProduct(positions),
        `${context}フォーメーション`,
      );
    }
  }
}

export function calculateBetPoints(plan: BetPlan): number {
  return expandBetCombinations(plan).length;
}

/** Alias useful at call sites that read as a question. */
export const countBetPoints = calculateBetPoints;

export function calculateBetInvestment(plan: BetPlan): number {
  return calculateBetPoints(plan) * plan.stakePerPoint;
}

export function calculateBetSummary(plans: readonly BetPlan[]): BetSummary {
  return plans.reduce<BetSummary>(
    (summary, plan) => {
      const points = calculateBetPoints(plan);
      return {
        points: summary.points + points,
        investment: summary.investment + points * plan.stakePerPoint,
      };
    },
    { points: 0, investment: 0 },
  );
}

export function calculateTotalInvestment(plans: readonly BetPlan[]): number {
  return calculateBetSummary(plans).investment;
}

export function calculateProfit(investment: number, payout: number): number {
  if (!Number.isFinite(investment) || investment < 0) {
    throw new BetValidationError("投資額は0以上の有限数で指定してください");
  }
  if (!Number.isFinite(payout) || payout < 0) {
    throw new BetValidationError("払戻額は0以上の有限数で指定してください");
  }
  return payout - investment;
}

export function calculateRecoveryRate(
  payout: number,
  investment: number,
): number {
  calculateProfit(investment, payout);
  if (investment === 0) return 0;
  return Math.round((payout / investment) * 1_000) / 10;
}

function payoutKey(betType: BetType, combination: number[]): string {
  return `${betType}:${combinationKey(
    normalizeCombination(betType, combination, "払戻の組み合わせ"),
  )}`;
}

/**
 * Settle actual purchased tickets against official ¥100 payouts.
 * A ¥200 winning point therefore receives twice `payoutPer100`.
 */
export function calculateRaceSettlement(
  purchasedBets: readonly BetPlan[],
  payouts: readonly Payout[],
): RaceSettlement {
  const payoutMap = new Map<string, number>();

  payouts.forEach((payout, index) => {
    if (!Number.isInteger(payout.payoutPer100) || payout.payoutPer100 < 0) {
      throw new BetValidationError(
        `${index + 1}件目の払戻額は0以上の整数で指定してください`,
      );
    }
    const key = payoutKey(payout.betType, payout.combination);
    if (payoutMap.has(key)) {
      throw new BetValidationError(
        `${index + 1}件目の払戻は同じ券種・組み合わせが重複しています`,
      );
    }
    payoutMap.set(key, payout.payoutPer100);
  });

  let points = 0;
  let investment = 0;
  let payout = 0;

  purchasedBets.forEach((plan) => {
    const expanded = expandBetCombinations(plan);
    points += expanded.length;
    investment += expanded.length * plan.stakePerPoint;
    expanded.forEach((ticket) => {
      const officialPayout = payoutMap.get(payoutKey(plan.betType, ticket));
      if (officialPayout !== undefined) {
        payout += officialPayout * (plan.stakePerPoint / 100);
      }
    });
  });

  return {
    points,
    investment,
    payout,
    profit: calculateProfit(investment, payout),
    recoveryRate: calculateRecoveryRate(payout, investment),
  };
}

export const calculateSettlement = calculateRaceSettlement;
