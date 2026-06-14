/**
 * Compute a "nice" axis scale for a small bar chart — a rounded maximum plus
 * evenly-spaced tick values — so users can read magnitudes off gridlines
 * instead of guessing from bar heights (GH #717... see issue #716: the
 * "Usage by day" chart had no Y-axis at all).
 *
 * Returns `{ max, ticks }` where `ticks` ascends from 0 to `max` inclusive.
 * Bars should be scaled against `max` (not the raw data max) so the tallest
 * bar aligns under the top gridline.
 *
 * Pure + unit-tested (tests/chartScale.test.ts).
 */
export interface AxisScale {
  max: number;
  ticks: number[];
}

/** Round a positive value to a "nice" step: 1, 2, 2.5, 5 (× 10ⁿ). */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const pow = Math.pow(10, exp);
  const frac = raw / pow; // [1, 10)
  let nice: number;
  if (frac <= 1) nice = 1;
  else if (frac <= 2) nice = 2;
  else if (frac <= 2.5) nice = 2.5;
  else if (frac <= 5) nice = 5;
  else nice = 10;
  return nice * pow;
}

export function niceAxisScale(rawMax: number, targetTicks = 4): AxisScale {
  if (!Number.isFinite(rawMax) || rawMax <= 0) {
    return { max: 0, ticks: [0] };
  }
  const intervals = Math.max(1, Math.floor(targetTicks));
  const step = niceStep(rawMax / intervals);
  const max = Math.ceil(rawMax / step) * step;
  const ticks: number[] = [];
  // Iterate by index (not `v += step`) to avoid floating-point drift, then
  // round each tick to a sane precision so 0.1 × 3 doesn't render 0.30000004.
  const count = Math.round(max / step);
  for (let i = 0; i <= count; i++) {
    ticks.push(Math.round(step * i * 1e6) / 1e6);
  }
  return { max, ticks };
}
