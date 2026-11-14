/**
 * @fileoverview Tests for search-awards tool.
 * @module tests/tools/search-awards.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockSearchAwards = vi.fn();
const mockCountAwards = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    searchAwards: mockSearchAwards,
    countAwards: mockCountAwards,
    autocompleteAwardingAgency: async () => ({ results: {} }),
  }),
}));

/** Count buckets with `n` awards in the contracts group. */
const contractCount = (n: number) => ({
  contracts: n,
  idvs: 0,
  grants: 0,
  direct_payments: 0,
  loans: 0,
  other: 0,
});

/**
 * Unless a test answers the count, the count request fails as the service
 * classifies an unreachable upstream, so the total stays unknown and paging keeps
 * the page-fullness rule the #37, #44, and #76 cases pin.
 */
beforeEach(() => {
  mockCountAwards.mockReset();
  mockCountAwards.mockRejectedValue(
    serviceUnavailable('USAspending API is unavailable.', {
      reason: 'api_unavailable',
      retryable: true,
    }),
  );
});

describe('searchAwardsTool', () => {
  it.each([
    { agency_name: 'U.S. Geological Survey' },
    { filters: { agency_name: 'U.S. Geological Survey' } },
  ])('wires dual-tier matching and preserves the agency echo for %j', async (args) => {
    mockSearchAwards.mockResolvedValueOnce({ results: [], page_metadata: { hasNext: false } });
    const response = await runToolContract(searchAwardsTool, args);
    expect(response.isError).toBeFalsy();
    expect(mockSearchAwards.mock.lastCall?.[0].filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'U.S. Geological Survey' },
      { type: 'awarding', tier: 'subtier', name: 'U.S. Geological Survey' },
    ]);
    expect(response.structuredContent).toMatchObject({
      results: [],
      applied_agency_name: 'U.S. Geological Survey',
    });
    expect(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    ).toContain('U.S. Geological Survey');
  });
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
          'Primary Place of Performance': { city_name: 'Seattle' },
          'Place of Performance State Code': 'WA',
          'Place of Performance Country Code': 'USA',
          'Awarding Agency Code': '097',
        },
      ],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'IT services', limit: 10 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.award_id).toBe('CONT_AWD_TEST');
    expect(result.results[0]!.generated_internal_id).toBe('CONT_AWD_TEST_ID');
    expect(result.results[0]!.recipient_name).toBe('Acme Corp');
    expect(result.results[0]!.award_amount).toBe(1_000_000);
    expect(result.results[0]!.awarding_agency).toBe('Department of Defense');
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ limit: 5 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toContain('Page 1 returned no awards');
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ limit: 5 });
    await searchAwardsTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_keyword).toBeUndefined();
    expect(enrichment.applied_agency_name).toBeUndefined();
    expect(enrichment.applied_naics_codes).toBeUndefined();
  });

  // --- #21: analytics-style nested filters object ---

  it('nested filters take precedence over flat inputs per-field, flat fills the gaps (#21)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({
      keyword: 'flatword',
      agency_name: 'Department of Flat',
      award_type_codes: ['02', '03'],
      filters: { keywords: ['nestedword'], agency_name: 'Department of Nested' },
    });
    await searchAwardsTool.handler(input, ctx);

    const sent = mockSearchAwards.mock.calls[0]![0]!.filters;
    // nested wins for keywords + agency
    expect(sent.keywords).toEqual(['nestedword']);
    expect(sent.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'Department of Nested' },
      { type: 'awarding', tier: 'subtier', name: 'Department of Nested' },
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'xxx' });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const result = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'mars' }),
      ctx,
    );

    // agency_slug requested from the API
    expect(mockSearchAwards).toHaveBeenCalledWith(
      expect.objectContaining({ fields: expect.arrayContaining(['agency_slug']) }),
      ctx,
    );
    expect(result.results[0]!.agency_slug).toBe('national-aeronautics-and-space-administration');

    const text = (searchAwardsTool.format!(result)[0] as { text: string }).text;
    expect(text).toContain('Agency Slug (for get_agency)');
    expect(text).toContain('national-aeronautics-and-space-administration');
  });

  it('treats a null agency_slug as absent, not an error (#22)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_NOPROFILE', agency_slug: null }],
      page_metadata: { hasNext: false, page: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const result = await searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'yyy' }),
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({
      last_record_sort_value: '4257135886768',
      last_record_unique_id: 295527116,
      limit: 2,
    });
    await searchAwardsTool.handler(input, ctx);

    const sent = mockSearchAwards.mock.calls[0]![0];
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
      createMockContext({ errors: searchAwardsTool.errors }),
    );
    expect(page1.results[0]!.generated_internal_id).toBe('AWD_A');
    expect(page1.page_metadata.last_record_sort_value).toBe('SV1');
    expect(page1.page_metadata.last_record_unique_id).toBe(111);
    // page 1 used page-number pagination
    expect(mockSearchAwards.mock.calls[0]![0]).toHaveProperty('page', 1);

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
      createMockContext({ errors: searchAwardsTool.errors }),
    );

    const sent2 = mockSearchAwards.mock.calls[1]![0];
    expect(sent2.last_record_sort_value).toBe('SV1');
    expect(sent2.last_record_unique_id).toBe(111);
    expect(sent2).not.toHaveProperty('page');
    // distinct row past the cursor
    expect(page2.results[0]!.generated_internal_id).toBe('AWD_B');
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
    expect(mockCountAwards).not.toHaveBeenCalled();
  });

  it('names the page, the limit, and the window when refusing a page past it (#37)', async () => {
    const result = await runToolContract(searchAwardsTool, { page: 25001, limit: 2 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message:
          "Requested page 25001 at limit 2 exceeds this endpoint's 50,000-result page-number window.",
        data: { reason: 'pagination_limit_exceeded' },
      },
    });
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

  it('rejects a pre-2007-10-01 flat time_period before calling the API (#38)', async () => {
    // Upstream answers this with a bare 422; the guard must pre-empt it with the
    // declared reason and an actionable recovery hint. The framework fills the
    // hint from the contract on the error envelope, which runToolContract applies.
    const result = await runToolContract(searchAwardsTool, {
      time_period: { start_date: '2005-01-01', end_date: '2006-01-01' },
      limit: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'date_before_earliest',
          recovery: { hint: expect.stringContaining('2007-10-01') },
        },
      },
    });
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('rejects a pre-2007-10-01 nested filters.time_period_start too (#38)', async () => {
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({
      filters: { time_period_start: '2005-01-01', time_period_end: '2006-01-01' },
      limit: 1,
    });

    await expect(searchAwardsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_before_earliest' },
    });
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('rejects a range that merely starts before the floor (#38)', async () => {
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({
      time_period: { start_date: '2007-09-30', end_date: '2007-12-01' },
      limit: 1,
    });

    await expect(searchAwardsTool.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'date_before_earliest' },
    });
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('allows a start date exactly on the 2007-10-01 floor (#38)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, limit: 1 },
    });
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({
      time_period: { start_date: '2007-10-01', end_date: '2007-12-01' },
      limit: 1,
    });

    await searchAwardsTool.handler(input, ctx);
    expect(mockSearchAwards).toHaveBeenCalledTimes(1);
  });

  it('rejects a lone cursor value — both cursor fields are required together (#37)', async () => {
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ last_record_sort_value: 'SV_only' });
    await expect(searchAwardsTool.handler(input, ctx)).rejects.toThrow();
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it('reports the count as page_metadata.total and totalCount — spending_by_award sends none (#114)', async () => {
    mockCountAwards.mockResolvedValue(contractCount(4_079_943));
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_T' }],
      page_metadata: { hasNext: true, page: 1, limit: 10 },
    });
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const result = await searchAwardsTool.handler(searchAwardsTool.input.parse({ limit: 10 }), ctx);
    expect(result.page_metadata.total).toBe(4_079_943);
    expect(getEnrichment(ctx).totalCount).toBe(4_079_943);
  });

  it('reports no total when the count fails (#114)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'AWD_T' }],
      page_metadata: { hasNext: true, page: 1, limit: 10 },
    });
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
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

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const result = await searchAwardsTool.handler(searchAwardsTool.input.parse({ limit: 1 }), ctx);

    expect(() => searchAwardsTool.output.parse(result)).not.toThrow();
    expect(result.page_metadata.last_record_sort_value).toBe('4257135886768');
    expect(result.page_metadata.last_record_unique_id).toBe(295_527_116);
  });

  // --- #44: continuation past the offset where upstream stops advertising it ---

  /**
   * The live page_metadata at and past a 10,000-result offset: full rows, hasNext
   * false, and both cursor values replaced by their end-of-results sentinels.
   */
  const boundaryPageMetadata = (page: number) => ({
    page,
    hasNext: false,
    limit: 100,
    last_record_unique_id: null,
    last_record_sort_value: 'None',
  });

  it('treats a full page as continuing when upstream reports hasNext false (#44)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: Array.from({ length: 100 }, (_, i) => ({
        generated_internal_id: `CONT_AWD_BOUNDARY_${i}`,
      })),
      page_metadata: boundaryPageMetadata(100),
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'defense', page: 100, limit: 100 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(() => searchAwardsTool.output.parse(result)).not.toThrow();
    expect(result.page_metadata.has_next).toBe(true);
    // The cursor sentinels are still unusable — continuation must not fabricate one.
    expect(result.page_metadata).not.toHaveProperty('last_record_sort_value');
    expect(result.page_metadata).not.toHaveProperty('last_record_unique_id');

    const enrichment = getEnrichment(ctx);
    expect(enrichment.has_next).toBe(true);
    // Past the boundary upstream hasNext is always false, so there is no evidence of
    // withheld rows — truncated stays unset while the notice still says more may remain (#76).
    expect(enrichment.truncated).toBeUndefined();
    expect(enrichment.shown).toBeUndefined();
    expect(enrichment.cap).toBeUndefined();
    expect(enrichment.notice).toContain('More results may remain');
  });

  // --- #76: truncated means rows are known to exist beyond the page ---

  it('sets no truncated on an exactly-full final page, keeping has_next (#76)', async () => {
    // Live: keyword "zyxel" at limit 4 returns 4 rows with hasNext false; page 2 is empty.
    mockSearchAwards.mockResolvedValueOnce({
      results: Array.from({ length: 4 }, (_, i) => ({ generated_internal_id: `CONT_AWD_Z${i}` })),
      page_metadata: {
        page: 1,
        hasNext: false,
        last_record_unique_id: null,
        last_record_sort_value: 'None',
      },
    });

    const result = await runToolContract(searchAwardsTool, { keyword: 'zyxel', limit: 4 });

    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect((sc.page_metadata as { has_next: boolean }).has_next).toBe(true);
    expect(sc.has_next).toBe(true);
    expect(sc.truncated).toBeUndefined();
    expect(sc.shown).toBeUndefined();
    expect(sc.cap).toBeUndefined();
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**Has next:** Yes');
    expect(text).not.toContain('**truncated:**');
  });

  it('sets truncated from the upstream hasNext on both surfaces (#76)', async () => {
    // Live: "zyxel" at limit 3 — three rows, hasNext true, and a usable cursor.
    mockSearchAwards.mockResolvedValueOnce({
      results: Array.from({ length: 3 }, (_, i) => ({ generated_internal_id: `CONT_AWD_Z${i}` })),
      page_metadata: {
        page: 1,
        hasNext: true,
        last_record_unique_id: 301640553,
        last_record_sort_value: '108425',
      },
    });

    const result = await runToolContract(searchAwardsTool, { keyword: 'zyxel', limit: 3 });

    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.truncated).toBe(true);
    expect(sc.shown).toBe(3);
    expect(sc.cap).toBe(3);
    expect(sc.notice).toContain('More results may remain');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('**truncated:** true');
  });

  it('keeps reporting continuation on every page past the boundary (#44)', async () => {
    // The upstream lie does not reset one page later — page 101 carries it too.
    mockSearchAwards.mockResolvedValueOnce({
      results: Array.from({ length: 100 }, (_, i) => ({
        generated_internal_id: `CONT_AWD_PAST_${i}`,
      })),
      page_metadata: boundaryPageMetadata(101),
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'defense', page: 101, limit: 100 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.page_metadata.has_next).toBe(true);
    expect(result.page_metadata.page).toBe(101);
  });

  it('reports the end of results on a short final page (#44)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [{ generated_internal_id: 'CONT_AWD_LAST' }],
      page_metadata: { hasNext: false, page: 7, limit: 10 },
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'defense', page: 7, limit: 10 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.page_metadata.has_next).toBe(false);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('reports the end of results on an empty page (#44)', async () => {
    mockSearchAwards.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 8, limit: 10 },
    });

    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'defense', page: 8, limit: 10 });
    const result = await searchAwardsTool.handler(input, ctx);

    expect(result.page_metadata.has_next).toBe(false);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('directs to page numbers in format when continuing without a cursor (#44)', () => {
    const output = {
      results: [{ generated_internal_id: 'CONT_AWD_BOUNDARY_0' }],
      page_metadata: { has_next: true, page: 100, limit: 100 },
    };

    const text = (searchAwardsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Next page:** request page 101');
    expect(text).not.toContain('Next-page cursor');
  });

  it('does not blame the cursor window on an exactly-full final page (#44)', () => {
    // page 1 at limit 1: the cursor is absent because this is the last page, not
    // because the 10,000-result window was crossed. Attributing it to the window
    // tells the agent it has paged far past a boundary it is nowhere near.
    const output = {
      results: [{ generated_internal_id: 'CONT_AWD_ONLY' }],
      page_metadata: { has_next: true, page: 1, limit: 1 },
    };

    const text = (searchAwardsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Next page:** request page 2');
    expect(text).toContain('final page');
    expect(text).not.toContain('only way forward');
  });

  it('does not direct past the page-number cap when no cursor is offered (#44)', () => {
    // page 500 at limit 100 is the last servable page — the handler's own
    // pagination_limit_exceeded guard rejects page 501, so format() must not send
    // the caller there.
    const output = {
      results: [{ generated_internal_id: 'CONT_AWD_CAP' }],
      page_metadata: { has_next: true, page: 500, limit: 100 },
    };

    const text = (searchAwardsTool.format!(output)[0] as { text: string }).text;
    expect(text).not.toContain('request page 501');
    expect(text).toContain('**No further pages reachable:**');
  });

  // --- #50: the API-notices trailer heading ---

  it('renders the API notices heading in the content[] trailer (#50)', () => {
    const trailer = searchAwardsTool.enrichmentTrailer?.upstream_messages;
    // A sibling `label` never renders — the trailer renderer treats `render` as a
    // full escape hatch — so the heading has to come from `render` itself.
    expect(trailer?.label).toBeUndefined();

    const rendered = trailer?.render?.([
      'For searches, time period start and end dates are currently limited to an earliest date of 2007-10-01.',
      "The following filters from the request were not used: {'recipient_id'}.",
    ]);

    expect(rendered).toContain('**API notices:**');
    expect(rendered?.split('\n')[0]).toBe('**API notices:**');
    expect(rendered).toContain('- For searches, time period start and end dates');
    expect(rendered).toContain('- The following filters from the request were not used');
  });

  it('closes the API notices list so the next trailer entry gets its own line', () => {
    // The framework joins trailer entries with a single '\n'. Without a blank line
    // after the last bullet, the next entry (`**applied_keyword:** …`) lands on the
    // line right below it, which a strict markdown renderer folds into that bullet
    // as a lazy continuation.
    const rendered = searchAwardsTool.enrichmentTrailer?.upstream_messages?.render?.([
      "The following filters from the request were not used: {'recipient_id'}.",
    ]);

    expect(rendered?.endsWith('\n')).toBe(true);

    const joined = [rendered, '**applied_keyword:** solar'].join('\n');
    const lines = joined.split('\n');
    expect(lines.at(-1)).toBe('**applied_keyword:** solar');
    expect(lines.at(-2)).toBe('');
  });
});

