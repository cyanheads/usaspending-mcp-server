/**
 * @fileoverview `usaspending_get_agency` run through its public contract against
 * the real USAspending service, with `globalThis.fetch` stubbed per endpoint.
 * Covers the leg-failure paths (#69) at a seam that includes the service's
 * status mapping and retry loop, which the module-mocked suite stubs away.
 * @module tests/tools/get-agency-upstream.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgencyTool } from '@/mcp-server/tools/definitions/get-agency.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';

const BASE = 'https://api.usaspending.gov/api/v2/';

/** Per-path responders; any request not listed fails the test instead of reaching the network. */
type Routes = Record<string, (url: URL) => Response | Promise<Response>>;

const stubRoutes = (routes: Routes) => {
  const fetchMock = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    const responder = routes[parsed.pathname.replace('/api/v2/', '')];
    if (!responder) throw new Error(`Unmocked fetch in get-agency-upstream.test: ${url}`);
    return responder(parsed);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status });

const pathsCalled = (fetchMock: ReturnType<typeof stubRoutes>) =>
  fetchMock.mock.calls.map(([url]) => new URL(url).pathname.replace('/api/v2/', ''));

beforeEach(() => {
  initUSASpendingService({} as AppConfig, {} as StorageService, {
    baseUrl: BASE,
    timeoutMs: 30_000,
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Runs the tool while advancing fake time through every retry backoff. */
const settle = async (input: Parameters<typeof runToolContract<typeof getAgencyTool>>[1]) => {
  const pending = runToolContract(getAgencyTool, input);
  await vi.advanceTimersByTimeAsync(120_000);
  return await pending;
};

const MISS_999 = { detail: "Agency with a toptier code of '999' does not exist" };

describe('usaspending_get_agency against the real service', () => {
  it('fails a nonexistent agency as agency_not_found even though its sub-resources also 404', async () => {
    const fetchMock = stubRoutes({
      'agency/999/': json(404, MISS_999),
      'agency/999/sub_agency/': json(404, MISS_999),
      'agency/999/budgetary_resources/': json(404, MISS_999),
    });

    const result = await settle({ toptier_code: '999' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'agency_not_found' } },
    });
    expect(pathsCalled(fetchMock).sort()).toEqual([
      'agency/999/',
      'agency/999/budgetary_resources/',
      'agency/999/sub_agency/',
    ]);
  });

  it('returns the overview with sub_agencies unavailable when that endpoint keeps answering 503', async () => {
    const fetchMock = stubRoutes({
      'agency/247/': json(200, {
        toptier_code: '247',
        name: '400 Years of African-American History Commission',
        abbreviation: 'AAHC',
        agency_id: 1525,
        subtier_agency_count: 0,
        def_codes: [],
      }),
      'agency/247/sub_agency/': () => new Response('', { status: 503 }),
      'agency/247/budgetary_resources/': json(200, {
        toptier_code: '247',
        agency_data_by_year: [
          {
            fiscal_year: 2025,
            agency_budgetary_resources: 1_000_000,
            agency_total_obligated: 750_000,
            agency_total_outlayed: 500_000,
          },
        ],
      }),
    });

    const result = await settle({ toptier_code: '247' });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.name).toBe('400 Years of African-American History Commission');
    expect(sc.budgetary_resources_amount).toBe(1_000_000);
    expect(sc).not.toHaveProperty('has_more_sub_agencies');
    expect(sc).not.toHaveProperty('sub_agency_page');
    expect(sc.unavailable_sections).toEqual([
      expect.objectContaining({
        section: 'sub_agencies',
        reason: 'api_unavailable',
        retryable: true,
        message: expect.stringContaining('Status: 503'),
      }),
    ]);
    // The service's retry loop ran for the failing leg before the tool degraded it.
    expect(pathsCalled(fetchMock).filter((p) => p === 'agency/247/sub_agency/')).toHaveLength(4);
  });

  it('fails on a failed overview without waiting for a hung budget request', async () => {
    const fetchMock = stubRoutes({
      'agency/014/': () => new Response('', { status: 503 }),
      'agency/014/budgetary_resources/': () => new Promise<Response>(() => {}),
      'agency/014/sub_agency/': json(200, {
        toptier_code: '014',
        fiscal_year: 2027,
        page_metadata: { page: 1, total: 1, limit: 10, hasNext: false },
        results: [{ name: 'Departmental Offices', total_obligations: 71_312 }],
      }),
    });

    let settled: Awaited<ReturnType<typeof runToolContract>> | undefined;
    const pending = runToolContract(getAgencyTool, { toptier_code: '014' }).then((r) => {
      settled = r;
    });
    // The overview exhausts its retries within ~7 s; the hung budget would hold the call to its 45 s budget.
    await vi.advanceTimersByTimeAsync(10_000);

    expect(settled?.isError).toBe(true);
    expect(settled?.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'api_unavailable' } },
    });
    expect(pathsCalled(fetchMock).filter((p) => p === 'agency/014/')).toHaveLength(4);
    await pending;
  });

  it('fails on a failed overview and absorbs legs that reject after it', async () => {
    const fetchMock = stubRoutes({
      'agency/014/': () => new Response('', { status: 503 }),
      'agency/014/budgetary_resources/': () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(new Response('', { status: 400 })), 8_000),
        ),
      'agency/014/sub_agency/': () => new Response('', { status: 503 }),
    });

    const result = await settle({ toptier_code: '014' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'api_unavailable' } },
    });
    // Both legs ran to their own failure after the overview failed; neither surfaced as an unhandled rejection.
    expect(pathsCalled(fetchMock)).toContain('agency/014/budgetary_resources/');
    expect(pathsCalled(fetchMock).filter((p) => p === 'agency/014/sub_agency/')).toHaveLength(4);
  });

  it('fetches the sub-agency breakdown for the budget totals year (#86)', async () => {
    /** Upstream answers the current fiscal year unless `fiscal_year` selects another. */
    const subAgencyFor = (url: URL) => {
      const year = Number(url.searchParams.get('fiscal_year') ?? 2027);
      const rows =
        year === 2026
          ? Array.from({ length: 10 }, (_, i) => ({ name: `Bureau ${i}`, total_obligations: i }))
          : [{ name: 'Departmental Offices', total_obligations: 71_312 }];
      return new Response(
        JSON.stringify({
          toptier_code: '014',
          fiscal_year: year,
          page_metadata: {
            page: 1,
            total: year === 2026 ? 12 : 3,
            limit: 10,
            hasNext: year === 2026,
          },
          results: rows,
        }),
        { status: 200 },
      );
    };
    const fetchMock = stubRoutes({
      'agency/014/': json(200, { toptier_code: '014', name: 'Department of the Interior' }),
      'agency/014/budgetary_resources/': json(200, {
        toptier_code: '014',
        agency_data_by_year: [
          {
            fiscal_year: 2027,
            agency_budgetary_resources: null,
            agency_total_obligated: null,
            agency_total_outlayed: null,
          },
          {
            fiscal_year: 2026,
            agency_budgetary_resources: 96_773_322_454.92,
            agency_total_obligated: 37_802_479_770.8,
            agency_total_outlayed: 36_821_485_523.31,
          },
        ],
      }),
      'agency/014/sub_agency/': subAgencyFor,
    });

    const result = await settle({ toptier_code: '014' });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.fiscal_year).toBe(2026);
    expect(sc.sub_agency_fiscal_year).toBe(2026);
    expect(sc.sub_agency_total).toBe(12);
    expect(sc.sub_agencies).toHaveLength(10);
    const subUrl = fetchMock.mock.calls
      .map(([u]) => new URL(u))
      .find((u) => u.pathname.endsWith('/sub_agency/'));
    expect(subUrl?.searchParams.get('fiscal_year')).toBe('2026');
  });
});
