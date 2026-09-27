import { JsonProbeResult } from '../api/client';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  DEFAULT_USAGE_ENDPOINT,
  DailyUsageSample,
  DailyUsageState,
  parseDailyUsage,
  resolveUsagePath,
} from '../status/dailyUsage';

export const DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS = 300;
/** Floor for the background poll so a typo like `1` can't hammer the gateway. */
const MIN_REFRESH_INTERVAL_SECONDS = 30;
/** Ceiling for any single timer — also keeps `setTimeout` well inside its 32-bit range. */
const MAX_TIMER_DELAY_MS = 86_400_000;
/**
 * Delay between a chat request settling and the usage re-fetch, giving the
 * gateway a moment to book the request's tokens. Also coalesces the bursts of
 * requests an agent turn produces into one fetch.
 */
const AFTER_REQUEST_DELAY_MS = 1500;
/** Re-fetch this long after the reported `reset_time` so the new day has started server-side. */
const RESET_GRACE_MS = 5000;

/** The one client call the service needs — narrowed so tests can fake it. */
export interface UsageClient {
  fetchCurrentUsage(path: string): Promise<JsonProbeResult>;
}

/** Timer + clock seam, injected by tests. */
export interface UsageScheduler {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realScheduler: UsageScheduler = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface UsageServiceDeps {
  client: UsageClient;
  getConfig: () => GatewayConfig;
  log: (message: string) => void;
  /** Fired whenever the usage state changes (status bar + popup refresh). */
  onStatusChanged: () => void;
  /** Background polls are skipped while the window is unfocused and caught up on focus. */
  isWindowFocused: () => boolean;
  scheduler?: UsageScheduler;
}

/**
 * Background poll interval in ms for the `usageRefreshInterval` setting
 * (seconds), or 0 when periodic polling is off.
 */
export function refreshIntervalMs(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  const clamped = Math.max(MIN_REFRESH_INTERVAL_SECONDS, seconds) * 1000;
  return Math.min(MAX_TIMER_DELAY_MS, clamped);
}

/**
 * Owns the gateway's daily-usage quota: fetches `GET <usageEndpoint>`,
 * shares one in-flight request between concurrent triggers, and keeps the
 * result fresh — shortly after each chat request, on a background interval,
 * and right after the quota's reported reset time.
 *
 * A 404/405 marks the endpoint `unsupported`: every usage surface hides and
 * background polling stops until the config changes or the user refreshes, so
 * servers without the endpoint (vLLM, Ollama, …) pay one request and nothing
 * else. Other failures keep the last good sample on screen, marked stale.
 *
 * Only type-level `vscode` dependencies, so it runs under `node --test`.
 */
export class UsageService {
  private state: DailyUsageState;
  private readonly scheduler: UsageScheduler;
  private inFlight?: Promise<void>;
  /** Set by the first explicit refresh — nothing fetches before activation's probe. */
  private started = false;
  private disposed = false;
  private pollTimer?: unknown;
  private afterRequestTimer?: unknown;
  private missedPollWhileUnfocused = false;
  /** Bumped on a relevant config change so in-flight results for the old server are dropped. */
  private generation = 0;
  private fingerprint: string;
  private lastLoggedError?: string;

  constructor(private readonly deps: UsageServiceDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
    const config = deps.getConfig();
    this.fingerprint = usageFingerprint(config);
    this.state = initialState(config);
  }

  public getState(): DailyUsageState {
    return this.state;
  }

