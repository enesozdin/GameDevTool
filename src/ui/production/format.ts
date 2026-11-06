import type { Settings } from "../../core/index.ts";

export type RateUnit = Settings["rateUnit"];

/** Seconds per display unit. Rates are stored per second (SI). */
export const UNIT_SECONDS: Readonly<Record<RateUnit, number>> = { second: 1, minute: 60, hour: 3_600 };

const numberFormat = new Intl.NumberFormat("en", { maximumSignificantDigits: 4 });

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "–";
  return numberFormat.format(Math.abs(n) < 1e-9 ? 0 : n);
}

/** Items/s → text in the project's display unit, e.g. "12 /min". */
export function formatRate(perSecond: number, unit: RateUnit, suffix: Readonly<Record<string, string>>): string {
  return `${formatNumber(perSecond * UNIT_SECONDS[unit])} ${suffix[unit] ?? ""}`;
}

