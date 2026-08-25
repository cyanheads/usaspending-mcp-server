/**
 * @fileoverview USAspending.gov API v2 service. Wraps all award search, award detail,
 * recipient, agency, spending analytics, disaster, and federal account endpoints.
 * @module services/usaspending/usaspending-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { McpError, serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  type FetchWithTimeoutOptions,
  fetchWithTimeout,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  RawAgencyAutocomplete,
  RawAgencyDetail,
  RawAgencyEntry,
  RawAwardDetail,
  RawAwardFederalAccountsResponse,
  RawAwardSummary,
  RawBudgetaryResources,
  RawCfdaAutocomplete,
  RawDisasterGeoResult,
  RawDisasterOverview,
  RawDisasterResult,
  RawFederalAccount,
  RawFederalAccountBreakdownResponse,
  RawFederalAccountSearchResponse,
  RawGeographyResult,
  RawIdvAwardsResponse,
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

/**
 * Upstream statuses that mean "no such entity" on the single-entity detail
 * endpoints. Verified against the live API per endpoint:
 *
 * - `recipient/{id}/` — 400 for a well-formed miss ("Recipient ID not found")
 *   and for a malformed identifier ("Invalid Recipient-Level"). The
 *   `fiscal_year` / `award_type` query params are ignored rather than
 *   rejected, so no existing recipient can answer 400.
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

export class USASpendingService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retryBudgetMs: number;

  constructor(_appConfig: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl.endsWith('/')
      ? serverConfig.baseUrl
      : `${serverConfig.baseUrl}/`;
    this.timeoutMs = serverConfig.timeoutMs;
    this.retryBudgetMs = serverConfig.retryBudgetMs ?? Math.round(serverConfig.timeoutMs * 1.5);
  }

  // --- HTTP primitives ---

  /**
   * Issues one upstream request under a wall-clock deadline spanning the whole
   * retry loop.
   *
   * `withRetry` re-runs a transient failure three more times by default and a
   * per-request timeout classifies as transient, so an endpoint that cannot
   * answer inside `USASPENDING_TIMEOUT_MS` re-pays that budget on every attempt
   * — measured at 128s against the 30s default. A timeout is not evidence the
   * next attempt will be faster, so a single deadline signal, composed with the
   * caller's and threaded into both `withRetry` and `fetchWithTimeout`, caps the
   * total instead of letting it scale with the attempt count.
   *
   * Worst case is `USASPENDING_RETRY_BUDGET_MS` plus the time to unwind an
   * in-flight fetch: ~45s at the defaults, and ~180s if a caller raises
   * `USASPENDING_TIMEOUT_MS` to its 120000 ceiling and leaves the budget derived
   * — where the unbounded loop ran roughly eight minutes.
   *
   * `this.timeoutMs` bounds the whole exchange, not just the header phase: a 2xx
   * carrying a body comes back as a passthrough wrapper that keeps that deadline
   * armed until the body closes, so the `await response.text()` below is covered
   * too and a peer that answers headers and then stalls the stream cannot hold
   * an attempt open past its timeout.
   *
   * Deadline expiry reaches this frame two ways, neither coherent on its own.
   * Aborted mid-fetch, `fetchWithTimeout` throws its `FetchAborted`
   * `InternalError` ("was aborted") and `withRetry` re-throws it verbatim,
   * naming no deadline. Aborted mid-backoff, `withRetry`'s internal sleep
   * rejects with the raw abort reason, which bypasses its error-enrichment path
   * entirely and surfaces a bare `AbortError`. Both are normalized here into one
   * `Timeout` naming the budget it exhausted. A caller-initiated abort is left
   * untouched.
   */
  private async request<T>(
    operation: string,
    url: string,
    ctx: Context,
    init: FetchWithTimeoutOptions,
  ): Promise<T> {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.retryBudgetMs);
    const signal = ctx.signal ? AbortSignal.any([deadline.signal, ctx.signal]) : deadline.signal;

    try {
      return await withRetry(
        async () => {
          const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
            ...init,
            signal,
          });
          const text = await response.text();
          return this.parseJson<T>(text, url);
        },
        {
          operation,
          context: ctx,
          baseDelayMs: RETRY_BASE_DELAY_MS,
          signal,
        },
      );
    } catch (err) {
      if (deadline.signal.aborted && !ctx.signal?.aborted) {
        throw timeout(
          `USAspending did not answer ${operation} within the ${this.retryBudgetMs}ms request budget (${this.timeoutMs}ms per attempt, retries included).`,
          {
            url,
            operation,
            budgetMs: this.retryBudgetMs,
            timeoutMs: this.timeoutMs,
            errorSource: 'RequestBudgetExhausted',
          },
          { cause: err },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string, ctx: Context, expectedStatuses?: number[]): Promise<T> {
    return this.request<T>(`GET ${path}`, `${this.baseUrl}${path}`, ctx, {
      headers: { Accept: 'application/json' },
      ...(expectedStatuses ? { expectedStatuses } : {}),
    });
  }

  private post<T>(path: string, body: unknown, ctx: Context): Promise<T> {
    return this.request<T>(`POST ${path}`, `${this.baseUrl}${path}`, ctx, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
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
   * because `usaspending_get_agency` resolves them alongside the agency detail
   * and catches their rejection — a miss there is an expected outcome and logs
   * at `debug`, while the still-thrown error reaches that caller's catch.
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
      keyword: string;
      award_type?: string;
      limit?: number;
      page?: number;
    },
    ctx: Context,
  ): Promise<RawRecipientSearchResponse> {
    ctx.log.debug('searchRecipients', { keyword: params.keyword, page: params.page });
    return this.post<RawRecipientSearchResponse>('recipient/', params, ctx);
  }

  async getRecipient(
    recipientId: string,
    params: { fiscal_year?: number; award_type?: string },
    ctx: Context,
  ): Promise<RawRecipientDetail | undefined> {
    ctx.log.debug('getRecipient', { recipientId });
    const qs = new URLSearchParams();
    if (params.fiscal_year) qs.set('fiscal_year', String(params.fiscal_year));
    if (params.award_type) qs.set('award_type', params.award_type);
    const query = qs.toString();
    return await this.getEntity<RawRecipientDetail>(
      `recipient/${encodeURIComponent(recipientId)}/${query ? `?${query}` : ''}`,
      ctx,
    );
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

  async getAgencySubAgencies(
    toptierCode: string,
    params: { page?: number; limit?: number },
    ctx: Context,
  ): Promise<{ results: RawSubAgencyEntry[]; page_metadata?: RawPageMetadata }> {
    ctx.log.debug('getAgencySubAgencies', { toptierCode, page: params.page });
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    const query = qs.toString();
    return await this.get<{ results: RawSubAgencyEntry[]; page_metadata?: RawPageMetadata }>(
      `agency/${encodeURIComponent(toptierCode)}/sub_agency/${query ? `?${query}` : ''}`,
      ctx,
      [...ENTITY_MISS_STATUSES],
    );
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

  getDisasterOverview(ctx: Context): Promise<RawDisasterOverview> {
    ctx.log.debug('getDisasterOverview');
    return this.get<RawDisasterOverview>('disaster/overview/', ctx);
  }

  getDisasterByAgency(
    spendingType: 'award' | 'total',
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByAgency', { spendingType });
    return this.post('disaster/agency/spending/', { ...body, spending_type: spendingType }, ctx);
  }

  getDisasterByCfda(
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByCfda');
    return this.post('disaster/cfda/spending/', body, ctx);
  }

  getDisasterByRecipient(
    spendingType: 'award' | 'total',
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByRecipient', { spendingType });
    return this.post('disaster/recipient/spending/', { ...body, spending_type: spendingType }, ctx);
  }

  getDisasterByGeography(
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ scope: string; geo_layer: string; results: RawDisasterGeoResult[] }> {
    ctx.log.debug('getDisasterByGeography');
    return this.post('disaster/spending_by_geography/', body, ctx);
  }

  // --- Federal accounts ---

  async getFederalAccount(
    accountCode: string,
    ctx: Context,
  ): Promise<RawFederalAccount | undefined> {
    ctx.log.debug('getFederalAccount', { accountCode });
    return await this.getEntity<RawFederalAccount>(
      `federal_accounts/${encodeURIComponent(accountCode)}/`,
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
    body: { limit: number; page: number },
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
    body: { limit: number; page: number },
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
  ): Promise<{ results: RawAgencyAutocomplete[] }> {
    ctx.log.debug('autocompleteAwardingAgency', { searchText });
    return this.post('autocomplete/awarding_agency/', { search_text: searchText, limit }, ctx);
  }

  autocompleteRecipient(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawRecipientAutocomplete[] }> {
    ctx.log.debug('autocompleteRecipient', { searchText });
    return this.post('autocomplete/recipient/', { search_text: searchText, limit }, ctx);
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
