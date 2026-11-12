/**
 * @fileoverview Tests for get-award-subawards tool.
 * @module tests/tools/get-award-subawards.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAwardSubawardsTool } from '@/mcp-server/tools/definitions/get-award-subawards.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockGetAwardSubawards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardSubawards: mockGetAwardSubawards }),
}));

/**
 * Wiring of the shared count-limit mechanism, whose full table lives in
 * tests/tools/count-limit.test.ts.
 */
describe('limit above the 100 cap (#99)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetAwardSubawards.mockReset();
  });

  const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));

  it('reads limit 101 as 100: the request, page_metadata.limit, limitClamp, and the notice on both surfaces', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, amount: 1 }));
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: rows,
      page_metadata: { hasNext: true, page: 2 },
    });

    const result = await runToolContract(getAwardSubawardsTool, {
      award_id: 'CONT_AWD_PRIME',
      limit: 101,
      page: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAwardSubawards.mock.calls[0]?.[0]).toMatchObject({ limit: 100, page: 2 });
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 100, page: 2, has_next: true },
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
      notice: 'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    });
    const raw = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
    expect(raw).toContain('**Per page:** 100');
    expect(raw).toContain('**Limit clamp:** `limit` requested 101, applied 100');
    expect(text(result)).toContain(
      'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    );
  });

  it('keeps the clamp sentence beside the empty-page notice', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1 },
    });

    const result = await runToolContract(getAwardSubawardsTool, {
      award_id: 'CONT_AWD_NO_SUBS',
      limit: 500,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('limit 500 exceeds the per-call maximum of 100');
    expect(notice).toContain('subaward_count');
  });

  it('reports no clamp at the cap', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [{ id: 1 }],
      page_metadata: { hasNext: false, page: 1 },
    });

    const result = await runToolContract(getAwardSubawardsTool, { award_id: 'X', limit: 100 });

    expect(result.structuredContent).not.toHaveProperty('limitClamp');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('advertises no maximum by default, and maximum 100 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(getAwardSubawardsTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Subawards per page. Default 10, at most 100 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/get-award-subawards.tool.js'))
          .getAwardSubawardsTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 100 });
    const rejected = await runToolContract(strict, { award_id: 'X', limit: 101 });
    expect(rejected.isError).toBe(true);
    expect(text(rejected)).toContain('Too big: expected number to be <=100');
    expect(mockGetAwardSubawards).not.toHaveBeenCalled();
  });
});

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
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: getAwardSubawardsTool.errors });
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_PRIME_001' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_PRIME_001');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.subaward_number).toBe('SUB-001');
    expect(result.results[0]!.amount).toBe(150_000);
    expect(result.results[0]!.recipient_name).toBe('SubCo LLC');
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

    const ctx = createMockContext({ errors: getAwardSubawardsTool.errors });
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_NO_SUBS' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('subaward_count');
    expect(enrichment.notice).toContain('CONT_AWD_NO_SUBS');
  });

  it('declares no not-found reason — the upstream gives no such signal', () => {
    // A declared reason that can never fire is an unreachable recovery contract.
    const reasons = (getAwardSubawardsTool.errors ?? []).map((e) => e.reason);
    expect(reasons).toEqual(['api_unavailable', 'api_timeout']);
  });

  it('throws when service call fails', async () => {
    mockGetAwardSubawards.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getAwardSubawardsTool.errors });
    const input = getAwardSubawardsTool.input.parse({ award_id: 'INVALID' });
    await expect(getAwardSubawardsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles a sparse subaward with no description or action date', async () => {
    mockGetAwardSubawards.mockResolvedValueOnce({
      results: [
        {
          id: 2,
          subaward_number: 'SUB-002',
          amount: 75_000,
          recipient_name: 'AnotherCo',
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: getAwardSubawardsTool.errors });
    const input = getAwardSubawardsTool.input.parse({ award_id: 'CONT_AWD_SPARSE' });
    const result = await getAwardSubawardsTool.handler(input, ctx);

    expect(result.results[0]).not.toHaveProperty('description');
    expect(result.results[0]).not.toHaveProperty('action_date');
    expect(result.results[0]!.amount).toBe(75_000);
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

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // total=45 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      award_id: 'CONT_AWD_PRIME',
      results: [{ id: 1, subaward_number: 'SUB-001', recipient_name: 'SubCo LLC' }],
      page_metadata: { has_next: true, page: 1, total: 45, limit: 5 },
    };

    const text = (getAwardSubawardsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~45');
    expect(text).not.toContain(' of ~');
  });
});
