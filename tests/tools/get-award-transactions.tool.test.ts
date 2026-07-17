/**
 * @fileoverview Tests for get-award-transactions tool.
 * @module tests/tools/get-award-transactions.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getAwardTransactionsTool } from '@/mcp-server/tools/definitions/get-award-transactions.tool.js';

const mockGetAwardTransactions = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardTransactions: mockGetAwardTransactions }),
}));

describe('getAwardTransactionsTool', () => {
  it('returns transactions for a valid award ID', async () => {
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [
        {
          id: 1,
          type: 'D',
          type_description: 'Definitive Contract',
          action_date: '2023-01-15',
          action_type: 'A',
          action_type_description: 'Additional Work',
          federal_action_obligation: 250_000,
          modification_number: 'M0001',
          description: 'Scope increase',
          recipient_name: 'Acme Corp',
          awarding_agency_name: 'Department of Defense',
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = getAwardTransactionsTool.input.parse({ award_id: 'CONT_AWD_TEST' });
    const result = await getAwardTransactionsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_TEST');
    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe(1);
    expect(result.results[0].modification_number).toBe('M0001');
    expect(result.results[0].federal_action_obligation).toBe(250_000);
    expect(result.page_metadata.has_next).toBe(false);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.queried_award_id).toBe('CONT_AWD_TEST');
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.has_next_page).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('returns empty results for an award with no transactions', async () => {
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = getAwardTransactionsTool.input.parse({ award_id: 'CONT_AWD_EMPTY' });
    const result = await getAwardTransactionsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.page_metadata.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('transactions_count');
    expect(enrichment.notice).toContain('CONT_AWD_EMPTY');
  });

  it('throws when service call fails', async () => {
    mockGetAwardTransactions.mockRejectedValueOnce(new Error('Not found'));

    const ctx = createMockContext({ errors: getAwardTransactionsTool.errors });
    const input = getAwardTransactionsTool.input.parse({ award_id: 'INVALID' });
    await expect(getAwardTransactionsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes sort and pagination params through', async () => {
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 2, total: 15, limit: 5 },
    });

    const ctx = createMockContext();
    const input = getAwardTransactionsTool.input.parse({
      award_id: 'CONT_AWD_TEST',
      sort: 'federal_action_obligation',
      order: 'asc',
      limit: 5,
      page: 2,
    });
    await getAwardTransactionsTool.handler(input, ctx);

    expect(mockGetAwardTransactions).toHaveBeenCalledWith(
      expect.objectContaining({
        award_id: 'CONT_AWD_TEST',
        sort: 'federal_action_obligation',
        order: 'asc',
        limit: 5,
        page: 2,
      }),
      ctx,
    );
  });

  it('formats output with transaction details', () => {
    const output = {
      award_id: 'CONT_AWD_TEST',
      results: [
        {
          id: 42,
          type: 'D',
          type_description: 'Definitive Contract',
          action_date: '2023-06-01',
          action_type: 'A',
          action_type_description: 'Additional Work',
          federal_action_obligation: 100_000,
          modification_number: 'M0002',
          description: 'Scope change',
          recipient_name: 'Test Corp',
          awarding_agency_name: 'DoD',
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = getAwardTransactionsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CONT_AWD_TEST');
    expect(text).toContain('M0002');
    expect(text).toContain('100,000');
    expect(text).toContain('2023-06-01');
  });

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // total=48 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      award_id: 'CONT_AWD_TEST',
      results: [{ id: 42, modification_number: 'M0002', action_date: '2023-06-01' }],
      page_metadata: { has_next: true, page: 1, total: 48, limit: 8 },
    };

    const text = (getAwardTransactionsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~48');
    expect(text).not.toContain(' of ~');
  });
});
