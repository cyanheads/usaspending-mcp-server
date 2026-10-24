/**
 * @fileoverview Tests for spending-by-geography tool.
 * @module tests/tools/spending-by-geography.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';

const mockSpendingByGeography = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ spendingByGeography: mockSpendingByGeography }),
}));

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

/** A `search/spending_by_geography/` state row exactly as the live endpoint returns it (FY2025 contracts). */
const LIVE_STATE_ROW = {
  shape_code: 'VA',
  display_name: 'Virginia',
  aggregated_amount: 120_579_333_436.23,
  population: 8_631_393,
  per_capita: 13_969.86,
};

describe('spendingByGeographyTool row fields (#82)', () => {
  it('wires both agency tiers and preserves the echo on an empty result', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: [] });
    const response = await runToolContract(spendingByGeographyTool, {
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: { agency_name: 'U.S. Geological Survey' },
    });
    expect(response.isError).toBeFalsy();
    expect(mockSpendingByGeography.mock.lastCall?.[0].filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'U.S. Geological Survey' },
      { type: 'awarding', tier: 'subtier', name: 'U.S. Geological Survey' },
    ]);
    expect(response.structuredContent).toMatchObject({
      results: [],
      applied_agency_name: 'U.S. Geological Survey',
    });
    expect(textOf(response)).toContain('U.S. Geological Survey');
  });
  it('advertises no award_count, which the endpoint never returns', () => {
    const rowShape = spendingByGeographyTool.output.shape.results.element.shape;
    expect(Object.keys(rowShape).sort()).toEqual(
      ['aggregated_amount', 'display_name', 'per_capita', 'population', 'shape_code'].sort(),
    );
  });

  it('passes a live row through the output schema and renders it without N/A placeholders', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: [LIVE_STATE_ROW] });

    const result = await runToolContract(spendingByGeographyTool, {
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: {
        award_type_codes: ['A', 'B', 'C', 'D'],
        time_period_start: '2024-10-01',
        time_period_end: '2025-09-30',
      },
    });

    expect(result.isError).toBeFalsy();
    const row = (result.structuredContent as { results: Record<string, unknown>[] }).results[0];
    expect(row).toEqual(LIVE_STATE_ROW);
    const text = textOf(result);
    expect(text).not.toContain('N/A');
    expect(text).not.toContain('Awards');
    expect(text).toContain('| Virginia | VA | $120,579,333,436.23 | 8,631,393 | $13,969.86 |');
  });
});