// --- #70: location_filter shapes ---

describe('searchAwardsTool location_filter (#70)', () => {
  const run = (location_filter: Record<string, unknown>) =>
    runToolContract(searchAwardsTool, { location_filter, limit: 2 });
  const sentLocations = () =>
    mockSearchAwards.mock.calls.at(-1)?.[0].filters.place_of_performance_locations;

  beforeEach(() => {
    mockSearchAwards.mockReset();
    mockSearchAwards.mockResolvedValue({
      results: [{ 'Award ID': 'A1', generated_internal_id: 'CONT_AWD_A1' }],
      page_metadata: { hasNext: false, page: 1 },
    });
  });

  it('sends a canonical location unchanged', async () => {
    const result = await run({ country: 'USA', state: 'NM', county: '049', city: 'Albuquerque' });

    expect(result.isError).toBeFalsy();
    expect(sentLocations()).toEqual([
      { country: 'USA', state: 'NM', county: '049', city: 'Albuquerque' },
    ]);
  });

  it('leaves blank fields out of the location it sends', async () => {
    const result = await run({ country: 'USA', state: '', county: '', city: '' });

    expect(result.isError).toBeFalsy();
    expect(sentLocations()).toEqual([{ country: 'USA' }]);
  });

  it.each([
    ['country omitted', { state: 'NM' }, { country: 'USA', state: 'NM' }],
    ['lowercase codes', { country: 'usa', state: 'nm' }, { country: 'USA', state: 'NM' }],
    ['a 2-digit state FIPS code', { country: 'USA', state: '35' }, { country: 'USA', state: 'NM' }],
    ['DC', { state: 'DC' }, { country: 'USA', state: 'DC' }],
    ['PRI', { country: 'PRI' }, { country: 'USA', state: 'PR' }],
    ['GUM', { country: 'GUM' }, { country: 'USA', state: 'GU' }],
    ['VIR', { country: 'VIR' }, { country: 'USA', state: 'VI' }],
    ['ASM', { country: 'ASM' }, { country: 'USA', state: 'AS' }],
    ['MNP', { country: 'MNP' }, { country: 'USA', state: 'MP' }],
    [
      'a territory code with its own postal state',
      { country: 'PRI', state: 'PR' },
      { country: 'USA', state: 'PR' },
    ],
    [
      'a territory code with its own FIPS state',
      { country: 'PRI', state: '72' },
      { country: 'USA', state: 'PR' },
    ],
    [
      'a 5-digit county with a matching state',
      { country: 'USA', state: 'NM', county: '35049' },
      { country: 'USA', state: 'NM', county: '049' },
    ],
    [
      'a 5-digit county alone, taking the state from its prefix',
      { county: '35049' },
      { country: 'USA', state: 'NM', county: '049' },
    ],
    [
      'a 5-digit county with a matching FIPS state',
      { state: '35', county: '35049' },
      { country: 'USA', state: 'NM', county: '049' },
    ],
    [
      'a 3-digit county inside a territory code',
      { country: 'PRI', county: '127' },
      { country: 'USA', state: 'PR', county: '127' },
    ],
    [
      'a 5-digit county inside a territory code',
      { country: 'PRI', county: '72127' },
      { country: 'USA', state: 'PR', county: '127' },
    ],
    ['a city alone', { city: 'Albuquerque' }, { country: 'USA', city: 'Albuquerque' }],
    ['a non-USA country', { country: 'CAN' }, { country: 'CAN' }],
    [
      'a non-USA country with a city',
      { country: 'can', city: 'Toronto' },
      { country: 'CAN', city: 'Toronto' },
    ],
    [
      "a non-USA country with that country's letter state",
      { country: 'can', state: 'on' },
      { country: 'CAN', state: 'ON' },
    ],
    [
      'a non-USA country with a letter state and a city',
      { country: 'CAN', state: 'ON', city: 'Ottawa' },
      { country: 'CAN', state: 'ON', city: 'Ottawa' },
    ],
    ['an armed-forces code (AE)', { state: 'ae' }, { country: 'USA', state: 'AE' }],
    ['an armed-forces code (AA)', { country: 'USA', state: 'AA' }, { country: 'USA', state: 'AA' }],
    ['an armed-forces code (AP)', { state: 'AP' }, { country: 'USA', state: 'AP' }],
    ['a freely associated state (FM)', { state: 'FM' }, { country: 'USA', state: 'FM' }],
    ['a freely associated state (MH)', { state: 'MH' }, { country: 'USA', state: 'MH' }],
    ['a freely associated state (PW)', { state: 'PW' }, { country: 'USA', state: 'PW' }],
    ['the Minor Outlying Islands (UM)', { state: 'UM' }, { country: 'USA', state: 'UM' }],
    ['the FIPS code of FM', { state: '64' }, { country: 'USA', state: 'FM' }],
    ['the FIPS code of UM', { state: '74' }, { country: 'USA', state: 'UM' }],
    [
      'whitespace-only fields as blank',
      { country: ' ', state: 'NM', county: '  ', city: '\t' },
      { country: 'USA', state: 'NM' },
    ],
  ])('normalizes %s', async (_label, location, sent) => {
    const result = await run(location);

    expect(result.isError).toBeFalsy();
    expect(sentLocations()).toEqual([sent]);
  });

  it('sends a 5-digit county exactly as its 3-digit form with the state', async () => {
    await run({ state: 'NM', county: '049' });
    const canonical = mockSearchAwards.mock.calls.at(-1)?.[0];
    await run({ county: '35049' });
    expect(mockSearchAwards.mock.calls.at(-1)?.[0]).toEqual(canonical);
  });

  it('reads a numeric state FIPS code the caller sent as a number', async () => {
    const result = await run({ state: 35 });

    expect(result.isError).toBeFalsy();
    expect(sentLocations()).toEqual([{ country: 'USA', state: 'NM' }]);
  });

  it.each([
    ['an unknown postal state', { state: 'ZZ' }, 'location_filter.state "ZZ"'],
    ['an unknown FIPS state', { country: 'USA', state: '99' }, 'location_filter.state "99"'],
    [
      'a 5-digit county prefix contradicting state',
      { country: 'USA', state: 'NM', county: '06037' },
      'location_filter.county "06037"',
    ],
    [
      'a 5-digit county with an unknown state prefix',
      { county: '99049' },
      'location_filter.county "99049"',
    ],
    ['a 3-digit county without state', { county: '049' }, 'location_filter.county "049"'],
    [
      'a 3-digit county without state, country given',
      { country: 'USA', county: '049' },
      'location_filter.county "049"',
    ],
    [
      'a FIPS-number state with a non-USA country',
      { country: 'CAN', state: '35' },
      'location_filter.country',
    ],
    [
      'a 5-digit county with an armed-forces state',
      { state: 'AE', county: '35049' },
      'location_filter.county "35049"',
    ],
    [
      'a 3-digit county with an armed-forces state',
      { state: 'AE', county: '049' },
      'location_filter.county "049"',
    ],
    [
      'a county with a non-USA country',
      { country: 'CAN', county: '049' },
      'location_filter.country',
    ],
    [
      'a state contradicting a territory code',
      { country: 'PRI', state: 'NM' },
      'location_filter.state "NM"',
    ],
    [
      'a 5-digit county contradicting a territory code',
      { country: 'PRI', county: '35049' },
      'location_filter.county "35049"',
    ],
  ])('rejects %s as invalid_location before any request', async (_label, location, names) => {
    const result = await run(location);

    expect(result.isError).toBe(true);
    const error = (
      result.structuredContent as {
        error: {
          code: number;
          message: string;
          data: { reason: string; recovery: { hint: string } };
        };
      }
    ).error;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_location');
    expect(error.message).toContain(names);
    expect(error.message).not.toContain('undefined');
    // The message names the path; the recovery serves all three location inputs (#109).
    expect(error.data.recovery.hint).toContain('5-digit state + county code (35049)');
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain(names);
    expect(text).toContain('Recovery:');
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it.each([
    ['country', 'US'],
    ['country', 'USAA'],
    ['country', 'U5A'],
    ['state', 'N'],
    ['state', 'NMX'],
    ['state', 'New Mexico'],
    ['state', '355'],
    ['county', 'ABC'],
    ['county', '49'],
    ['county', '0490'],
    ['county', '350490'],
    ['county', ' 049'],
  ])(
    'rejects a malformed %s (%j) at argument validation, naming the field',
    async (field, value) => {
      const result = await run({ state: 'NM', [field]: value });

      expect(result.isError).toBe(true);
      const error = (result.structuredContent as { error: { code: number; message: string } })
        .error;
      expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
      expect(error.message).toContain(`location_filter.${field}`);
      expect(mockSearchAwards).not.toHaveBeenCalled();
    },
  );

  it('advertises each code field as anyOf ["", pattern] and leaves city free text', () => {
    type Node = {
      anyOf?: Node[];
      const?: unknown;
      description?: string;
      pattern?: string;
      type?: string;
    };
    const schema = z.toJSONSchema(searchAwardsTool.input, { io: 'input' }) as {
      properties: Record<string, { properties?: Record<string, Node> }>;
    };
    const fields = schema.properties.location_filter?.properties ?? {};
    for (const field of ['country', 'state', 'county']) {
      const branches = fields[field]?.anyOf ?? [];
      expect(branches.some((b) => b.const === '')).toBe(true);
      expect(branches.map((b) => b.pattern).filter(Boolean)).toHaveLength(1);
      expect(fields[field]?.description).toEqual(expect.any(String));
    }
    expect(fields.city?.type).toBe('string');
  });

  it('echoes the location sent on both surfaces', async () => {
    const result = await run({ county: '35049', city: 'Albuquerque' });

    expect(result.structuredContent).toMatchObject({
      applied_location: 'country=USA, state=NM, county=049, city=Albuquerque',
    });
    const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    expect(text).toContain('country=USA, state=NM, county=049, city=Albuquerque');
  });

  it('names the location sent in the empty-result notice', async () => {
    mockSearchAwards.mockResolvedValue({ results: [], page_metadata: { hasNext: false, page: 1 } });

    const result = await run({ country: 'PRI' });

    expect(result.structuredContent).toMatchObject({
      applied_location: 'country=USA, state=PR',
      notice: expect.stringContaining('location="country=USA, state=PR"'),
    });
  });

  it('echoes no location when none was sent', async () => {
    const result = await run({ country: '', state: '', county: '', city: '' });

    expect(result.structuredContent).not.toHaveProperty('applied_location');
    expect(sentLocations()).toBeUndefined();
  });
});

// --- #109: filters.place_of_performance_location and filters.recipient_location ---

/**
 * Wiring of the shared location filters, whose normalization is tabled once in
 * tests/utils/filters.test.ts: both nested keys reach the one `filters` object the
 * search and the count share, the nested place of performance wins over the flat
 * location_filter, both are echoed and named in the empty-result notice, and a
 * rejected nested location names its own path.
 */
describe('searchAwardsTool nested location filters (#109)', () => {
  type Result = Awaited<ReturnType<typeof runToolContract>>;
  const run = (args: Record<string, unknown>) =>
    runToolContract(searchAwardsTool, { limit: 2, ...args });
  const sentFilters = () =>
    mockSearchAwards.mock.calls.at(-1)?.[0].filters as Record<string, unknown>;
  const textOf = (result: Result) =>
    markdownText(result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n'));

  beforeEach(() => {
    mockSearchAwards.mockReset();
    mockSearchAwards.mockResolvedValue({
      results: [{ 'Award ID': 'A1', generated_internal_id: 'CONT_AWD_A1' }],
      page_metadata: { hasNext: false, page: 1 },
    });
    mockCountAwards.mockResolvedValue(contractCount(1));
  });

  it('sends the request it sent before the nested keys existed, when neither is given', async () => {
    const result = await run({
      keyword: 'bridge',
      location_filter: { state: 'WA', county: '033' },
      filters: {
        naics_codes: ['237310'],
        time_period_start: '2024-10-01',
        time_period_end: '2025-09-30',
      },
      page: 2,
    });

    expect(result.isError).toBeFalsy();
    const filters = {
      keywords: ['bridge'],
      award_type_codes: ['A', 'B', 'C', 'D'],
      naics_codes: { require: ['237310'] },
      time_period: [{ start_date: '2024-10-01', end_date: '2025-09-30' }],
      place_of_performance_locations: [{ country: 'USA', state: 'WA', county: '033' }],
    };
    expect(mockSearchAwards.mock.calls[0]![0]).toEqual({
      filters,
      fields: expect.any(Array),
      sort: 'Award Amount',
      order: 'desc',
      limit: 2,
      page: 2,
    });
    expect(mockCountAwards.mock.calls[0]![0]).toEqual(filters);
    expect(result.structuredContent).toMatchObject({
      applied_location: 'country=USA, state=WA, county=033',
    });
    expect(result.structuredContent).not.toHaveProperty('applied_recipient_location');
  });

  it('sends filters.place_of_performance_location to the search and the count, echoed as applied_location', async () => {
    const result = await run({ filters: { place_of_performance_location: { county: '35049' } } });

    expect(result.isError).toBeFalsy();
    const filters = sentFilters();
    expect(filters.place_of_performance_locations).toEqual([
      { country: 'USA', state: 'NM', county: '049' },
    ]);
    expect(filters).not.toHaveProperty('place_of_performance_location');
    expect(filters).not.toHaveProperty('recipient_locations');
    expect(mockCountAwards.mock.calls[0]![0]).toBe(filters);
    expect(result.structuredContent).toMatchObject({
      applied_location: 'country=USA, state=NM, county=049',
    });
    expect(result.structuredContent).not.toHaveProperty('applied_recipient_location');
    expect(textOf(result)).toContain('country=USA, state=NM, county=049');
  });

  it('sends filters.recipient_location as recipient_locations beside a flat location_filter, echoing each', async () => {
    const result = await run({
      location_filter: { state: 'NM' },
      filters: { recipient_location: { country: 'PRI' } },
    });

    expect(result.isError).toBeFalsy();
    const filters = sentFilters();
    expect(filters.place_of_performance_locations).toEqual([{ country: 'USA', state: 'NM' }]);
    expect(filters.recipient_locations).toEqual([{ country: 'USA', state: 'PR' }]);
    expect(filters).not.toHaveProperty('recipient_location');
    expect(mockCountAwards.mock.calls[0]![0]).toBe(filters);
    expect(result.structuredContent).toMatchObject({
      applied_location: 'country=USA, state=NM',
      applied_recipient_location: 'country=USA, state=PR',
    });
    const text = textOf(result);
    expect(text).toContain('country=USA, state=NM');
    expect(text).toContain('country=USA, state=PR');
  });

  it('lets a nested place of performance override the flat location_filter', async () => {
    const result = await run({
      location_filter: { state: 'NM', county: '049' },
      filters: { place_of_performance_location: { state: 'WA' } },
    });

    expect(result.isError).toBeFalsy();
    expect(sentFilters().place_of_performance_locations).toEqual([{ country: 'USA', state: 'WA' }]);
    expect(result.structuredContent).toMatchObject({ applied_location: 'country=USA, state=WA' });
  });

  it('neither sends nor rejects a flat location_filter the nested place of performance overrides', async () => {
    // A 3-digit county without a state fails on its own (#70), but this one is never sent.
    const result = await run({
      location_filter: { county: '049' },
      filters: { place_of_performance_location: { state: 'WA' } },
    });

    expect(result.isError).toBeFalsy();
    expect(sentFilters().place_of_performance_locations).toEqual([{ country: 'USA', state: 'WA' }]);
  });

  it('falls back to the flat location_filter when the nested place of performance is all blank', async () => {
    const result = await run({
      location_filter: { state: 'NM' },
      filters: {
        place_of_performance_location: { country: '', state: '', county: '', city: '' },
        recipient_location: { country: '', state: '', county: '', city: '' },
      },
    });

    expect(result.isError).toBeFalsy();
    expect(sentFilters().place_of_performance_locations).toEqual([{ country: 'USA', state: 'NM' }]);
    expect(sentFilters()).not.toHaveProperty('recipient_locations');
    expect(result.structuredContent).not.toHaveProperty('applied_recipient_location');
  });

  it('names both locations sent in the empty-result notice', async () => {
    mockSearchAwards.mockResolvedValue({ results: [], page_metadata: { hasNext: false, page: 1 } });
    mockCountAwards.mockResolvedValue(contractCount(0));

    const result = await run({
      filters: {
        place_of_performance_location: { state: 'WA' },
        recipient_location: { state: 'NM', county: '049' },
      },
    });

    const notice =
      'No awards match place_of_performance_location="country=USA, state=WA", recipient_location="country=USA, state=NM, county=049", types=A,B,C,D.';
    expect(result.structuredContent).toMatchObject({
      notice: `Results use USAspending's available coverage without a date filter. ${notice}`,
    });
    expect(textOf(result)).toContain(notice);
  });

  it.each(['place_of_performance_location', 'recipient_location'] as const)(
    'rejects a contradictory filters.%s as invalid_location naming its path, before any request',
    async (key) => {
      const result = await run({
        location_filter: { state: 'WA' },
        filters: { [key]: { state: 'NM', county: '06037' } },
      });

      expect(result.isError).toBe(true);
      const error = (
        result.structuredContent as {
          error: {
            code: number;
            message: string;
            data: { reason: string; recovery: { hint: string } };
          };
        }
      ).error;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_location');
      expect(error.message).toContain(`filters.${key}.county "06037"`);
      expect(error.message).not.toContain('location_filter');
      expect(error.data.recovery.hint).not.toContain('location_filter');
      expect(textOf(result)).toContain(`filters.${key}.county "06037"`);
      expect(mockSearchAwards).not.toHaveBeenCalled();
      expect(mockCountAwards).not.toHaveBeenCalled();
    },
  );
});

// --- #114: recipient IDs on rows, and the total from the count request ---

describe('searchAwardsTool total count and recipient IDs (#114)', () => {
  type Result = Awaited<ReturnType<typeof runToolContract>>;
  type Content = Record<string, unknown> & { page_metadata: Record<string, unknown> };
  const textOf = (result: Result) =>
    result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const contentOf = (result: Result) => result.structuredContent as Content;
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ generated_internal_id: `CONT_AWD_${i}` }));
  /** The page_metadata upstream sends on a page it marks as last, or past a 10,000 offset. */
  const lastPageMeta = (page: number) => ({
    page,
    hasNext: false,
    last_record_unique_id: null,
    last_record_sort_value: 'None',
  });
  const answer = (results: unknown[], page_metadata: Record<string, unknown>) =>
    mockSearchAwards.mockResolvedValueOnce({ results, page_metadata });

  beforeEach(() => {
    mockSearchAwards.mockReset();
  });

  it('requests the recipient fields and returns them on both surfaces, omitting nulls', async () => {
    mockCountAwards.mockResolvedValue(contractCount(2));
    answer(
      [
        {
          'Award ID': '36C10B18N0006',
          generated_internal_id: 'CONT_AWD_36C10B18N0006_3600_36C10B18D5000_3600',
          'Recipient Name': 'Acme Corp',
          recipient_id: '9232b26d-789d-bdd2-5a6d-28714f1dfa2c-C',
          'Recipient UEI': 'DT2KS3HH5FP5',
        },
        {
          'Award ID': 'AGGREGATE',
          generated_internal_id: 'ASST_AGG_1',
          'Recipient Name': 'MULTIPLE RECIPIENTS',
          recipient_id: null,
          'Recipient UEI': null,
        },
      ],
      lastPageMeta(1),
    );

    const result = await runToolContract(searchAwardsTool, { limit: 5 });

    expect(result.isError).toBeFalsy();
    expect(mockSearchAwards.mock.calls[0]![0].fields).toEqual(
      expect.arrayContaining(['recipient_id', 'Recipient UEI']),
    );
    const [first, aggregate] = contentOf(result).results as Record<string, unknown>[];
    expect(first).toMatchObject({
      recipient_id: '9232b26d-789d-bdd2-5a6d-28714f1dfa2c-C',
      uei: 'DT2KS3HH5FP5',
    });
    expect(aggregate).not.toHaveProperty('recipient_id');
    expect(aggregate).not.toHaveProperty('uei');
    const text = textOf(result);
    expect(text).toContain(
      '**Recipient ID (for get_recipient):** 9232b26d-789d-bdd2-5a6d-28714f1dfa2c-C',
    );
    expect(text).toContain('**UEI:** DT2KS3HH5FP5');
    expect(text.match(/\*\*UEI:\*\*/g)).toHaveLength(1);
  });

  it('sends the count the very filters object the search sends, beside it, with a 10 s deadline', async () => {
    let releaseSearch: (value: unknown) => void = () => undefined;
    mockSearchAwards.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseSearch = resolve;
      }),
    );
    mockCountAwards.mockResolvedValue(contractCount(1));
    const before = Date.now();

    const pending = searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'hydrographic', location_filter: { state: 'WA' } }),
      createMockContext({ errors: searchAwardsTool.errors }),
    );
    // The count left while the search was still in flight.
    expect(mockCountAwards).toHaveBeenCalledTimes(1);
    const after = Date.now();
    releaseSearch({ results: rows(1), page_metadata: lastPageMeta(1) });
    await pending;

    const [countFilters, , deadlineAt] = mockCountAwards.mock.calls[0]!;
    expect(countFilters).toBe(mockSearchAwards.mock.calls[0]![0].filters);
    expect(countFilters).toMatchObject({
      keywords: ['hydrographic'],
      place_of_performance_locations: [{ country: 'USA', state: 'WA' }],
    });
    expect(deadlineAt).toBeGreaterThanOrEqual(before + 10_000);
    expect(deadlineAt).toBeLessThanOrEqual(after + 10_000);
  });

  it.each([
    {
      label: 'an exactly-full last page',
      page: 2,
      limit: 5,
      shown: 5,
      upstreamHasNext: false,
      total: 10,
      hasNext: false,
    },
    {
      label: 'a full interior page past a 10,000-result offset',
      page: 101,
      limit: 100,
      shown: 100,
      upstreamHasNext: false,
      total: 20_000,
      hasNext: true,
    },
    {
      label: 'a short last page',
      page: 3,
      limit: 5,
      shown: 2,
      upstreamHasNext: false,
      total: 12,
      hasNext: false,
    },
    {
      label: 'an interior page the upstream also flags',
      page: 1,
      limit: 5,
      shown: 5,
      upstreamHasNext: true,
      total: 12,
      hasNext: true,
    },
  ])('decides has_next and truncated from the total on $label', async (c) => {
    mockCountAwards.mockResolvedValue(contractCount(c.total));
    answer(rows(c.shown), { ...lastPageMeta(c.page), hasNext: c.upstreamHasNext });

    const result = await runToolContract(searchAwardsTool, {
      keyword: 'defense',
      page: c.page,
      limit: c.limit,
    });

    const sc = contentOf(result);
    expect(sc.page_metadata).toMatchObject({ has_next: c.hasNext, total: c.total });
    expect(sc).toMatchObject({ has_next: c.hasNext, totalCount: c.total });
    if (c.hasNext) {
      expect(sc).toMatchObject({ truncated: true, shown: c.shown, cap: c.limit });
      expect(sc.notice).toContain(`Request page ${c.page + 1}`);
    } else {
      expect(sc).not.toHaveProperty('truncated');
      expect(sc.notice).toBe("Results use USAspending's available coverage without a date filter.");
    }
    const text = textOf(result);
    expect(text).toContain(`**Has next:** ${c.hasNext ? 'Yes' : 'No'}`);
    expect(text).toContain(`**Total matches:** ${c.total.toLocaleString()}`);
    if (!c.hasNext) expect(text).not.toContain('Next page');
  });

  it('drops the cursor-capture guidance when page numbers reach every match', async () => {
    mockCountAwards.mockResolvedValue(contractCount(30_000));
    answer(rows(100), {
      page: 1,
      hasNext: true,
      last_record_sort_value: '5',
      last_record_unique_id: 7,
    });

    const result = await runToolContract(searchAwardsTool, { keyword: 'defense', limit: 100 });

    const notice = contentOf(result).notice as string;
    expect(notice).toContain('30,000 awards match; this page ends at result 100.');
    expect(notice).toContain('Request page 2');
    expect(notice).not.toContain('last_record_sort_value');
    expect(notice).not.toContain('may remain');
    expect(markdownText(textOf(result))).toContain(notice);
  });

  it('counts the matches past the 50,000-result window and keeps the cursor guidance', async () => {
    mockCountAwards.mockResolvedValue(contractCount(4_079_943));
    answer(rows(100), {
      page: 1,
      hasNext: true,
      last_record_sort_value: '5',
      last_record_unique_id: 7,
    });

    const result = await runToolContract(searchAwardsTool, { keyword: 'defense', limit: 100 });

    const notice = contentOf(result).notice as string;
    expect(notice).toContain('4,079,943 awards match');
    expect(notice).toContain('4,029,943 of them lie past the 50,000-result page-number window');
    expect(notice).toContain('last_record_sort_value + last_record_unique_id');
    expect(notice).toContain('10,000');
  });

  it.each([
    {
      label: 'past a positive total',
      page: 3,
      total: 10,
      fragment:
        'Page 3 is past the end of the 10 matching results. Request an earlier page with the same filters.',
    },
    {
      label: 'under a zero total',
      page: 1,
      total: 0,
      fragment: 'No awards match keyword="defense", types=A,B,C,D.',
    },
  ])('describes an empty page $label from the total', async ({ page, total, fragment }) => {
    mockCountAwards.mockResolvedValue(contractCount(total));
    answer([], lastPageMeta(page));

    const result = await runToolContract(searchAwardsTool, { keyword: 'defense', page, limit: 5 });

    const sc = contentOf(result);
    expect(sc.page_metadata).toMatchObject({ has_next: false, total });
    expect(sc.notice).toBe(
      `Results use USAspending's available coverage without a date filter. ${fragment}`,
    );
    expect(markdownText(textOf(result))).toContain(fragment);
  });

  it('reports the total on a cursor page but keeps the page-fullness rule there', async () => {
    mockCountAwards.mockResolvedValue(contractCount(7));
    answer(rows(5), lastPageMeta(1));

    const result = await runToolContract(searchAwardsTool, {
      limit: 5,
      last_record_sort_value: '9',
      last_record_unique_id: 3,
    });

    const sc = contentOf(result);
    // The cursor hides the page's absolute offset, so the total cannot say where it ends.
    expect(sc.page_metadata).toMatchObject({ has_next: true, total: 7 });
    expect(sc).toMatchObject({ totalCount: 7 });
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.notice).toContain('More results may remain');
  });

  it('answers with the rows and the page-fullness rule when the count fails, naming the section', async () => {
    answer(rows(5), lastPageMeta(1));

    const result = await runToolContract(searchAwardsTool, { keyword: 'defense', limit: 5 });

    expect(result.isError).toBeFalsy();
    const sc = contentOf(result);
    expect(sc.results).toHaveLength(5);
    expect(sc.page_metadata).not.toHaveProperty('total');
    expect(sc).not.toHaveProperty('totalCount');
    expect(sc).toMatchObject({ has_next: true, page_metadata: { has_next: true } });
    expect(sc).not.toHaveProperty('truncated');
    expect(sc.unavailable_sections).toEqual([
      {
        section: 'total',
        reason: 'api_unavailable',
        retryable: true,
        message: 'USAspending API is unavailable.',
      },
    ]);
    expect(sc.notice).toContain('More results may remain');
    expect(sc.notice).toContain('Partial result: total (api_unavailable) could not be fetched');
    const text = markdownText(textOf(result));
    expect(text).toContain('Unavailable sections:');
    expect(text).toContain('total: api_unavailable (retryable) — USAspending API is unavailable.');
    expect(text).not.toContain('Total matches');
  });

  it('keeps an empty page page-scoped when the count fails', async () => {
    answer([], lastPageMeta(2));

    const result = await runToolContract(searchAwardsTool, { keyword: 'defense', page: 2 });

    const notice = contentOf(result).notice as string;
    expect(notice).toContain('Page 2 returned no awards for keyword="defense", types=A,B,C,D.');
    expect(notice).toContain('does not establish zero matches');
    expect(notice).not.toContain('No awards match');
  });

  it('rethrows a caller abort that lands while the count is in flight', async () => {
    const caller = new AbortController();
    answer(rows(1), lastPageMeta(1));
    mockCountAwards.mockImplementation(
      (_filters: unknown, ctx: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        }),
    );

    const pending = searchAwardsTool.handler(
      searchAwardsTool.input.parse({ keyword: 'defense' }),
      createMockContext({ errors: searchAwardsTool.errors, signal: caller.signal }),
    );
    await Promise.resolve();
    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('surfaces a search failure at once, without waiting on the count', async () => {
    mockSearchAwards.mockRejectedValueOnce(
      serviceUnavailable('USAspending search is down.', { reason: 'api_unavailable' }),
    );
    mockCountAwards.mockReturnValue(new Promise(() => undefined));

    await expect(
      searchAwardsTool.handler(
        searchAwardsTool.input.parse({ keyword: 'defense' }),
        createMockContext({ errors: searchAwardsTool.errors }),
      ),
    ).rejects.toMatchObject({ message: 'USAspending search is down.' });
  });

  it('names the matches past the cap in format when no page is reachable', () => {
    const text = (
      searchAwardsTool.format!({
        results: [{ generated_internal_id: 'CONT_AWD_CAP' }],
        page_metadata: { has_next: true, page: 500, limit: 100, total: 60_000 },
      })[0] as { text: string }
    ).text;

    expect(text).toContain('**No further pages reachable:**');
    expect(text).toContain('10,000 matching awards lie past it');
    expect(text).toContain('**Total matches:** 60,000');
  });
});

