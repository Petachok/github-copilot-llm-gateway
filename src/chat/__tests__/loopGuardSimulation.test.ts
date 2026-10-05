import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { GatewayClient } from '../../api/client';
import { OpenAIChatCompletionRequest, OpenAIMessage, OpenAIToolDefinition } from '../../api/types';
import { GatewayConfig } from '../../config/gatewayConfig';
import { StreamChunk, StreamStats, streamResponse } from '../responseStreamer';
import { ToolLoopAction, ToolLoopGuardOptions, guardToolLoop, isToolHistoryRejection } from '../toolLoop';

// Simulates both loop guards end to end: a local fake OpenAI server, the real HTTP client and the stream parser.

type ServerBehavior =
  | 'repeatToolCall'
  | 'repeatToolCallIgnoringNone'
  | 'repeatToolCallAsText'
  | 'rejectToolHistoryWithoutTools'
  | 'repeatText';

interface FakeServer {
  readonly url: string;
  readonly requests: OpenAIChatCompletionRequest[];
  /** Settles when a `repeatText` stream closes: true when the client hung up before the server finished. */
  readonly clientHungUp: Promise<boolean>;
  close(): Promise<void>;
}

interface StreamResult {
  readonly stats: StreamStats;
  readonly texts: string[];
  readonly toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
}

interface Round extends StreamResult {
  readonly action: ToolLoopAction;
}

const TOOL: OpenAIToolDefinition = {
  type: 'function',
  function: { name: 'file_search', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
};
const SENTENCE = 'I should check the configuration file again before answering. ';
/** Far more than the detector needs, so a broken guard fails the test instead of hanging it. */
const MAX_REPEATS = 400;
const GUARD_OPTIONS: ToolLoopGuardOptions = { toolsOffered: true, nudgeAfter: 3, forceAnswerAfter: 5, canForceAnswer: true };

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as import('vscode').CancellationToken;

function sendDelta(res: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

async function startServer(behavior: ServerBehavior): Promise<FakeServer> {
  const requests: OpenAIChatCompletionRequest[] = [];
  let settleHangUp: (hungUp: boolean) => void = () => undefined;
  const clientHungUp = new Promise<boolean>((resolve) => {
    settleHangUp = resolve;
  });

  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
    }
    const request = JSON.parse(body) as OpenAIChatCompletionRequest;
    requests.push(request);
    const hasTools = (request.tools?.length ?? 0) > 0;
    const hasToolHistory = request.messages.some((m) => m.role === 'tool');
    if (behavior === 'rejectToolHistoryWithoutTools' && hasToolHistory && !hasTools) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tool_result blocks require tools to be defined' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });

    if (behavior === 'repeatText') {
      let sent = 0;
      const timer = setInterval(() => {
        if (sent++ < MAX_REPEATS) {
          sendDelta(res, { content: SENTENCE });
        } else {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, 1);
      res.on('close', () => {
        clearInterval(timer);
        settleHangUp(!res.writableEnded);
      });
      return;
    }

    // A text-only round arrives without tools, or with tool_choice 'none' on the fallback.
    const forcedAnswer = !hasTools || request.tool_choice === 'none';
    if (forcedAnswer && (behavior === 'repeatToolCall' || behavior === 'rejectToolHistoryWithoutTools')) {
      sendDelta(res, { content: 'Done looping.' }, 'stop');
    } else if (forcedAnswer && behavior === 'repeatToolCallAsText') {
      // vLLM only runs its tool parser for a request with tools and tool_choice auto, so GLM/Qwen markup streams as content.
      sendDelta(res, { content: 'Let me try a broader search approach.' });
      sendDelta(res, { content: '<tool_' });
      sendDelta(res, { content: `call>${TOOL.function.name}\n<arg_key>query</arg_key>\n<arg_value>**/package.json</arg_value>\n</tool_call>` }, 'stop');
    } else {
      const fn = { name: TOOL.function.name, arguments: JSON.stringify({ query: '**/package.json' }) };
      sendDelta(res, { tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: fn }] });
      sendDelta(res, {}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    clientHungUp,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function makeClient(url: string): GatewayClient {
  // The client only reads connection fields.
  return new GatewayClient({ serverUrl: url, requestTimeout: 5000, customHeaders: {} } as unknown as GatewayConfig);
}

async function streamReply(
  client: GatewayClient,
  request: OpenAIChatCompletionRequest,
  options: { detectRepetition?: boolean; dropToolCalls?: boolean }
): Promise<StreamResult> {
  const texts: string[] = [];
  const toolCalls: StreamResult['toolCalls'] = [];
  const stats = await streamResponse({
    chunks: client.streamChatCompletion(request, TOKEN) as AsyncIterable<StreamChunk>,
    reporter: {
      reportText: (text) => texts.push(text),
      reportThinking: () => undefined,
      reportThinkingDone: () => undefined,
      reportToolCall: (id, name, args) => toolCalls.push({ id, name, args }),
      reportUsage: () => undefined,
    },
    isCancelled: () => false,
    resolveToolCallArgs: (call) => JSON.parse(call.arguments) as Record<string, unknown>,
    ...options,
  });
  return { stats, texts, toolCalls };
}

/** Plays Copilot's agent loop: run every tool call and send the result back until the model answers. */
async function runAgentTurn(client: GatewayClient): Promise<Round[]> {
  const history: OpenAIMessage[] = [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: 'Find the package manifest.' },
  ];
  const rounds: Round[] = [];
  while (rounds.length < 10) {
    const { action, messages } = guardToolLoop(history, GUARD_OPTIONS);
    // Same request wiring as ChatRequestHandler, which can't load outside VS Code:
    // a forced answer goes out without tools, then with tools and tool_choice 'none' if the server rejects that.
    const forceAnswer = action === 'forceAnswer';
    const send = (withTools: boolean): Promise<StreamResult> =>
      streamReply(
        client,
        withTools
          ? { model: 'loop-sim', messages, tools: [TOOL], tool_choice: forceAnswer ? 'none' : 'auto' }
          : { model: 'loop-sim', messages },
        { dropToolCalls: forceAnswer }
      );
    let result: StreamResult;
    try {
      result = await send(!forceAnswer);
    } catch (error) {
      if (!forceAnswer || !isToolHistoryRejection(error)) {
        throw error;
      }
      result = await send(true);
    }
    rounds.push({ action, ...result });
    if (result.toolCalls.length === 0) {
      break;
    }
    history.push(
      {
        role: 'assistant',
        content: null,
        tool_calls: result.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args) },
        })),
      },
      ...result.toolCalls.map((c) => ({ role: 'tool', tool_call_id: c.id, content: '/repo/package.json' }))
    );
  }
  return rounds;
}

