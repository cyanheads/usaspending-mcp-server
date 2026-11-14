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
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgencyTool } from '@/mcp-server/tools/definitions/get-agency.tool.js';
import { initUSASpendingService } from '@/services/usaspending/usaspending-service.js';

const BASE = 'https://api.usaspending.gov/api/v2/';

/** Per-path responders; any request not listed fails the test instead of reaching the network. */
type Routes = Record<string, (url: URL, init?: RequestInit) => Response | Promise<Response>>;

const stubRoutes = (routes: Routes) => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const parsed = new URL(url);
    const responder = routes[parsed.pathname.replace('/api/v2/', '')];
    if (!responder) throw new Error(`Unmocked fetch in get-agency-upstream.test: ${url}`);
    return responder(parsed, init);
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

const agencyDefRoutes = (supplemental: Routes[string]): Routes => ({
  'agency/075/': (url, init) =>
    url.searchParams.has('fiscal_year')
      ? supplemental(url, init)
      : Response.json({ name: 'Health and Human Services', fiscal_year: 2027, def_codes: [] }),
  'agency/075/budgetary_resources/': json(200, {
    agency_data_by_year: [{ fiscal_year: 2026, agency_total_obligated: 100 }],
  }),
  'agency/075/sub_agency/': json(200, {
    fiscal_year: 2026,
    results: [{ name: 'Administration for Children and Families' }],
  }),
});

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

