/**
 * @fileoverview Tests for search-awards tool.
 * @module tests/tools/search-awards.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';

const mockSearchAwards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchAwards: mockSearchAwards }),
}));

describe('searchAwardsTool', () => {
  it('returns award results for a keyword search', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [
        {
          'Award ID': 'CONT_AWD_TEST',
          generated_internal_id: 'CONT_AWD_TEST_ID',
          'Recipient Name': 'Acme Corp',
          'Award Amount': 1_000_000,
          'Total Outlays': 800_000,
          'Awarding Agency': 'Department of Defense',
          'Awarding Sub Agency': 'Army',
          'Award Type': 'Definitive Contract',
          'Start Date': '2023-01-01',
          'End Date': '2024-12-31',
          Description: 'IT services contract',
          'Funding Agency': 'Department of Defense',
          'Place of Performance City Code': 'Seattle',
          'Place of Performance State Code': 'WA',
          'Place of Performance Country Code': 'USA',
          'Awarding Agency Code': '097',
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'IT services', limit: 10 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].award_id).toBe('CONT_AWD_TEST');
    expect(result.results[0].generated_internal_id).toBe('CONT_AWD_TEST_ID');
    expect(result.results[0].recipient_name).toBe('Acme Corp');
    expect(result.results[0].award_amount).toBe(1_000_000);
    expect(result.results[0].awarding_agency).toBe('Department of Defense');
    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata.page).toBe(1);
    expect(result.page_metadata.limit).toBe(10);
  });

  it('populates enrichment with pagination context', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [
        {
          'Award ID': 'CONT_AWD_TEST',
          generated_internal_id: 'CONT_AWD_TEST_ID',
          'Recipient Name': 'Acme Corp',
          'Award Amount': 1_000_000,
        },
      ],
      page_metadata: { hasNext: true, page: 1, total: 42, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'IT services', limit: 10 });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.total).toBe(42);
    expect(enrichment.page).toBe(1);
    expect(enrichment.has_next).toBe(true);
    expect(enrichment.notice).toBeUndefined();
  });

  it('populates enrichment notice when no results found', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'nonexistent_xyz_123' });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('nonexistent_xyz_123');
  });

  it('propagates service rejection when API call fails', async () => {
    mockSearchAwards.mockRejectedValueOnce(new Error('Service unavailable'));

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'test' });
    await expect(searchAwardsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes award_type_codes filter through', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      award_type_codes: ['A', 'B'],
      limit: 5,
    });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ award_type_codes: ['A', 'B'] }),
      }),
      ctx,
    );
  });

  it('defaults award_type_codes to contracts when not provided', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'artificial intelligence' });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ award_type_codes: ['A', 'B', 'C', 'D'] }),
      }),
      ctx,
    );
  });

  it('passes recipient_name filter as recipient_search_text to service', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ recipient_name: 'Lockheed' });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ recipient_search_text: ['Lockheed'] }),
      }),
      ctx,
    );
  });

  it('passes naics_code filter as naics_codes.require to service', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ naics_code: '541512' });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ naics_codes: { require: ['541512'] } }),
      }),
      ctx,
    );
  });

  it('passes location_filter as place_of_performance_locations to service', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      location_filter: { country: 'USA', state: 'WA' },
    });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({
          place_of_performance_locations: [{ country: 'USA', state: 'WA' }],
        }),
      }),
      ctx,
    );
  });

  it('notice with no filters mentions no specific filter label', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ limit: 5 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('No awards matched');
  });

  it('formats output with no place_of_performance when fields are absent', () => {
    const output = {
      results: [
        {
          award_id: 'PIID-SPARSE',
          generated_internal_id: 'CONT_AWD_SPARSE',
          recipient_name: 'Sparse Corp',
          award_amount: 100_000,
          // no place_of_performance fields
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = searchAwardsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('PIID-SPARSE');
    expect(text).toContain('100,000');
    expect(text).not.toContain('Place of Performance:');
  });

  it('formats output with award type from Contract Award Type when Award Type absent', () => {
    const output = {
      results: [
        {
          generated_internal_id: 'IDV_AWD_001',
          award_type: 'IDV - GWAC',
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = searchAwardsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('IDV - GWAC');
  });

  it('formats output with award IDs and amounts', () => {
    const output = {
      results: [
        {
          award_id: 'PIID-001',
          generated_internal_id: 'CONT_AWD_GEN_001',
          recipient_name: 'Test Corp',
          award_amount: 500_000,
          total_outlays: 400_000,
          awarding_agency: 'DoD',
          awarding_sub_agency: 'Army',
          award_type: 'Contract',
          start_date: '2023-01-01',
          end_date: '2024-12-31',
          description: 'Test award',
          funding_agency: 'DoD',
          place_of_performance: { city: 'Seattle', state: 'WA', country: 'USA' },
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = searchAwardsTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('PIID-001');
    expect(text).toContain('CONT_AWD_GEN_001');
    expect(text).toContain('Test Corp');
    expect(text).toContain('500,000');
    expect(text).toContain('**Page:** 1');
  });
});
