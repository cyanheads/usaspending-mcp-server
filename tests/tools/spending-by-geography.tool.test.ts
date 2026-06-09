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
    expect(result.results[0].shape_code).toBe('53');
    expect(result.results[0].display_name).toBe('Washington');
    expect(result.results[0].aggregated_amount).toBe(4_500_000_000);
    expect(result.total).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_scope).toBe('place_of_performance');
    expect(enrichment.applied_geo_layer).toBe('state');
    expect(enrichment.area_count).toBe(2);
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
    };

    const blocks = spendingByGeographyTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Washington');
    expect(text).toContain('53');
    expect(text).toContain('4,500,000,000');
    expect(text).toContain('place_of_performance');
    expect(text).toContain('state');
  });
});
