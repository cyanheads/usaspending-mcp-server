/**
 * @fileoverview The seven nested input objects across the five filter-taking
 * tools — `usaspending_search_awards` `filters` / `time_period` /
 * `location_filter`, the `filters` of the three `usaspending_spending_*`
 * analytics tools, and `usaspending_disaster_spending` `filters`. Each case runs
 * through the tool's public contract (argument validation, handler, output
 * schema, `format()`, enrichment) with the service stubbed, so the request the
 * tool builds can be read back and a rejected call can be shown to send nothing.
 * @module tests/tools/nested-input-strict.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disasterSpendingTool } from '@/mcp-server/tools/definitions/disaster-spending.tool.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';

const svc = vi.hoisted(() => ({
  searchAwards: vi.fn(),
  spendingByCategory: vi.fn(),
  spendingByGeography: vi.fn(),
  spendingOverTime: vi.fn(),
  getDisasterOverview: vi.fn(),
  getDisasterByAgency: vi.fn(),
}));

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => svc,
}));

/** Every declared field of each analytics `filters` object, sent blank as a form client does. */
const BLANK_ANALYTICS_FILTERS = {
  keywords: [],
  award_type_codes: [],
  agency_name: '',
  recipient_id: '',
  naics_codes: [],
  assistance_listings: [],
  psc_codes: [],
  def_codes: [],
  time_period_start: '',
  time_period_end: '',
};

/** One row per analytics tool: how to call it, and the `filters` its request carried. */
const ANALYTICS = [
  {
    name: 'usaspending_spending_by_category',
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByCategoryTool, { category: 'naics', ...args }),
    sent: () => svc.spendingByCategory.mock.calls.at(-1)?.[1].filters as Record<string, unknown>,
    mock: svc.spendingByCategory,
  },
  {
    name: 'usaspending_spending_by_geography',
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingByGeographyTool, {
        scope: 'place_of_performance',
        geo_layer: 'state',
        ...args,
      }),
    sent: () => svc.spendingByGeography.mock.calls.at(-1)?.[0].filters as Record<string, unknown>,
    mock: svc.spendingByGeography,
  },
  {
    name: 'usaspending_spending_over_time',
    run: (args: Record<string, unknown>) =>
      runToolContract(spendingOverTimeTool, { group: 'fiscal_year', ...args }),
    sent: () => svc.spendingOverTime.mock.calls.at(-1)?.[0].filters as Record<string, unknown>,
    mock: svc.spendingOverTime,
  },
] as const;

type AnalyticsCase = (typeof ANALYTICS)[number];

const searchRun = (args: Record<string, unknown>) =>
  runToolContract(searchAwardsTool, { limit: 5, ...args });
const searchSent = () => svc.searchAwards.mock.calls.at(-1)?.[0].filters as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  svc.searchAwards.mockResolvedValue({
    results: [{ 'Award ID': 'A1', generated_internal_id: 'CONT_AWD_A1' }],
    page_metadata: { hasNext: false, page: 1 },
  });
  svc.spendingByCategory.mockResolvedValue({
    results: [{ id: 1, code: '237310', name: 'Bridges', amount: 10 }],
    page_metadata: { hasNext: false, page: 1 },
  });
  svc.spendingByGeography.mockResolvedValue({
    results: [{ shape_code: 'WA', display_name: 'Washington', aggregated_amount: 10 }],
  });
  svc.spendingOverTime.mockResolvedValue({
    results: [{ time_period: { fiscal_year: '2024' }, aggregated_amount: 10 }],
  });
  svc.getDisasterOverview.mockResolvedValue({ total_budget_authority: 1, funding: [] });
  svc.getDisasterByAgency.mockResolvedValue({
    results: [{ id: '1', code: '097', description: 'DoD', obligation: 1 }],
    page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
  });
});

