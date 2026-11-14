/**
 * @fileoverview Tests for search-recipients tool.
 * @module tests/tools/search-recipients.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchRecipientsTool } from '@/mcp-server/tools/definitions/search-recipients.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockSearchRecipients = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchRecipients: mockSearchRecipients }),
}));

/**
 * Wiring of the shared count-limit mechanism (full table in
 * tests/tools/count-limit.test.ts). The cap is the upstream's 1,000-row page maximum.
 */
describe('limit above the 1,000 cap (#99)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockSearchRecipients.mockReset();
  });

  const raw = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');

  it('accepts limit 1000, which the previous 100 maximum refused, with no clamp', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: Array.from({ length: 1000 }, (_, i) => ({ id: `r-${i}-R`, name: `R${i}` })),
      page_metadata: { page: 1, total: 5000, hasNext: true },
    });

    const result = await runToolContract(searchRecipientsTool, { keyword: 'acme', limit: 1000 });

    expect(result.isError).toBeFalsy();
    expect(mockSearchRecipients.mock.calls[0]?.[0]).toMatchObject({ limit: 1000 });
    expect(result.structuredContent).toMatchObject({
      period: 'trailing 12 months',
      page_metadata: { limit: 1000 },
      recipient_count: 1000,
    });
    expect(raw(result)).toContain('**Period:** trailing 12 months');
    expect(result.structuredContent).not.toHaveProperty('limitClamp');
  });

  it('reads limit 1001 as 1000: the request, page_metadata.limit, limitClamp, and the clamp sentence beside the continuation notice', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [{ id: 'r-1-R', name: 'R1' }],
      page_metadata: { page: 1, total: 5000, hasNext: true },
    });

    const result = await runToolContract(searchRecipientsTool, { keyword: 'acme', limit: 1001 });

    expect(result.isError).toBeFalsy();
    expect(mockSearchRecipients.mock.calls[0]?.[0]).toMatchObject({ limit: 1000, page: 1 });
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 1000 },
      limitClamp: { field: 'limit', requested: 1001, applied: 1000 },
      notice:
        'limit 1001 exceeds the per-call maximum of 1000; this call used limit 1000. More recipients match (5,000 total). Request page 2 to continue.',
    });
    expect(raw(result)).toContain('**Per page:** 1000');
    expect(raw(result)).toContain('**Limit clamp:** `limit` requested 1001, applied 1000');
    expect(markdownText(raw(result))).toContain('this call used limit 1000. More recipients match');
  });

  it('places an empty page against the applied limit, the clamp sentence beside that notice', async () => {
    // Page 2 of 1,001 matches: at limit 1000 it is not past the end; at 1001 it would be.
    mockSearchRecipients.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 2, total: 1001, hasNext: false },
    });

    const result = await runToolContract(searchRecipientsTool, {
      keyword: 'acme',
      limit: 1001,
      page: 2,
    });

    expect((result.structuredContent as { notice?: string }).notice).toBe(
      'limit 1001 exceeds the per-call maximum of 1000; this call used limit 1000. Page 2 returned no results. The API reports 1,001 matching results across all pages.',
    );
  });

  it('advertises no maximum by default, and maximum 1000 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(searchRecipientsTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Recipients per page. Default 10, at most 1,000 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/search-recipients.tool.js'))
          .searchRecipientsTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 1000 });
    const rejected = await runToolContract(strict, { keyword: 'acme', limit: 1001 });
    expect(rejected.isError).toBe(true);
    expect(raw(rejected)).toContain('Too big: expected number to be <=1000');
    expect(mockSearchRecipients).not.toHaveBeenCalled();
  });
});

