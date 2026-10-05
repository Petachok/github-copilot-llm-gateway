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

export interface ToolLoopStatus {
  /** Consecutive trailing rounds identical to the latest one; 0 when it made no tool calls. */
  readonly count: number;
  readonly toolNames: readonly string[];
}

export type ToolLoopAction = 'none' | 'nudge' | 'forceAnswer';

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
    return { count: 0, toolNames: [] };
  }

  // Results are paired with the round they follow; some servers reuse call ids across rounds.
  let results = new Map<string, string>();
  let latest: string | undefined;
  let toolNames: string[] = [];
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
    } else if (signature !== latest) {
      break;
    }
    count++;
  }
  return { count, toolNames };
}

/** The count includes the current round, so a threshold below 2 would fire on every tool round. */
const MIN_THRESHOLD = 2;

/** A threshold below 2 (e.g. 0) disables that level. */
export function resolveToolLoopAction(count: number, nudgeAfter: number, forceAnswerAfter: number): ToolLoopAction {
  if (forceAnswerAfter >= MIN_THRESHOLD && count >= forceAnswerAfter) {
    return 'forceAnswer';
  }
  if (nudgeAfter >= MIN_THRESHOLD && count >= nudgeAfter) {
    return 'nudge';
  }
  return 'none';
}

/** Model-facing note appended to the latest tool result. */
export function buildToolLoopNote(status: ToolLoopStatus, forceAnswer: boolean): string {
  const seen =
    `[Loop guard] You have called ${status.toolNames.join(', ')} ${status.count} times in a row ` +
    'with identical arguments and received identical results.';
  return forceAnswer
    ? `${seen} Tools are disabled for this reply. Answer with what you know so far, explain what is blocking you, and ask the user how to proceed.`
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

export interface ToolLoopGuardOptions {
  /** False for utility requests (titles, summaries) that replay agent history without offering tools. */
  readonly toolsOffered: boolean;
  readonly nudgeAfter: number;
  readonly forceAnswerAfter: number;
  /** False when the caller requires a tool call, which caps the guard at a nudge. */
  readonly canForceAnswer: boolean;
}

export interface ToolLoopGuard {
  /** 'forceAnswer' means the request must send `tool_choice: 'none'` and withhold any tool call. */
  readonly action: ToolLoopAction;
  readonly status: ToolLoopStatus;
  /** The request history, with the loop note appended once the guard fires. */
  readonly messages: OpenAIMessage[];
}

/** Pick the guard action for one request and append the matching note to its history. */
export function guardToolLoop(messages: OpenAIMessage[], options: ToolLoopGuardOptions): ToolLoopGuard {
  if (!options.toolsOffered) {
    return { action: 'none', status: { count: 0, toolNames: [] }, messages };
  }
  const status = countRepeatedToolRounds(messages);
  const resolved = resolveToolLoopAction(status.count, options.nudgeAfter, options.forceAnswerAfter);
  const action = resolved === 'forceAnswer' && !options.canForceAnswer ? 'nudge' : resolved;
  if (action === 'none') {
    return { action, status, messages };
  }
  const note = buildToolLoopNote(status, action === 'forceAnswer');
  return { action, status, messages: appendToolLoopNudge(messages, note) };
}
