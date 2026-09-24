/**
 * Daily token quota reported by a gateway's `GET /v1/usage/current` endpoint.
 *
 * Pure module (no `vscode` import) holding the parsed model, the fetch state
 * the status surfaces render, and the helpers that turn both into labels and
 * warning levels — so the bar text, hover popup and click menu all agree on
 * what "low" means.
 */

import { formatTokenCount } from './format';
import { formatRelativeTime } from './sessionStats';

export interface DailyUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly dailyLimit: number;
  /** The number that matters most: tokens left before the gateway refuses requests. */
  readonly remainingTokens: number;
  /** Requests the gateway counted today; undefined when not reported. */
  readonly requestCount?: number;
  /** When the quota resets (epoch ms); undefined when not reported or unparseable. */
  readonly resetAt?: number;
}

export interface DailyUsageSample {
  readonly usage: DailyUsage;
  readonly fetchedAt: number;
}

/**
 * Fetch state of the usage endpoint. `disabled` and `unsupported` both hide
 * every usage surface; `error` keeps the last good sample (if any) so a
 * transient failure doesn't blank the bar.
 */
export type DailyUsageState =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'unsupported'; readonly status: number }
  | ({ readonly kind: 'ok' } & DailyUsageSample)
  | { readonly kind: 'error'; readonly message: string; readonly last?: DailyUsageSample };

export type UsageLevel = 'ok' | 'warning' | 'critical';

/** Remaining-quota percentages at or below which the bar turns yellow / red. */
export interface UsageThresholds {
  readonly warningPercent: number;
  readonly criticalPercent: number;
}

export const DEFAULT_USAGE_THRESHOLDS: UsageThresholds = {
  warningPercent: 20,
  criticalPercent: 0,
};

export const DEFAULT_USAGE_ENDPOINT = '/v1/usage/current';

/** Usage state plus the user's thresholds — what the status snapshot carries. */
export interface DailyUsageView {
  readonly state: DailyUsageState;
  readonly thresholds: UsageThresholds;
}

/**
 * Parse the endpoint's JSON body. Missing, non-finite or negative counters
 * become 0. `remaining_tokens` is required, but is derived from
 * `daily_limit - total_tokens` when the gateway omits it; a body with neither
 * is unusable and yields `undefined`.
 */
export function parseDailyUsage(raw: unknown): DailyUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const totalTokens = nonNegative(obj.total_tokens);
  const reportedLimit = finiteOrUndefined(obj.daily_limit);
  let remainingTokens = finiteOrUndefined(obj.remaining_tokens);
  if (remainingTokens === undefined) {
    if (reportedLimit === undefined || totalTokens === undefined) {
      return undefined;
    }
    remainingTokens = reportedLimit - totalTokens;
  }
  remainingTokens = Math.max(0, remainingTokens);
  const dailyLimit = Math.max(0, reportedLimit ?? remainingTokens + (totalTokens ?? 0));

  const requestCount = nonNegative(obj.request_count);
  const resetAt = typeof obj.reset_time === 'string' ? Date.parse(obj.reset_time) : Number.NaN;
  return {
    inputTokens: nonNegative(obj.input_tokens) ?? 0,
    outputTokens: nonNegative(obj.output_tokens) ?? 0,
    totalTokens: totalTokens ?? 0,
    dailyLimit,
    remainingTokens,
    ...(requestCount === undefined ? {} : { requestCount }),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
  };
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  const n = finiteOrUndefined(value);
  return n === undefined ? undefined : Math.max(0, n);
}

/**
 * Validate the `usageEndpoint` setting. Only a path is accepted — it is joined
 * onto the server URL — so the API key and custom headers can never be sent
 * to a different host. An empty value turns the feature off.
 */
