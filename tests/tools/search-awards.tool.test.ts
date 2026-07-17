/**
 * @fileoverview Tests for search-awards tool.
 * @module tests/tools/search-awards.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';

const mockSearchAwards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchAwards: mockSearchAwards }),
}));

describe('searchAwardsTool', () => {
  beforeEach(() => {
    mockSearchAwards.mockClear();
  });

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
      page_metadata: { hasNext: true, page: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'IT services', limit: 10 });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.page).toBe(1);
    expect(enrichment.has_next).toBe(true);
    // a capped page discloses page-based truncation (this endpoint returns no total)
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(1);
    expect(enrichment.cap).toBe(10);
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

  it('passes naics_codes filter as naics_codes.require to service', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ naics_codes: ['541512', '541511'] });
    await searchAwardsTool.handler(input, ctx);

    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ naics_codes: { require: ['541512', '541511'] } }),
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

  it('echoes applied filter values in enrichment', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_X' }],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      keyword: 'cyber',
      agency_name: 'Department of Defense',
      naics_codes: ['541512', '541511'],
      time_period: { start_date: '2023-01-01', end_date: '2023-12-31' },
    });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_keyword).toBe('cyber');
    expect(enrichment.applied_agency_name).toBe('Department of Defense');
    expect(enrichment.applied_naics_codes).toBe('541512, 541511');
    expect(enrichment.applied_time_period_start).toBe('2023-01-01');
    expect(enrichment.applied_time_period_end).toBe('2023-12-31');
  });

  it('omits applied filter echoes from enrichment when no filters are set', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_Y' }],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ limit: 5 });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_keyword).toBeUndefined();
    expect(enrichment.applied_agency_name).toBeUndefined();
    expect(enrichment.applied_naics_codes).toBeUndefined();
  });

  // --- #21: analytics-style nested filters object ---

  it('flows a nested filters object to the request with endpoint keys, dropping recipient_id (#21)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext();
    // recipient_id is not part of the nested schema — Zod strips it, and the handler must
    // never forward it (search/spending_by_award/ silently ignores it).
    const input = searchAwardsTool.input.parse({
      filters: {
        keywords: ['solar'],
        award_type_codes: ['IDV_A', 'IDV_B'],
        agency_name: 'National Aeronautics and Space Administration',
        recipient_name: 'Boeing',
        naics_codes: ['541512'],
        time_period_start: '2023-01-01',
        time_period_end: '2023-12-31',
        recipient_id: 'abc-123-def',
      },
      limit: 5,
    });
    await searchAwardsTool.handler(input, ctx);

    const sent = mockSearchAwards.mock.calls[0][0].filters;
    expect(sent).toEqual({
      keywords: ['solar'],
      award_type_codes: ['IDV_A', 'IDV_B'],
      agencies: [
        {
          type: 'awarding',
          tier: 'toptier',
          name: 'National Aeronautics and Space Administration',
        },
      ],
      recipient_search_text: ['Boeing'],
      naics_codes: { require: ['541512'] },
      time_period: [{ start_date: '2023-01-01', end_date: '2023-12-31' }],
    });
    expect(sent).not.toHaveProperty('recipient_id');
  });

  it('nested filters take precedence over flat inputs per-field, flat fills the gaps (#21)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      keyword: 'flatword',
      agency_name: 'Department of Flat',
      award_type_codes: ['02', '03'],
      filters: { keywords: ['nestedword'], agency_name: 'Department of Nested' },
    });
    await searchAwardsTool.handler(input, ctx);

    const sent = mockSearchAwards.mock.calls[0][0].filters;
    // nested wins for keywords + agency
    expect(sent.keywords).toEqual(['nestedword']);
    expect(sent.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Nested' },
    ]);
    // flat award_type_codes preserved where nested doesn't specify
    expect(sent.award_type_codes).toEqual(['02', '03']);
  });

  it('surfaces the upstream API messages array via enrichment (#21)', async () => {
    const droppedFilterMessage =
      "The following filters from the request were not used: {'recipient_id'}. See https://api.usaspending.gov/docs/endpoints for a list of appropriate filters";
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_M' }],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
      messages: [droppedFilterMessage],
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ keyword: 'x' });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.upstream_messages).toEqual([droppedFilterMessage]);
  });

  // --- #22: agency_slug chaining field ---

  it('requests and maps agency_slug into results and format (#22)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [
        {
          generated_internal_id: 'CONT_AWD_NASA',
          'Awarding Agency': 'National Aeronautics and Space Administration',
          agency_slug: 'national-aeronautics-and-space-administration',
        },
      ],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const result = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'mars' }),
      ctx,
    );

    // agency_slug requested from the API
    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.arrayContaining(['agency_slug']) }),
      ctx,
    );
    expect(result.results[0].agency_slug).toBe('national-aeronautics-and-space-administration');

    const text = (searchAwardsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Agency Slug (for get_agency)');
    expect(text).toContain('national-aeronautics-and-space-administration');
  });

  it('treats a null agency_slug as absent, not an error (#22)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_NOPROFILE', agency_slug: null }],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext();
    const result = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'y' }),
      ctx,
    );

    expect(result.results[0]).not.toHaveProperty('agency_slug');
  });

  // --- #37: cursor pagination past the 50,000-result window ---

  it('sends the cursor pair top-level and omits page when paginating by cursor (#37)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, limit: 2 },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      last_record_sort_value: '4257135886768',
      last_record_unique_id: 295527116,
      limit: 2,
    });
    await searchAwardsTool.handler(input, ctx);

    const sent = mockSearchAwards.mock.calls[0][0];
    expect(sent.last_record_sort_value).toBe('4257135886768');
    expect(sent.last_record_unique_id).toBe(295527116);
    expect(sent).not.toHaveProperty('page');
  });

  it('round-trips the cursor: a page-1 cursor fed back is sent top-level, yielding distinct rows (#37)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_A' }],
      page_metadata: {
        hasNext: true,
        page: 1,
        limit: 1,
        last_record_sort_value: 'SV1',
        last_record_unique_id: 111,
      },
    });

    const page1 = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({ limit: 1 }),
      createMockContext(),
    );
    expect(page1.results[0].generated_internal_id).toBe('AWD_A');
    expect(page1.page_metadata.last_record_sort_value).toBe('SV1');
    expect(page1.page_metadata.last_record_unique_id).toBe(111);
    // page 1 used page-number pagination
    expect(mockSearchAwards.mock.calls[0][0]).toHaveProperty('page', 1);

    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_B' }],
      page_metadata: {
        hasNext: false,
        page: 1,
        limit: 1,
        last_record_sort_value: 'SV2',
        last_record_unique_id: 222,
      },
    });

    const page2 = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({
        limit: 1,
        last_record_sort_value: page1.page_metadata.last_record_sort_value,
        last_record_unique_id: page1.page_metadata.last_record_unique_id,
      }),
      createMockContext(),
    );

    const sent2 = mockSearchAwards.mock.calls[1][0];
    expect(sent2.last_record_sort_value).toBe('SV1');
    expect(sent2.last_record_unique_id).toBe(111);
    expect(sent2).not.toHaveProperty('page');
    // distinct row past the cursor
    expect(page2.results[0].generated_internal_id).toBe('AWD_B');
  });

  it('renders the next-page cursor in format only when has_next (#37)', () => {
    const withNext = {
      results: [{ generated_internal_id: 'AWD_1' }],
      page_metadata: {
        has_next: true,
        page: 1,
        limit: 2,
        last_record_sort_value: '4257135886768',
        last_record_unique_id: 295527116,
      },
    };
    const nextText = (searchAwardsTool.format!(withNext)[0] as { text: string }).text;
    expect(nextText).toContain('Next-page cursor');
    expect(nextText).toContain('4257135886768');
    expect(nextText).toContain('295527116');

    const lastPage = {
      results: [{ generated_internal_id: 'AWD_L' }],
      page_metadata: {
        has_next: false,
        page: 5,
        limit: 2,
        last_record_sort_value: 'X',
        last_record_unique_id: 9,
      },
    };
    const lastText = (searchAwardsTool.format!(lastPage)[0] as { text: string }).text;
    expect(lastText).not.toContain('Next-page cursor');
  });

  it('rejects a page beyond the 50,000-result window before calling the API (#37)', async () => {
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ page: 25001, limit: 2 });
    await expect(searchAwardsTool.handler(input, ctx)).rejects.toThrow();
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('allows the boundary page where offset equals exactly 50,000 (#37)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 25000, limit: 2 },
    });
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ page: 25000, limit: 2 });
    await searchAwardsTool.handler(input, ctx);
    expect(mockSearchAwards).toHaveBeenCalledTimes(1);
  });

  it('rejects a lone cursor value — both cursor fields are required together (#37)', async () => {
    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({ last_record_sort_value: 'SV_only' });
    await expect(searchAwardsTool.handler(input, ctx)).rejects.toThrow();
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('does not surface a total count — this endpoint never returns one (#37)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_T' }],
      page_metadata: { hasNext: true, page: 1, limit: 10 },
    });
    const ctx = createMockContext();
    const result = await searchAwardsTool.handler(searchAwardsTool.input.parse({ limit: 10 }), ctx);
    expect(result.page_metadata).not.toHaveProperty('total');
    expect(getEnrichment(ctx).totalCount).toBeUndefined();
  });

  // --- #39: terminal-page cursor sentinels must not crash the output schema ---

  it('does not crash or surface a cursor on a terminal page (null unique_id, "None" sort) (#39)', async () => {
    // The upstream returns last_record_unique_id: null + last_record_sort_value: "None" on
    // the final page of ANY search — including a routine empty result. A bare `!== undefined`
    // forwarded the null and failed the z.number() output schema. Validate against the real
    // schema here — that's the boundary where the crash actually fires.
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: {
        hasNext: false,
        page: 1,
        limit: 2,
        last_record_unique_id: null,
        last_record_sort_value: 'None',
      },
    });

    const ctx = createMockContext();
    const input = searchAwardsTool.input.parse({
      keyword: 'lunar regolith excavation robotics',
      limit: 2,
    });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(() => searchAwardsTool.output.parse(result)).not.toThrow();
    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata).not.toHaveProperty('last_record_unique_id');
    expect(result.page_metadata).not.toHaveProperty('last_record_sort_value');
  });

  it('still surfaces a usable cursor on an interior page, and it passes the output schema (#39)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_INT' }],
      page_metadata: {
        hasNext: true,
        page: 1,
        limit: 1,
        last_record_sort_value: '4257135886768',
        last_record_unique_id: 295_527_116,
      },
    });

    const ctx = createMockContext();
    const result = await searchAwardsTool.handler(searchAwardsTool.input.parse({ limit: 1 }), ctx);

    expect(() => searchAwardsTool.output.parse(result)).not.toThrow();
    expect(result.page_metadata.last_record_sort_value).toBe('4257135886768');
    expect(result.page_metadata.last_record_unique_id).toBe(295_527_116);
  });
});
