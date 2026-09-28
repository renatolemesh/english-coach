/** Number formatting where JS's built-ins round or print differently than we need. */

/** Fixed-point with `digits` decimals: exact ties round half to even (95.25 -> "95.2"); JS's
 * toFixed rounds them up ("95.3"). Non-finite values print as "inf", "-inf" and "nan". */
export function formatFixed(x: number, digits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const exact = Math.abs(x).toFixed(Math.min(100, digits + 60)); // exact decimal expansion
  const cut = exact.indexOf(".") + digits + (digits > 0 ? 1 : 0);
  const rest = exact.slice(cut).replace(".", "");
  const tie = /^50*$/.test(rest);
  let out = x.toFixed(digits);
  if (tie) {
    const kept = exact.slice(0, cut).replace(".", "");
    const lastEven = Number(kept.at(-1)) % 2 === 0;
    if (lastEven) out = `${x < 0 ? "-" : ""}${exact.slice(0, cut).replace(/\.$/, "")}`;
  }
  return out;
}
