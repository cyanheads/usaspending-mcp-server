/**
 * @fileoverview USAspending.gov API v2 service. Wraps all award search, award detail,
 * recipient, agency, spending analytics, disaster, and federal account endpoints.
 * @module services/usaspending/usaspending-service
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
  timeout,
} from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  defaultIsTransient,
  type FetchWithTimeoutOptions,
  fetchWithTimeout,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  DisasterBreakdownRequest,
  RawAgencyAutocomplete,
  RawAgencyDetail,
  RawAgencyEntry,
  RawAwardDetail,
  RawAwardFederalAccountsResponse,
  RawAwardSummary,
  RawBudgetaryResources,
  RawCfdaAutocomplete,
  RawDisasterBreakdownResponse,
  RawDisasterGeoResult,
  RawDisasterOverview,
  RawFederalAccount,
  RawFederalAccountBreakdownResponse,
  RawFederalAccountSearchResponse,
  RawGeographyResult,
  RawIdvAwardsResponse,
  RawLocationAutocompleteResponse,
  RawNaicsAutocomplete,
  RawPageMetadata,
  RawPscAutocomplete,
  RawRecipientAutocomplete,
  RawRecipientDetail,
  RawRecipientSearchResponse,
  RawSpendingByCategoryResult,
  RawSpendingOverTimeResult,
  RawSubAgencyEntry,
  RawSubaward,
  RawTransaction,
} from './types.js';
import { LOCATION_AUTOCOMPLETE_LIMIT_MAX } from './types.js';

/**
 * Upstream statuses that mean "no such entity" on the single-entity detail
 * endpoints. Verified against the live API per endpoint:
 *
 * - `recipient/{id}/` — 400 for a well-formed miss ("Recipient ID not found")
 *   and for a malformed identifier ("Invalid Recipient-Level"). It also
 *   answers a malformed `year` ("Invalid year: abc.") with 400, so
 *   `getRecipient` only ever sends an integer `year` — any integer, in range
 *   or not, answers 200 — and no existing recipient can answer 400.
 * - `federal_accounts/{code}/` — 400 for a well-formed miss ("Cannot find
 *   Federal Account"), 404 when the code shape fails URL routing.
 * - `agency/{code}/` and `awards/{id}/` — 404 for both a miss and a malformed
 *   identifier.
 *
 * Every reachable 400/404 at these four call sites means the entity does not
 * exist, so neither status can mask a real record. Everything else — notably
 * 5xx, and the 422 the agency endpoint raises for an out-of-range
 * `fiscal_year` — still propagates.
 */
const ENTITY_MISS_STATUSES = new Set([400, 404]);

/** Backoff before the first retry; subsequent waits double from here. */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Request budget when `USASPENDING_RETRY_BUDGET_MS` is unset — raised to the
 * per-attempt timeout when that is higher, so one attempt can always run its full
 * timeout.
 */
const DEFAULT_REQUEST_BUDGET_MS = 45_000;

/**
 * How long the recipient children side read waits. `recipient/children/` answered
 * in 0.21–1.27 s across 16 cold parents (the largest 217 children) and 0.22–0.27 s
 * warm, so 5 s is about four times its slowest measured answer.
 */
const RECIPIENT_CHILDREN_WAIT_MS = 5_000;

/** One `recipient/children/` row; `state_province` is absent when upstream has no location for the child. */
const RecipientChildSchema = z.object({
  amount: z.number().nullish(),
  duns: z.string().nullish(),
  name: z.string().nullish(),
  recipient_id: z.string().nullish(),
  state_province: z.string().nullish(),
  uei: z.string().nullish(),
});
const RecipientChildrenSchema = z.array(RecipientChildSchema);
type RecipientChild = z.infer<typeof RecipientChildSchema>;

/** `fetchWithTimeout`'s own per-attempt timeout firing, header or body phase. */
function isAttemptTimeout(err: unknown): boolean {
  return (
    err instanceof McpError &&
    err.code === JsonRpcErrorCode.Timeout &&
    err.data?.errorSource === 'FetchTimeout'
  );
}

/** `withRetry`'s `deadlineMs` clock expiring, mid-attempt or in place of a backoff. */
function isBudgetExpiry(err: unknown): boolean {
  return err instanceof McpError && err.data?.reason === 'retry_deadline_exceeded';
}

/**
 * Bytes of a non-2xx body read for diagnostics. The framework's default
 * 500-byte capture elides a longer body mid-string, which leaves a 4xx `detail`
 * (the loan-sort 400 runs 1,430 bytes, the largest seen) unparseable; 4 KiB
 * clears it with headroom. The framework also logs the body it reads on every
 * non-2xx, HTML 5xx pages included, so the bound stays small. Past it only a
 * head and a tail of the body are kept, so a detail in the middle is lost and
 * the status-line message stands.
 */
