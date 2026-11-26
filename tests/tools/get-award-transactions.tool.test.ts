/**
 * @fileoverview Tests for get-award-transactions tool.
 * @module tests/tools/get-award-transactions.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAwardTransactionsTool } from '@/mcp-server/tools/definitions/get-award-transactions.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockGetAwardTransactions = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardTransactions: mockGetAwardTransactions }),
}));

/**
 * Wiring of the shared count-limit mechanism (full table in
 * tests/tools/count-limit.test.ts). The cap is the upstream's 5,000-row page maximum
 * (#129); 5,001 answers HTTP 422 upstream.
 */
describe('limit above the 5,000 cap (#99, #129)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetAwardTransactions.mockReset();
  });

  const raw = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');

  it('sends limit 5000 upstream unclamped and returns a whole 1,374-row award on one page', async () => {
    const rows = Array.from({ length: 1374 }, (_, i) => ({ id: `CONT_TX_${i}` }));
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: rows,
      page_metadata: { hasNext: false, page: 1 },
    });

    const result = await runToolContract(getAwardTransactionsTool, {
      award_id: 'CONT_AWD_TEST',
      limit: 5000,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAwardTransactions.mock.calls[0]?.[0]).toMatchObject({ limit: 5000, page: 1 });
    const structured = result.structuredContent as { results: unknown[] };
    expect(structured.results).toHaveLength(1374);
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 5000, has_next: false },
      has_next_page: false,
    });
    expect(result.structuredContent).not.toHaveProperty('limitClamp');
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(raw(result)).toContain('**Per page:** 5000');
    expect(raw(result)).not.toContain('Limit clamp');
    expect(markdownText(raw(result))).toContain('CONT_TX_1373');
  });

  it('reads limit 5001 as 5000: the request, page_metadata.limit, limitClamp, and the notice on both surfaces', async () => {
    const rows = Array.from({ length: 5000 }, (_, i) => ({ id: `CONT_TX_${i}` }));
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: rows,
      page_metadata: { hasNext: true, page: 1 },
    });

    const result = await runToolContract(getAwardTransactionsTool, {
      award_id: 'CONT_AWD_TEST',
      limit: 5001,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAwardTransactions.mock.calls[0]?.[0]).toMatchObject({ limit: 5000, page: 1 });
    const structured = result.structuredContent as { results: unknown[] };
    expect(structured.results).toHaveLength(5000);
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 5000, has_next: true },
      limitClamp: { field: 'limit', requested: 5001, applied: 5000 },
      notice: 'limit 5001 exceeds the per-call maximum of 5000; this call used limit 5000.',
    });
    expect(raw(result)).toContain('**Per page:** 5000');
    expect(raw(result)).toContain('**Limit clamp:** `limit` requested 5001, applied 5000');
    expect(markdownText(raw(result))).toContain(
      'limit 5001 exceeds the per-call maximum of 5000; this call used limit 5000.',
    );
  });

  it('accepts every limit from the former 100 and 2,000 caps up to 5000 with no clamp', async () => {
    for (const limit of [101, 2000, 2001, 4999, 5000]) {
      mockGetAwardTransactions.mockResolvedValueOnce({
        results: [{ id: 'CONT_TX_1' }],
        page_metadata: { hasNext: false, page: 1 },
      });

      const result = await runToolContract(getAwardTransactionsTool, { award_id: 'X', limit });

      expect(result.isError, `limit ${limit}`).toBeFalsy();
      expect(mockGetAwardTransactions.mock.lastCall?.[0]).toMatchObject({ limit });
      expect(result.structuredContent, `limit ${limit}`).toMatchObject({
        page_metadata: { limit },
      });
      expect(result.structuredContent).not.toHaveProperty('limitClamp');
    }
  });

  it('keeps the clamp sentence beside the empty-page notice', async () => {
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1 },
    });

    const result = await runToolContract(getAwardTransactionsTool, {
      award_id: 'CONT_AWD_EMPTY',
      limit: 5001,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('limit 5001 exceeds the per-call maximum of 5000');
    expect(notice).toContain('generated_internal_id');
  });

  it('advertises no maximum by default, and maximum 5000 with rejection above it under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(getAwardTransactionsTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Transactions per page. Default 10, at most 5,000 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/get-award-transactions.tool.js'))
          .getAwardTransactionsTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 5000 });
    const rejected = await runToolContract(strict, { award_id: 'X', limit: 5001 });
    expect(rejected.isError).toBe(true);
    expect(raw(rejected)).toContain('Too big: expected number to be <=5000');
    expect(mockGetAwardTransactions).not.toHaveBeenCalled();

    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [{ id: 'CONT_TX_1' }],
      page_metadata: { hasNext: false, page: 1 },
    });
    const atCap = await runToolContract(strict, { award_id: 'X', limit: 5000 });
    expect(atCap.isError).toBeFalsy();
    expect(mockGetAwardTransactions.mock.lastCall?.[0]).toMatchObject({ limit: 5000 });
  });
});

describe('getAwardTransactionsTool', () => {
  it('returns transactions for a valid award ID', async () => {
    mockGetAwardTransactions.mockResolvedValueOnce({
      results: [
        {
          id: 'CONT_TX_9700_TEST_0',
          type: 'D',
          type_description: 'Definitive Contract',
          action_date: '2023-01-15',
          action_type: 'A',
          action_type_description: 'Additional Work',
          federal_action_obligation: 250_000,
          modification_number: 'M0001',
          description: 'Scope increase',
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: getAwardTransactionsTool.errors });
    const input = getAwardTransactionsTool.input.parse({ award_id: 'CONT_AWD_TEST' });
    const result = await getAwardTransactionsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_TEST');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('CONT_TX_9700_TEST_0');
    expect(result.results[0]!.modification_number).toBe('M0001');
    expect(result.results[0]!.federal_action_obligation).toBe(250_000);
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

    const ctx = createMockContext({ errors: getAwardTransactionsTool.errors });
    const input = getAwardTransactionsTool.input.parse({ award_id: 'CONT_AWD_EMPTY' });
    const result = await getAwardTransactionsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.page_metadata.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    // #12: notice must not cite transactions_count (absent from the live award endpoint);
    // it points to the generated_internal_id from usaspending_search_awards instead.
    expect(enrichment.notice).not.toContain('transactions_count');
    expect(enrichment.notice).toContain('generated_internal_id');
    expect(enrichment.notice).toContain('CONT_AWD_EMPTY');
  });

  it('declares no not-found reason — the upstream gives no such signal', () => {
    // A declared reason that can never fire is an unreachable recovery contract.
    const reasons = (getAwardTransactionsTool.errors ?? []).map((e) => e.reason);
    expect(reasons).toEqual(['api_unavailable', 'api_timeout']);
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

    const ctx = createMockContext({ errors: getAwardTransactionsTool.errors });
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
          id: 'CONT_TX_9700_TEST_M0002',
          type: 'D',
          type_description: 'Definitive Contract',
          action_date: '2023-06-01',
          action_type: 'A',
          action_type_description: 'Additional Work',
          federal_action_obligation: 100_000,
          modification_number: 'M0002',
          description: 'Scope change',
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
      results: [
        { id: 'CONT_TX_9700_TEST_M0002', modification_number: 'M0002', action_date: '2023-06-01' },
      ],
      page_metadata: { has_next: true, page: 1, total: 48, limit: 8 },
    };

    const text = (getAwardTransactionsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~48');
    expect(text).not.toContain(' of ~');
  });
});
