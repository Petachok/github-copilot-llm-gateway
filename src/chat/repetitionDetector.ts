/**
 * Detects a streamed response that has degenerated into an exact repeating
 * cycle — a small or quantized model stuck emitting the same sentence or
 * paragraph until it exhausts `max_tokens`. Pure (no `vscode` import).
 */

const WINDOW_CHARS = 4096;
const CHECK_EVERY_CHARS = 256;
const MIN_PERIOD = 20;
const MAX_PERIOD = 800;
const MIN_REPEATS = 4;
/**
 * Short units must repeat across at least this many chars before they count,
 * so legitimate boilerplate (identical mock rows, empty grid cells) survives.
 */
const MIN_REPEATED_SPAN = 2000;
/** Rules out separator lines, dot leaders and `0, 0, 0` arrays. */
const MIN_DISTINCT_CHARS = 8;

export class RepetitionDetector {
  private buffer = '';
  private sinceCheck = 0;

  /** Append streamed text; returns true once the tail is a repeating cycle. */
  push(text: string): boolean {
    if (!text) {
      return false;
    }
    this.buffer = (this.buffer + text).slice(-WINDOW_CHARS);
    this.sinceCheck += text.length;
    if (this.sinceCheck < CHECK_EVERY_CHARS) {
      return false;
    }
    this.sinceCheck = 0;
    return hasRepeatingTail(this.buffer.replaceAll(/\s+/g, ' '));
  }
}

function hasRepeatingTail(text: string): boolean {
  for (let period = MIN_PERIOD; period <= MAX_PERIOD; period++) {
    const span = period * Math.max(MIN_REPEATS, Math.ceil(MIN_REPEATED_SPAN / period));
    if (span > text.length) {
      continue;
    }
    const tail = text.slice(-span);
    // A string is p-periodic exactly when it equals itself shifted by p.
    if (tail.slice(period) === tail.slice(0, span - period) && distinctNonSpace(tail.slice(-period)) >= MIN_DISTINCT_CHARS) {
      return true;
    }
  }
  return false;
}

function distinctNonSpace(unit: string): number {
  return new Set(unit.replaceAll(' ', '')).size;
}
