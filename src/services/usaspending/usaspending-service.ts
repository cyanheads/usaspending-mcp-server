/**
 * @fileoverview USAspending.gov API v2 service. Wraps all award search, award detail,
 * recipient, agency, spending analytics, disaster, and federal account endpoints.
 * @module services/usaspending/usaspending-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  fetchWithTimeout,
  httpErrorFromResponse,
  type RequestContext,
  withRetry,
} from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  RawAgencyAutocomplete,
  RawAgencyDetail,
  RawAgencyEntry,
  RawAwardDetail,
  RawAwardSummary,
  RawBudgetaryResources,
  RawCfdaAutocomplete,
  RawDisasterGeoResult,
  RawDisasterOverview,
  RawDisasterResult,
  RawFederalAccount,
  RawGeographyResult,
  RawNaicsAutocomplete,
  RawPageMetadata,
  RawPscAutocomplete,
  RawRecipientAutocomplete,
  RawRecipientDetail,
  RawRecipientSearchResult,
  RawSpendingByCategoryResult,
  RawSpendingOverTimeResult,
  RawSubAgencyEntry,
  RawSubaward,
  RawTransaction,
} from './types.js';

export class USASpendingService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_appConfig: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl.endsWith('/')
      ? serverConfig.baseUrl
      : `${serverConfig.baseUrl}/`;
    this.timeoutMs = serverConfig.timeoutMs;
  }

  // --- HTTP primitives ---

  private async get<T>(path: string, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          url,
          this.timeoutMs,
          ctx as unknown as RequestContext,
          {
            headers: { Accept: 'application/json' },
            signal: ctx.signal,
          },
        );
        const text = await response.text();
        return this.parseJson<T>(text, url);
      },
      {
        operation: `GET ${path}`,
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
  }

  private async post<T>(path: string, body: unknown, ctx: Context): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    return withRetry(
      async () => {
        const response = await fetchWithTimeout(
          url,
          this.timeoutMs,
          ctx as unknown as RequestContext,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify(body),
            signal: ctx.signal,
          },
        );
        if (!response.ok) {
          throw await httpErrorFromResponse(response, {
            service: 'USAspending',
            data: { path },
          });
        }
        const text = await response.text();
        return this.parseJson<T>(text, url);
      },
      {
        operation: `POST ${path}`,
        context: ctx as unknown as RequestContext,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );
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

  async searchAwards(
    params: {
      filters: Record<string, unknown>;
      fields: string[];
      sort: string;
      order?: string;
      limit: number;
      page: number;
      subawards?: boolean;
    },
    ctx: Context,
  ): Promise<{ results: RawAwardSummary[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('searchAwards', { sort: params.sort, limit: params.limit, page: params.page });
    return this.post('search/spending_by_award/', params, ctx);
  }

  // --- Award detail ---

  async getAward(awardId: string, ctx: Context): Promise<RawAwardDetail> {
    ctx.log.debug('getAward', { awardId });
    return this.get<RawAwardDetail>(`awards/${encodeURIComponent(awardId)}/`, ctx);
  }

  async getAwardTransactions(
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

  async getAwardSubawards(
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

  // --- Recipients ---

  async searchRecipients(
    params: {
      keyword: string;
      award_type?: string;
      limit?: number;
    },
    ctx: Context,
  ): Promise<RawRecipientSearchResult[]> {
    ctx.log.debug('searchRecipients', { keyword: params.keyword });
    const result = await this.post<{ results: RawRecipientSearchResult[] }>(
      'recipient/',
      params,
      ctx,
    );
    return result.results ?? [];
  }

  async getRecipient(
    recipientId: string,
    params: { fiscal_year?: number; award_type?: string },
    ctx: Context,
  ): Promise<RawRecipientDetail> {
    ctx.log.debug('getRecipient', { recipientId });
    const qs = new URLSearchParams();
    if (params.fiscal_year) qs.set('fiscal_year', String(params.fiscal_year));
    if (params.award_type) qs.set('award_type', params.award_type);
    const query = qs.toString();
    return this.get<RawRecipientDetail>(
      `recipient/${encodeURIComponent(recipientId)}/${query ? `?${query}` : ''}`,
      ctx,
    );
  }

  // --- Agencies ---

  async listAgencies(
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

  async getAgency(toptierCode: string, ctx: Context): Promise<RawAgencyDetail> {
    ctx.log.debug('getAgency', { toptierCode });
    return this.get<RawAgencyDetail>(`agency/${encodeURIComponent(toptierCode)}/`, ctx);
  }

  async getAgencySubAgencies(
    toptierCode: string,
    ctx: Context,
  ): Promise<{ results: RawSubAgencyEntry[] }> {
    ctx.log.debug('getAgencySubAgencies', { toptierCode });
    return this.get<{ results: RawSubAgencyEntry[] }>(
      `agency/${encodeURIComponent(toptierCode)}/sub_agency/`,
      ctx,
    );
  }

  async getAgencyBudgetaryResources(
    toptierCode: string,
    ctx: Context,
  ): Promise<{ agency_data_by_year: RawBudgetaryResources[] }> {
    ctx.log.debug('getAgencyBudgetaryResources', { toptierCode });
    return this.get<{ agency_data_by_year: RawBudgetaryResources[] }>(
      `agency/${encodeURIComponent(toptierCode)}/budgetary_resources/`,
      ctx,
    );
  }

  // --- Spending analytics ---

  async spendingByGeography(
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

  async spendingByCategory(
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

  async spendingOverTime(
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

  async getDisasterOverview(ctx: Context): Promise<RawDisasterOverview> {
    ctx.log.debug('getDisasterOverview');
    return this.get<RawDisasterOverview>('disaster/overview/', ctx);
  }

  async getDisasterByAgency(
    spendingType: 'award' | 'total',
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByAgency', { spendingType });
    return this.post('disaster/agency/spending/', { ...body, spending_type: spendingType }, ctx);
  }

  async getDisasterByCfda(
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByCfda');
    return this.post('disaster/cfda/spending/', body, ctx);
  }

  async getDisasterByRecipient(
    spendingType: 'award' | 'total',
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ results: RawDisasterResult[]; page_metadata: RawPageMetadata }> {
    ctx.log.debug('getDisasterByRecipient', { spendingType });
    return this.post('disaster/recipient/spending/', { ...body, spending_type: spendingType }, ctx);
  }

  async getDisasterByGeography(
    body: Record<string, unknown>,
    ctx: Context,
  ): Promise<{ scope: string; geo_layer: string; results: RawDisasterGeoResult[] }> {
    ctx.log.debug('getDisasterByGeography');
    return this.post('disaster/spending_by_geography/', body, ctx);
  }

  // --- Federal accounts ---

  async getFederalAccount(accountCode: string, ctx: Context): Promise<RawFederalAccount> {
    ctx.log.debug('getFederalAccount', { accountCode });
    return this.get<RawFederalAccount>(`federal_accounts/${encodeURIComponent(accountCode)}/`, ctx);
  }

  // --- Autocomplete ---

  async autocompleteNaics(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawNaicsAutocomplete[] }> {
    ctx.log.debug('autocompleteNaics', { searchText });
    return this.post('autocomplete/naics/', { search_text: searchText, limit }, ctx);
  }

  async autocompletePsc(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawPscAutocomplete[] }> {
    ctx.log.debug('autocompletePsc', { searchText });
    return this.post('autocomplete/psc/', { search_text: searchText, limit }, ctx);
  }

  async autocompleteCfda(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawCfdaAutocomplete[] }> {
    ctx.log.debug('autocompleteCfda', { searchText });
    return this.post('autocomplete/cfda/', { search_text: searchText, limit }, ctx);
  }

  async autocompleteAwardingAgency(
    searchText: string,
    limit: number,
    ctx: Context,
  ): Promise<{ results: RawAgencyAutocomplete[] }> {
    ctx.log.debug('autocompleteAwardingAgency', { searchText });
    return this.post('autocomplete/awarding_agency/', { search_text: searchText, limit }, ctx);
  }

  async autocompleteRecipient(
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