describe('searchRecipientsTool', () => {
  it('labels amounts with the snapshot period on both surfaces', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [{ id: 'acme-R', amount: 42 }],
      page_metadata: { page: 1, total: 1, hasNext: false },
    });

    const result = await runToolContract(searchRecipientsTool, { keyword: 'Acme' });

    expect(result.structuredContent).toMatchObject({
      period: 'trailing 12 months',
      results: [{ id: 'acme-R', amount: 42 }],
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('**Period:** trailing 12 months'),
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('**Obligations:** $42'),
    });
    expect(mockSearchRecipients).toHaveBeenLastCalledWith(
      { keyword: 'Acme', limit: 10, page: 1 },
      expect.anything(),
    );
  });

  it('keeps the period on a filtered page past the end', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 3, total: 2, hasNext: false },
    });

    const result = await runToolContract(searchRecipientsTool, {
      keyword: 'Acme',
      award_type: 'grants',
      limit: 1,
      page: 3,
    });

    expect(mockSearchRecipients).toHaveBeenLastCalledWith(
      { keyword: 'Acme', award_type: 'grants', limit: 1, page: 3 },
      expect.anything(),
    );
    expect(result.structuredContent).toMatchObject({
      period: 'trailing 12 months',
      results: [],
      page_metadata: { page: 3, total: 2, has_next: false },
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('**Period:** trailing 12 months'),
    });
  });

  it('returns recipients for a name keyword', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [
        {
          id: 'abc123-P',
          name: 'Acme Corporation',
          uei: 'ACMEAAAAAAAA',
          duns: '123456789',
          recipient_level: 'P',
          amount: 5_000_000,
        },
      ],
      page_metadata: { page: 1, total: 1, limit: 10, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'Acme' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('abc123-P');
    expect(result.results[0]!.name).toBe('Acme Corporation');
    expect(result.results[0]!.uei).toBe('ACMEAAAAAAAA');
    expect(result.results[0]!.amount).toBe(5_000_000);
    expect(result.page_metadata.total).toBe(1);
    expect(result.page_metadata.page).toBe(1);
    expect(result.page_metadata.has_next).toBe(false);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.recipient_count).toBe(1);
    expect(enrichment.totalCount).toBe(1);
    expect(enrichment.has_next).toBe(false);
    expect(enrichment.notice).toBeUndefined();
  });

  it('passes page through and echoes the returned page_metadata', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [{ id: 'id-2-R', name: 'Recipient Two' }],
      page_metadata: { page: 2, total: 150, limit: 1, hasNext: true, hasPrevious: true },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'corp', page: 2, limit: 1 });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(mockSearchRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, limit: 1 }),
      ctx,
    );
    expect(result.page_metadata.page).toBe(2);
    expect(result.page_metadata.has_next).toBe(true);
    expect(result.page_metadata.total).toBe(150);
    const enrichment = getEnrichment(ctx);
    // Continuation guidance points to the next page, not a limit increase
    expect(enrichment.notice).toContain('page 3');
  });

  it('at the max limit, recovery guidance names pagination instead of a limit increase', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}-R`, name: `Recipient ${i}` })),
      page_metadata: { page: 1, total: 5000, limit: 100, hasNext: true, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'a', limit: 100 });
    await searchRecipientsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.has_next).toBe(true);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('page 2');
    expect(enrichment.notice).toContain('5,000');
    // The old bug: suggesting an impossible limit increase when already at max
    expect(enrichment.notice).not.toMatch(/raise limit/i);
  });

  it('populates enrichment notice when no results found', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 1, total: 0, limit: 10, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'NoSuchCompanyXYZ' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('NoSuchCompanyXYZ');
  });

  it('passes award_type filter through to service', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 1, total: 0, limit: 10, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'Acme', award_type: 'contracts' });
    await searchRecipientsTool.handler(input, ctx);

    expect(mockSearchRecipients).toHaveBeenCalledWith(
      expect.objectContaining({ award_type: 'contracts' }),
      ctx,
    );
  });

  it('throws when service call fails', async () => {
    mockSearchRecipients.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'Acme' });
    await expect(searchRecipientsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles sparse recipient — missing uei and duns', async () => {
    mockSearchRecipients.mockResolvedValueOnce({
      results: [
        {
          id: 'sparse-id-P',
          name: 'Minimal Corp',
          recipient_level: 'P',
          amount: 10_000,
          // no uei or duns — the recipient endpoint returns no location/address data
        },
      ],
      page_metadata: { page: 1, total: 1, limit: 10, hasNext: false, hasPrevious: false },
    });

    const ctx = createMockContext({ errors: searchRecipientsTool.errors });
    const input = searchRecipientsTool.input.parse({ keyword: 'minimal' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results[0]!.id).toBe('sparse-id-P');
    expect(result.results[0]!.name).toBe('Minimal Corp');
    expect(result.results[0]!.uei).toBeUndefined();
    expect(result.results[0]!.duns).toBeUndefined();
  });

  it('formats output with recipient IDs, amounts, and pagination', () => {
    const output = {
      period: 'trailing 12 months' as const,
      results: [
        {
          id: 'abc123-P',
          name: 'Acme Corporation',
          uei: 'ACMEAAAAAAAA',
          duns: '123456789',
          recipient_level: 'P',
          amount: 5_000_000,
        },
      ],
      page_metadata: { total: 42, page: 1, has_next: true, limit: 10 },
    };

    const blocks = searchRecipientsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('abc123-P');
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('5,000,000');
    expect(text).toContain('ACMEAAAAAAAA');
    expect(text).toContain('Page:');
  });

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // total=200 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      period: 'trailing 12 months' as const,
      results: [{ id: 'abc123-P', name: 'Acme Corporation', amount: 1_234 }],
      page_metadata: { total: 200, page: 1, has_next: true, limit: 2 },
    };

    const text = (searchRecipientsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~200');
    expect(text).not.toContain(' of ~');
  });
});
