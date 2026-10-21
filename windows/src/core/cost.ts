// A conversation's totals as Settings → Claude Code → Usage says them
// (settings/usage.ts), kept free of the DOM: tested on their own.

/** US dollars with their cents, as the interface's language writes money. */
export function usd(amount: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
}

type DurationFormat = new (locale: string, options: Record<string, string>) => { format(d: Record<string, number>): string };

/**
 * A duration as Claude Code's /usage says it: its three largest units from
 * the first that isn't zero (3d 13h 55m, 13h 59m 17s, 42s), in the
 * interface's language where the webview can (Intl.DurationFormat).
 */
export function duration(ms: number, locale: string): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const all: [unit: string, n: number, short: string][] = [
    ["days", Math.floor(total / 86_400), "d"],
    ["hours", Math.floor(total / 3600) % 24, "h"],
    ["minutes", Math.floor(total / 60) % 60, "m"],
    ["seconds", total % 60, "s"],
  ];
  const first = all.findIndex(([, n]) => n > 0);
  const kept = first < 0 ? all.slice(3) : all.slice(first, first + 3);
  const Format = (Intl as unknown as { DurationFormat?: DurationFormat }).DurationFormat;
  if (Format) {
    // Nothing at all still says "0s".
    const options: Record<string, string> = first < 0 ? { style: "narrow", secondsDisplay: "always" } : { style: "narrow" };
    return new Format(locale, options).format(Object.fromEntries(kept.map(([unit, n]) => [unit, n])));
  }
  return kept.filter(([, n], i) => n > 0 || i === 0).map(([, n, short]) => `${n}${short}`).join(" ");
}
