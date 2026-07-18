import { describe, expect, it } from "vitest";
import {
  BetValidationError,
  calculateBetInvestment,
  calculateBetPoints,
  calculateBetSummary,
  calculateProfit,
  calculateRaceSettlement,
  calculateRecoveryRate,
  expandBetCombinations,
  normalizeBetMethod,
} from "../lib/calculations";
import type { BetPlan, BetType } from "../lib/types";

function boxPlan(betType: BetType, horses = [1, 2, 3, 4]): BetPlan {
  return {
    id: `box-${betType}`,
    betType,
    selection: { method: "box", horses },
    stakePerPoint: 100,
  };
}

describe("normalizeBetMethod", () => {
  it("単勝では直前の方式にかかわらず通常買いへ正規化する", () => {
    expect(normalizeBetMethod("win", "normal")).toBe("normal");
    expect(normalizeBetMethod("win", "box")).toBe("normal");
    expect(normalizeBetMethod("win", "formation")).toBe("normal");
  });

  it("単勝以外では選択済みの方式を保持する", () => {
    expect(normalizeBetMethod("quinella", "box")).toBe("box");
    expect(normalizeBetMethod("trifecta", "formation")).toBe("formation");
  });
});

describe("expandBetCombinations", () => {
  it("順不同券種の通常買いを正規化し、重複を除く", () => {
    const plan: BetPlan = {
      id: "normal-quinella",
      betType: "quinella",
      selection: {
        method: "normal",
        combinations: [
          [2, 1],
          [1, 2],
          [1, 3],
          [3, 1],
        ],
      },
      stakePerPoint: 100,
    };

    expect(expandBetCombinations(plan)).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(calculateBetPoints(plan)).toBe(2);
  });

  it("3連単では着順違いを別の点として扱う", () => {
    const plan: BetPlan = {
      id: "normal-trifecta",
      betType: "trifecta",
      selection: {
        method: "normal",
        combinations: [
          [1, 2, 3],
          [1, 3, 2],
          [1, 2, 3],
        ],
      },
      stakePerPoint: 100,
    };

    expect(expandBetCombinations(plan)).toEqual([
      [1, 2, 3],
      [1, 3, 2],
    ]);
  });

  it.each([
    ["win", 4],
    ["quinella", 6],
    ["wide", 6],
    ["trio", 4],
    ["trifecta", 24],
  ] as const)("%s BOXの点数を計算する", (betType, expected) => {
    expect(calculateBetPoints(boxPlan(betType))).toBe(expected);
  });

  it("BOX内の入力重複は点数に含めない", () => {
    expect(calculateBetPoints(boxPlan("trio", [1, 1, 2, 3, 3, 4]))).toBe(4);
  });

  it("順不同フォーメーションの列またぎ重複を除く", () => {
    const plan: BetPlan = {
      id: "formation-trio",
      betType: "trio",
      selection: {
        method: "formation",
        positions: [[1], [2, 3], [2, 3, 4]],
      },
      stakePerPoint: 100,
    };

    expect(expandBetCombinations(plan)).toEqual([
      [1, 2, 3],
      [1, 2, 4],
      [1, 3, 4],
    ]);
  });

  it("3連単フォーメーションでは列の順序を維持する", () => {
    const plan: BetPlan = {
      id: "formation-trifecta",
      betType: "trifecta",
      selection: {
        method: "formation",
        positions: [[1], [2, 3], [2, 3, 4]],
      },
      stakePerPoint: 100,
    };

    expect(expandBetCombinations(plan)).toEqual([
      [1, 2, 3],
      [1, 2, 4],
      [1, 3, 2],
      [1, 3, 4],
    ]);
  });

  it("同じ馬を同一点内に指定した通常買いを拒否する", () => {
    const invalid: BetPlan = {
      id: "invalid",
      betType: "wide",
      selection: { method: "normal", combinations: [[2, 2]] },
      stakePerPoint: 100,
    };
    expect(() => expandBetCombinations(invalid)).toThrow(BetValidationError);
    expect(() => expandBetCombinations(invalid)).toThrow(/同じ馬番/);
  });

  it("券種と異なる列数のフォーメーションを拒否する", () => {
    const invalid: BetPlan = {
      id: "invalid-columns",
      betType: "trio",
      selection: { method: "formation", positions: [[1], [2, 3]] },
      stakePerPoint: 100,
    };
    expect(() => expandBetCombinations(invalid)).toThrow(/3列/);
  });

  it("100円単位でない1点金額を拒否する", () => {
    const invalid = { ...boxPlan("win"), stakePerPoint: 150 };
    expect(() => calculateBetPoints(invalid)).toThrow(/100円単位/);
  });
});

describe("investment and settlement", () => {
  it("点数、1点金額、合計投資額を集計する", () => {
    const win = { ...boxPlan("win", [1, 2]), stakePerPoint: 300 };
    const quinella = boxPlan("quinella", [1, 2, 3]);

    expect(calculateBetInvestment(win)).toBe(600);
    expect(calculateBetSummary([win, quinella])).toEqual({
      points: 5,
      investment: 900,
    });
  });

  it("購入券面と100円あたり払戻から収支・回収率を計算する", () => {
    const purchased: BetPlan[] = [
      {
        id: "win",
        betType: "win",
        selection: { method: "normal", combinations: [[4]] },
        stakePerPoint: 200,
      },
      {
        id: "wide",
        betType: "wide",
        selection: { method: "normal", combinations: [[4, 8]] },
        stakePerPoint: 300,
      },
      {
        id: "trifecta",
        betType: "trifecta",
        selection: { method: "normal", combinations: [[4, 8, 2]] },
        stakePerPoint: 100,
      },
    ];

    expect(
      calculateRaceSettlement(purchased, [
        { betType: "win", combination: [4], payoutPer100: 480 },
        // Wide is unordered and should match the reversed official value.
        { betType: "wide", combination: [8, 4], payoutPer100: 1_200 },
        {
          betType: "trifecta",
          combination: [4, 8, 2],
          payoutPer100: 10_000,
        },
      ]),
    ).toEqual({
      points: 3,
      investment: 600,
      payout: 14_560,
      profit: 13_960,
      recoveryRate: 2_426.7,
    });
  });

  it("投資がない場合の収支と回収率を0にする", () => {
    expect(calculateRaceSettlement([], [])).toEqual({
      points: 0,
      investment: 0,
      payout: 0,
      profit: 0,
      recoveryRate: 0,
    });
  });

  it("収支と回収率の単体計算を行う", () => {
    expect(calculateProfit(1_000, 1_250)).toBe(250);
    expect(calculateRecoveryRate(1_250, 1_000)).toBe(125);
  });

  it("順不同で同じ払戻の重複登録を拒否する", () => {
    expect(() =>
      calculateRaceSettlement([], [
        { betType: "wide", combination: [1, 2], payoutPer100: 300 },
        { betType: "wide", combination: [2, 1], payoutPer100: 300 },
      ]),
    ).toThrow(/重複/);
  });
});