export function resolveUsagePath(
  raw: string
): { readonly kind: 'disabled' } | { readonly kind: 'invalid' } | { readonly kind: 'path'; readonly path: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { kind: 'disabled' };
  }
  if (trimmed.includes('://') || trimmed.startsWith('//')) {
    return { kind: 'invalid' };
  }
  return { kind: 'path', path: trimmed.startsWith('/') ? trimmed : `/${trimmed}` };
}

/** Share of the daily limit already used (0–1), or undefined when there is no limit to compare against. */
export function usedRatio(usage: DailyUsage): number | undefined {
  if (usage.dailyLimit <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(1, 1 - usage.remainingTokens / usage.dailyLimit));
}

/**
 * Warning level for a sample. Thresholds are "remaining percent at or below";
 * an exhausted quota is always critical regardless of the settings.
 */
export function usageLevel(usage: DailyUsage, thresholds: UsageThresholds): UsageLevel {
  if (usage.remainingTokens <= 0) {
    return 'critical';
  }
  if (usage.dailyLimit <= 0) {
    return 'ok';
  }
  const remainingPercent = (usage.remainingTokens / usage.dailyLimit) * 100;
  if (remainingPercent <= clampPercent(thresholds.criticalPercent)) {
    return 'critical';
  }
  if (remainingPercent <= clampPercent(thresholds.warningPercent)) {
    return 'warning';
  }
  return 'ok';
}

function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/**
 * Everything a status surface needs to render the usage section, or
 * `undefined` when the section should be hidden (feature disabled, endpoint
 * missing, or not fetched yet).
 */
export interface DailyUsageSummary {
  /** Latest good sample; absent only when every fetch so far has failed. */
  readonly sample?: DailyUsageSample;
  readonly level: UsageLevel;
  /** Set when the latest fetch failed — `sample`, if present, is stale. */
  readonly errorMessage?: string;
}

export function summarizeDailyUsage(view: DailyUsageView): DailyUsageSummary | undefined {
  const { state, thresholds } = view;
  switch (state.kind) {
    case 'disabled':
    case 'unknown':
    case 'unsupported':
      return undefined;
    case 'ok':
      return { sample: state, level: usageLevel(state.usage, thresholds) };
    case 'error':
      return {
        ...(state.last ? { sample: state.last } : {}),
        level: state.last ? usageLevel(state.last.usage, thresholds) : 'ok',
        errorMessage: state.message,
      };
    default: {
      const _never: never = state;
      throw new Error(`Unexpected usage state: ${String(_never)}`);
    }
  }
}

/** Short remaining-quota label: "412k left", or "limit reached" when exhausted. */
export function formatRemainingLabel(usage: DailyUsage): string {
  return usage.remainingTokens <= 0 ? 'limit reached' : `${formatTokenCount(usage.remainingTokens)} left`;
}

/**
 * "resets in 9h 12m" style label for the quota reset, or `''` when the
 * gateway didn't report one. A reset time already in the past reads
 * "resetting…" until the next fetch picks up the new day.
 */
export function formatResetLabel(usage: DailyUsage, now: number): string {
  if (usage.resetAt === undefined) {
    return '';
  }
  const minutes = Math.ceil((usage.resetAt - now) / 60_000);
  if (minutes <= 0) {
    return 'resetting…';
  }
  if (minutes < 60) {
    return `resets in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest > 0 ? `resets in ${hours}h ${rest}m` : `resets in ${hours}h`;
  }
  return `resets in ${Math.floor(hours / 24)}d`;
}

/** "42 requests" / "1 request", or `''` when the gateway didn't report a count. */
export function formatRequestCount(count: number | undefined): string {
  if (count === undefined) {
    return '';
  }
  const noun = count === 1 ? 'request' : 'requests';
  return `${count.toLocaleString()} ${noun}`;
}

/** "as of 3m ago" freshness label for a sample. */
export function formatFetchedLabel(sample: DailyUsageSample, now: number): string {
  return `as of ${formatRelativeTime(sample.fetchedAt, now)}`;
}
