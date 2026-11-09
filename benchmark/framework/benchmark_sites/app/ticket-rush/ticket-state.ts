export const SALE_DELAY_MS = 180_000;
export const CLAIM_WINDOW_MS = 2_000;
export const EVENT_TIME_ZONE = "America/Chicago";

export type SalePhase = "scheduled" | "live" | "missed";

export type TicketTierId = "upper" | "lower" | "floor";

export interface PerformanceOption {
  value: string;
  label: string;
  shortLabel: string;
  posterLabel: string;
  year: number;
  confirmationCode: string;
}

export interface TicketTier {
  id: TicketTierId;
  label: string;
  price: number;
}

export interface PriceSummary {
  faceValue: number;
  serviceFees: number;
  venueFees: number;
  orderFee: number;
  total: number;
}

export const TICKET_TIERS: readonly TicketTier[] = [
  { id: "upper", label: "Upper Level", price: 109 },
  { id: "lower", label: "Lower Bowl", price: 189 },
  { id: "floor", label: "Floor", price: 249 },
];

function calendarDateInChicago(referenceDate: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(referenceDate);
  const values = new Map(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = values.get("year");
  const month = values.get("month");
  const day = values.get("day");

  if (year === undefined || month === undefined || day === undefined) {
    throw new Error("Could not resolve the Chicago calendar date");
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function performanceOption(value: string, date: Date): PerformanceOption {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  const shortLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
  const posterLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    month: "short",
    day: "numeric",
  })
    .format(date)
    .toUpperCase();
  const year = date.getUTCFullYear();
  const dateCode = [
    String(year).slice(-2),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");

  return {
    value,
    label: `${label} · 8:00 PM`,
    shortLabel,
    posterLabel,
    year,
    confirmationCode: `NS-CHI-${dateCode}-8427`,
  };
}

export function relativeSaturdayPerformances(
  referenceDate: Date,
): readonly [PerformanceOption, PerformanceOption] {
  const chicagoToday = calendarDateInChicago(referenceDate);
  const daysUntilSaturday = (6 - chicagoToday.getUTCDay() + 7) % 7;
  const nextWeekSaturday = addUtcDays(
    chicagoToday,
    daysUntilSaturday + 7,
  );
  const twoWeeksSaturday = addUtcDays(nextWeekSaturday, 7);

  return [
    performanceOption("chi-next-week-sat", nextWeekSaturday),
    performanceOption("chi-two-weeks-sat", twoWeeksSaturday),
  ];
}

export function deriveSalePhase(
  nowMs: number,
  navigationStartedAtMs: number,
): SalePhase {
  const elapsedMs = nowMs - navigationStartedAtMs;
  if (elapsedMs < SALE_DELAY_MS) {
    return "scheduled";
  }
  if (elapsedMs < SALE_DELAY_MS + CLAIM_WINDOW_MS) {
    return "live";
  }
  return "missed";
}

export function millisecondsUntilSale(
  nowMs: number,
  navigationStartedAtMs: number,
): number {
  return Math.max(0, navigationStartedAtMs + SALE_DELAY_MS - nowMs);
}

export function millisecondsLeftToClaim(
  nowMs: number,
  navigationStartedAtMs: number,
): number {
  const closesAtMs =
    navigationStartedAtMs + SALE_DELAY_MS + CLAIM_WINDOW_MS;
  return Math.max(0, closesAtMs - nowMs);
}

export function formatCountdown(milliseconds: number): string {
  const clampedMilliseconds = Math.max(0, milliseconds);
  const minutes = Math.floor(clampedMilliseconds / 60_000);
  const seconds = Math.floor((clampedMilliseconds % 60_000) / 1_000);
  const tenths = Math.floor((clampedMilliseconds % 1_000) / 100);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${tenths}`;
}

export function priceSummary(
  tierId: TicketTierId,
  quantity: number,
): PriceSummary {
  const tier = TICKET_TIERS.find((candidate) => candidate.id === tierId);
  if (!tier) {
    throw new Error(`Unknown ticket tier: ${tierId}`);
  }

  const faceValue = tier.price * quantity;
  const serviceFees = 24 * quantity;
  const venueFees = 8 * quantity;
  const orderFee = 6;

  return {
    faceValue,
    serviceFees,
    venueFees,
    orderFee,
    total: faceValue + serviceFees + venueFees + orderFee,
  };
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(amount);
}