// --- #99: limit above the 100 cap ---

/**
 * Wiring of the shared count-limit mechanism, whose full table lives in
 * tests/tools/count-limit.test.ts: every read after the clamp — the request, the
 * 50,000-result window guard, has_next on both branches, page_metadata.limit, the
 * paging guidance, truncation `cap`, the empty-page notice, the log record — uses
 * the applied value.
 */
describe('searchAwardsTool limit above the 100 cap (#99)', () => {
  type Result = Awaited<ReturnType<typeof runToolContract>>;
  type Content = Record<string, unknown> & { page_metadata: Record<string, unknown> };
  const contentOf = (result: Result) => result.structuredContent as Content;
  const raw = (result: Result) =>
    result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ generated_internal_id: `CONT_AWD_${i}` }));
  /** Upstream page_metadata past a 10,000-result offset: hasNext false on full pages too. */
  const pastCursorWindow = (page: number) => ({
    page,
    hasNext: false,
    last_record_unique_id: null,
    last_record_sort_value: 'None',
  });
  const CLAMP_101 = 'limit 101 exceeds the per-call maximum of 100; this call used limit 100.';
  const search = (args: Record<string, unknown>) =>
    runToolContract(searchAwardsTool, { keyword: 'defense', ...args });
  const answer = (results: unknown[], page_metadata: Record<string, unknown>) =>
    mockSearchAwards.mockResolvedValue({ results, page_metadata });

  beforeEach(() => {
    mockSearchAwards.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('answers {limit:101, page:2} with the request, rows, and paging {limit:100, page:2} gets, disclosing the clamp beside the paging guidance', async () => {
    mockCountAwards.mockResolvedValue(contractCount(250));
    answer(rows(100), { page: 2, hasNext: true });

    const at100 = await search({ limit: 100, page: 2 });
    const at101 = await search({ limit: 101, page: 2 });

    expect(at101.isError).toBeFalsy();
    const [sent100, sent101] = mockSearchAwards.mock.calls.map(([body]) => body);
    expect(sent101).toEqual(sent100);
    expect(sent101).toMatchObject({ limit: 100, page: 2 });
    expect(contentOf(at101).results).toEqual(contentOf(at100).results);
    expect(contentOf(at101).page_metadata).toEqual(contentOf(at100).page_metadata);
    expect(contentOf(at100).page_metadata).toMatchObject({
      limit: 100,
      page: 2,
      has_next: true,
      total: 250,
    });
    const guidance =
      "250 awards match; this page ends at result 200. Request page 3 for more. Results use USAspending's available coverage without a date filter.";
    expect(contentOf(at100)).not.toHaveProperty('limitClamp');
    expect(contentOf(at100).notice).toBe(guidance);
    expect(contentOf(at101)).toMatchObject({
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
      truncated: true,
      cap: 100,
      notice: `${CLAMP_101} ${guidance}`,
    });
    expect(raw(at100)).toContain('**Per page:** 100');
    expect(raw(at101)).toContain('**Per page:** 100');
    expect(raw(at101)).toContain('**Limit clamp:** `limit` requested 101, applied 100');
    expect(markdownText(raw(at101))).toContain(`${CLAMP_101} ${guidance}`);
  });

  it('answers {limit:101, page:496} like {limit:100, page:496}: inside the 50,000-result window', async () => {
    mockCountAwards.mockResolvedValue(contractCount(60_000));
    answer(rows(100), pastCursorWindow(496));

    const result = await search({ limit: 101, page: 496 });

    expect(result.isError).toBeFalsy();
    expect(mockSearchAwards.mock.calls[0]![0]).toMatchObject({ limit: 100, page: 496 });
    expect(contentOf(result)).toMatchObject({
      page_metadata: { limit: 100, page: 496, has_next: true, total: 60_000 },
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
    });
    const notice = contentOf(result).notice as string;
    expect(notice.startsWith(CLAMP_101)).toBe(true);
    expect(notice).toContain('this page ends at result 49,600. Request page 497 for more.');
  });

  it('refuses a page past the window at the applied limit, naming the clamp in the message', async () => {
    const result = await search({ limit: 101, page: 501 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message: `${CLAMP_101} Requested page 501 at limit 100 exceeds this endpoint's 50,000-result page-number window.`,
        data: { reason: 'pagination_limit_exceeded' },
      },
    });
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'without a total (the count failed)', total: undefined },
    { label: 'with a total of 10,101, one row past this page', total: 10_101 },
  ])(
    'reports has_next true on a full 100-row page at limit 101 wherever limit 100 does, $label',
    async ({ total }) => {
      if (total !== undefined) mockCountAwards.mockResolvedValue(contractCount(total));
      answer(rows(100), pastCursorWindow(101));

      const at100 = await search({ limit: 100, page: 101 });
      const at101 = await search({ limit: 101, page: 101 });

      for (const result of [at100, at101]) {
        expect(contentOf(result).page_metadata).toMatchObject({ has_next: true, limit: 100 });
        expect(contentOf(result)).toMatchObject({ has_next: true });
        expect(raw(result)).toContain('**Has next:** Yes');
      }
      expect(contentOf(at101).notice).toBe(`${CLAMP_101} ${contentOf(at100).notice}`);
    },
  );

  it('keeps the clamp sentence beside the empty-page notice', async () => {
    mockCountAwards.mockResolvedValue(contractCount(10));
    answer([], pastCursorWindow(3));

    const result = await search({ limit: 150, page: 3 });

    const notice =
      "limit 150 exceeds the per-call maximum of 100; this call used limit 100. Results use USAspending's available coverage without a date filter. Page 3 is past the end of the 10 matching results. Request an earlier page with the same filters.";
    expect(contentOf(result)).toMatchObject({
      page_metadata: { limit: 100, page: 3, has_next: false, total: 10 },
      limitClamp: { field: 'limit', requested: 150, applied: 100 },
      notice,
    });
    expect(markdownText(raw(result))).toContain(notice);
  });

  it('logs the applied limit and one clamp record', async () => {
    answer(rows(1), pastCursorWindow(1));
    const ctx = createMockContext({ errors: searchAwardsTool.errors });
    const input = searchAwardsTool.input.parse({ keyword: 'defense', limit: 101 });

    await searchAwardsTool.handler(input, ctx);

    const calls = (ctx.log as MockContextLogger).calls;
    expect(calls).toContainEqual({
      level: 'info',
      msg: 'usaspending_search_awards',
      data: { keyword: 'defense', limit: 100, page: 1 },
    });
    const clampRecords = calls.filter((c) => c.msg === 'Clamped a count input to its per-call cap');
    expect(clampRecords).toHaveLength(1);
  });

  it('advertises no maximum by default, and maximum 100 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(searchAwardsTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Awards per page. Default 10, at most 100 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/search-awards.tool.js')).searchAwardsTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 100 });
    const rejected = await runToolContract(strict, { limit: 101 });
    expect(rejected.isError).toBe(true);
    expect(markdownText(raw(rejected))).toContain('Too big: expected number to be <=100');
    expect(mockSearchAwards).not.toHaveBeenCalled();
  });
});