const ERROR_BODY_READ_BYTES = 4_096;

/**
 * Bytes of that body kept on `data.body` for the failure log, matching the
 * framework's default capture. The body never reaches a client envelope.
 */
const ERROR_BODY_KEEP_BYTES = 500;

/** Share of {@link ERROR_BODY_KEEP_BYTES} kept from the head of an over-budget body, as the framework does. */
const ERROR_BODY_HEAD_SHARE = 0.4;

/** Characters of an upstream 4xx `detail` carried into the error message, ellipsis included. */
const DETAIL_MESSAGE_CAP = 500;

/** Contract reasons every tool declares for upstream failures the service classifies. */
type UpstreamFailureReason = 'api_timeout' | 'api_unavailable';

/**
 * The `data` fields that turn a service-classified upstream failure into the
 * calling tool's declared contract entry: the reason and whether a retry can
 * help. The framework fills `data.recovery` from the calling tool's `errors[]`
 * entry for that reason, so the tool's own recovery text reaches the wire.
 */
function upstreamFailure(reason: UpstreamFailureReason, retryable = true) {
  return { reason, retryable };
}

/** Re-bounds a diagnostic body to the framework's default capture, head + tail. */
function boundBody(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= ERROR_BODY_KEEP_BYTES) return text;
  const head = Math.floor(ERROR_BODY_KEEP_BYTES * ERROR_BODY_HEAD_SHARE);
  const tail = ERROR_BODY_KEEP_BYTES - head;
  const decoder = new TextDecoder();
  return `${decoder.decode(bytes.subarray(0, head))}…[${bytes.byteLength - ERROR_BODY_KEEP_BYTES} bytes elided]…${decoder.decode(bytes.subarray(bytes.byteLength - tail))}`;
}

/**
 * The explanation USAspending puts in a 4xx JSON body: its `detail` string, or
 * a `message` string when there is no detail — the mixed-award-type 422 carries
 * only `message`, beside an `award_type_groups` map that stays in the
 * server-side `data.body`.
 */
function extractDetail(body: unknown): string | undefined {
  if (typeof body !== 'string') return;
  try {
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown } | null;
    for (const value of [parsed?.detail, parsed?.message]) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return;
  } catch {
    return;
  }
}

/**
 * Maps a failure that escaped the retry loop onto the tool contract (#57) and
 * the caller-readable 4xx message (#58):
 *
 * - `Timeout` (a per-attempt timeout or an upstream 504 that exhausted the
 *   retries) → `api_timeout`.
 * - `ServiceUnavailable` (5xx, network failure, HTML or invalid-JSON body) →
 *   `api_unavailable`. A 501 keeps the framework's `retryable: false`.
 * - 4xx with a JSON `detail` (or, lacking one, a string `message`) → that
 *   text, capped, replaces the status-line message. The code and every `data`
 *   field are kept.
 *
 * Status-mapped errors had their body read at {@link ERROR_BODY_READ_BYTES};
 * the rebuilt `data.body` is bounded back to the usual capture so the failure
 * log does not grow. The upstream body stays on the server: spreading
 * `err.data` carries the framework's server-only marker for `body` and
 * `responseBody`, so the bounded copies are logged and left out of every
 * client envelope. A proxy's HTML error page never reaches a client, and the
 * 4xx detail travels in the message instead. Rebuilding `data` any other way
 * (a fresh literal, `Object.entries`) drops the marker and sends the body.
 * Anything else (a non-`McpError`) passes through.
 */
function classifyUpstreamError(err: unknown, operation: string): unknown {
  if (!(err instanceof McpError)) return err;
  const httpBody = err.data?.errorSource === 'FetchHttpError' ? err.data.body : undefined;
  const data =
    typeof httpBody === 'string'
      ? { ...err.data, body: boundBody(httpBody), responseBody: boundBody(httpBody) }
      : err.data;
  const rebuild = (message: string, next: Record<string, unknown> | undefined) =>
    new McpError(err.code, message, next, { cause: err });

  if (err.code === JsonRpcErrorCode.Timeout) {
    return rebuild(err.message, { ...data, ...upstreamFailure('api_timeout') });
  }
  if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
    return rebuild(err.message, {
      ...data,
      ...upstreamFailure('api_unavailable', data?.retryable !== false),
    });
  }
  const status = data?.status;
  const detail = extractDetail(httpBody);
  if (typeof status === 'number' && status >= 400 && status < 500 && detail) {
    const capped =
      detail.length > DETAIL_MESSAGE_CAP ? `${detail.slice(0, DETAIL_MESSAGE_CAP - 1)}…` : detail;
    return rebuild(`USAspending rejected ${operation} (HTTP ${status}): ${capped}`, data);
  }
  return data === err.data ? err : rebuild(err.message, data);
}