describe('usaspending_get_agency against the real service', () => {
  it('uses the eventual budget year for DEF codes after the sub-agency fallback', async () => {
    const codes = [
      { code: 'Z', title: 'Infrastructure Investment and Jobs Act', public_law: '117-58' },
    ];
    const fetchMock = stubRoutes({
      'agency/075/': (url) =>
        url.searchParams.has('fiscal_year')
          ? json(200, { fiscal_year: 2026, def_codes: codes })()
          : json(200, { name: 'Health and Human Services', fiscal_year: 2027, def_codes: [] })(),
      'agency/075/budgetary_resources/': () =>
        new Promise<Response>((resolve) => {
          setTimeout(
            () =>
              resolve(
                Response.json({
                  agency_data_by_year: [
                    { fiscal_year: 2027, agency_total_obligated: null },
                    { fiscal_year: 2026, agency_total_obligated: 0 },
                  ],
                }),
              ),
            6_000,
          );
        }),
      'agency/075/sub_agency/': json(200, { fiscal_year: 2027, results: [] }),
    });
    const result = await settle({ toptier_code: '075', page: 50 });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      fiscal_year: 2026,
      obligated_amount: 0,
      sub_agency_fiscal_year: 2027,
      def_codes_fiscal_year: 2026,
      def_codes: codes,
    });
    const text = textOf(result);
    expect(text).toContain('**DEF Codes Fiscal Year:** 2026');
    expect(text).toContain('**Z** — Infrastructure Investment and Jobs Act (117-58)');
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url));
    const subIndex = urls.findIndex((url) => url.pathname.endsWith('/sub_agency/'));
    const defIndex = urls.findIndex((url) => url.search === '?fiscal_year=2026');
    expect(urls[subIndex]?.search).toBe('?page=50&limit=10');
    expect(defIndex).toBeGreaterThan(subIndex);
  });

  it.each([undefined, 2027])('reuses the default year when the budget year is %s', async (year) => {
    const fetchMock = stubRoutes({
      ...agencyDefRoutes(() => {
        throw new Error('Unexpected supplemental lookup');
      }),
      'agency/075/budgetary_resources/': json(200, {
        agency_data_by_year:
          year === undefined ? [] : [{ fiscal_year: year, agency_total_obligated: 0 }],
      }),
    });
    const result = await settle({ toptier_code: '075' });
    expect(result.structuredContent).toMatchObject({ def_codes_fiscal_year: 2027, def_codes: [] });
    expect(textOf(result)).toContain('USAspending reported no DEF codes.');
    expect(pathsCalled(fetchMock).filter((path) => path === 'agency/075/')).toHaveLength(1);
  });

  it('distinguishes an empty DEF list for the requested year from an unavailable list', async () => {
    stubRoutes(agencyDefRoutes(json(200, { fiscal_year: 2026, def_codes: [] })));
    const result = await settle({ toptier_code: '075' });
    expect(result.structuredContent).toMatchObject({ def_codes_fiscal_year: 2026, def_codes: [] });
    expect(result.structuredContent).not.toHaveProperty('unavailable_sections');
    expect(textOf(result)).toContain('USAspending reported no DEF codes.');
  });

  it.each([
    [503, {}, 'api_unavailable', true],
    [404, {}, 'upstream_error', false],
    [200, { fiscal_year: 2027, def_codes: [{ code: 'Z' }] }, 'api_unavailable', false],
    [200, { fiscal_year: 2026 }, 'api_unavailable', false],
  ] as const)(
    'keeps other results when the DEF lookup returns %i %j',
    async (status, body, reason, retryable) => {
      const fetchMock = stubRoutes(agencyDefRoutes(json(status, body)));
      const result = await settle({ toptier_code: '075' });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        name: 'Health and Human Services',
        fiscal_year: 2026,
        obligated_amount: 100,
        sub_agency_fiscal_year: 2026,
        unavailable_sections: [
          expect.objectContaining({ section: 'def_codes', reason, retryable }),
        ],
      });
      expect(result.structuredContent).not.toHaveProperty('def_codes');
      expect(result.structuredContent).not.toHaveProperty('def_codes_fiscal_year');
      expect(textOf(result)).toContain(`- def_codes: ${reason}`);
      expect(pathsCalled(fetchMock).filter((path) => path === 'agency/075/')).toHaveLength(2);
    },
  );

  it('returns the rest of the agency within the supplemental deadline if the DEF body stalls', async () => {
    stubRoutes(
      agencyDefRoutes(
        (_url, init) =>
          new Response(
            new ReadableStream({
              start(controller) {
                init?.signal?.addEventListener('abort', () =>
                  controller.error(init.signal?.reason),
                );
              },
            }),
          ),
      ),
    );
    let result: Awaited<ReturnType<typeof runToolContract>> | undefined;
    const pending = runToolContract(getAgencyTool, { toptier_code: '075' }).then((value) => {
      result = value;
    });
    await vi.advanceTimersByTimeAsync(3_001);
    expect(result?.structuredContent).toMatchObject({
      name: 'Health and Human Services',
      unavailable_sections: [
        expect.objectContaining({ section: 'def_codes', reason: 'api_timeout', retryable: true }),
      ],
    });
    await pending;
  });

  it('propagates caller cancellation while the supplemental request is in flight', async () => {
    const abort = new AbortController();
    const reason = new DOMException('Cancelled agency lookup', 'AbortError');
    stubRoutes(
      agencyDefRoutes(() => {
        abort.abort(reason);
        return Response.json({ fiscal_year: 2026, def_codes: [] });
      }),
    );
    const ctx = createMockContext({ signal: abort.signal, errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ toptier_code: '075' });
    await expect(getAgencyTool.handler(input, ctx)).rejects.toBe(reason);
  });

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
        fiscal_year: 2025,
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

  it('returns the budget series from the live payload shape, and none when that request keeps failing (#111)', async () => {
    const overview = json(200, {
      toptier_code: '080',
      name: 'National Aeronautics and Space Administration',
    });
    const subAgency = json(200, {
      toptier_code: '080',
      fiscal_year: 2026,
      page_metadata: { page: 1, total: 1, limit: 10, hasNext: false },
      results: [{ name: 'National Aeronautics and Space Administration', total_obligations: 1 }],
    });
    // Rows as `agency/080/budgetary_resources/` answered them on 2026-11-12, trimmed to three years.
    stubRoutes({
      'agency/080/': overview,
      'agency/080/sub_agency/': subAgency,
      'agency/080/budgetary_resources/': json(200, {
        toptier_code: '080',
        agency_data_by_year: [
          {
            fiscal_year: 2027,
            agency_budgetary_resources: null,
            agency_total_obligated: null,
            agency_total_outlayed: null,
            total_budgetary_resources: null,
            agency_obligation_by_period: [],
          },
          {
            fiscal_year: 2026,
            agency_budgetary_resources: 44_028_063_933.25,
            agency_total_obligated: 22_854_576_671.2,
            agency_total_outlayed: 22_889_244_716.19,
            total_budgetary_resources: 16_181_198_695_809.91,
            agency_obligation_by_period: [
              { period: 10, obligated: 20_568_873_126.37 },
              { period: 11, obligated: 22_854_576_671.2 },
            ],
          },
          {
            fiscal_year: 2017,
            agency_budgetary_resources: 24_058_622_609.29,
            agency_total_obligated: 22_678_235_157.39,
            agency_total_outlayed: 21_465_276_363.26,
            total_budgetary_resources: 7_158_037_155_046.72,
            agency_obligation_by_period: [
              { period: 6, obligated: 1 },
              { period: 9, obligated: 2 },
              { period: 12, obligated: 3 },
            ],
          },
        ],
        messages: [],
      }),
    });

    const ok = await settle({ toptier_code: '080' });

    expect(ok.isError).toBeFalsy();
    const series = (ok.structuredContent as Record<string, unknown>).budget_by_fiscal_year as {
      fiscal_year: number;
      reported_through_period?: number;
    }[];
    expect(series.map((r) => [r.fiscal_year, r.reported_through_period])).toEqual([
      [2026, 11],
      [2017, 12],
    ]);

    const fetchMock = stubRoutes({
      'agency/080/': overview,
      'agency/080/sub_agency/': subAgency,
      'agency/080/budgetary_resources/': () => new Response('', { status: 503 }),
    });

    const failed = await settle({ toptier_code: '080' });

    expect(failed.isError).toBeFalsy();
    const sc = failed.structuredContent as Record<string, unknown>;
    expect(sc.name).toBe('National Aeronautics and Space Administration');
    expect(sc).not.toHaveProperty('budget_by_fiscal_year');
    expect(sc.unavailable_sections).toEqual([
      expect.objectContaining({ section: 'budgetary_resources', reason: 'api_unavailable' }),
    ]);
    expect(
      pathsCalled(fetchMock).filter((p) => p === 'agency/080/budgetary_resources/'),
    ).toHaveLength(4);
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
