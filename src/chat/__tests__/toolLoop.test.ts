import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIMessage } from '../../api/types';
import {
  appendToolLoopNudge,
  buildToolLoopNote,
  countRepeatedToolRounds,
  resolveToolLoopAction,
} from '../toolLoop';

function call(id: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function round(id: string, name: string, args: Record<string, unknown>, result: string): OpenAIMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [call(id, name, args)] },
    { role: 'tool', tool_call_id: id, content: result },
  ];
}

const PROMPT: OpenAIMessage[] = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: 'Fix the failing test.' },
];

const READ_ARGS = { filePath: '/repo/src/a.ts', startLine: 1, endLine: 50 };

describe('countRepeatedToolRounds', () => {
  test('counts identical trailing rounds', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.deepEqual(countRepeatedToolRounds(messages), { count: 3, toolNames: ['read_file'] });
  });

  test('a different result breaks the chain', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'get_terminal_output', { id: 't1' }, 'building...'),
      ...round('c2', 'get_terminal_output', { id: 't1' }, 'building... 50%'),
      ...round('c3', 'get_terminal_output', { id: 't1' }, 'building... done'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('different arguments break the chain', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'same'),
      ...round('c2', 'read_file', { ...READ_ARGS, endLine: 100 }, 'same'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('stops at a plain assistant answer from an earlier turn', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'Check again.' },
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });

  test('skips user messages between rounds', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      { role: 'user', content: 'Context update.' },
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 2);
  });

  test('matches parallel calls regardless of order', () => {
    const messages: OpenAIMessage[] = [
      ...PROMPT,
      { role: 'assistant', content: null, tool_calls: [call('a1', 'read_file', READ_ARGS), call('b1', 'grep', { q: 'x' })] },
      { role: 'tool', tool_call_id: 'a1', content: 'file body' },
      { role: 'tool', tool_call_id: 'b1', content: 'no matches' },
      { role: 'assistant', content: null, tool_calls: [call('b2', 'grep', { q: 'x' }), call('a2', 'read_file', READ_ARGS)] },
      { role: 'tool', tool_call_id: 'b2', content: 'no matches' },
      { role: 'tool', tool_call_id: 'a2', content: 'file body' },
    ];
    assert.deepEqual(countRepeatedToolRounds(messages), { count: 2, toolNames: ['grep', 'read_file'] });
  });

  test('returns 0 when the latest assistant message made no tool calls', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      { role: 'assistant', content: 'Here is the fix.' },
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 0);
    assert.equal(countRepeatedToolRounds([]).count, 0);
  });

  test('returns 0 for a fresh user prompt after an unfinished looping turn', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'file body'),
      ...round('c2', 'read_file', READ_ARGS, 'file body'),
      ...round('c3', 'read_file', READ_ARGS, 'file body'),
      { role: 'user', content: 'Try something else.' },
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 0);
  });

  test('compares each round with its own results when servers reuse call ids', () => {
    const messages = [
      ...PROMPT,
      ...round('call_0', 'get_terminal_output', { id: 't1' }, 'building...'),
      ...round('call_0', 'get_terminal_output', { id: 't1' }, 'building... done'),
    ];
    assert.equal(countRepeatedToolRounds(messages).count, 1);
  });
});

describe('resolveToolLoopAction', () => {
  test('escalates from nudge to forced answer', () => {
    assert.equal(resolveToolLoopAction(2, 3, 5), 'none');
    assert.equal(resolveToolLoopAction(3, 3, 5), 'nudge');
    assert.equal(resolveToolLoopAction(5, 3, 5), 'forceAnswer');
  });

  test('a threshold below 2 disables that level', () => {
    assert.equal(resolveToolLoopAction(7, 0, 5), 'forceAnswer');
    assert.equal(resolveToolLoopAction(9, 3, 0), 'nudge');
    assert.equal(resolveToolLoopAction(10, 0, 0), 'none');
    assert.equal(resolveToolLoopAction(1, 1, 1), 'none');
  });
});

describe('appendToolLoopNudge', () => {
  test('appends to the last tool message only, without mutating the input', () => {
    const messages = [
      ...PROMPT,
      ...round('c1', 'read_file', READ_ARGS, 'first'),
      ...round('c2', 'read_file', READ_ARGS, 'second'),
    ];
    const snapshot = structuredClone(messages);
    const result = appendToolLoopNudge(messages, 'NOTE');
    assert.deepEqual(messages, snapshot);
    assert.equal(result.length, messages.length);
    assert.equal(result[3].content, 'first');
    assert.equal(result[5].content, 'second\n\nNOTE');
  });

  test('leaves a history without tool results unchanged', () => {
    assert.deepEqual(appendToolLoopNudge(PROMPT, 'NOTE'), PROMPT);
  });
});

describe('buildToolLoopNote', () => {
  test('names the repeated tools and the count', () => {
    const note = buildToolLoopNote({ count: 3, toolNames: ['read_file'] }, false);
    assert.match(note, /read_file/);
    assert.match(note, /3 times/);
    assert.doesNotMatch(note, /disabled/);
  });

  test('tells the model tools are disabled when forcing an answer', () => {
    assert.match(buildToolLoopNote({ count: 5, toolNames: ['read_file'] }, true), /disabled/);
  });
});
