/**
 * @fileoverview Tests for get-award-subawards tool.
 * @module tests/tools/get-award-subawards.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getAwardSubawardsTool } from '@/mcp-server/tools/definitions/get-award-subawards.tool.js';

const mockGetAwardSubawards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardSubawards: mockGetAwardSubawards }),
}));

describe('getAwardSubawardsTool', () => {
  it('returns subawards for a valid award ID', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [
        {
          id: 1,
          subaward_number: 'SUB-001',
          description: 'Subcontract for hardware',
          action_date: '2023-03-01',
          amount: 150_000,
          recipient_name: 'SubCo LLC',
          recipient_uei: 'SUBUEIAAAAA',
          place_of_performance: {
            city_name: 'Portland',
            state_code: 'OR',
            country_code: 'USA',
          },
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_PRIME_001' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_PRIME_001');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].subaward_number).toBe('SUB-001');
    expect(result.results[0].amount).toBe(150_000);
    expect(result.results[0].recipient_name).toBe('SubCo LLC');
    expect(result.results[0].place_of_performance?.city).toBe('Portland');
    expect(result.page_metadata.has_next).toBe(false);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.prime_award_id).toBe('CONT_AWD_PRIME_001');
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.has_next_page).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results for an award with no subawards', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_NO_SUBS' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('subaward_count');
    expect(enrichment.notice).toContain('CONT_AWD_NO_SUBS');
  });

  it('throws when service call fails', async () => {
    mockGetAwardSubawards.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getAwardSubawardsTool.errors });
    const input = getAwardSubawardsTool.input.parse({ award_id: 'INVALID' });
    await expect(getAwardSubawardsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles sparse subaward — place_of_performance omitted', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [
        {
          id: 2,
          subaward_number: 'SUB-002',
          amount: 75_000,
          recipient_name: 'AnotherCo',
          // place_of_performance omitted
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_SPARSE' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.results[0].place_of_performance).toBeUndefined();
    expect(result.results[0].amount).toBe(75_000);
  });

  it('formats output with subaward details', () => {
    const output = {
      award_id: 'CONT_AWD_PRIME',
      results: [
        {
          id: 1,
          subaward_number: 'SUB-001',
          description: 'Hardware subcontract',
          action_date: '2023-03-01',
          amount: 50_000,
          recipient_name: 'SubCo LLC',
          recipient_uei: 'SUBUEI12345',
          place_of_performance: { city: 'Portland', state: 'OR', country: 'USA' },
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = getAwardSubawardsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CONT_AWD_PRIME');
    expect(text).toContain('SUB-001');
    expect(text).toContain('50,000');
    expect(text).toContain('SubCo LLC');
  });
});
