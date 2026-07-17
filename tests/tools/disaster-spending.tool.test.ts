/**
 * @fileoverview Tests for disaster-spending tool.
 * @module tests/tools/disaster-spending.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { disasterSpendingTool } from '@/mcp-server/tools/definitions/disaster-spending.tool.js';

const mockGetDisasterOverview = vi.fn();
const mockGetDisasterByAgency = vi.fn();
const mockGetDisasterByCfda = vi.fn();
const mockGetDisasterByRecipient = vi.fn();
const mockGetDisasterByGeography = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getDisasterOverview: mockGetDisasterOverview,
    getDisasterByAgency: mockGetDisasterByAgency,
    getDisasterByCfda: mockGetDisasterByCfda,
    getDisasterByRecipient: mockGetDisasterByRecipient,
    getDisasterByGeography: mockGetDisasterByGeography,
  }),
}));

describe('disasterSpendingTool', () => {
  // Mocks are module-level; clear call history between tests so per-test call
  // indexing (mock.calls[0], mock.calls[1]) reflects only the current test.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns overview data for dimension=overview', async () => {
    mockGetDisasterOverview.mockResolvedValueOnce({
      total_budget_authority: 2_000_000_000_000,
      spending: {
        award_obligations: 1_800_000_000_000,
        award_outlays: 1_600_000_000_000,
        total_obligations: 1_900_000_000_000,
        total_outlays: 1_700_000_000_000,
        unobligated_balance: 100_000_000_000,
      },
      funding: [
        {
          def_code: 'L',
          label: 'CARES Act - Other',
          public_law: '116-136',
          amount: 500_000_000_000,
        },
        { def_code: 'M', label: 'CARES Act - FEMA', public_law: '116-136', amount: 45_000_000_000 },
      ],
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({ dimension: 'overview' });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('overview');
    expect(result.overview?.total_budget_authority).toBe(2_000_000_000_000);
    expect(result.overview?.award_obligations).toBe(1_800_000_000_000);
    expect(result.overview?.funding_by_def_code).toHaveLength(2);
    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_dimension).toBe('overview');
  });

  it('returns agency breakdown for dimension=agency', async () => {
    mockGetDisasterByAgency.mockResolvedValueOnce({
      results: [
        {
          id: '517',
          code: '097',
          description: 'Department of Defense',
          obligation: 200_000_000_000,
          outlay: 180_000_000_000,
          award_count: 10_000,
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'agency',
      spending_type: 'award',
      filters: { def_codes: ['L', 'M'] },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('agency');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('517');
    expect(result.results[0].name).toBe('Department of Defense');
    expect(result.results[0].obligation).toBe(200_000_000_000);
    expect(result.page_metadata?.has_next).toBe(false);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_dimension).toBe('agency');
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.has_next_page).toBe(false);
  });

  it('passes spending_type as body field for agency dimension', async () => {
    mockGetDisasterByAgency.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'agency',
      spending_type: 'total',
      filters: { def_codes: ['L'] },
    });
    await disasterSpendingTool.handler(input, ctx);

    // Service is called with 'total' as the spendingType arg (forwarded as body field in service)
    expect(mockGetDisasterByAgency).toHaveBeenCalledWith('total', expect.any(Object), ctx);
  });

  it('returns geography breakdown mapping the real amount field (issue #18)', async () => {
    // The disaster geography endpoint returns `amount` (not `aggregated_amount`) plus
    // population, per_capita, and award_count. Shape confirmed live against the v2 API.
    mockGetDisasterByGeography.mockResolvedValueOnce({
      geo_layer: 'state',
      scope: 'place_of_performance',
      spending_type: 'obligation',
      results: [
        {
          shape_code: 'CA',
          display_name: 'California',
          amount: 167_052_572_147.29,
          population: 39_538_223,
          per_capita: 4225.09,
          award_count: 2_655_932,
        },
        {
          shape_code: 'WA',
          display_name: 'Washington',
          amount: 20_000_000_000,
          population: 7_705_281,
          per_capita: 2595.6,
          award_count: 500_000,
        },
      ],
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'geography',
      filters: { def_codes: ['L', 'M', 'N', 'O', 'P'] },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('geography');
    expect(result.spending_type).toBe('obligation');
    expect(result.results).toHaveLength(2);
    // `amount` is surfaced as aggregated_amount; the phantom aggregated_amount is gone.
    expect(result.results[0].aggregated_amount).toBe(167_052_572_147.29);
    expect(result.results[0].population).toBe(39_538_223);
    expect(result.results[0].per_capita).toBe(4225.09);
    expect(result.results[0].award_count).toBe(2_655_932);
    expect(result.results[0].shape_code).toBe('CA');
    expect(result.results[0].display_name).toBe('California');

    // Without spending_type in the body the endpoint returns HTTP 422 — assert it is sent.
    const geoBody = mockGetDisasterByGeography.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(geoBody.spending_type).toBe('obligation');
    expect(geoBody.scope).toBe('place_of_performance');
    expect(geoBody.geo_layer).toBe('state');
  });

  it('ignores the phantom aggregated_amount field on geography rows (issue #18)', async () => {
    // A row carrying only the old (non-existent) aggregated_amount must not populate output —
    // the mapping reads `amount`, so a missing `amount` yields no value.
    mockGetDisasterByGeography.mockResolvedValueOnce({
      results: [{ shape_code: 'CA', display_name: 'California', aggregated_amount: 999 }],
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'geography',
      filters: { def_codes: ['L'] },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.results[0].aggregated_amount).toBeUndefined();
  });

  it('throws ValidationError when def_codes is omitted for non-overview dimension', async () => {
    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({ dimension: 'agency' });
    await expect(disasterSpendingTool.handler(input, ctx)).rejects.toMatchObject({
      message: expect.stringContaining('def_codes is required'),
    });
  });

  it('throws when service call fails (with def_codes present)', async () => {
    mockGetDisasterByAgency.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: disasterSpendingTool.errors });
    const input = disasterSpendingTool.input.parse({
      dimension: 'agency',
      filters: { def_codes: ['L'] },
    });
    await expect(disasterSpendingTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats overview output with budget totals', () => {
    const output = {
      dimension: 'overview',
      spending_type: 'spending',
      overview: {
        total_budget_authority: 2_000_000_000_000,
        award_obligations: 1_800_000_000_000,
        award_outlays: 1_600_000_000_000,
        total_obligations: 1_900_000_000_000,
        total_outlays: 1_700_000_000_000,
        unobligated_balance: 100_000_000_000,
        funding_by_def_code: [
          { def_code: 'L', label: 'CARES Act', public_law: '116-136', amount: 500_000_000_000 },
        ],
      },
      results: [],
    };

    const blocks = disasterSpendingTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('overview');
    expect(text).toContain('2,000,000,000,000');
    expect(text).toContain('CARES Act');
  });

  it('returns CFDA breakdown for dimension=cfda', async () => {
    mockGetDisasterByCfda.mockResolvedValueOnce({
      results: [
        {
          id: '301',
          code: '10.001',
          name: 'Agriculture Research',
          description: null,
          obligation: 50_000_000,
          outlay: 45_000_000,
          award_count: 120,
          face_value_of_loan: 0,
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'cfda',
      spending_type: 'award',
      filters: { def_codes: ['L', 'M'] },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('cfda');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('301');
    expect(result.results[0].code).toBe('10.001');
    expect(result.results[0].name).toBe('Agriculture Research');
    expect(result.results[0].obligation).toBe(50_000_000);
  });

  it('returns recipient breakdown with face_value_of_loan field', async () => {
    mockGetDisasterByRecipient.mockResolvedValueOnce({
      results: [
        {
          id: '501',
          code: null,
          name: 'Small Biz Corp',
          obligation: 0,
          outlay: 0,
          award_count: 1,
          face_value_of_loan: 350_000,
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'recipient',
      spending_type: 'award',
      filters: { def_codes: ['N'] },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('recipient');
    expect(result.results[0].face_value_of_loan).toBe(350_000);
    expect(result.results[0].name).toBe('Small Biz Corp');
  });

  it('passes def_codes filter in filter body', async () => {
    mockGetDisasterByAgency.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'agency',
      filters: { def_codes: ['L', 'M'] },
    });
    await disasterSpendingTool.handler(input, ctx);

    expect(mockGetDisasterByAgency).toHaveBeenCalledWith(
      'award',
      expect.objectContaining({ filter: { def_codes: ['L', 'M'] } }),
      ctx,
    );
  });

  it('uses county geo_layer filter and sends obligation spending_type (issue #18)', async () => {
    mockGetDisasterByGeography.mockResolvedValueOnce({
      results: [
        {
          shape_code: '06037',
          display_name: 'Los Angeles',
          amount: 40_408_945_418.74,
          population: 10_014_009,
          per_capita: 4035.24,
          award_count: 970_642,
        },
      ],
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'geography',
      filters: { def_codes: ['L'], geo_layer: 'county' },
    });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.results[0].shape_code).toBe('06037');
    expect(result.results[0].display_name).toBe('Los Angeles');
    expect(result.results[0].aggregated_amount).toBe(40_408_945_418.74);
    expect(mockGetDisasterByGeography).toHaveBeenCalledWith(
      expect.objectContaining({ geo_layer: 'county', spending_type: 'obligation' }),
      ctx,
    );
  });

  it('formats agency breakdown with all row fields', () => {
    const output = {
      dimension: 'agency',
      spending_type: 'spending',
      results: [
        {
          id: '517',
          code: '097',
          name: 'Department of Defense',
          display_name: 'DoD',
          shape_code: undefined,
          obligation: 200_000_000_000,
          outlay: 180_000_000_000,
          award_count: 10_000,
          face_value_of_loan: undefined,
          aggregated_amount: undefined,
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = disasterSpendingTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('517');
    expect(text).toContain('097');
    expect(text).toContain('200,000,000,000');
    expect(text).toContain('Page:');
  });

  it('nests pagination under a pagination key for agency (issue #19)', async () => {
    mockGetDisasterByAgency.mockResolvedValueOnce({
      results: [{ id: '882', obligation: 1_000, outlay: 900, award_count: 3 }],
      page_metadata: { hasNext: true, page: 2, total: 38, limit: 2 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'agency',
      spending_type: 'award',
      filters: { def_codes: ['L', 'M', 'N', 'O', 'P'] },
      limit: 2,
      page: 2,
    });
    await disasterSpendingTool.handler(input, ctx);

    // Top-level {limit,page} are ignored upstream; the fix nests them under `pagination`.
    const body = mockGetDisasterByAgency.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.pagination).toEqual({ page: 2, limit: 2 });
    expect(body.limit).toBeUndefined();
    expect(body.page).toBeUndefined();
  });

  it('nests pagination under a pagination key for cfda (issue #19)', async () => {
    mockGetDisasterByCfda.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: true, page: 3, total: 387, limit: 5 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'cfda',
      filters: { def_codes: ['L', 'M', 'N', 'O', 'P'] },
      limit: 5,
      page: 3,
    });
    await disasterSpendingTool.handler(input, ctx);

    const body = mockGetDisasterByCfda.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.pagination).toEqual({ page: 3, limit: 5 });
    expect(body.limit).toBeUndefined();
    expect(body.page).toBeUndefined();
  });

  it('nests pagination under a pagination key for recipient (issue #19)', async () => {
    mockGetDisasterByRecipient.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: true, page: 1, total: 10_000, limit: 2 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({
      dimension: 'recipient',
      spending_type: 'award',
      filters: { def_codes: ['N'] },
      limit: 2,
      page: 1,
    });
    await disasterSpendingTool.handler(input, ctx);

    const body = mockGetDisasterByRecipient.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(body.pagination).toEqual({ page: 1, limit: 2 });
    expect(body.limit).toBeUndefined();
    expect(body.page).toBeUndefined();
  });

  it('advances to distinct rows when the page changes (issue #19)', async () => {
    // Live API confirmed page 1 and page 2 return different row ids; assert the page number
    // flows through to the nested pagination body so upstream can advance.
    mockGetDisasterByAgency
      .mockResolvedValueOnce({
        results: [{ id: '882' }, { id: '95' }],
        page_metadata: { hasNext: true, page: 1, total: 38, limit: 2 },
      })
      .mockResolvedValueOnce({
        results: [{ id: '1132' }, { id: '11' }],
        page_metadata: { hasNext: true, page: 2, total: 38, limit: 2 },
      });

    const base = {
      dimension: 'agency' as const,
      spending_type: 'award' as const,
      filters: { def_codes: ['L', 'M', 'N', 'O', 'P'] },
      limit: 2,
    };
    const page1 = await disasterSpendingTool.handler(
      disasterSpendingTool.input.parse({ ...base, page: 1 }),
      createMockContext(),
    );
    const page2 = await disasterSpendingTool.handler(
      disasterSpendingTool.input.parse({ ...base, page: 2 }),
      createMockContext(),
    );

    const call1Body = mockGetDisasterByAgency.mock.calls[0]?.[1] as Record<string, unknown>;
    const call2Body = mockGetDisasterByAgency.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(call1Body.pagination).toEqual({ page: 1, limit: 2 });
    expect(call2Body.pagination).toEqual({ page: 2, limit: 2 });
    const ids1 = page1.results.map((r) => r.id);
    const ids2 = page2.results.map((r) => r.id);
    expect(ids1).toEqual(['882', '95']);
    expect(ids2).toEqual(['1132', '11']);
    expect(ids1).not.toEqual(ids2);
  });

  it('does not declare the unreachable no_data error contract (issue #35)', () => {
    const reasons = (disasterSpendingTool.errors ?? []).map((e) => e.reason);
    expect(reasons).not.toContain('no_data');
    // The valid, reachable contract stays.
    expect(reasons).toContain('api_unavailable');
  });

  it('empty-results message does not tell callers to remove required DEF codes (issue #35)', () => {
    const output = {
      dimension: 'agency',
      spending_type: 'award',
      results: [],
      page_metadata: { has_next: false, page: 1, total: 0, limit: 10 },
    };

    const blocks = disasterSpendingTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toMatch(/remov(e|ing) DEF/i);
    expect(text.toLowerCase()).toContain('no data found');
  });

  it('formats geography rows with population and per_capita columns (issue #18)', () => {
    const output = {
      dimension: 'geography',
      spending_type: 'obligation',
      results: [
        {
          shape_code: 'CA',
          display_name: 'California',
          aggregated_amount: 167_052_572_147,
          population: 39_538_223,
          per_capita: 4225,
          award_count: 2_655_932,
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 1 },
    };

    const blocks = disasterSpendingTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('California');
    expect(text).toContain('39,538,223'); // population rendered
    expect(text).toContain('4,225'); // per_capita rendered
    expect(text).toContain('167,052,572,147'); // aggregated_amount (from `amount`)
  });
});