describe('spendingByGeographyTool', () => {
  it('returns state-level spending results', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [
        {
          shape_code: '53',
          display_name: 'Washington',
          aggregated_amount: 4_500_000_000,
          population: 7_900_000,
          per_capita: 569.62,
          award_count: 12_500,
        },
        {
          shape_code: '06',
          display_name: 'California',
          aggregated_amount: 35_000_000_000,
          population: 39_500_000,
          per_capita: 885.95,
          award_count: 95_000,
        },
      ],
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.scope).toBe('place_of_performance');
    expect(result.geo_layer).toBe('state');
    expect(result.results).toHaveLength(2);
    // Ranked by aggregated_amount descending, so California leads despite arriving second.
    expect(result.results[0]!.shape_code).toBe('06');
    expect(result.results[0]!.display_name).toBe('California');
    expect(result.results[0]!.aggregated_amount).toBe(35_000_000_000);
    expect(result.results[1]!.display_name).toBe('Washington');
    expect(result.total).toBe(2);
    expect(result.total_areas_available).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_scope).toBe('place_of_performance');
    expect(enrichment.applied_geo_layer).toBe('state');
    expect(enrichment.area_count).toBe(2);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('returns structured empty response with notice when API returns no results', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: { keywords: ['nonexistent_xyz'] },
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.scope).toBe('place_of_performance');
    expect(result.geo_layer).toBe('state');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.area_count).toBe(0);
    expect(enrichment.notice).toContain('No spending data matched');
    expect(enrichment.applied_keywords).toBe('nonexistent_xyz');
  });

  it('throws when service call fails', async () => {
    mockSpendingByGeography.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'recipient_location',
      geo_layer: 'county',
    });
    await expect(spendingByGeographyTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles sparse geographic results — no per_capita or population', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [
        {
          shape_code: '53',
          display_name: 'Washington',
          aggregated_amount: 4_500_000_000,
          // population and per_capita omitted
        },
      ],
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.results[0]!.population).toBeUndefined();
    expect(result.results[0]!.per_capita).toBeUndefined();
    expect(result.results[0]!.aggregated_amount).toBe(4_500_000_000);
  });

  it('forwards subawards=true to service', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [{ shape_code: '53', display_name: 'Washington', aggregated_amount: 1_000_000 }],
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
      subawards: true,
    });
    await spendingByGeographyTool.handler(input, ctx);

    expect(mockSpendingByGeography).toHaveBeenCalledWith(
      expect.objectContaining({ subawards: true }),
      ctx,
    );
  });

  it('ranks by obligation and caps at limit, disclosing what was withheld', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: Array.from({ length: 200 }, (_, i) => ({
        shape_code: String(i).padStart(5, '0'),
        display_name: `County ${i}`,
        aggregated_amount: i * 1_000_000,
      })),
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'county',
      filters: { keywords: ['cyber'] },
      limit: 3,
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.results).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.total_areas_available).toBe(200);
    expect(result.results.map((r) => r.aggregated_amount)).toEqual([
      199_000_000, 198_000_000, 197_000_000,
    ]);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(3);
    expect(enrichment.cap).toBe(3);
    expect(enrichment.truncationCeiling).toBe(197_000_000);
    expect(enrichment.notice).toContain('3 highest-obligation areas of 200');
  });

  it('defaults to 50 areas when no limit is supplied', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: Array.from({ length: 120 }, (_, i) => ({
        shape_code: String(i),
        display_name: `County ${i}`,
        aggregated_amount: i,
      })),
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'county',
      filters: { keywords: ['cyber'] },
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.results).toHaveLength(50);
    expect(result.total_areas_available).toBe(120);
  });

  it('sends the complete award-type-code set when no filters are supplied', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [{ shape_code: '53', display_name: 'Washington', aggregated_amount: 1_000_000 }],
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
    });
    await spendingByGeographyTool.handler(input, ctx);

    const sentFilters = mockSpendingByGeography.mock.calls.at(-1)?.[0].filters as {
      award_type_codes?: string[];
    };
    // The endpoint answers HTTP 500 to `filters: {}`.
    expect(Object.keys(sentFilters)).not.toHaveLength(0);
    // Contracts-only (A/B/C/D) would undercount total obligations by roughly 85%.
    expect(sentFilters.award_type_codes).toEqual(
      expect.arrayContaining(['A', 'D', 'IDV_A', '02', '05', '06', '07', '09', '10', '11', '-1']),
    );
    expect(getEnrichment(ctx).applied_award_type_default).toContain('complete set');
  });

  it('leaves a caller-supplied filter set untouched', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [{ shape_code: '53', display_name: 'Washington', aggregated_amount: 1_000_000 }],
    });

    const ctx = createMockContext({ errors: spendingByGeographyTool.errors });
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
      filters: { time_period_start: '2023-10-01', time_period_end: '2024-09-30' },
    });
    await spendingByGeographyTool.handler(input, ctx);

    const sentFilters = mockSpendingByGeography.mock.calls.at(-1)?.[0].filters as Record<
      string,
      unknown
    >;
    expect(sentFilters.award_type_codes).toBeUndefined();
    expect(sentFilters.time_period).toEqual([{ start_date: '2023-10-01', end_date: '2024-09-30' }]);
    expect(getEnrichment(ctx).applied_award_type_default).toBeUndefined();
  });

  it('formats output with area names and spending amounts', () => {
    const output = {
      scope: 'place_of_performance',
      geo_layer: 'state',
      results: [
        {
          shape_code: '53',
          display_name: 'Washington',
          aggregated_amount: 4_500_000_000,
          population: 7_900_000,
          per_capita: 569.62,
          award_count: 12_500,
        },
      ],
      total: 1,
      total_areas_available: 57,
    };

    const blocks = spendingByGeographyTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('1 of 57 matched');
    expect(text).toContain('Washington');
    expect(text).toContain('53');
    expect(text).toContain('4,500,000,000');
    expect(text).toContain('place_of_performance');
    expect(text).toContain('state');
  });
});

/**
 * The county aggregate behind #72's reproduction, condensed: 700 counties where
 * Wayne County, NY (36117) ranks 601st, so it sits past the 500-area cap.
 */
const COUNTY_AGGREGATE = Array.from({ length: 700 }, (_, i) => {
  const rank = i + 1;
  if (rank === 601) {
    return {
      shape_code: '36117',
      display_name: 'Wayne County',
      aggregated_amount: 404_539.84,
      population: 91_283,
      per_capita: 4.43,
    };
  }
  if (rank === 40) {
    return {
      shape_code: '06037',
      display_name: 'Los Angeles County',
      aggregated_amount: 11_521_232.46,
      population: 10_014_009,
      per_capita: 1.15,
    };
  }
  return {
    shape_code: String(10_000 + rank).padStart(5, '0'),
    display_name: `County ${rank}`,
    aggregated_amount: 1_000_000_000 - rank * 1_000_000,
  };
}).reverse();

