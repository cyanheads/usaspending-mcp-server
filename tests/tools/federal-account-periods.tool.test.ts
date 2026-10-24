/**
 * @fileoverview Federal-account periods through real tool, service, and HTTP boundaries.
 * @module tests/tools/federal-account-periods.tool.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFederalAccountTool } from '@/mcp-server/tools/definitions/get-federal-account.tool.js';
import { getFederalAccountBreakdownTool } from '@/mcp-server/tools/definitions/get-federal-account-breakdown.tool.js';
import { searchFederalAccountsTool } from '@/mcp-server/tools/definitions/search-federal-accounts.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { markdownText } from '../helpers/markdown-text.js';

beforeEach(() => {
  // The service uses only serverConfig; no storage/config operations run in this path.
  initUSASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: 'https://api.usaspending.gov/api/v2/',
    timeoutMs: 1000,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('Unexpected HTTP request');
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('federal-account HTTP periods', () => {
  it.each([undefined, '', 2027])(
    'preserves an empty snapshot without fallback for year %s',
    async (fiscal_year) => {
      // Captured empty-year fields; explicit year responses return the year as a string.
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              account_title: 'Water and Related Resources, Bureau of Reclamation, Interior',
              federal_account_code: '014-0680',
              fiscal_year: fiscal_year === 2027 ? '2027' : 2027,
              total_obligated_amount: null,
              total_gross_outlay_amount: null,
              total_budgetary_resources: null,
              children: [],
            }),
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await runToolContract(getFederalAccountTool, {
        account_code: '014-0680',
        fiscal_year,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![0]).toBe(
        fiscal_year === 2027
          ? 'https://api.usaspending.gov/api/v2/federal_accounts/014-0680/?fiscal_year=2027'
          : 'https://api.usaspending.gov/api/v2/federal_accounts/014-0680/',
      );
      expect(result.structuredContent).toMatchObject({
        fiscal_year: 2027,
        federal_account_code: '014-0680',
        notice: expect.stringContaining('FY2027'),
      });
      expect(result.structuredContent).not.toHaveProperty('total_obligated_amount');
      expect(result.structuredContent).not.toHaveProperty('children');
      const rendered = markdownText(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      );
      expect(rendered).toContain('FY2027');
      expect(rendered).toContain('No financial totals');
      expect(rendered).not.toContain('$0');
    },
  );

  it('requests selected-year detail and preserves captured financial values on both surfaces', async () => {
    // Selected fields from the captured 014-0680 FY2025 response.
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            account_title: 'Water and Related Resources, Bureau of Reclamation, Interior',
            fiscal_year: '2025',
            total_obligated_amount: 4_117_711_187.29,
            total_budgetary_resources: 10_130_607_579.09,
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '014-0680',
      fiscal_year: 2025,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      'https://api.usaspending.gov/api/v2/federal_accounts/014-0680/?fiscal_year=2025',
    );
    expect(new Request(url, init).method).toBe('GET');
    expect(result.structuredContent).toMatchObject({
      fiscal_year: 2025,
      total_obligated_amount: 4_117_711_187.29,
      total_budgetary_resources: 10_130_607_579.09,
    });
    const rendered = markdownText(
      result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    expect(rendered).toContain('2025');
    expect(rendered).toContain('4,117,711,187.29');
    expect(rendered).toContain('10,130,607,579.09');
  });

  it.each(['program_activity', 'object_class'] as const)(
    'sends the selected financial reporting range through %s HTTP',
    async (dimension) => {
      const fetchMock = vi.fn(
        async (_url: string, _init?: RequestInit) =>
          new Response(
            JSON.stringify({
              results: [],
              page_metadata: { total: 0, page: 2, hasNext: false, hasPrevious: true },
            }),
          ),
      );
      vi.stubGlobal('fetch', fetchMock);
      const result = await runToolContract(getFederalAccountBreakdownTool, {
        account_code: '014-0680',
        dimension,
        fiscal_year: 2025,
        page: 2,
        limit: 1,
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe(
        `https://api.usaspending.gov/api/v2/federal_accounts/014-0680/${dimension === 'program_activity' ? 'program_activities' : 'object_classes'}/total`,
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        page: 2,
        limit: 1,
        filters: { time_period: [{ start_date: '2024-10-01', end_date: '2025-09-30' }] },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        fiscal_year: 2025,
        period: 'FY2025',
        results: [],
        notice: expect.any(String),
      });
    },
  );

  it('sends the search year and retains the returned effective year', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ fy: '2025', count: 0, results: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await runToolContract(searchFederalAccountsTool, {
      fiscal_year: 2025,
      agency_identifier: '014',
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.usaspending.gov/api/v2/federal_accounts/');
    expect(JSON.parse(String(init?.body))).toEqual({
      sort: { field: 'budgetary_resources', direction: 'desc' },
      page: 1,
      limit: 10,
      filters: { agency_identifier: '014', fy: '2025' },
    });
    expect(result.structuredContent).toMatchObject({ fiscal_year: 2025 });
  });

  it('rejects invalid years in all three tools before HTTP', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const results = [
      await runToolContract(searchFederalAccountsTool, { fiscal_year: '2025' }),
      await runToolContract(getFederalAccountTool, {
        account_code: '014-0680',
        fiscal_year: 'FY2025',
      }),
      await runToolContract(getFederalAccountBreakdownTool, {
        account_code: '014-0680',
        dimension: 'object_class',
        fiscal_year: 2000,
      }),
    ];
    expect(fetchMock).not.toHaveBeenCalled();
    for (const result of results) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(JSON.stringify(result.content)).toContain('fiscal_year');
    }
  });

  it('retains the GET account-not-found recovery on both surfaces', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: 'Cannot find Federal Account' }), { status: 400 }),
      ),
    );
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '999-9999',
      fiscal_year: 2025,
    });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        data: {
          reason: 'account_not_found',
          recovery: { hint: expect.stringContaining('account_number') },
        },
      },
    });
    expect(JSON.stringify(result.content)).toContain('account_number');
    expect(JSON.stringify(result.content)).toContain('usaspending_search_federal_accounts');
  });
});
