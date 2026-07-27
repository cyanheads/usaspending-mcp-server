/**
 * @fileoverview Tests for spending-by-geography tool.
 * @module tests/tools/spending-by-geography.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';

const mockSpendingByGeography = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ spendingByGeography: mockSpendingByGeography }),
}));

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

    const ctx = createMockContext();
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.scope).toBe('place_of_performance');
    expect(result.geo_layer).toBe('state');
    expect(result.results).toHaveLength(2);
    // Ranked by aggregated_amount descending, so California leads despite arriving second.
    expect(result.results[0].shape_code).toBe('06');
    expect(result.results[0].display_name).toBe('California');
    expect(result.results[0].aggregated_amount).toBe(35_000_000_000);
    expect(result.results[1].display_name).toBe('Washington');
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = spendingByGeographyTool.input.parse({
      scope: 'place_of_performance',
      geo_layer: 'state',
    });
    const result = await spendingByGeographyTool.handler(input, ctx);

    expect(result.results[0].population).toBeUndefined();
    expect(result.results[0].per_capita).toBeUndefined();
    expect(result.results[0].aggregated_amount).toBe(4_500_000_000);
  });

  it('forwards subawards=true to service', async () => {
    mockSpendingByGeography.mockResolvedValueOnce({
      results: [{ shape_code: '53', display_name: 'Washington', aggregated_amount: 1_000_000 }],
    });

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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
