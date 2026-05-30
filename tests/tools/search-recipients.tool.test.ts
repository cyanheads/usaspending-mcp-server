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
    mockSearchRecipients.mockResolvedValueOnce([
      {
        id: 'abc123-P',
        name: 'Acme Corporation',
        uei: 'ACMEAAAAAAAA',
        duns: '123456789',
        recipient_level: 'P',
        amount: 5_000_000,
        state_province: 'WA',
        location: { city_name: 'Seattle', state_code: 'WA', country_code: 'USA' },
      },
    ]);

    const ctx = createMockContext();
    const input = searchRecipientsTool.input.parse({ keyword: 'Acme' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].id).toBe('abc123-P');
    expect(result.results[0].name).toBe('Acme Corporation');
    expect(result.results[0].uei).toBe('ACMEAAAAAAAA');
    expect(result.results[0].amount).toBe(5_000_000);
    expect(result.results[0].location?.city_name).toBe('Seattle');
    expect(result.total).toBe(1);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.recipient_count).toBe(1);
    expect(enrichment.notice).toBeUndefined();
  });

  it('populates enrichment notice when no results found', async () => {
    mockSearchRecipients.mockResolvedValueOnce([]);

    const ctx = createMockContext();
    const input = searchRecipientsTool.input.parse({ keyword: 'NoSuchCompanyXYZ' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('NoSuchCompanyXYZ');
  });

  it('passes award_type filter through to service', async () => {
    mockSearchRecipients.mockResolvedValueOnce([]);

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

  it('handles sparse recipient — missing uei and location', async () => {
    mockSearchRecipients.mockResolvedValueOnce([
      {
        id: 'sparse-id-P',
        name: 'Minimal Corp',
        recipient_level: 'P',
        amount: 10_000,
        // no uei, duns, or location
      },
    ]);

    const ctx = createMockContext();
    const input = searchRecipientsTool.input.parse({ keyword: 'minimal' });
    const result = await searchRecipientsTool.handler(input, ctx);

    expect(result.results[0].id).toBe('sparse-id-P');
    expect(result.results[0].name).toBe('Minimal Corp');
    expect(result.results[0].uei).toBeUndefined();
    expect(result.results[0].location).toBeUndefined();
  });

  it('formats output with recipient IDs and amounts', () => {
    const output = {
      results: [
        {
          id: 'abc123-P',
          name: 'Acme Corporation',
          uei: 'ACMEAAAAAAAA',
          duns: '123456789',
          recipient_level: 'P',
          amount: 5_000_000,
          state: 'WA',
          location: { city_name: 'Seattle', state_code: 'WA', country_code: 'USA' },
        },
      ],
      total: 1,
    };

    const blocks = searchRecipientsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('abc123-P');
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('5,000,000');
    expect(text).toContain('ACMEAAAAAAAA');
  });
});
