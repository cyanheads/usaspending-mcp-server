/**
 * @fileoverview Tests for get-idv-awards tool.
 * @module tests/tools/get-idv-awards.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getIdvAwardsTool } from '@/mcp-server/tools/definitions/get-idv-awards.tool.js';

const mockGetIdvAwards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getIdvAwards: mockGetIdvAwards }),
}));

/**
 * POST idvs/awards/ returns only `results` and `page_metadata` at the top level —
 * every pagination field is nested. Fixtures mirror that shape so a handler reading
 * the flat top level cannot pass.
 */
describe('getIdvAwardsTool', () => {
  it('returns child awards for a valid IDV award_id', async () => {
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: 2, previous: null, hasNext: true, hasPrevious: false },
      results: [
        {
          award_id: 291813109,
          generated_unique_award_id: 'CONT_AWD_80KSC024FA106_8000_NNK14MA74C_8000',
          piid: '80KSC024FA106',
          award_type: 'DELIVERY ORDER',
          description: 'SPECIAL STUDIES SERVICES',
          obligated_amount: 295048.0,
          period_of_performance_start_date: '2024-08-12',
          period_of_performance_current_end_date: '2024-09-12',
          last_date_to_order: null,
          awarding_agency: 'National Aeronautics and Space Administration',
          funding_agency: 'National Aeronautics and Space Administration',
          awarding_agency_slug: 'national-aeronautics-and-space-administration',
          funding_agency_slug: 'national-aeronautics-and-space-administration',
        },
      ],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'CONT_IDV_NNK14MA74C_8000' });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.award_id).toBe('CONT_IDV_NNK14MA74C_8000');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.generated_unique_award_id).toBe(
      'CONT_AWD_80KSC024FA106_8000_NNK14MA74C_8000',
    );
    expect(result.results[0]!.piid).toBe('80KSC024FA106');
    expect(result.results[0]!.award_type).toBe('DELIVERY ORDER');
    expect(result.results[0]!.obligated_amount).toBe(295048.0);
    expect(result.results[0]!.awarding_agency).toBe(
      'National Aeronautics and Space Administration',
    );
    // last_date_to_order is null — should be omitted from output
    expect(result.results[0]!.last_date_to_order).toBeUndefined();
    expect(result.page_metadata.has_next).toBe(true);
    expect(result.page_metadata.has_previous).toBe(false);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.parent_award_id).toBe('CONT_IDV_NNK14MA74C_8000');
    expect(enrichment.has_next_page).toBe(true);
    expect(enrichment.current_page).toBe(1);
  });

  it('discloses truncation when a full page has more results', async () => {
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: 2, previous: null, hasNext: true, hasPrevious: false },
      results: Array.from({ length: 2 }, (_, i) => ({
        generated_unique_award_id: `CONT_AWD_CHILD_${i}`,
      })),
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'CONT_IDV_FULLPAGE_000', limit: 2 });
    await getIdvAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(2);
    expect(enrichment.cap).toBe(2);
    expect(enrichment.notice).toBeDefined();
  });

  it('keeps continuation but sets no truncated on a full page the upstream marks as last (#76)', async () => {
    // The live shape for CONT_IDV_NNK14MA74C_8000 at limit 12: twelve rows, hasNext
    // false, and an empty page 2. has_next keeps the precautionary fullness guard;
    // truncated needs evidence that rows exist beyond the page, and there is none.
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: null, previous: null, hasNext: false, hasPrevious: false },
      results: Array.from({ length: 12 }, (_, i) => ({
        generated_unique_award_id: `CONT_AWD_CHILD_${i}`,
      })),
    });

    const result = await runToolContract(getIdvAwardsTool, {
      award_id: 'CONT_IDV_NNK14MA74C_8000',
      limit: 12,
    });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.page_metadata as { has_next: boolean }).has_next).toBe(true);
    expect(sc.has_next_page).toBe(true);
    expect(sc.truncated).toBeUndefined();
    expect(sc.shown).toBeUndefined();
    expect(sc.cap).toBeUndefined();
    expect(sc.notice).toBeUndefined();
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Has next:** Yes');
    expect(text).not.toContain('truncated');
  });

  it('sets truncated from the upstream hasNext on both surfaces (#76)', async () => {
    // Same IDV at limit 6: page 1 is full and the upstream reports a next page.
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: 2, previous: null, hasNext: true, hasPrevious: false },
      results: Array.from({ length: 6 }, (_, i) => ({
        generated_unique_award_id: `CONT_AWD_CHILD_${i}`,
      })),
    });

    const result = await runToolContract(getIdvAwardsTool, {
      award_id: 'CONT_IDV_NNK14MA74C_8000',
      limit: 6,
    });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(6);
    expect(sc.cap).toBe(6);
    expect(sc.notice).toContain('next page');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('next page');
  });

  it('does not disclose continuation on a short final page', async () => {
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 2, next: null, previous: 1, hasNext: false, hasPrevious: true },
      results: [{ generated_unique_award_id: 'CONT_AWD_LAST_001' }],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'CONT_IDV_END_000', limit: 2, page: 2 });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata.has_previous).toBe(true);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.has_next_page).toBe(false);
    expect(enrichment.truncated).toBeUndefined();
  });

  it('reports has_previous on a page past the first (#46)', async () => {
    // The live page-2 shape for CONT_IDV_FA862115D6276_9700 at limit 2. Reading these
    // from the response top level instead of page_metadata pinned has_previous to false
    // on every page.
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 2, next: 3, previous: 1, hasNext: true, hasPrevious: true },
      results: [
        { generated_unique_award_id: 'CONT_AWD_CHILD_P2_A', piid: 'FA862115F6276A' },
        { generated_unique_award_id: 'CONT_AWD_CHILD_P2_B', piid: 'FA862115F6276B' },
      ],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({
      award_id: 'CONT_IDV_FA862115D6276_9700',
      limit: 2,
      page: 2,
    });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.page_metadata.has_previous).toBe(true);
    expect(result.page_metadata.page).toBe(2);
    expect(result.page_metadata.has_next).toBe(true);
    expect(getEnrichment(ctx).current_page).toBe(2);
  });

  it('honors the upstream hasNext on a short page instead of discarding it (#46)', async () => {
    // A short page cannot trigger the page-fullness fallback, so has_next here is
    // truthful only if the nested upstream flag is actually read.
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: 2, previous: null, hasNext: true, hasPrevious: false },
      results: [{ generated_unique_award_id: 'CONT_AWD_SHORT_001' }],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'CONT_IDV_SHORT_000', limit: 2 });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.page_metadata.has_next).toBe(true);
    expect(getEnrichment(ctx).has_next_page).toBe(true);
  });

  it('populates empty-results notice for IDV with no children of requested type', async () => {
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: null, previous: null, hasNext: false, hasPrevious: false },
      results: [],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({
      award_id: 'CONT_IDV_NOSUBS_0000',
      type: 'child_idvs',
    });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('child_idvs');
    expect(enrichment.notice).toContain('CONT_IDV_NOSUBS_0000');
  });

  it('handles sparse child award — optional fields omitted by upstream', async () => {
    mockGetIdvAwards.mockResolvedValueOnce({
      page_metadata: { page: 1, next: null, previous: null, hasNext: false, hasPrevious: false },
      results: [
        {
          // Only generated_unique_award_id present; everything else omitted
          generated_unique_award_id: 'CONT_AWD_SPARSE_001',
        },
      ],
    });

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'CONT_IDV_SPARSE_000' });
    const result = await getIdvAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.generated_unique_award_id).toBe('CONT_AWD_SPARSE_001');
    expect(result.results[0]!.piid).toBeUndefined();
    expect(result.results[0]!.award_type).toBeUndefined();
    expect(result.results[0]!.obligated_amount).toBeUndefined();
    expect(result.results[0]!.awarding_agency).toBeUndefined();
    expect(result.results[0]!.last_date_to_order).toBeUndefined();
  });

  it('throws when service call fails', async () => {
    mockGetIdvAwards.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getIdvAwardsTool.errors });
    const input = getIdvAwardsTool.input.parse({ award_id: 'INVALID' });
    await expect(getIdvAwardsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with all child award fields', () => {
    const output = {
      award_id: 'CONT_IDV_NNK14MA74C_8000',
      results: [
        {
          generated_unique_award_id: 'CONT_AWD_80KSC024FA106_8000_NNK14MA74C_8000',
          piid: '80KSC024FA106',
          award_type: 'DELIVERY ORDER',
          description: 'SPECIAL STUDIES SERVICES',
          obligated_amount: 295048.0,
          period_of_performance_start_date: '2024-08-12',
          period_of_performance_current_end_date: '2024-09-12',
          last_date_to_order: '2025-01-01',
          awarding_agency: 'NASA',
          funding_agency: 'NASA',
        },
      ],
      page_metadata: { has_next: false, has_previous: false, page: 1, limit: 10 },
    };

    const blocks = getIdvAwardsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CONT_IDV_NNK14MA74C_8000');
    expect(text).toContain('**Has previous:** No');
    expect(text).toContain('CONT_AWD_80KSC024FA106_8000_NNK14MA74C_8000');
    expect(text).toContain('80KSC024FA106');
    expect(text).toContain('DELIVERY ORDER');
    expect(text).toContain('295,048');
    expect(text).toContain('NASA');
    expect(text).toContain('2025-01-01');
  });

  it('renders has_previous for content[]-only clients (#46)', () => {
    const output = {
      award_id: 'CONT_IDV_FA862115D6276_9700',
      results: [{ generated_unique_award_id: 'CONT_AWD_CHILD_P2_A' }],
      page_metadata: { has_next: true, has_previous: true, page: 2, limit: 2 },
    };

    const text = (getIdvAwardsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Has previous:** Yes');
    expect(text).toContain('**Has next:** Yes');
  });
});
