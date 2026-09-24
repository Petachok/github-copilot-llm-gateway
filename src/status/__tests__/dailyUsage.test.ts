import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_USAGE_THRESHOLDS,
  DailyUsage,
  formatRemainingLabel,
  formatResetLabel,
  parseDailyUsage,
  resolveUsagePath,
  summarizeDailyUsage,
  usageLevel,
  usedRatio,
} from '../dailyUsage';

/** Real payload shape from the gateway's `/v1/usage/current`. */
const GATEWAY_PAYLOAD = {
  user_id: '00000000-0000-0000-0000-000000000000',
  date: '2026-09-24',
  input_tokens: 401_200,
  output_tokens: 186_500,
  total_tokens: 587_700,
  daily_limit: 15_000_000,
  remaining_tokens: 14_412_300,
  request_count: 42,
  reset_time: '2026-09-25T00:00:00Z',
  by_model: null,
};

function usage(overrides: Partial<DailyUsage> = {}): DailyUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    dailyLimit: 1000,
    remainingTokens: 1000,
    ...overrides,
  };
}

describe('parseDailyUsage', () => {
  test('reads the gateway payload and ignores unrelated fields', () => {
    assert.deepEqual(parseDailyUsage(GATEWAY_PAYLOAD), {
      inputTokens: 401_200,
      outputTokens: 186_500,
      totalTokens: 587_700,
      dailyLimit: 15_000_000,
      remainingTokens: 14_412_300,
      requestCount: 42,
      resetAt: Date.parse('2026-09-25T00:00:00Z'),
    });
  });

  test('derives remaining_tokens from daily_limit - total_tokens when omitted', () => {
    const parsed = parseDailyUsage({ total_tokens: 300, daily_limit: 1000 });
    assert.equal(parsed?.remainingTokens, 700);
    assert.equal(parsed?.dailyLimit, 1000);
  });

  test('clamps negative and over-limit values to zero remaining', () => {
    assert.equal(parseDailyUsage({ total_tokens: 1200, daily_limit: 1000 })?.remainingTokens, 0);
    assert.equal(parseDailyUsage({ remaining_tokens: -5, daily_limit: 1000 })?.remainingTokens, 0);
    assert.equal(parseDailyUsage({ remaining_tokens: 5, input_tokens: -1 })?.inputTokens, 0);
  });

  test('coerces missing or non-numeric counters to 0 and omits optional fields', () => {
    const parsed = parseDailyUsage({ remaining_tokens: 50, daily_limit: 100, input_tokens: '12', reset_time: 'soon' });
    assert.deepEqual(parsed, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      dailyLimit: 100,
      remainingTokens: 50,
    });
  });

  test('rejects bodies with no way to know the remaining tokens', () => {
    assert.equal(parseDailyUsage({ total_tokens: 10 }), undefined);
    assert.equal(parseDailyUsage({ daily_limit: 10 }), undefined);
    assert.equal(parseDailyUsage(null), undefined);
    assert.equal(parseDailyUsage('nope'), undefined);
    assert.equal(parseDailyUsage([GATEWAY_PAYLOAD]), undefined);
  });
});

describe('resolveUsagePath', () => {
  test('an empty value disables the feature', () => {
    assert.deepEqual(resolveUsagePath(''), { kind: 'disabled' });
    assert.deepEqual(resolveUsagePath('   '), { kind: 'disabled' });
  });

  test('adds a leading slash and trims', () => {
    assert.deepEqual(resolveUsagePath(' v1/usage/current '), { kind: 'path', path: '/v1/usage/current' });
    assert.deepEqual(resolveUsagePath('/v1/usage/current'), { kind: 'path', path: '/v1/usage/current' });
  });

  test('refuses full URLs so credentials never leave the configured host', () => {
    assert.deepEqual(resolveUsagePath('https://evil.example/usage'), { kind: 'invalid' });
    assert.deepEqual(resolveUsagePath('//evil.example/usage'), { kind: 'invalid' });
  });
});

