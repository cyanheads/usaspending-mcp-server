/**
 * @fileoverview Tests for search-recipients tool.
 * @module tests/tools/search-recipients.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { searchRecipientsTool } from '@/mcp-server/tools/definitions/search-recipients.tool.js';

const mockSearchRecipients = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchRecipients: mockSearchRecipients }),
}));

describe('searchRecipientsTool', () => {
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

    const ctx = createMockContext();
    const input = searchRecipientsTool.input.parse({ keyword: 'Acme' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('abc123-P');
    expect(result.results[0].name).toBe('Acme Corporation');
    expect(result.results[0].uei).toBe('ACMEAAAAAAAA');
    expect(result.results[0].amount).toBe(5_000_000);
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
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

    const ctx = createMockContext();
    const input = searchRecipientsTool.input.parse({ keyword: 'minimal' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results[0].id).toBe('sparse-id-P');
    expect(result.results[0].name).toBe('Minimal Corp');
    expect(result.results[0].uei).toBeUndefined();
    expect(result.results[0].duns).toBeUndefined();
  });

  it('formats output with recipient IDs, amounts, and pagination', () => {
    const output = {
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
});
