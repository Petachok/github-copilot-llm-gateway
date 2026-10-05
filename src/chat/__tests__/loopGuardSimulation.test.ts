import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { GatewayClient } from '../../api/client';
import { OpenAIChatCompletionRequest, OpenAIMessage, OpenAIToolDefinition } from '../../api/types';
import { GatewayConfig } from '../../config/gatewayConfig';
import { StreamChunk, StreamStats, streamResponse } from '../responseStreamer';
import { ToolLoopAction, ToolLoopGuardOptions, guardToolLoop, isRepeatedToolCall } from '../toolLoop';

// Simulates both loop guards end to end: a local fake OpenAI server, the real HTTP client and the stream parser.

/**
 * `repeatToolCall`: the model never changes its mind.
 * `changeApproachWhenBlocked`: once told its call is blocked, it searches for something else, then answers.
 * `repeatText`: a reply that loops on one sentence.
 */
type ServerBehavior = 'repeatToolCall' | 'changeApproachWhenBlocked' | 'repeatText';

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
const GUARD_OPTIONS: ToolLoopGuardOptions = { toolsOffered: true, nudgeAfter: 3, blockAfter: 5, canBlock: true };
const LOOPING_QUERY = '**/package.json';
const NEW_QUERY = '**/manifest.json';

const TOKEN = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => undefined }),
} as unknown as import('vscode').CancellationToken;

function sendDelta(res: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`);
}

function sendToolCall(res: ServerResponse, id: string, query: string): void {
  const fn = { name: TOOL.function.name, arguments: JSON.stringify({ query }) };
  sendDelta(res, { tool_calls: [{ index: 0, id, type: 'function', function: fn }] });
  sendDelta(res, {}, 'tool_calls');
}

function lastToolResult(request: OpenAIChatCompletionRequest): string {
  const toolResults = request.messages.filter((m) => m.role === 'tool');
  return String(toolResults[toolResults.length - 1]?.content ?? '');
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

    const searchedElsewhere = request.messages.some(
      (m) => m.role === 'assistant' && JSON.stringify(m.tool_calls ?? []).includes(NEW_QUERY)
    );
    const id = `call_${requests.length}`;
    if (behavior === 'changeApproachWhenBlocked' && searchedElsewhere) {
      sendDelta(res, { content: 'Found it in the manifest.' }, 'stop');
    } else if (behavior === 'changeApproachWhenBlocked' && lastToolResult(request).includes('blocked')) {
      sendDelta(res, { content: 'Searching elsewhere.' });
      sendToolCall(res, id, NEW_QUERY);
    } else {
      sendToolCall(res, id, LOOPING_QUERY);
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
  options: Pick<Parameters<typeof streamResponse>[0], 'detectRepetition' | 'withholdToolCall'>
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
    const { action, status, messages } = guardToolLoop(history, GUARD_OPTIONS);
    // Same request wiring as ChatRequestHandler, which can't load outside VS Code.
    const result = await streamReply(
      client,
      { model: 'loop-sim', messages, tools: [TOOL], tool_choice: 'auto' },
      { withholdToolCall: action === 'block' ? isRepeatedToolCall(status) : undefined }
    );
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
  return lastToolResult(request).includes('[Loop guard]');
}

describe('loop guard against a fake server', () => {
  test('nudges, then blocks the repeated call and ends the turn when the model only repeats it', async () => {
    const server = await startServer('repeatToolCall');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      assert.deepEqual(rounds.map((r) => r.action), ['none', 'none', 'none', 'nudge', 'nudge', 'block']);
      // Tools stay in every request; the block happens on the reply, not in the request.
      assert.deepEqual(server.requests.map((r) => r.tools?.length), [1, 1, 1, 1, 1, 1]);
      assert.deepEqual(server.requests.map((r) => r.tool_choice), ['auto', 'auto', 'auto', 'auto', 'auto', 'auto']);
      assert.deepEqual(server.requests.map(sentLoopNote), [false, false, false, true, true, true]);
      assert.match(lastToolResult(server.requests[5]), /now blocked/);
      const last = rounds[rounds.length - 1];
      assert.equal(last.toolCalls.length, 0);
      assert.equal(last.stats.droppedToolCalls, 1);
      assert.match(last.texts.join(''), /made the blocked tool call again/);
    } finally {
      await server.close();
    }
  });

  test('lets the agent carry on when it changes approach after the block', async () => {
    const server = await startServer('changeApproachWhenBlocked');
    try {
      const rounds = await runAgentTurn(makeClient(server.url));
      assert.deepEqual(rounds.map((r) => r.action), ['none', 'none', 'none', 'nudge', 'nudge', 'block', 'none']);
      const blocked = rounds[5];
      assert.deepEqual(blocked.toolCalls.map((c) => c.args.query), [NEW_QUERY]);
      assert.equal(blocked.stats.droppedToolCalls, undefined);
      assert.deepEqual(blocked.texts, ['Searching elsewhere.']);
      // The new call reset the count, so the final request carries no loop note.
      assert.equal(sentLoopNote(server.requests[6]), false);
      assert.deepEqual(rounds[6].texts, ['Found it in the manifest.']);
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
