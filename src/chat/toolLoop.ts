/**
 * Detects an agent tool-call loop across rounds: the model making the same
 * tool call(s) with identical arguments and getting identical results round
 * after round. Stateless — every round's request carries the full history.
 * Pure (no `vscode` import).
 */

import { OpenAIMessage } from '../api/types';

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

export interface RepeatedToolCall {
  readonly name: string;
  /** Raw JSON arguments as recorded in the history. */
  readonly arguments: string;
}

export interface ToolLoopStatus {
  /** Consecutive trailing rounds identical to the latest one; 0 when it made no tool calls. */
  readonly count: number;
  readonly toolNames: readonly string[];
  /** The calls of the latest round, i.e. the ones being repeated. */
  readonly calls: readonly RepeatedToolCall[];
}

/** 'block' withholds a repeat of the looping call(s); anything else the model does still goes through. */
export type ToolLoopAction = 'none' | 'nudge' | 'block';

const NO_LOOP: ToolLoopStatus = { count: 0, toolNames: [], calls: [] };

function callName(call: WireToolCall): string {
  return typeof call.function?.name === 'string' ? call.function.name : '';
}

function callArguments(call: WireToolCall): string {
  const args = call.function?.arguments;
  return typeof args === 'string' ? args : JSON.stringify(args ?? null);
}

function roundSignature(calls: readonly WireToolCall[], results: ReadonlyMap<string, string>): string {
  return calls
    .map((call) => [callName(call), callArguments(call), results.get(String(call.id)) ?? ''].join('\u0000'))
    .sort((a, b) => a.localeCompare(b))
    .join('\u0001');
}

function recordToolResult(msg: OpenAIMessage, results: Map<string, string>): void {
  if (typeof msg.tool_call_id === 'string' && typeof msg.content === 'string') {
    results.set(msg.tool_call_id, msg.content);
  }
}

/**
 * Walk back from the latest round, skipping user messages between rounds,
 * until an assistant message differs from it or carries no tool calls (the
 * end of an earlier turn). A request ending in a user message is a fresh
 * prompt, not a continuation, so it never counts.
 */
export function countRepeatedToolRounds(messages: readonly OpenAIMessage[]): ToolLoopStatus {
  if (messages[messages.length - 1]?.role === 'user') {
    return NO_LOOP;
  }

  // Results are paired with the round they follow; some servers reuse call ids across rounds.
  let results = new Map<string, string>();
  let latest: string | undefined;
  let toolNames: string[] = [];
  let repeated: RepeatedToolCall[] = [];
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      recordToolResult(msg, results);
      continue;
    }
    if (msg.role !== 'assistant') {
      continue;
    }
    const calls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as WireToolCall[]) : [];
    if (calls.length === 0) {
      break;
    }
    const signature = roundSignature(calls, results);
    results = new Map();
    if (latest === undefined) {
      latest = signature;
      toolNames = [...new Set(calls.map(callName))];
      repeated = calls.map((call) => ({ name: callName(call), arguments: callArguments(call) }));
    } else if (signature !== latest) {
      break;
    }
    count++;
  }
  return { count, toolNames, calls: repeated };
}

/** The count includes the current round, so a threshold below 2 would fire on every tool round. */
const MIN_THRESHOLD = 2;

/** A threshold below 2 (e.g. 0) disables that level. */
export function resolveToolLoopAction(count: number, nudgeAfter: number, blockAfter: number): ToolLoopAction {
  if (blockAfter >= MIN_THRESHOLD && count >= blockAfter) {
    return 'block';
  }
  if (nudgeAfter >= MIN_THRESHOLD && count >= nudgeAfter) {
    return 'nudge';
  }
  return 'none';
}

/** Model-facing note appended to the latest tool result. */
export function buildToolLoopNote(status: ToolLoopStatus, block: boolean): string {
  const seen =
    `[Loop guard] You have called ${status.toolNames.join(', ')} ${status.count} times in a row ` +
    'with identical arguments and received identical results.';
  return block
    ? `${seen} That exact call is now blocked and will not run again. Use the result you already have, call a different tool or use different arguments, or answer the user.`
    : `${seen} Repeating the call will not produce new information. Use the result you already have, try a different approach, or answer the user.`;
}

/**
 * Append `note` to the latest tool result rather than adding a new message:
 * some chat templates reject a user or system message right after a tool result.
 */
export function appendToolLoopNudge(messages: readonly OpenAIMessage[], note: string): OpenAIMessage[] {
  const copy = [...messages];
  for (let i = copy.length - 1; i >= 0; i--) {
    const msg = copy[i];
    if (msg.role === 'tool' && typeof msg.content === 'string') {
      copy[i] = { ...msg, content: `${msg.content}\n\n${note}` };
      break;
    }
  }
  return copy;
}

/** JSON with object keys sorted at every level, so argument order does not matter. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toolCallKey(name: string, args: unknown): string {
  return `${name}\u0000${canonicalJson(args)}`;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export type ToolCallFilter = (name: string, args: Record<string, unknown>) => boolean;

/** True for a repeat of one of the looping calls (same tool, same arguments); any other call passes. */
export function isRepeatedToolCall(status: ToolLoopStatus): ToolCallFilter {
  const blocked = new Set(status.calls.map((call) => toolCallKey(call.name, parseArguments(call.arguments))));
  return (name, args) => blocked.has(toolCallKey(name, args));
}

export interface ToolLoopGuardOptions {
  /** False for utility requests (titles, summaries) that replay agent history without offering tools. */
  readonly toolsOffered: boolean;
  readonly nudgeAfter: number;
  readonly blockAfter: number;
  /** False when the caller requires a tool call, which caps the guard at a nudge. */
  readonly canBlock: boolean;
}

export interface ToolLoopGuard {
  /** 'block' means a repeat of `status.calls` in the reply must be withheld (see `isRepeatedToolCall`). */
  readonly action: ToolLoopAction;
  readonly status: ToolLoopStatus;
  /** The request history, with the loop note appended once the guard fires. */
  readonly messages: OpenAIMessage[];
}

/** Pick the guard action for one request and append the matching note to its history. */
export function guardToolLoop(messages: OpenAIMessage[], options: ToolLoopGuardOptions): ToolLoopGuard {
  if (!options.toolsOffered) {
    return { action: 'none', status: NO_LOOP, messages };
  }
  const status = countRepeatedToolRounds(messages);
  const resolved = resolveToolLoopAction(status.count, options.nudgeAfter, options.blockAfter);
  const action = resolved === 'block' && !options.canBlock ? 'nudge' : resolved;
  if (action === 'none') {
    return { action, status, messages };
  }
  const note = buildToolLoopNote(status, action === 'block');
  return { action, status, messages: appendToolLoopNudge(messages, note) };
}