/**
 * `search/spending_by_award_count/` for prime awards: the matches in each
 * award-type group, the same partition `search/spending_by_award/` accepts one
 * group at a time.
 */
const AwardCountResponseSchema = z.object({
  results: z.object({
    contracts: z.number().int().nonnegative(),
    direct_payments: z.number().int().nonnegative(),
    grants: z.number().int().nonnegative(),
    idvs: z.number().int().nonnegative(),
    loans: z.number().int().nonnegative(),
    other: z.number().int().nonnegative(),
  }),
});

/** Award matches per award-type group, as {@link USASpendingService.countAwards} returns them. */
export type AwardCounts = z.infer<typeof AwardCountResponseSchema>['results'];

export class USASpendingService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryBudgetMs: number;

  constructor(_appConfig: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl.endsWith('/')
      ? serverConfig.baseUrl
      : `${serverConfig.baseUrl}/`;
    this.timeoutMs = serverConfig.timeoutMs;
    this.retryBudgetMs =
      serverConfig.retryBudgetMs ?? Math.max(DEFAULT_REQUEST_BUDGET_MS, serverConfig.timeoutMs);
  }

  // --- HTTP primitives ---

  /**
   * Issues one upstream request under a wall-clock deadline spanning the whole
   * retry loop.
   *
   * One call-level budget (#52). `withRetry` re-runs a transient failure three
   * more times by default, so with only a per-attempt timeout an endpoint that
   * cannot answer re-pays that timeout on every attempt — measured at 128s
   * against a 30s timeout. `withRetry`'s `deadlineMs` clock, composed with the
   * caller's signal and threaded into `fetchWithTimeout`, caps the total instead
   * of letting it scale with the attempt count; a backoff that would outlast what
   * is left fails at once rather than sleeping into a certain timeout.
   *
   * Each attempt is cut at the smaller of `USASPENDING_TIMEOUT_MS` and the time
   * left in that budget, and an attempt that times out is not retried (#79). A
   * timeout is not evidence the next attempt will be faster: the uncached
   * aggregations behind the slow calls repeat the same work, so a retry started
   * with whatever the first attempt left over is cut too, and an answer that
   * would have arrived inside the budget is lost to the earlier cut. Fast
   * transient failures — a 5xx, an upstream 504, a network error, an HTML or
   * unparseable body — still retry inside the budget.
   *
   * Worst case is `USASPENDING_RETRY_BUDGET_MS` plus the time to unwind an
   * in-flight fetch: 45s at the defaults, where a never-answering upstream sees
   * exactly one request.
   *
   * The attempt timeout bounds the whole exchange, not just the header phase: a
   * 2xx carrying a body comes back as a passthrough wrapper that keeps that
   * deadline armed until the body closes, so the `await response.text()` below
   * is covered too and a peer that answers headers and then stalls the stream
   * cannot hold an attempt open past its timeout.
   *
   * A timeout reaches this frame as `fetchWithTimeout`'s own `FetchTimeout` or as
   * `withRetry`'s `retry_deadline_exceeded` expiry, whichever clock fires first;
   * both become one `Timeout` naming the limit that ended the call — the request
   * budget when the attempt was cut at the time left in it, the per-attempt
   * timeout otherwise. A caller-initiated abort is left untouched.
   *
   * Every other failure goes through {@link classifyUpstreamError}, so a
   * `Timeout` or `ServiceUnavailable` reaches the caller as the calling tool's
   * declared `api_timeout` / `api_unavailable`, and a 4xx carries upstream's
   * `detail` (or `message`) in its message.
   *
   * `maxRetries` overrides `withRetry`'s default of three retries; a side read
   * beside a call's main request passes 0, so a failure ends it at once.
   */
  private async request<T>(
    operation: string,
    url: string,
    ctx: Context,
    init: FetchWithTimeoutOptions,
    deadlineAt?: number,
    maxRetries?: number,
  ): Promise<T> {
    const budgetMs = Math.min(
      this.retryBudgetMs,
      deadlineAt === undefined ? this.retryBudgetMs : deadlineAt - Date.now(),
    );
    ctx.signal?.throwIfAborted();
    if (budgetMs <= 0)
      throw timeout(`The call deadline elapsed before USAspending was asked for ${operation}.`, {
        ...upstreamFailure('api_timeout'),
        operation,
        budgetMs: 0,
      });
    let cutAtBudget = false;
    try {
      return await withRetry(
        async ({ signal, remainingMs }) => {
          cutAtBudget = remainingMs <= this.timeoutMs;
          const response = await fetchWithTimeout(url, Math.min(this.timeoutMs, remainingMs), ctx, {
            ...init,
            signal,
            errorBodyLimit: ERROR_BODY_READ_BYTES,
          });
          const text = await response.text();
          return this.parseJson<T>(text, url);
        },
        {
          operation,
          context: ctx,
          baseDelayMs: RETRY_BASE_DELAY_MS,
          signal: ctx.signal,
          deadlineMs: budgetMs,
          ...(maxRetries !== undefined ? { maxRetries } : {}),
          isTransient: (err) => !isAttemptTimeout(err) && defaultIsTransient(err),
        },
      );
    } catch (err) {
      if (ctx.signal?.aborted) throw err;
      const attemptTimedOut = isAttemptTimeout(err);
      const budgetSpent = isBudgetExpiry(err) || (attemptTimedOut && cutAtBudget);
      if (budgetSpent || attemptTimedOut) {
        throw timeout(
          budgetSpent
            ? maxRetries === 0
              ? `USAspending did not answer ${operation} within its ${budgetMs}ms deadline (one attempt, not retried).`
              : `USAspending did not answer ${operation} within the ${budgetMs}ms request budget (${this.timeoutMs}ms per attempt, retries included).`
            : `USAspending did not answer ${operation} within the ${this.timeoutMs}ms per-attempt timeout; a timed-out attempt is not retried.`,
          {
            url,
            operation,
            budgetMs,
            timeoutMs: this.timeoutMs,
            errorSource: budgetSpent ? 'RequestBudgetExhausted' : 'AttemptTimeout',
            ...upstreamFailure('api_timeout'),
          },
          { cause: err },
        );
      }
      throw classifyUpstreamError(err, operation);
    }
  }

  private get<T>(
    path: string,
    ctx: Context,
    expectedStatuses?: number[],
    deadlineAt?: number,
    maxRetries?: number,
  ): Promise<T> {
    return this.request<T>(
      `GET ${path}`,
      `${this.baseUrl}${path}`,
      ctx,
      {
        headers: { Accept: 'application/json' },
        ...(expectedStatuses ? { expectedStatuses } : {}),
      },
      deadlineAt,
      maxRetries,
    );
  }

  private post<T>(
    path: string,
    body: unknown,
    ctx: Context,
    deadlineAt?: number,
    maxRetries?: number,
  ): Promise<T> {
    return this.request<T>(
      `POST ${path}`,
      `${this.baseUrl}${path}`,
      ctx,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      deadlineAt,
      maxRetries,
    );
  }

  /**
   * Fetches one entity by path identifier, resolving to `undefined` when the
   * upstream reports it does not exist (see {@link ENTITY_MISS_STATUSES}). This
   * lets the calling tool handler's existence check run and its declared
   * not-found contract fire, instead of `fetchWithTimeout`'s status-mapped
   * throw escaping as an unclassified error. Those same statuses are declared
   * as `expectedStatuses` so a routine miss logs at `debug` rather than `error`.
   *
   * Deliberately kept out of `get<T>()` itself: `listAgencies`,
   * `getAgencySubAgencies`, `getAgencyBudgetaryResources`, and
   * `getDisasterOverview` share that primitive but have no not-found contract
   * and no existence check, so swallowing their 4xx would silently turn real
   * upstream failures into empty successes.
   *
   * The two agency sub-resources still declare the same `expectedStatuses`,
   * because `usaspending_get_agency` resolves them alongside the agency detail,
   * which decides existence: a miss there is an expected outcome and logs at
   * `debug`, while the still-thrown error reaches that tool, which reports a
   * failed sub-resource as an unavailable section of a partial result.
   * `listAgencies` and `getDisasterOverview` have no such caller, so their
   * misses stay at `error`.
   */
  private async getEntity<T>(path: string, ctx: Context): Promise<T | undefined> {
    try {
      return await this.get<T>(path, ctx, [...ENTITY_MISS_STATUSES]);
    } catch (err) {
      if (err instanceof McpError) {
        const status = err.data?.status;
        if (typeof status === 'number' && ENTITY_MISS_STATUSES.has(status)) {
          ctx.log.debug('Upstream reported no such entity', { path, status });
          return;
        }
      }
      throw err;
    }
  }

  private parseJson<T>(text: string, url: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(
        'USAspending API returned HTML instead of JSON — service may be degraded.',
        { url },
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw serviceUnavailable('USAspending API returned invalid JSON.', { url }, { cause: err });
    }
  }

  // --- Award search ---

  searchAwards(
    params: {
      filters: Record<string, unknown>;
      fields: string[];
      sort: string;
      order?: string;
      limit: number;
      page?: number;
      last_record_sort_value?: string;
      last_record_unique_id?: number;
      subawards?: boolean;
    },
    ctx: Context,
  ): Promise<{
    results: RawAwardSummary[];
    page_metadata: RawPageMetadata;
    messages?: string[];
  }> {
    ctx.log.debug('searchAwards', { sort: params.sort, limit: params.limit, page: params.page });
    return this.post('search/spending_by_award/', params, ctx);
  }

  /**
   * Counts the awards matching `filters` in each award-type group. A side read
   * beside a search: one attempt, never retried, aborted at `deadlineAt` (epoch
   * ms). Upstream builds the count from the same filter query as the search, so
   * the search's own `filters` give its total.
   * @throws {McpError} The classified upstream failure; `api_unavailable` when the
   * body lacks a non-negative integer count for every group.
   */
  async countAwards(
    filters: Record<string, unknown>,
    ctx: Context,
    deadlineAt: number,
  ): Promise<AwardCounts> {
    ctx.log.debug('countAwards');
    const path = 'search/spending_by_award_count/';
    const raw = await this.post<unknown>(path, { filters }, ctx, deadlineAt, 0);
    const parsed = AwardCountResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw serviceUnavailable('USAspending returned an award count without a count per group.', {
        operation: `POST ${path}`,
        ...upstreamFailure('api_unavailable'),
      });
    }
    return parsed.data.results;
  }

  // --- Award detail ---

  async getAward(awardId: string, ctx: Context): Promise<RawAwardDetail | undefined> {
    ctx.log.debug('getAward', { awardId });
    return await this.getEntity<RawAwardDetail>(`awards/${encodeURIComponent(awardId)}/`, ctx);
  }

  getAwardTransactions(
    params: {
      award_id: string;
      sort: string;
      order: string;
      limit: number;
      page: number;
    },
    ctx: Context,
  ): Promise<{ results: RawTransaction[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getAwardTransactions', { awardId: params.award_id });
    return this.post('transactions/', params, ctx);
  }

  getAwardSubawards(
    params: {
      award_id: string;
      sort: string;
      order: string;
      limit: number;
      page: number;
    },
    ctx: Context,
  ): Promise<{ results: RawSubaward[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getAwardSubawards', { awardId: params.award_id });
    return this.post('subawards/', params, ctx);
  }

  /**
   * Lists the Treasury federal accounts that funded an award.
   *
   * Not routed through {@link getEntity}: this endpoint answers a nonexistent or
   * malformed `award_id` with HTTP 200 and zero rows rather than a miss status,
   * so there is no not-found signal to map. Callers disclose the empty case as a
   * notice.
   */
  getAwardFederalAccounts(
    params: {
      award_id: string;
      limit: number;
      page: number;
    },
    ctx: Context,
  ): Promise<RawAwardFederalAccountsResponse> {
    ctx.log.debug('getAwardFederalAccounts', { awardId: params.award_id, page: params.page });
    return this.post<RawAwardFederalAccountsResponse>('awards/accounts/', params, ctx);
  }

  // --- Recipients ---

  searchRecipients(
    params: {
      keyword?: string;
      award_type?: string;
      limit?: number;
      page?: number;
    },
    ctx: Context,
  ): Promise<RawRecipientSearchResponse> {
    ctx.log.debug('searchRecipients', { keyword: params.keyword, page: params.page });
    return this.post<RawRecipientSearchResponse>('recipient/', params, ctx);
  }

  /**
   * Fetches a recipient profile. The endpoint scopes its totals by `year` alone
   * (a fiscal year; omitted, the trailing 12 months) and has no award-type
   * selector. `fiscal_year` must be an integer: a malformed `year` draws a 400,
   * which {@link getEntity} would read as a missing recipient.
   */
  async getRecipient(
    recipientId: string,
    params: { fiscal_year?: number },
    ctx: Context,
  ): Promise<RawRecipientDetail | undefined> {
    ctx.log.debug('getRecipient', { recipientId, fiscalYear: params.fiscal_year });
    const query = params.fiscal_year !== undefined ? `?year=${params.fiscal_year}` : '';
    return await this.getEntity<RawRecipientDetail>(
      `recipient/${encodeURIComponent(recipientId)}/${query}`,
      ctx,
    );
  }

  /**
   * The deadline of a request issued now: its full request budget. A tool that
   * chains a side read after such a request passes this, so the chain ends inside
   * the first request's deadline.
   */
  requestDeadline(): number {
    return Date.now() + this.retryBudgetMs;
  }

  /**
   * Child recipients of a parent, keyed by the parent's UEI or DUNS (not its hash):
   * `recipient/children/{uei_or_duns}/`, every child in one response. `fiscal_year`
   * scopes the amounts as {@link getRecipient} scopes the profile's. A best-effort
   * side read: one attempt, cut at {@link RECIPIENT_CHILDREN_WAIT_MS} or
   * `deadlineAt`, whichever comes first.
   * @throws {McpError} The classified upstream failure; `ServiceUnavailable` (not
   * retryable) when the body is not a list of child rows.
   */
  async getRecipientChildren(
    ueiOrDuns: string,
    params: { fiscal_year?: number },
    ctx: Context,
    deadlineAt: number,
  ): Promise<RecipientChild[]> {
    ctx.log.debug('getRecipientChildren', { ueiOrDuns, fiscalYear: params.fiscal_year });
    const query = params.fiscal_year !== undefined ? `?year=${params.fiscal_year}` : '';
    const path = `recipient/children/${encodeURIComponent(ueiOrDuns)}/${query}`;
    const raw = await this.get<unknown>(
      path,
      ctx,
      undefined,
      Math.min(deadlineAt, Date.now() + RECIPIENT_CHILDREN_WAIT_MS),
      0,
    );
    const parsed = RecipientChildrenSchema.safeParse(raw);
    if (!parsed.success) {
      throw serviceUnavailable('USAspending returned recipient children in an unexpected shape.', {
        ...upstreamFailure('api_unavailable', false),
        operation: `GET ${path}`,
      });
    }
    return parsed.data;
  }

  // --- Agencies ---

  listAgencies(
    params: { sort?: string; order?: string },
    ctx: Context,
  ): Promise<{ results: RawAgencyEntry[] }> {
    ctx.log.debug('listAgencies');
    const qs = new URLSearchParams();
    if (params.sort) qs.set('sort', params.sort);
    if (params.order) qs.set('order', params.order);
    const query = qs.toString();
    return this.get<{ results: RawAgencyEntry[] }>(
      `references/toptier_agencies/${query ? `?${query}` : ''}`,
      ctx,
    );
  }

  async getAgency(toptierCode: string, ctx: Context): Promise<RawAgencyDetail | undefined> {
    ctx.log.debug('getAgency', { toptierCode });
    return await this.getEntity<RawAgencyDetail>(`agency/${encodeURIComponent(toptierCode)}/`, ctx);
  }

  /**
   * One page of an agency's sub-agency breakdown. Without `fiscal_year` the
   * upstream answers for the current fiscal year; the response's `fiscal_year`
   * names the year it covered either way.
   */
  async getAgencySubAgencies(
    toptierCode: string,
    params: { page?: number; limit?: number; fiscal_year?: number },
    ctx: Context,
  ): Promise<{
    fiscal_year?: number | null;
    results: RawSubAgencyEntry[];
    page_metadata?: RawPageMetadata;
  }> {
    ctx.log.debug('getAgencySubAgencies', {
      toptierCode,
      page: params.page,
      fiscalYear: params.fiscal_year,
    });
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.fiscal_year !== undefined) qs.set('fiscal_year', String(params.fiscal_year));
    const query = qs.toString();
    return await this.get<{
      fiscal_year?: number | null;
      results: RawSubAgencyEntry[];
      page_metadata?: RawPageMetadata;
    }>(`agency/${encodeURIComponent(toptierCode)}/sub_agency/${query ? `?${query}` : ''}`, ctx, [
      ...ENTITY_MISS_STATUSES,
    ]);
  }

  async getAgencyBudgetaryResources(
    toptierCode: string,
    ctx: Context,
  ): Promise<{ agency_data_by_year: RawBudgetaryResources[] }> {
    ctx.log.debug('getAgencyBudgetaryResources', { toptierCode });
    return await this.get<{ agency_data_by_year: RawBudgetaryResources[] }>(
      `agency/${encodeURIComponent(toptierCode)}/budgetary_resources/`,
      ctx,
      [...ENTITY_MISS_STATUSES],
    );
  }

  // --- Spending analytics ---

  spendingByGeography(
    body: {
      scope: string;
      geo_layer: string;
      filters: Record<string, unknown>;
      subawards?: boolean;
    },
    ctx: Context,
  ): Promise<{ scope: string; geo_layer: string; results: RawGeographyResult[] }> {
    ctx.log.debug('spendingByGeography', { scope: body.scope, geo_layer: body.geo_layer });
    return this.post('search/spending_by_geography/', body, ctx);
  }

  spendingByCategory(
    category: string,
    body: {
      filters: Record<string, unknown>;
      limit: number;
      page: number;
    },
    ctx: Context,
  ): Promise<{
    category: string;
    results: RawSpendingByCategoryResult[];
    page_metadata: RawPageMetadata;
  }> {
    ctx.log.debug('spendingByCategory', { category });
    return this.post(`search/spending_by_category/${category}/`, body, ctx);
  }

  spendingOverTime(
    body: {
      group: string;
      filters: Record<string, unknown>;
      subawards?: boolean;
    },
    ctx: Context,
  ): Promise<{ group: string; results: RawSpendingOverTimeResult[] }> {
    ctx.log.debug('spendingOverTime', { group: body.group });
    return this.post('search/spending_over_time/', body, ctx);
  }

  // --- Disaster ---

  /** Absolute deadline shared by disaster page walks and reference reads; never exceeds 45 seconds. */
  disasterDeadline(): number {
    return Date.now() + Math.min(DEFAULT_REQUEST_BUDGET_MS, this.retryBudgetMs);
  }

  /** Best-effort official COVID grouping, bounded to two seconds within the caller's total budget. */
  async getDisasterAmountCodes(ctx: Context, deadlineAt: number): Promise<string[] | undefined> {
    try {
      const raw = await this.get<unknown>(
        'references/def_codes/',
        ctx,
        undefined,
        Math.min(deadlineAt, Date.now() + 2_000),
      );
      ctx.signal?.throwIfAborted();
      const parsed = z
        .object({
          codes: z
            .array(z.object({ code: z.string().min(1), disaster: z.string().nullable() }))
            .min(1),
        })
        .safeParse(raw);
      if (!parsed.success) return undefined;
      return parsed.data.codes
        .filter((entry) => entry.disaster === 'covid_19')
        .map((entry) => entry.code);
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      if (
        error instanceof McpError &&
        (typeof error.data?.status === 'number' ||
          error.code === JsonRpcErrorCode.Timeout ||
          error.code === JsonRpcErrorCode.ServiceUnavailable)
      )
        return undefined;
      throw error;
    }
  }

  getDisasterOverview(ctx: Context, defCodes?: string[]): Promise<RawDisasterOverview> {
    ctx.log.debug('getDisasterOverview');
    const query = defCodes?.length
      ? `?${new URLSearchParams({ def_codes: defCodes.join(',') })}`
      : '';
    return this.get<RawDisasterOverview>(`disaster/overview/${query}`, ctx);
  }

  async getDisasterByAgency(
    spendingType: 'award' | 'total',
    body: DisasterBreakdownRequest,
    ctx: Context,
    deadlineAt = this.disasterDeadline(),
  ): Promise<RawDisasterBreakdownResponse> {
    ctx.log.debug('getDisasterByAgency', { spendingType });
    if (spendingType !== 'award' || body.filter?.award_type_codes?.length) {
      return this.post(
        'disaster/agency/spending/',
        { ...body, spending_type: spendingType },
        ctx,
        deadlineAt,
      );
    }
    /** The FABA backend slices before sorting. Collect its complete set before selecting a ranked page. */
    const pagination = body.pagination;
    let first: RawDisasterBreakdownResponse | undefined;
    const rows: NonNullable<RawDisasterBreakdownResponse['results']> = [];
    const messages = new Set<string>();
    for (let page = 1; ; page++) {
      const data = await this.post<RawDisasterBreakdownResponse>(
        'disaster/agency/spending/',
        {
          ...body,
          spending_type: spendingType,
          pagination: { page, limit: 100, sort: 'obligation', order: 'desc' },
        },
        ctx,
        deadlineAt,
      );
      first ??= data;
      rows.push(...(data.results ?? []));
      for (const message of data.messages ?? []) messages.add(message);
      if (!data.page_metadata?.hasNext) break;
    }
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    rows.sort(
      (a, b) =>
        (b.obligation ?? -Infinity) - (a.obligation ?? -Infinity) ||
        compare(a.code ?? '', b.code ?? '') ||
        compare(String(a.id ?? ''), String(b.id ?? '')),
    );
    const start = (pagination.page - 1) * pagination.limit;
    return {
      ...first,
      ...(messages.size ? { messages: [...messages] } : {}),
      results: rows.slice(start, start + pagination.limit),
      page_metadata: {
        ...first.page_metadata,
        page: pagination.page,
        limit: pagination.limit,
        hasNext: start + pagination.limit < rows.length,
      },
    };
  }

  getDisasterByCfda(
    body: Record<string, unknown>,
    ctx: Context,
    deadlineAt?: number,
  ): Promise<RawDisasterBreakdownResponse> {
    ctx.log.debug('getDisasterByCfda');
    return this.post('disaster/cfda/spending/', body, ctx, deadlineAt);
  }

  getDisasterByRecipient(
    spendingType: 'award' | 'total',
    body: Record<string, unknown>,
    ctx: Context,
    deadlineAt?: number,
  ): Promise<RawDisasterBreakdownResponse> {
    ctx.log.debug('getDisasterByRecipient', { spendingType });
    return this.post(
      'disaster/recipient/spending/',
      { ...body, spending_type: spendingType },
      ctx,
      deadlineAt,
    );
  }

  getDisasterByGeography(
    body: Record<string, unknown>,
    ctx: Context,
    deadlineAt?: number,
  ): Promise<{ scope: string; geo_layer: string; results: RawDisasterGeoResult[] }> {
    ctx.log.debug('getDisasterByGeography');
    return this.post('disaster/spending_by_geography/', body, ctx, deadlineAt);
  }

  // --- Federal accounts ---

  async getFederalAccount(
    accountCode: string,
    ctx: Context,
    fiscalYear?: number,
  ): Promise<RawFederalAccount | undefined> {
    ctx.log.debug('getFederalAccount', { accountCode, fiscalYear });
    const query = fiscalYear !== undefined ? `?fiscal_year=${fiscalYear}` : '';
    return await this.getEntity<RawFederalAccount>(
      `federal_accounts/${encodeURIComponent(accountCode)}/${query}`,
      ctx,
    );
  }

  searchFederalAccounts(
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<RawFederalAccountSearchResponse> {
    ctx.log.debug('searchFederalAccounts', {
      keyword: body.keyword,
      page: body.page,
      limit: body.limit,
    });
    return this.post<RawFederalAccountSearchResponse>('federal_accounts/', body, ctx);
  }

  /**
   * Obligations for an account broken down by program activity.
   *
   * Like {@link getFederalAccountObjectClasses}, a well-formed but nonexistent
   * account code answers HTTP 200 with zero rows and `total: 0` — only a code
   * that fails URL routing 404s — so neither route carries a not-found signal
   * the way `federal_accounts/{code}/` does.
   */
  getFederalAccountProgramActivities(
    accountCode: string,
    body: {
      limit: number;
      page: number;
      filters?: { time_period: { start_date: string; end_date: string }[] };
    },
    ctx: Context,
  ): Promise<RawFederalAccountBreakdownResponse> {
    ctx.log.debug('getFederalAccountProgramActivities', { accountCode, page: body.page });
    return this.post<RawFederalAccountBreakdownResponse>(
      `federal_accounts/${encodeURIComponent(accountCode)}/program_activities/total`,
      body,
      ctx,
    );
  }

  /** Obligations for an account broken down by object class. */
  getFederalAccountObjectClasses(
    accountCode: string,
    body: {
      limit: number;
      page: number;
      filters?: { time_period: { start_date: string; end_date: string }[] };
    },
    ctx: Context,
  ): Promise<RawFederalAccountBreakdownResponse> {
    ctx.log.debug('getFederalAccountObjectClasses', { accountCode, page: body.page });
    return this.post<RawFederalAccountBreakdownResponse>(
      `federal_accounts/${encodeURIComponent(accountCode)}/object_classes/total`,
      body,
      ctx,
    );
  }

  // --- IDV awards ---

  getIdvAwards(
    params: {
      award_id: string;
      type: string;
      sort: string;
      order: string;
      limit: number;
      page: number;
    },
    ctx: Context,
  ): Promise<RawIdvAwardsResponse> {
    ctx.log.debug('getIdvAwards', { awardId: params.award_id, type: params.type });
    return this.post<RawIdvAwardsResponse>('idvs/awards/', params, ctx);
  }

  // --- Autocomplete ---

  autocompleteNaics(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawNaicsAutocomplete[] }> {
    ctx.log.debug('autocompleteNaics', { searchText });
    return this.post('autocomplete/naics/', { search_text: searchText, limit }, ctx);
  }

  autocompletePsc(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawPscAutocomplete[] }> {
    ctx.log.debug('autocompletePsc', { searchText });
    return this.post('autocomplete/psc/', { search_text: searchText, limit }, ctx);
  }

  autocompleteCfda(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawCfdaAutocomplete[] }> {
    ctx.log.debug('autocompleteCfda', { searchText });
    return this.post('autocomplete/cfda/', { search_text: searchText, limit }, ctx);
  }

  autocompleteAwardingAgency(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{
    results: {
      toptier_agency?: RawAgencyAutocomplete[];
      subtier_agency?: RawAgencyAutocomplete[];
      office?: unknown[];
    };
  }> {
    ctx.log.debug('autocompleteAwardingAgency', { searchText });
    return this.post(
      'autocomplete/awarding_agency_office/',
      { search_text: searchText, limit },
      ctx,
    );
  }

  autocompleteRecipient(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawRecipientAutocomplete[] }> {
    ctx.log.debug('autocompleteRecipient', { searchText });
    return this.post('autocomplete/recipient/', { search_text: searchText, limit }, ctx);
  }

  /**
   * Location names matching `searchText`, up to `limit` per bucket. Sends at most
   * {@link LOCATION_AUTOCOMPLETE_LIMIT_MAX}, the largest limit the route answers.
   */
  autocompleteLocation(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<RawLocationAutocompleteResponse> {
    ctx.log.debug('autocompleteLocation', { searchText });
    return this.post(
      'autocomplete/location/',
      { search_text: searchText, limit: Math.min(limit, LOCATION_AUTOCOMPLETE_LIMIT_MAX) },
      ctx,
    );
  }
}

// --- Init/accessor pattern ---

let _service: USASpendingService | undefined;

export function initUSASpendingService(
  appConfig: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new USASpendingService(appConfig, storage, serverConfig);
}

export function getUSASpendingService(): USASpendingService {
  if (!_service) {
    throw new Error(
      'USASpendingService not initialized — call initUSASpendingService() in setup()',
    );
  }
  return _service;
}
