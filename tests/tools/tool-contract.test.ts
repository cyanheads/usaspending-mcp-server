/**
 * @fileoverview Production-envelope conformance for the tool surface. The suites
 * in this directory call `handler()` and `format()` directly; this one drives
 * representative definitions through the full path a client sees — input parse,
 * handler, output parse, `format()`, enrichment merge, and the error envelope.
 *
 * That envelope is what the advertised `outputSchema` now declares: success
 * fields are optional, `error` is a declared member, and a failed call answers
 * with `structuredContent.error` alongside `content[]` rather than a rejected
 * result. Nothing else in this suite exercises it.
 * @module tests/tools/tool-contract.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import {
  createFetchMock,
  runToolContract,
  toolContractSuite,
} from '@cyanheads/mcp-ts-core/testing/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { disasterSpendingTool } from '@/mcp-server/tools/definitions/disaster-spending.tool.js';
import { getAwardTool } from '@/mcp-server/tools/definitions/get-award.tool.js';
import { listAgenciesTool } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { USASpendingService } from '@/services/usaspending/usaspending-service.js';

/**
 * The disaster tool runs on a real `USASpendingService` beneath a strict fetch
 * fake, so its error envelope comes out of the service's own classification —
 * the retry loop, the budget, and the contract tagging — rather than a stub.
 * Each case builds the service it needs.
 */
const upstream = vi.hoisted(() => ({ service: undefined as USASpendingService | undefined }));
const realService = () => {
  if (!upstream.service) throw new Error('Build upstream.service before calling the disaster tool');
  return upstream.service;
};

const KNOWN_AWARD_ID = 'CONT_AWD_FA862118F6251_9700';

const awardFixture = {
  generated_unique_award_id: KNOWN_AWARD_ID,
  piid: 'FA862118F6251',
  type: 'D',
  type_description: 'Definitive Contract',
  category: 'contract',
  description: 'IT services contract for cloud infrastructure',
  total_obligation: 5_000_000,
  total_outlay: 4_200_000,
  date_signed: '2018-06-01',
  period_of_performance: { start_date: '2018-07-01', end_date: '2023-06-30' },
  recipient: { recipient_name: 'Acme Corp', uei: 'AAAAAAAAAAAA' },
  awarding_agency: {
    toptier_agency: { name: 'Department of Defense', code: '097', slug: 'department-of-defense' },
  },
};

vi.mock('@/services/usaspending/usaspending-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/usaspending/usaspending-service.js')>()),
  getUSASpendingService: () => ({
    getDisasterOverview: (ctx: Context) => realService().getDisasterOverview(ctx),
    getDisasterByAgency: (
      spendingType: 'award' | 'total',
      body: Record<string, unknown>,
      ctx: Context,
    ) => realService().getDisasterByAgency(spendingType, body, ctx),
    listAgencies: vi.fn().mockResolvedValue({
      results: [
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 1_000_000_000,
          obligated_amount: 900_000_000,
          outlay_amount: 800_000_000,
        },
      ],
    }),
    /**
     * The upstream answers a nonexistent award with a miss status, which the
     * service maps to `undefined` so the declared not-found contract can fire.
     */
    getAward: vi.fn(async (awardId: string) =>
      awardId === KNOWN_AWARD_ID ? awardFixture : undefined,
    ),
    searchAwards: vi.fn().mockResolvedValue({
      results: [
        {
          'Award ID': 'DELP0000146',
          generated_internal_id: 'ASST_NON_DELP0000146_089',
          'Recipient Name': 'BLUEOVAL SK, LLC',
          'Award Amount': null,
          'Loan Value': 27_600_000_001,
          'Subsidy Cost': 167_256_001,
          'Issued Date': '2024-12-13',
        },
      ],
      page_metadata: { page: 1, hasNext: false },
    }),
    spendingOverTime: vi.fn().mockResolvedValue({
      results: [{ time_period: { fiscal_year: '2024' }, aggregated_amount: 10 }],
    }),
  }),
}));

toolContractSuite(searchAwardsTool, {
  success: [
    {
      name: 'returns loan rows with loan value, subsidy cost, and issue date on both paths',
      input: { award_type_codes: ['07', '08'], limit: 5 },
      expected: {
        results: [
          {
            award_id: 'DELP0000146',
            generated_internal_id: 'ASST_NON_DELP0000146_089',
            recipient_name: 'BLUEOVAL SK, LLC',
            loan_value: 27_600_000_001,
            subsidy_cost: 167_256_001,
            issued_date: '2024-12-13',
          },
        ],
      },
      assert: (result) => {
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text).toContain('**Loan Value:** $27,600,000,001');
        expect(text).toContain('**Subsidy Cost:** $167,256,001');
        expect(text).toContain('**Issued:** 2024-12-13');
      },
    },
  ],
  errors: [
    {
      name: 'rejects End Date on IDVs (#60)',
      input: { award_type_codes: ['IDV_A', 'IDV_B'], sort: 'End Date' },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'unsupported_sort',
    },
    {
      name: 'rejects assistance listings with the default contract codes (#61)',
      input: { assistance_listings: ['93.866'] },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'assistance_listings_type_mismatch',
    },
    {
      name: 'rejects an inverted time_period (#64)',
      input: { time_period: { start_date: '2024-12-31', end_date: '2024-01-01' } },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'date_range_inverted',
    },
  ],
});

