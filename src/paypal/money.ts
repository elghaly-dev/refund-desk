/** Compare and add USD-style decimal strings (two fractional digits). */

const MONEY_RX = /^-?\d+\.\d{2}$/;

export function assertMoney(value: string): string {
  if (!MONEY_RX.test(value)) throw new Error("bad money");
  return value;
}

function toCents(value: string): bigint {
  assertMoney(value);
  const negative = value.startsWith("-");
  const [whole, frac] = value.replace("-", "").split(".");
  const cents = BigInt(whole) * 100n + BigInt(frac);
  return negative ? -cents : cents;
}

export function fromCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const text = `${whole}.${frac.toString().padStart(2, "0")}`;
  return negative ? `-${text}` : text;
}

export function moneyLessOrEqual(a: string, b: string): boolean {
  return toCents(a) <= toCents(b);
}

export function moneySubtract(a: string, b: string): string {
  return fromCents(toCents(a) - toCents(b));
}

export function moneyMin(a: string, b: string): string {
  return toCents(a) <= toCents(b) ? a : b;
}