const DOI_FY2025 = {
  award_type_codes: ['A', 'B', 'C', 'D'],
  agency_name: 'Department of the Interior',
  time_period_start: '2024-10-01',
  time_period_end: '2025-09-30',
};

const runGeo = (args: Record<string, unknown>) =>
  runToolContract(spendingByGeographyTool, {
    scope: 'place_of_performance',
    geo_layer: 'county',
    filters: DOI_FY2025,
    ...args,
  });

type GeoStructured = {
  results: { shape_code?: string; display_name?: string; aggregated_amount?: number }[];
  total: number;
  total_areas_available: number;
  applied_shape_codes?: string;
  notice?: string;
  truncated?: boolean;
  shown?: number;
  cap?: number;
};
const structuredOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.structuredContent as GeoStructured;

describe('spendingByGeographyTool without shape_codes (pre-#72 behavior)', () => {
  it('sends only scope, geo_layer, filters, and subawards upstream', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    await runGeo({ limit: 500 });
    const [request] = mockSpendingByGeography.mock.calls.at(-1)!;
    expect(Object.keys(request).sort()).toEqual(['filters', 'geo_layer', 'scope', 'subawards']);
  });

  it('caps the ranked aggregate at limit and counts every match', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const result = await runGeo({ limit: 500 });
    const sc = structuredOf(result);
    expect(sc.results).toHaveLength(500);
    expect(sc.total_areas_available).toBe(700);
    expect(sc.results.some((r) => r.shape_code === '36117')).toBe(false);
    expect(sc.applied_shape_codes).toBeUndefined();
    expect(sc.truncated).toBe(true);
  });
});