toolContractSuite(spendingOverTimeTool, {
  success: [
    {
      name: 'accepts a one-day window',
      input: {
        group: 'fiscal_year',
        filters: { time_period_start: '2024-06-15', time_period_end: '2024-06-15' },
      },
      expected: { total_periods: 1 },
    },
  ],
  errors: [
    {
      name: 'rejects an inverted filters window (#64)',
      input: {
        group: 'fiscal_year',
        filters: { time_period_start: '2024-12-31', time_period_end: '2024-01-01' },
      },
      code: JsonRpcErrorCode.ValidationError,
      reason: 'date_range_inverted',
    },
  ],
});

toolContractSuite(listAgenciesTool, {
  success: [
    {
      name: 'returns the agency roster with its enrichment trailer',
      input: { sort: 'agency_name', order: 'asc' },
      expected: { total: 1 },
    },
  ],
});

toolContractSuite(getAwardTool, {
  success: [
    {
      name: 'returns award detail on both consumption paths',
      input: { award_id: KNOWN_AWARD_ID },
      expected: { generated_unique_award_id: KNOWN_AWARD_ID, category: 'contract' },
    },
  ],
  errors: [
    {
      name: 'reports an award that does not exist',
      input: { award_id: 'CONT_AWD_NOT_A_REAL_ID' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'award_not_found',
    },
  ],
});

describe('disasterSpendingTool through the real service', () => {
  const BASE = 'https://api.usaspending.gov/api/v2/';
  const http = createFetchMock();
  const build = (overrides: { timeoutMs: number; retryBudgetMs: number }) => {
    upstream.service = new USASpendingService({} as AppConfig, {} as StorageService, {
      baseUrl: BASE,
      ...overrides,
    });
  };
  const recoveryOf = (reason: string) =>
    disasterSpendingTool.errors?.find((e) => e.reason === reason)?.recovery;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

  beforeEach(() => {
    // Unrouted requests reject, so nothing here can reach the live API.
    http.reset();
    http.install();
  });

  afterEach(() => {
    http.restore();
    upstream.service = undefined;
    vi.useRealTimers();
  });

  it('answers an overview that outlasts the budget with api_timeout on both surfaces (#57)', async () => {
    http.route({
      method: 'GET',
      match: `${BASE}disaster/overview/`,
      respond: (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    });
    build({ timeoutMs: 60_000, retryBudgetMs: 100 });

    const result = await runToolContract(disasterSpendingTool, { dimension: 'overview' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        data: {
          reason: 'api_timeout',
          retryable: true,
          recovery: { hint: recoveryOf('api_timeout') },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain('within the 100ms request budget');
    expect(text).toContain(`Recovery: ${recoveryOf('api_timeout')}`);
    expect(text).toContain('(reason api_timeout · retryable)');
  });

  it('answers a breakdown the upstream keeps failing with api_unavailable on both surfaces (#57)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    http.route({
      method: 'POST',
      match: `${BASE}disaster/agency/spending/`,
      respond: () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
    });
    build({ timeoutMs: 60_000, retryBudgetMs: 60_000 });

    const pending = runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'] },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(http.calls).toHaveLength(4);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'api_unavailable',
          retryable: true,
          recovery: { hint: recoveryOf('api_unavailable') },
          status: 502,
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain(`Recovery: ${recoveryOf('api_unavailable')}`);
    expect(text).toContain('(reason api_unavailable · retryable)');
  });

  it('carries breakdown totals on both surfaces (#63)', async () => {
    http.route({
      method: 'POST',
      match: `${BASE}disaster/agency/spending/`,
      respond: Response.json({
        totals: { obligation: 2_000, outlay: 1_500, total_budgetary_resources: 3_000 },
        results: [
          {
            id: 1522,
            code: '077',
            description: 'U.S. International Development Finance Corporation',
            obligation: 20,
            outlay: 15,
            total_budgetary_resources: 30,
          },
        ],
        page_metadata: { page: 1, total: 39, limit: 1, hasNext: true },
      }),
    });
    build({ timeoutMs: 60_000, retryBudgetMs: 60_000 });

    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      spending_type: 'total',
      filters: { def_codes: ['L'] },
      limit: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      totals: { obligation: 2_000, outlay: 1_500, total_budgetary_resources: 3_000 },
      results: [{ total_budgetary_resources: 30 }],
    });
    expect(textOf(result)).toContain(
      '**Totals:** Obligation $2,000 · Outlay $1,500 · Budgetary Resources $3,000',
    );
  });
});
