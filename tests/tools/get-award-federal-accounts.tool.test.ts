/**
 * @fileoverview Tests for get-award-federal-accounts tool.
 * @module tests/tools/get-award-federal-accounts.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAwardFederalAccountsTool } from '@/mcp-server/tools/definitions/get-award-federal-accounts.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockGetAwardFederalAccounts = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAwardFederalAccounts: mockGetAwardFederalAccounts }),
}));

/** Wiring of the shared count-limit mechanism (full table in tests/tools/count-limit.test.ts). */
describe('limit above the 100 cap (#99)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockGetAwardFederalAccounts.mockReset();
  });

  const raw = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');

  it('reads limit 101 as 100: the request, page_metadata.limit, limitClamp, and the notice on both surfaces', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '080-0120' }],
      page_metadata: { page: 1, count: 1, hasNext: false, hasPrevious: false },
    });

    const result = await runToolContract(getAwardFederalAccountsTool, {
      award_id: 'CONT_AWD_X',
      limit: 101,
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAwardFederalAccounts.mock.calls[0]?.[0]).toMatchObject({ limit: 100, page: 1 });
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 100 },
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
      notice: 'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    });
    expect(raw(result)).toContain('**Per page:** 100');
    expect(raw(result)).toContain('**Limit clamp:** `limit` requested 101, applied 100');
    expect(markdownText(raw(result))).toContain('limit 101 exceeds the per-call maximum of 100');
  });

  it('places an empty page against the applied limit, the clamp sentence beside that notice', async () => {
    // Page 2 of 101 accounts: at limit 100 it is not past the end; at 101 it would be.
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 2, count: 101, hasNext: false, hasPrevious: true },
    });

    const result = await runToolContract(getAwardFederalAccountsTool, {
      award_id: 'CONT_AWD_X',
      limit: 101,
      page: 2,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toBe(
      'limit 101 exceeds the per-call maximum of 100; this call used limit 100. Page 2 returned no results. The API reports 101 matching results across all pages.',
    );
  });

  it('advertises no maximum by default, and maximum 100 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(getAwardFederalAccountsTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Funding accounts per page. Default 10, at most 100 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/get-award-federal-accounts.tool.js'))
          .getAwardFederalAccountsTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 100 });
    const rejected = await runToolContract(strict, { award_id: 'X', limit: 101 });
    expect(rejected.isError).toBe(true);
    expect(raw(rejected)).toContain('Too big: expected number to be <=100');
    expect(mockGetAwardFederalAccounts).not.toHaveBeenCalled();
  });
});

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

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
    const input = getAwardFederalAccountsTool.input.parse({
      award_id: 'CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-',
    });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_AWD_GSFC0198106DNAS526555_8000_-NONE-_-NONE-');
    expect(result.results).toHaveLength(1);
    // federal_account is the chaining value into usaspending_get_federal_account.
    expect(result.results[0]!.federal_account).toBe('080-0120');
    expect(result.results[0]!.account_title).toBe(
      'Science, National Aeronautics and Space Administration',
    );
    expect(result.results[0]!.total_transaction_obligated_amount).toBe(667_042_581.81);
    expect(result.results[0]!.funding_agency_name).toBe(
      'National Aeronautics and Space Administration',
    );
    expect(result.results[0]!.funding_agency_abbreviation).toBe('NASA');
    expect(result.results[0]!.funding_agency_slug).toBe(
      'national-aeronautics-and-space-administration',
    );
    // Both agency IDs are part of the fixed upstream shape — the issue's original
    // field list omitted them.
    expect(result.results[0]!.funding_agency_id).toBe(862);
    expect(result.results[0]!.funding_toptier_agency_id).toBe(72);

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

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
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

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
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

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
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
    expect(reasons).toEqual(['api_unavailable', 'api_timeout']);
  });

  it('rejects an empty award_id at the schema — upstream answers it with a 422', () => {
    expect(() => getAwardFederalAccountsTool.input.parse({ award_id: '' })).toThrow();
  });

  it('handles a sparse row — optional fields omitted by upstream', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '080-0120' }],
      page_metadata: { page: 1, count: 1, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
    const input = getAwardFederalAccountsTool.input.parse({ award_id: 'CONT_AWD_SPARSE_001' });
    const result = await getAwardFederalAccountsTool.handler(input, ctx);

    expect(result.results[0]!.federal_account).toBe('080-0120');
    expect(result.results[0]!.account_title).toBeUndefined();
    expect(result.results[0]!.total_transaction_obligated_amount).toBeUndefined();
    expect(result.results[0]!.funding_agency_name).toBeUndefined();
    expect(result.results[0]!.funding_agency_id).toBeUndefined();
    expect(result.results[0]!.funding_toptier_agency_id).toBeUndefined();
  });

  it('omits count when the upstream page_metadata carries none', async () => {
    mockGetAwardFederalAccounts.mockResolvedValueOnce({
      results: [{ federal_account: '080-0120' }],
      page_metadata: {},
    });

    const ctx = createMockContext({ errors: getAwardFederalAccountsTool.errors });
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
    const text = markdownText((blocks[0] as { text: string }).text);
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