describe('spendingByGeographyTool shape_codes (#72)', () => {
  it('retrieves an area ranked past the cap, keeping total_areas_available the full count', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const result = await runGeo({ limit: 500, shape_codes: ['36117'] });

    expect(result.isError).toBeFalsy();
    const sc = structuredOf(result);
    expect(sc.results).toEqual([
      {
        shape_code: '36117',
        display_name: 'Wayne County',
        aggregated_amount: 404_539.84,
        population: 91_283,
        per_capita: 4.43,
      },
    ]);
    expect(sc.total).toBe(1);
    expect(sc.total_areas_available).toBe(700);
    expect(sc.applied_shape_codes).toBe('36117');
    expect(sc.truncated).toBeUndefined();
    expect(sc.notice).toBeUndefined();
    const text = textOf(result);
    expect(text).toContain('| Wayne County | 36117 | $404,539.84 | 91,283 | $4.43 |');
    expect(text).toContain('1 of 700 matched');
    expect(text).toContain('36117');
  });

  it('selects client-side: the upstream request is identical with or without shape_codes', async () => {
    mockSpendingByGeography.mockReset();
    mockSpendingByGeography.mockResolvedValue({ results: COUNTY_AGGREGATE });
    await runGeo({ limit: 500 });
    await runGeo({ limit: 500, shape_codes: ['36117'] });
    const calls = [...mockSpendingByGeography.mock.calls];
    mockSpendingByGeography.mockReset();
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toEqual(calls[0]![0]);
  });

  it.each([
    {
      layer: 'state',
      codes: ['NY'],
      rows: [
        { shape_code: 'CA', display_name: 'California', aggregated_amount: 9 },
        { shape_code: 'NY', display_name: 'New York', aggregated_amount: 5 },
      ],
      expected: ['NY'],
    },
    {
      layer: 'county',
      codes: ['36117', '06037'],
      rows: COUNTY_AGGREGATE,
      expected: ['06037', '36117'],
    },
    {
      layer: 'district',
      codes: ['3623', '5600'],
      rows: [
        { shape_code: '3623', display_name: 'NY-23', aggregated_amount: 11_914_933.63 },
        { shape_code: '0612', display_name: 'CA-12', aggregated_amount: 500_000_000 },
        { shape_code: '5600', display_name: 'WY-00', aggregated_amount: 122_731_368.53 },
      ],
      expected: ['5600', '3623'],
    },
  ])(
    'selects $layer areas by their own code form, ranked by amount',
    async ({ layer, codes, rows, expected }) => {
      mockSpendingByGeography.mockResolvedValueOnce({ results: rows });
      const result = await runGeo({ geo_layer: layer, shape_codes: codes });
      const sc = structuredOf(result);
      expect(sc.results.map((r) => r.shape_code)).toEqual(expected);
      expect(sc.total_areas_available).toBe(rows.length);
      expect(sc.notice).toBeUndefined();
    },
  );

  it('matches a lowercase state postal code', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [
        { shape_code: 'NY', display_name: 'New York', aggregated_amount: 5 },
        { shape_code: 'CA', display_name: 'California', aggregated_amount: 9 },
      ],
    });
    const sc = structuredOf(await runGeo({ geo_layer: 'state', shape_codes: ['ny'] }));
    expect(sc.results.map((r) => r.shape_code)).toEqual(['NY']);
    expect(sc.applied_shape_codes).toBe('NY');
  });

  it('names a listed code that matches no area instead of dropping it', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const result = await runGeo({ shape_codes: ['36117', '99999'] });
    const sc = structuredOf(result);
    expect(sc.results.map((r) => r.shape_code)).toEqual(['36117']);
    // Only the unmatched code is listed; the matched 36117 is not.
    expect(sc.notice).toContain('shape_codes 99999 matched no county area');
    expect(textOf(result)).toContain('shape_codes 99999 matched no county area');
  });

  it('names every code when none matches, without blaming the filters', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [{ shape_code: 'NY', display_name: 'New York', aggregated_amount: 5 }],
    });
    const result = await runGeo({ geo_layer: 'state', shape_codes: ['36117', '3623'] });
    const sc = structuredOf(result);
    expect(sc.results).toEqual([]);
    expect(sc.total).toBe(0);
    expect(sc.total_areas_available).toBe(1);
    expect(sc.notice).toContain('36117, 3623');
    expect(sc.notice).toContain('2-letter postal code');
    expect(sc.notice).not.toContain('No spending data matched the filters');
  });

  it('still reports an empty aggregate as a filter miss', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: [] });
    const sc = structuredOf(await runGeo({ shape_codes: ['36117'] }));
    expect(sc.results).toEqual([]);
    expect(sc.total_areas_available).toBe(0);
    expect(sc.notice).toContain('No spending data matched the filters');
    expect(sc.notice).toContain('36117');
  });

  it('ranks the selected areas and caps them at limit', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const codes = ['36117', '06037', '10001', '10002', '10650'];
    const result = await runGeo({ shape_codes: codes, limit: 2 });
    const sc = structuredOf(result);
    expect(sc.results.map((r) => r.shape_code)).toEqual(['10001', '10002']);
    expect(sc.total).toBe(2);
    expect(sc.total_areas_available).toBe(700);
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(2);
    expect(sc.cap).toBe(2);
    expect(sc.notice).toContain('2 highest-obligation of the 5 selected areas');
    expect(sc.notice).toContain('Raise limit');
  });

  it.each([
    { label: 'an empty list', shape_codes: [] },
    {
      label: '501 codes',
      shape_codes: Array.from({ length: 501 }, (_, i) => String(i).padStart(5, '0')),
    },
    { label: 'a place name', shape_codes: ['Wayne County'] },
    { label: 'a blank code', shape_codes: [''] },
  ])('rejects $label before any request is sent', async ({ shape_codes }) => {
    mockSpendingByGeography.mockClear();
    const result = await runGeo({ shape_codes });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('shape_codes');
    // A declared field failing its own bound, not an undeclared key.
    expect(textOf(result)).not.toContain('Unrecognized key');
    expect(mockSpendingByGeography).not.toHaveBeenCalled();
  });

  it('accepts 500 codes', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const shape_codes = COUNTY_AGGREGATE.slice(0, 500).map((r) => r.shape_code);
    const result = await runGeo({ shape_codes, limit: 500 });
    expect(result.isError).toBeFalsy();
    expect(structuredOf(result).results).toHaveLength(500);
  });
});

describe('spendingByGeographyTool truncation guidance (#72)', () => {
  it('at limit 500, names shape_codes and does not suggest raising limit', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const sc = structuredOf(await runGeo({ limit: 500 }));
    expect(sc.notice).toContain('500 highest-obligation areas of 700');
    expect(sc.notice).toContain('shape_codes');
    expect(sc.notice).not.toMatch(/raise limit/i);
  });

  it('below 500, offers both raising limit and shape_codes', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({ results: COUNTY_AGGREGATE });
    const sc = structuredOf(await runGeo({ limit: 10 }));
    expect(sc.notice).toContain('Raise limit (max 500)');
    expect(sc.notice).toContain('shape_codes');
  });
});
