import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAIM_WINDOW_MS,
  deriveSalePhase,
  formatCountdown,
  millisecondsLeftToClaim,
  millisecondsUntilSale,
  priceSummary,
  relativeSaturdayPerformances,
  SALE_DELAY_MS,
} from "../app/ticket-rush/ticket-state.ts";

test("the sale opens exactly three minutes after navigation", () => {
  const startedAt = 1_000;

  assert.equal(SALE_DELAY_MS, 180_000);
  assert.equal(
    deriveSalePhase(startedAt + SALE_DELAY_MS - 1, startedAt),
    "scheduled",
  );
  assert.equal(
    deriveSalePhase(startedAt + SALE_DELAY_MS, startedAt),
    "live",
  );
});

test("the claim window closes exactly two seconds after opening", () => {
  const startedAt = 5_000;

  assert.equal(
    deriveSalePhase(
      startedAt + SALE_DELAY_MS + CLAIM_WINDOW_MS - 1,
      startedAt,
    ),
    "live",
  );
  assert.equal(
    deriveSalePhase(
      startedAt + SALE_DELAY_MS + CLAIM_WINDOW_MS,
      startedAt,
    ),
    "missed",
  );
});

test("countdown helpers clamp terminal values to zero", () => {
  const startedAt = 10_000;

  assert.equal(millisecondsUntilSale(startedAt, startedAt), SALE_DELAY_MS);
  assert.equal(
    millisecondsUntilSale(startedAt + SALE_DELAY_MS + 1, startedAt),
    0,
  );
  assert.equal(
    millisecondsLeftToClaim(startedAt + SALE_DELAY_MS, startedAt),
    CLAIM_WINDOW_MS,
  );
  assert.equal(
    millisecondsLeftToClaim(
      startedAt + SALE_DELAY_MS + CLAIM_WINDOW_MS + 1,
      startedAt,
    ),
    0,
  );
  assert.equal(formatCountdown(180_000), "03:00.0");
  assert.equal(formatCountdown(-100), "00:00.0");
});

test("two Lower Bowl tickets total $448 including disclosed fees", () => {
  assert.deepEqual(priceSummary("lower", 2), {
    faceValue: 378,
    serviceFees: 48,
    venueFees: 16,
    orderFee: 6,
    total: 448,
  });
});

test("performances use next-week and two-weeks-out Saturdays in Chicago", () => {
  const [nextWeek, twoWeeks] = relativeSaturdayPerformances(
    new Date("2026-07-24T18:00:00Z"),
  );

  assert.deepEqual(nextWeek, {
    value: "chi-next-week-sat",
    label: "Saturday, August 1, 2026 · 8:00 PM",
    shortLabel: "Sat, Aug 1, 2026",
    posterLabel: "AUG 1",
    year: 2026,
    confirmationCode: "NS-CHI-260801-8427",
  });
  assert.deepEqual(twoWeeks, {
    value: "chi-two-weeks-sat",
    label: "Saturday, August 8, 2026 · 8:00 PM",
    shortLabel: "Sat, Aug 8, 2026",
    posterLabel: "AUG 8",
    year: 2026,
    confirmationCode: "NS-CHI-260808-8427",
  });
});

test("relative performance dates roll across years", () => {
  const [nextWeek, twoWeeks] = relativeSaturdayPerformances(
    new Date("2026-12-25T18:00:00Z"),
  );

  assert.equal(nextWeek.shortLabel, "Sat, Jan 2, 2027");
  assert.equal(twoWeeks.shortLabel, "Sat, Jan 9, 2027");
});

test("relative performance dates use the Chicago calendar day", () => {
  const [nextWeek] = relativeSaturdayPerformances(
    new Date("2026-07-26T04:30:00Z"),
  );

  assert.equal(nextWeek.shortLabel, "Sat, Aug 1, 2026");
});
