/**
 * @fileoverview Tests for spending-by-category tool.
 * @module tests/tools/spending-by-category.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';

const mockSpendingByCategory = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ spendingByCategory: mockSpendingByCategory }),
}));

describe('spendingByCategoryTool', () => {
  it('returns NAICS breakdown results', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        {
          id: '541512',
          code: '541512',
          name: 'Computer Systems Design Services',
          amount: 2_000_000_000,
        },
        { id: '336411', code: '336411', name: 'Aircraft Manufacturing', amount: 1_500_000_000 },
      ],
      page_metadata: { hasNext: false, page: 1, total: 2, limit: 10 },
    });

    const ctx = createMockContext();
    const input = spendingByCategoryTool.input.parse({ category: 'naics', limit: 10 });
    const result = await spendingByCategoryTool.handler(input, ctx);

    expect(result.category).toBe('naics');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].code).toBe('541512');
    expect(result.results[0].name).toBe('Computer Systems Design Services');
    expect(result.results[0].amount).toBe(2_000_000_000);
    expect(result.page_metadata.has_next).toBe(false);
  });

  it('populates enrichment notice when no results found', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = spendingByCategoryTool.input.parse({ category: 'psc' });
    const result = await spendingByCategoryTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('psc');
  });

  it('populates enrichment with pagination context', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        { id: '541512', code: '541512', name: 'Computer Systems Design', amount: 2_000_000_000 },
      ],
      page_metadata: { hasNext: true, page: 1, total: 50, limit: 10 },
    });

    const ctx = createMockContext();
    const input = spendingByCategoryTool.input.parse({ category: 'naics', limit: 10 });
    await spendingByCategoryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(50);
    expect(enrichment.page).toBe(1);
    expect(enrichment.has_next).toBe(true);
  });

  it('throws when service call fails', async () => {
    mockSpendingByCategory.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({ category: 'awarding_agency' });
    await expect(spendingByCategoryTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes filters through to service', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [{ id: '097', code: '097', name: 'DoD', amount: 500_000_000 }],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = spendingByCategoryTool.input.parse({
      category: 'awarding_agency',
      filters: {
        time_period_start: '2023-01-01',
        time_period_end: '2023-12-31',
        award_type_codes: ['A', 'B'],
      },
      limit: 5,
    });
    await spendingByCategoryTool.handler(input, ctx);

    expect(mockSpendingByCategory).toHaveBeenCalledWith(
      'awarding_agency',
      expect.objectContaining({
        filters: expect.objectContaining({ award_type_codes: ['A', 'B'] }),
        limit: 5,
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_time_period_start).toBe('2023-01-01');
    expect(enrichment.applied_time_period_end).toBe('2023-12-31');
  });

  it('formats output with category codes and amounts', () => {
    const output = {
      category: 'naics',
      results: [
        {
          id: '541512',
          code: '541512',
          name: 'Computer Systems Design Services',
          amount: 2_000_000_000,
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = spendingByCategoryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('naics');
    expect(text).toContain('541512');
    expect(text).toContain('2,000,000,000');
    expect(text).toContain('Computer Systems Design Services');
  });

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // total=50 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      category: 'naics',
      results: [{ id: '541512', code: '541512', name: 'Computer Systems Design', amount: 1_234 }],
      page_metadata: { has_next: true, page: 1, total: 50, limit: 5 },
    };

    const text = (spendingByCategoryTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~50');
    expect(text).not.toContain(' of ~');
  });
});