  /**
   * Fetch now. Always hits the endpoint — even after a 404 — because this is
   * what the Refresh commands call. Concurrent callers share one request.
   */
  public refresh(): Promise<void> {
    this.started = true;
    if (this.disposed) {
      return Promise.resolve();
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    const pending = this.fetchAndApply().finally(() => {
      if (this.inFlight === pending) {
        this.inFlight = undefined;
      }
    });
    this.inFlight = pending;
    return pending;
  }

  /** Re-fetch shortly after a chat request settles; bursts collapse into one fetch. */
  public refreshSoon(): void {
    if (!this.started || this.disposed || !this.isPollable()) {
      return;
    }
    this.clearAfterRequestTimer();
    this.afterRequestTimer = this.scheduler.setTimeout(() => {
      this.afterRequestTimer = undefined;
      void this.refresh();
    }, AFTER_REQUEST_DELAY_MS);
  }

  /**
   * Called on every config reload. Only a change to what the usage request
   * depends on (server, endpoint, credentials) discards the current numbers;
   * anything else just re-arms the poll timer in case the interval changed.
   */
  public onConfigChanged(): void {
    const config = this.deps.getConfig();
    const next = usageFingerprint(config);
    if (next === this.fingerprint) {
      if (this.started) {
        this.scheduleNextPoll();
      }
      return;
    }
    this.fingerprint = next;
    this.generation++;
    this.inFlight = undefined;
    this.clearTimers();
    this.lastLoggedError = undefined;
    this.missedPollWhileUnfocused = false;
    this.setState(initialState(config));
    if (this.started) {
      void this.refresh();
    }
  }

  /** Catch up on a background poll that came due while the window was unfocused. */
  public onWindowFocusChanged(focused: boolean): void {
    if (focused && this.missedPollWhileUnfocused) {
      this.missedPollWhileUnfocused = false;
      void this.refresh();
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  private async fetchAndApply(): Promise<void> {
    const generation = this.generation;
    const resolved = resolveUsagePath(this.deps.getConfig().usageEndpoint);
    if (resolved.kind === 'disabled') {
      this.clearTimers();
      this.setState({ kind: 'disabled' });
      return;
    }
    if (resolved.kind === 'invalid') {
      this.fail(`usageEndpoint must be a path such as ${DEFAULT_USAGE_ENDPOINT}, not a full URL`);
      return;
    }

    const result = await this.deps.client.fetchCurrentUsage(resolved.path);
    if (generation !== this.generation || this.disposed) {
      return;
    }
    this.apply(result, resolved.path);
    this.scheduleNextPoll();
  }

  private apply(result: JsonProbeResult, path: string): void {
    switch (result.kind) {
      case 'ok': {
        const usage = parseDailyUsage(result.body);
        if (!usage) {
          this.fail('unexpected response (no remaining_tokens)');
          return;
        }
        this.lastLoggedError = undefined;
        this.setState({ kind: 'ok', usage, fetchedAt: this.scheduler.now() });
        return;
      }
      case 'http':
        if (result.status === 404 || result.status === 405) {
          this.deps.log(
            `Usage endpoint ${path} not available (HTTP ${result.status}); daily usage display hidden. Use Refresh Models to re-check.`
          );
          this.setState({ kind: 'unsupported', status: result.status });
          return;
        }
        this.fail(
          result.status === 401 || result.status === 403
            ? `not authorized (HTTP ${result.status})`
            : `HTTP ${result.status}`
        );
        return;
      case 'unreachable':
        this.fail(result.reason);
        return;
      default: {
        const _never: never = result;
        throw new Error(`Unexpected usage fetch result: ${String(_never)}`);
      }
    }
  }

  /** Record a failure, keeping the last good sample so the bar doesn't blank out. */
  private fail(message: string): void {
    const last = lastSample(this.state);
    this.setState({ kind: 'error', message, ...(last ? { last } : {}) });
    if (message !== this.lastLoggedError) {
      this.lastLoggedError = message;
      this.deps.log(`Daily usage fetch failed: ${message}`);
    }
  }

  private setState(state: DailyUsageState): void {
    this.state = state;
    this.deps.onStatusChanged();
  }

  private isPollable(): boolean {
    return this.state.kind !== 'disabled' && this.state.kind !== 'unsupported';
  }

  /**
   * Arm the single background timer for whichever comes first: the next
   * interval poll or the quota's reset time.
   */
  private scheduleNextPoll(): void {
    this.clearPollTimer();
    if (this.disposed || !this.isPollable()) {
      return;
    }
    const delays: number[] = [];
    const interval = refreshIntervalMs(this.deps.getConfig().usageRefreshInterval);
    if (interval > 0) {
      delays.push(interval);
    }
    const resetAt = lastSample(this.state)?.usage.resetAt;
    if (resetAt !== undefined) {
      const untilReset = resetAt + RESET_GRACE_MS - this.scheduler.now();
      if (untilReset > 0) {
        delays.push(untilReset);
      }
    }
    if (delays.length === 0) {
      return;
    }
    this.pollTimer = this.scheduler.setTimeout(
      () => this.onPollTimer(),
      Math.min(MAX_TIMER_DELAY_MS, ...delays)
    );
  }

  private onPollTimer(): void {
    this.pollTimer = undefined;
    if (!this.deps.isWindowFocused()) {
      this.missedPollWhileUnfocused = true;
      return;
    }
    void this.refresh();
  }

  private clearTimers(): void {
    this.clearPollTimer();
    this.clearAfterRequestTimer();
  }

  private clearPollTimer(): void {
    if (this.pollTimer !== undefined) {
      this.scheduler.clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  private clearAfterRequestTimer(): void {
    if (this.afterRequestTimer !== undefined) {
      this.scheduler.clearTimeout(this.afterRequestTimer);
      this.afterRequestTimer = undefined;
    }
  }
}

function initialState(config: GatewayConfig): DailyUsageState {
  return resolveUsagePath(config.usageEndpoint).kind === 'disabled'
    ? { kind: 'disabled' }
    : { kind: 'unknown' };
}

function lastSample(state: DailyUsageState): DailyUsageSample | undefined {
  if (state.kind === 'ok') {
    return { usage: state.usage, fetchedAt: state.fetchedAt };
  }
  return state.kind === 'error' ? state.last : undefined;
}

/** What the usage request depends on — a change means the old numbers belong to someone else. */
function usageFingerprint(config: GatewayConfig): string {
  return JSON.stringify([
    config.serverUrl,
    config.usageEndpoint.trim(),
    config.apiKey ?? '',
    config.customHeaders,
  ]);
}