describe('usageLevel', () => {
  const t = DEFAULT_USAGE_THRESHOLDS;

  test('defaults: yellow at or below 20% remaining, red only when exhausted', () => {
    assert.equal(usageLevel(usage({ remainingTokens: 1000 }), t), 'ok');
    assert.equal(usageLevel(usage({ remainingTokens: 201 }), t), 'ok');
    assert.equal(usageLevel(usage({ remainingTokens: 200 }), t), 'warning');
    assert.equal(usageLevel(usage({ remainingTokens: 1 }), t), 'warning');
    assert.equal(usageLevel(usage({ remainingTokens: 0 }), t), 'critical');
  });

  test('honours custom thresholds', () => {
    const custom = { warningPercent: 50, criticalPercent: 10 };
    assert.equal(usageLevel(usage({ remainingTokens: 600 }), custom), 'ok');
    assert.equal(usageLevel(usage({ remainingTokens: 500 }), custom), 'warning');
    assert.equal(usageLevel(usage({ remainingTokens: 100 }), custom), 'critical');
  });

  test('an exhausted quota is critical even with thresholds turned off', () => {
    const off = { warningPercent: 0, criticalPercent: 0 };
    assert.equal(usageLevel(usage({ remainingTokens: 1 }), off), 'ok');
    assert.equal(usageLevel(usage({ remainingTokens: 0 }), off), 'critical');
  });

  test('clamps out-of-range thresholds', () => {
    assert.equal(usageLevel(usage({ remainingTokens: 1000 }), { warningPercent: 500, criticalPercent: -3 }), 'warning');
  });

  test('a zero limit never divides by zero', () => {
    assert.equal(usageLevel(usage({ dailyLimit: 0, remainingTokens: 5 }), t), 'ok');
    assert.equal(usedRatio(usage({ dailyLimit: 0 })), undefined);
  });
});

describe('usedRatio', () => {
  test('is based on remaining tokens, the gateway-authoritative number', () => {
    assert.equal(usedRatio(usage({ remainingTokens: 250 })), 0.75);
    assert.equal(usedRatio(usage({ remainingTokens: 0 })), 1);
  });
});

describe('labels', () => {
  test('remaining label is compact, and explicit when exhausted', () => {
    assert.equal(formatRemainingLabel(usage({ remainingTokens: 14_412_300, dailyLimit: 15_000_000 })), '14M left');
    assert.equal(formatRemainingLabel(usage({ remainingTokens: 412_300 })), '412k left');
    assert.equal(formatRemainingLabel(usage({ remainingTokens: 0 })), 'limit reached');
  });

  test('reset label counts down in hours and minutes', () => {
    const now = Date.parse('2026-09-24T14:48:00Z');
    const resetAt = Date.parse('2026-09-25T00:00:00Z');
    assert.equal(formatResetLabel(usage({ resetAt }), now), 'resets in 9h 12m');
    assert.equal(formatResetLabel(usage({ resetAt }), resetAt - 3_600_000), 'resets in 1h');
    assert.equal(formatResetLabel(usage({ resetAt }), resetAt - 90_000), 'resets in 2m');
    assert.equal(formatResetLabel(usage({ resetAt }), resetAt + 1000), 'resetting…');
    assert.equal(formatResetLabel(usage(), now), '');
  });
});

describe('summarizeDailyUsage', () => {
  const thresholds = DEFAULT_USAGE_THRESHOLDS;

  test('hides the section until there is something to show', () => {
    assert.equal(summarizeDailyUsage({ state: { kind: 'disabled' }, thresholds }), undefined);
    assert.equal(summarizeDailyUsage({ state: { kind: 'unknown' }, thresholds }), undefined);
    assert.equal(summarizeDailyUsage({ state: { kind: 'unsupported', status: 404 }, thresholds }), undefined);
  });

  test('keeps the last good sample through a failed refresh', () => {
    const last = { usage: usage({ remainingTokens: 100 }), fetchedAt: 1 };
    const summary = summarizeDailyUsage({ state: { kind: 'error', message: 'HTTP 500', last }, thresholds });
    assert.deepEqual(summary, { sample: last, level: 'warning', errorMessage: 'HTTP 500' });
  });

  test('reports an error with no sample when nothing was ever fetched', () => {
    const summary = summarizeDailyUsage({ state: { kind: 'error', message: 'not authorized (HTTP 401)' }, thresholds });
    assert.deepEqual(summary, { level: 'ok', errorMessage: 'not authorized (HTTP 401)' });
  });
});
