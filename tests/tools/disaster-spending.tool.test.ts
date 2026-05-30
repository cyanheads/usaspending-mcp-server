/**
 * @fileoverview Tests for disaster-spending tool.
 * @module tests/tools/disaster-spending.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
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
    expect(enrichment.result_total).toBe(1);
    expect(enrichment.has_next_page).toBe(false);
  });

  it('passes spending_type as body field for agency dimension', async () => {
    mockGetDisasterByAgency.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({ dimension: 'agency', spending_type: 'total' });
    await disasterSpendingTool.handler(input, ctx);

    // Service is called with 'total' as the spendingType arg (forwarded as body field in service)
    expect(mockGetDisasterByAgency).toHaveBeenCalledWith('total', expect.any(Object), ctx);
  });

  it('returns geography breakdown for dimension=geography', async () => {
    mockGetDisasterByGeography.mockResolvedValueOnce({
      results: [
        { shape_code: '53', display_name: 'Washington', aggregated_amount: 2_000_000_000 },
        { shape_code: '06', display_name: 'California', aggregated_amount: 15_000_000_000 },
      ],
    });

    const ctx = createMockContext();
    const input = disasterSpendingTool.input.parse({ dimension: 'geography' });
    const result = await disasterSpendingTool.handler(input, ctx);

    expect(result.dimension).toBe('geography');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].shape_code).toBe('53');
    expect(result.results[0].display_name).toBe('Washington');
  });

  it('throws when service call fails', async () => {
    mockGetDisasterByAgency.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: disasterSpendingTool.errors });
    const input = disasterSpendingTool.input.parse({ dimension: 'agency' });
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
});
