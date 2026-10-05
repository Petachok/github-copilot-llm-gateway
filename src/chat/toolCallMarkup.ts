/**
 * Spots a tool call that the server returned as plain text. vLLM, for one,
 * only runs its tool-call parser for a request that carries tools with
 * `tool_choice: 'auto'`, so on a text-only round a model that still writes a
 * call (it sees its earlier ones in the history) streams its native markup
 * (`<tool_call>…`) as ordinary content. Handles markers that split across
 * SSE chunks. Pure (no `vscode` import).
 */

/** Opening markers of the common native tool-call syntaxes. */
const MARKERS: readonly string[] = [
  '<tool_call>', // Hermes, Qwen, GLM
  '<|tool_call|>', // Granite
  '<|tool_call_start|>', // LFM2
  '<function_call>',
  '<function=', // Llama 3.x
  '<|python_tag|>', // Llama 3.1 built-in tools
  '[TOOL_CALLS]', // Mistral
  '<｜tool▁calls▁begin｜>', // DeepSeek
  '<|tool_calls_section_begin|>', // Kimi K2
  '<minimax:tool_call>',
  '<seed:tool_call>',
];

function earliestMarker(text: string): number {
  let best = -1;
  for (const marker of MARKERS) {
    const i = text.indexOf(marker);
    if (i >= 0 && (best < 0 || i < best)) {
      best = i;
    }
  }
  return best;
}

/** How many trailing characters of `text` could be the start of a marker still arriving? */
function partialMarkerSuffixLength(text: string): number {
  let hold = 0;
  for (const marker of MARKERS) {
    for (let i = Math.min(marker.length - 1, text.length); i > hold; i--) {
      if (text.endsWith(marker.slice(0, i))) {
        hold = i;
        break;
      }
    }
  }
  return hold;
}

export interface ScannedText {
  /** The part of the input that is safe to show. */
  readonly text: string;
  /** True once a marker was found; the marker and everything after it are dropped. */
  readonly cut: boolean;
}

export class ToolCallMarkupScanner {
  private held = '';
  private cut = false;

  push(text: string): ScannedText {
    if (this.cut) {
      return { text: '', cut: true };
    }
    this.held += text;
    const at = earliestMarker(this.held);
    if (at >= 0) {
      this.cut = true;
      const before = this.held.slice(0, at);
      this.held = '';
      return { text: before, cut: true };
    }
    const safeLength = this.held.length - partialMarkerSuffixLength(this.held);
    const safe = this.held.slice(0, safeLength);
    this.held = this.held.slice(safeLength);
    return { text: safe, cut: false };
  }

  /** Held text that turned out not to start a marker; call at end of stream. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    return rest;
  }
}
