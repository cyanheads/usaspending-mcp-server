/**
 * @fileoverview Tests for get-award-federal-accounts tool.
 * @module tests/tools/get-award-federal-accounts.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getAwardFederalAccountsTool } from '@/mcp-server/tools/definitions/get-award-federal-accounts.tool.js';

const mockGetAwardFederalAccounts = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardFederalAccounts: mockGetAwardFederalAccounts }),
}));

describe('getAwardFederalAccountsTool', () => {
  it('returns funding accounts with every field the upstream row carries', async () => {
    // Verbatim live response row for CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-.
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [
        {
          total_transaction_obligated_amount: 667_042_581.81,
          federal_account: '080-0120',
          account_title: 'Science, National Aeronautics and Space Administration',
          funding_agency_abbreviation: 'NASA',
          funding_agency_name: 'National Aeronautics and Space Administration',
          funding_agency_id: 862,
          funding_toptier_agency_id: 72,
          funding_agency_slug: 'national-aeronautics-and-space-administration',
        },
      ],
      page_metadata: {
        page: 1,
        count: 1,
        next: null,
        previous: null,
        hasNext: false,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-',
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-');
    expect(result.results).toHaveLength(1);
    // federal_account is the chaining value into usaspending_get_federal_account.
    expect(result.results[0].federal_account).toBe('080-0120');
    expect(result.results[0].account_title).toBe(
      'Science, National Aeronautics and Space Administration',
    );
    expect(result.results[0].total_transaction_obligated_amount).toBe(667_042_581.81);
    expect(result.results[0].funding_agency_name).toBe(
      'National Aeronautics and Space Administration',
    );
    expect(result.results[0].funding_agency_abbreviation).toBe('NASA');
    expect(result.results[0].funding_agency_slug).toBe(
      'national-aeronautics-and-space-administration',
    );
    // Both agency IDs are part of the fixed upstream shape — the issue's original
    // field list omitted them.
    expect(result.results[0].funding_agency_id).toBe(862);
    expect(result.results[0].funding_toptier_agency_id).toBe(72);

    expect(result.page_metadata.count).toBe(1);
    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata.has_previous).toBe(false);
  });

  it('reports the upstream count as the total across pages, not the page size', async () => {
    // Live: a 29-account award at limit 2 reports count: 29 on page 1.
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '089-5231' }, { federal_account: '089-5227' }],
      page_metadata: {
        page: 1,
        count: 29,
        next: 2,
        previous: null,
        hasNext: true,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_DEAC0500OR22725_8900_-NONE-_-NONE-',
      limit: 2,
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.page_metadata.count).toBe(29);
    expect(result.page_metadata.has_next).toBe(true);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(29);
    expect(enrichment.has_next_page).toBe(true);
    expect(enrichment.current_page).toBe(1);
  });

  it('keeps enrichment keys disjoint from output keys', () => {
    // The effective output schema is output.extend(enrichment) — a shared key would
    // silently override the output field. award_id is already carried by output.
    const outputKeys = Object.keys(getAwardFederalAccountsTool.output.shape);
    const enrichmentKeys = Object.keys(getAwardFederalAccountsTool.enrichment ?? {});
    expect(enrichmentKeys.filter((k) => outputKeys.includes(k))).toEqual([]);
  });

  it('reports an interior page with both continuation flags set', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '089-0250' }, { federal_account: '089-0222' }],
      page_metadata: { page: 2, count: 29, next: 3, previous: 1, hasNext: true, hasPrevious: true },
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_DEAC0500OR22725_8900_-NONE-_-NONE-',
      limit: 2,
      page: 2,
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.page_metadata.page).toBe(2);
    expect(result.page_metadata.has_next).toBe(true);
    expect(result.page_metadata.has_previous).toBe(true);
  });

  it('reports the final page as having no next', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '089-0224' }],
      page_metadata: {
        page: 15,
        count: 29,
        next: null,
        previous: 14,
        hasNext: false,
        hasPrevious: true,
      },
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_DEAC0500OR22725_8900_-NONE-_-NONE-',
      limit: 2,
      page: 15,
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata.has_previous).toBe(true);
    expect(getEnrichment(ctx).has_next_page).toBe(false);
  });

  /**
   * The upstream answers a nonexistent award_id with HTTP 200 and zero rows —
   * byte-identical to a real award with no account linkage. There is no miss
   * signal to map, so this must be a notice rather than a thrown not-found.
   */
  it('surfaces a nonexistent award_id as an empty-result notice, not a throw', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [],
      page_metadata: {
        page: 1,
        count: 0,
        next: null,
        previous: null,
        hasNext: false,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_NOTAREALAWARD_0000_-NONE-_-NONE-',
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('CONT_AWD_NOTAREALAWARD_0000_-NONE-_-NONE-');
    expect(enrichment.notice).toContain('usaspending_search_awards');
  });

  it('declares no not-found reason — the upstream gives no such signal', () => {
    // A declared reason that can never fire is an unreachable recovery contract.
    const reasons = (getAwardFederalAccountsTool.errors ?? []).map((e) => e.reason);
    expect(reasons).toEqual(['api_unavailable']);
  });

  it('rejects an empty award_id at the schema — upstream answers it with a 422', () => {
    expect(() => getAwardFederalAccountsTool.input.parse({ award_id: '' })).toThrow();
  });

  it('handles a sparse row — optional fields omitted by upstream', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '080-0120' }],
      page_metadata: { page: 1, count: 1, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({ award_id: 'CONT_AWD_SPARSE_001' });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.results[0].federal_account).toBe('080-0120');
    expect(result.results[0].account_title).toBeUndefined();
    expect(result.results[0].total_transaction_obligated_amount).toBeUndefined();
    expect(result.results[0].funding_agency_name).toBeUndefined();
    expect(result.results[0].funding_agency_id).toBeUndefined();
    expect(result.results[0].funding_toptier_agency_id).toBeUndefined();
  });

  it('omits count when the upstream page_metadata carries none', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '080-0120' }],
      page_metadata: {},
    });

    const ctx = createMockContext();
    const input = getAwardFederalAccountsTool.input.parse({ award_id: 'CONT_AWD_NOCOUNT_001' });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.page_metadata.count).toBeUndefined();
    expect(getEnrichment(ctx).totalCount).toBeUndefined();
  });

  it('throws when service call fails', async () => {
    mockGetAwardFederalAccounts.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
    const input = getAwardFederalAccountsTool.input.parse({ award_id: 'CONT_AWD_BOOM_001' });
    await expect(getAwardFederalAccountsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('renders every output field in content[] at parity with structuredContent', () => {
    const output = {
      award_id: 'CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-',
      results: [
        {
          federal_account: '080-0120',
          account_title: 'Science, National Aeronautics and Space Administration',
          total_transaction_obligated_amount: 667_042_581.81,
          funding_agency_name: 'National Aeronautics and Space Administration',
          funding_agency_abbreviation: 'NASA',
          funding_agency_slug: 'national-aeronautics-and-space-administration',
          funding_agency_id: 862,
          funding_toptier_agency_id: 72,
        },
      ],
      page_metadata: { count: 1, page: 1, has_next: false, has_previous: false, limit: 10 },
    };

    const blocks = getAwardFederalAccountsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-');
    expect(text).toContain('080-0120');
    expect(text).toContain('Science, National Aeronautics and Space Administration');
    expect(text).toContain('667,042,581.81');
    expect(text).toContain('NASA');
    expect(text).toContain('national-aeronautics-and-space-administration');
    expect(text).toContain('862');
    expect(text).toContain('72');
  });
});