describe('Nested objects made only of declared keys keep working', () => {
  it('search_awards: the analytics-style filters object flows to the request (#21)', async () => {
    const result = await searchRun({
      filters: {
        keywords: ['solar'],
        award_type_codes: ['IDV_A', 'IDV_B'],
        agency_name: 'National Aeronautics and Space Administration',
        recipient_name: 'Boeing',
        naics_codes: ['541512'],
        time_period_start: '2023-01-01',
        time_period_end: '2023-12-31',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(searchSent()).toEqual({
      keywords: ['solar'],
      award_type_codes: ['IDV_A', 'IDV_B'],
      agencies: [
        {
          type: 'awarding',
          tier: 'toptier',
          name: 'National Aeronautics and Space Administration',
        },
        {
          type: 'awarding',
          tier: 'subtier',
          name: 'National Aeronautics and Space Administration',
        },
      ],
      recipient_search_text: ['Boeing'],
      naics_codes: { require: ['541512'] },
      time_period: [{ start_date: '2023-01-01', end_date: '2023-12-31' }],
    });
  });

  it('search_awards: every filters field blank sends only the flat award type default', async () => {
    const result = await searchRun({
      filters: {
        keywords: [],
        award_type_codes: [],
        agency_name: '',
        recipient_name: '',
        naics_codes: [],
        assistance_listings: [],
        psc_codes: [],
        def_codes: [],
        time_period_start: '',
        time_period_end: '',
      },
    });

    expect(result.isError).toBeFalsy();
    expect(searchSent()).toEqual({ award_type_codes: ['A', 'B', 'C', 'D'] });
  });

  it('search_awards: an empty filters.award_type_codes falls back to the flat value', async () => {
    const result = await searchRun({
      award_type_codes: ['02', '03'],
      filters: { award_type_codes: [] },
    });

    expect(result.isError).toBeFalsy();
    expect(searchSent()).toEqual({ award_type_codes: ['02', '03'] });
  });

  it('search_awards: an all-blank time_period is no date filter', async () => {
    const result = await searchRun({ time_period: { start_date: '', end_date: '' } });

    expect(result.isError).toBeFalsy();
    expect(searchSent()).not.toHaveProperty('time_period');
  });

  it('search_awards: a lone unpadded time_period date is padded and filled (#58, #62)', async () => {
    const result = await searchRun({ time_period: { start_date: '', end_date: '2024-1-5' } });

    expect(result.isError).toBeFalsy();
    expect(searchSent().time_period).toEqual([
      { start_date: '2007-10-01', end_date: '2024-01-05' },
    ]);
  });

  it('search_awards: an all-blank location_filter is no location filter', async () => {
    const result = await searchRun({
      location_filter: { country: '', state: '', county: '', city: '' },
    });

    expect(result.isError).toBeFalsy();
    expect(searchSent()).not.toHaveProperty('place_of_performance_locations');
  });

  it.each(ANALYTICS)(
    '$name: every filters field blank sends what omitting filters sends',
    async (tool: AnalyticsCase) => {
      await tool.run({});
      const omitted = tool.sent();

      const result = await tool.run({ filters: BLANK_ANALYTICS_FILTERS });

      expect(result.isError).toBeFalsy();
      expect(tool.sent()).toEqual(omitted);
    },
  );

  it.each(ANALYTICS)(
    '$name: a lone unpadded start is padded and filled (#58, #62)',
    async (tool: AnalyticsCase) => {
      const result = await tool.run({ filters: { time_period_start: '2024-1-5' } });

      expect(result.isError).toBeFalsy();
      expect(tool.sent().time_period).toEqual([
        { start_date: '2024-01-05', end_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
      ]);
    },
  );

  it('disaster_spending: blank def_codes and award_type_codes run the overview', async () => {
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'overview',
      filters: { def_codes: [], award_type_codes: [] },
    });

    expect(result.isError).toBeFalsy();
    expect(svc.getDisasterOverview).toHaveBeenCalledTimes(1);
  });

  it('disaster_spending: a blank award_type_codes is left out of the breakdown filter', async () => {
    const result = await runToolContract(disasterSpendingTool, {
      dimension: 'agency',
      filters: { def_codes: ['L'], award_type_codes: [] },
    });

    expect(result.isError).toBeFalsy();
    expect(svc.getDisasterByAgency.mock.calls.at(-1)?.[1].filter).toEqual({ def_codes: ['L'] });
  });
});

/** The rejection runToolContract returns for an undeclared nested key. */
interface Rejection {
  code: number;
  data: { reason: string; recovery: { hint: string } };
  message: string;
}

const rejectionOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  (result.structuredContent as { error: Rejection }).error;

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** Every service method a filter-taking tool calls — none may run on a rejected call. */
const ALL_CALLS = () => Object.values(svc).reduce((n, fn) => n + fn.mock.calls.length, 0);

/**
 * One case per nested object: the call carrying an undeclared key, the key's
 * full path, and a declared key the hint must list as accepted.
 */
const UNDECLARED = [
  {
    label: 'search_awards filters.recipient_id',
    run: () =>
      searchRun({ filters: { recipient_id: '00000000-0000-0000-0000-000000000000-R' }, limit: 1 }),
    path: 'filters.recipient_id',
    object: 'filters',
    accepted: 'recipient_name',
  },
  {
    label: 'search_awards location_filter.zip',
    run: () => searchRun({ location_filter: { state: 'WA', zip: '98101' } }),
    path: 'location_filter.zip',
    object: 'location_filter',
    accepted: 'county',
  },
  {
    label: 'search_awards time_period.fiscal_year beside valid dates',
    run: () =>
      searchRun({
        time_period: { start_date: '2024-01-01', end_date: '2024-12-31', fiscal_year: 2024 },
      }),
    path: 'time_period.fiscal_year',
    object: 'time_period',
    accepted: 'start_date',
  },
  ...ANALYTICS.flatMap((tool) => [
    {
      label: `${tool.name} filters.keyword`,
      run: () => tool.run({ filters: { keyword: ['zzqxnonexistentterm'] } }),
      path: 'filters.keyword',
      object: 'filters',
      accepted: 'keywords',
    },
    {
      label: `${tool.name} filters.recipient_name`,
      run: () => tool.run({ filters: { recipient_name: 'Boeing' } }),
      path: 'filters.recipient_name',
      object: 'filters',
      accepted: 'recipient_id',
    },
  ]),
  {
    label: 'disaster_spending filters.def_code',
    run: () => {
      const filters: Record<string, unknown> = { def_codes: ['L'], def_code: 'M' };
      return runToolContract(disasterSpendingTool, { dimension: 'agency', filters });
    },
    path: 'filters.def_code',
    object: 'filters',
    accepted: 'def_codes',
  },
];

describe('An undeclared nested key is rejected by path, before any request (#74)', () => {
  it.each(UNDECLARED)('$label', async ({ run, path, object, accepted }) => {
    const result = await run();

    expect(result.isError).toBe(true);
    const error = rejectionOf(result);
    expect(error.code).toBe(-32602);
    expect(error.data.reason).toBe('invalid_arguments');
    const key = path.slice(object.length + 1);
    expect(error.message).toContain(`${object}: Unrecognized key: "${key}"`);
    expect(error.data.recovery.hint).toContain(`Unknown key ${path}.`);
    expect(error.data.recovery.hint).toMatch(
      new RegExp(`${object} accepts: [^.]*\\b${accepted}\\b`),
    );
    expect(textOf(result)).toContain(path);
    expect(ALL_CALLS()).toBe(0);
  });
});