function sentLoopNote(request: OpenAIChatCompletionRequest): boolean {
  const toolResults = request.messages.filter((m) => m.role === 'tool');
  return String(toolResults[toolResults.length - 1]?.content).includes('[Loop guard]');
}

describe('loop guard against a fake server', () => {
  test('nudges, then forces a text-only answer without tools when the same tool call keeps repeating', async () => {
    const server = await startServer('repeatToolCall');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      assert.deepEqual(rounds.map((r) => r.action), ['none', 'none', 'none', 'nudge', 'nudge', 'forceAnswer']);
      assert.deepEqual(server.requests.map((r) => r.tools?.length ?? 0), [1, 1, 1, 1, 1, 0]);
      assert.deepEqual(server.requests.map((r) => r.tool_choice), ['auto', 'auto', 'auto', 'auto', 'auto', undefined]);
      assert.deepEqual(server.requests.map(sentLoopNote), [false, false, false, true, true, true]);
      assert.deepEqual(rounds[rounds.length - 1].texts, ['Done looping.']);
    } finally {
      await server.close();
    }
  });

  test('resends the text-only round with tools and tool_choice none when the server rejects tool history without them', async () => {
    const server = await startServer('rejectToolHistoryWithoutTools');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      assert.equal(rounds.length, 6);
      assert.equal(server.requests.length, 7);
      const [rejected, fallback] = server.requests.slice(5);
      assert.equal(rejected.tools, undefined);
      assert.equal(fallback.tools?.length, 1);
      assert.equal(fallback.tool_choice, 'none');
      assert.ok(sentLoopNote(fallback));
      assert.deepEqual(rounds[rounds.length - 1].texts, ['Done looping.']);
    } finally {
      await server.close();
    }
  });

  test('withholds the tool call when the server ignores tool_choice none', async () => {
    const server = await startServer('repeatToolCallIgnoringNone');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      const last = rounds[rounds.length - 1];
      assert.equal(rounds.length, 6);
      assert.equal(last.stats.droppedToolCalls, 1);
      assert.match(last.texts.join(''), /tried to call a tool again/);
    } finally {
      await server.close();
    }
  });

  test('cuts a tool call the server returns as text on the text-only round', async () => {
    const server = await startServer('repeatToolCallAsText');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      const last = rounds[rounds.length - 1];
      assert.equal(rounds.length, 6);
      assert.equal(last.action, 'forceAnswer');
      assert.equal(last.stats.toolMarkupStopped, true);
      assert.equal(last.toolCalls.length, 0);
      const shown = last.texts.join('');
      assert.ok(shown.startsWith('Let me try a broader search approach.\n\n*(Loop guard:'), shown);
      assert.equal(shown.includes('<tool_call>'), false, shown);
    } finally {
      await server.close();
    }
  });

  test('cuts a repeating reply and hangs up on the server', async () => {
    const server = await startServer('repeatText');
    try {
      const { stats, texts } = await streamReply(
        makeClient(server.url),
        { model: 'loop-sim', messages: [{ role: 'user', content: 'Explain the config.' }] },
        { detectRepetition: true }
      );
      assert.equal(stats.repetitionStopped, true);
      assert.match(texts[texts.length - 1], /kept repeating/);
      assert.equal(await server.clientHungUp, true, 'the server finished before the gateway closed the request');
    } finally {
      await server.close();
    }
  });
});
