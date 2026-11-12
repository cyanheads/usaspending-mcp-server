/**
 * @fileoverview Tests for autocomplete-filters tool.
 * @module tests/tools/autocomplete-filters.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autocompleteFiltersTool } from '@/mcp-server/tools/definitions/autocomplete-filters.tool.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockAutocompleteNaics = vi.fn();
const mockAutocompletePsc = vi.fn();
const mockAutocompleteCfda = vi.fn();
const mockAutocompleteAwardingAgency = vi.fn();
const mockAutocompleteRecipient = vi.fn();
const mockAutocompleteLocation = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    autocompleteNaics: mockAutocompleteNaics,
    autocompletePsc: mockAutocompletePsc,
    autocompleteCfda: mockAutocompleteCfda,
    autocompleteAwardingAgency: mockAutocompleteAwardingAgency,
    autocompleteRecipient: mockAutocompleteRecipient,
    autocompleteLocation: mockAutocompleteLocation,
  }),
}));

/**
 * Wiring of the shared count-limit mechanism, whose full table lives in
 * tests/tools/count-limit.test.ts.
 */
describe('limit above the 500 cap (#99)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const mock of [mockAutocompleteNaics, mockAutocompletePsc, mockAutocompleteRecipient]) {
      mock.mockReset();
    }
  });

  const joined = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
  const clampSentence = 'limit 501 exceeds the per-call maximum of 500; this call used limit 500.';

  it('reads limit 501 as 500, keeping the clamp sentence beside the upstream-maximum notice on both surfaces', async () => {
    mockAutocompletePsc.mockResolvedValueOnce({
      results: Array.from({ length: 500 }, (_, i) => ({
        product_or_service_code: `W${i}`,
        psc_description: `Water ${i}`,
      })),
    });

    const result = await runToolContract(autocompleteFiltersTool, {
      type: 'psc',
      search_text: 'water',
      limit: 501,
    });

    expect(result.isError).toBeFalsy();
    expect(mockAutocompletePsc).toHaveBeenLastCalledWith('water', 500, expect.anything());
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({
      total: 500,
      result_count: 500,
      limitClamp: { field: 'limit', requested: 501, applied: 500 },
    });
    expect(sc.truncated).toBeUndefined();
    expect(sc.notice).toBe(
      `${clampSentence} Returned the upstream maximum of 500 matches, so more may exist. Use a more specific search term.`,
    );
    expect(joined(result)).toContain('**Limit clamp:** `limit` requested 501, applied 500');
    const text = markdownText(joined(result));
    expect(text).toContain(clampSentence);
    expect(text).toContain('upstream maximum of 500');
  });

  it('keeps the clamp sentence beside truncation guidance, judged against the applied limit', async () => {
    // Recipient buckets are capped per match type, so 500 requested can return more.
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: Array.from({ length: 501 }, (_, i) => ({ recipient_name: `NAME ${i}` })),
    });

    const result = await runToolContract(autocompleteFiltersTool, {
      type: 'recipient',
      search_text: 'a',
      limit: 501,
    });

    expect(mockAutocompleteRecipient).toHaveBeenLastCalledWith('a', 500, expect.anything());
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc).toMatchObject({ total: 500, truncated: true, shown: 500, cap: 500 });
    expect(sc.notice).toContain(`${clampSentence} More matches exist beyond limit.`);
    expect(sc.notice).toContain('search_text');
    expect(markdownText(joined(result))).toContain(clampSentence);
  });

  it('reports no clamp at the cap', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [{ naics: '221310', naics_description: 'Water Supply' }],
    });

    const result = await runToolContract(autocompleteFiltersTool, {
      type: 'naics',
      search_text: 'water',
      limit: 500,
    });

    expect(result.structuredContent).not.toHaveProperty('limitClamp');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('advertises no maximum by default, and maximum 500 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(autocompleteFiltersTool.input, 'limit')).toMatchObject({
      type: 'integer',
      minimum: 1,
      default: 10,
    });
    expect(advertisedProperty(autocompleteFiltersTool.input, 'limit')).not.toHaveProperty(
      'maximum',
    );

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/autocomplete-filters.tool.js'))
          .autocompleteFiltersTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 500 });
    mockAutocompleteNaics.mockClear();
    const rejected = await runToolContract(strict, {
      type: 'naics',
      search_text: 'water',
      limit: 501,
    });
    expect(rejected.isError).toBe(true);
    expect(markdownText(joined(rejected))).toContain('Too big: expected number to be <=500');
    expect(mockAutocompleteNaics).not.toHaveBeenCalled();
  });
});

describe('autocompleteFiltersTool', () => {
  it('registers under the renamed tool identifier', () => {
    expect(autocompleteFiltersTool.name).toBe('usaspending_autocomplete_filters');
  });

  it('maps naics field names correctly', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [
        { naics: '513210', naics_description: 'Software Publishers', year_retired: null },
        {
          naics: '541512',
          naics_description: 'Computer Systems Design Services',
          year_retired: null,
        },
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({ type: 'naics', search_text: 'software' });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.type).toBe('naics');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.code).toBe('513210');
    expect(result.results[0]!.name).toBe('Software Publishers');
    expect(result.total).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.lookup_type).toBe('naics');
    expect(enrichment.query).toBe('software');
    expect(enrichment.result_count).toBe(2);
  });

  it('maps psc field names correctly', async () => {
    mockAutocompletePsc.mockResolvedValueOnce({
      results: [{ product_or_service_code: 'AC60', psc_description: 'R&D-ELECTRONICS & COMM EQ' }],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({ type: 'psc', search_text: 'electronics' });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results[0]!.code).toBe('AC60');
    expect(result.results[0]!.name).toBe('R&D-ELECTRONICS & COMM EQ');
  });

  it('maps cfda field names correctly', async () => {
    mockAutocompleteCfda.mockResolvedValueOnce({
      results: [
        {
          program_number: '10.405',
          program_title: 'Farm Labor Housing Loans and Grants',
          popular_name: 'Labor Housing',
        },
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({ type: 'cfda', search_text: 'housing' });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results[0]!.code).toBe('10.405');
    expect(result.results[0]!.name).toBe('Farm Labor Housing Loans and Grants');
  });

  it('maps a top-tier awarding_agency match with name equal to toptier_name and no id (#71)', async () => {
    mockAutocompleteAwardingAgency.mockResolvedValueOnce({
      results: {
        toptier_agency: [{ code: '097', abbreviation: 'DOD', name: 'Department of Defense' }],
        subtier_agency: [],
        office: [],
      },
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'awarding_agency',
      search_text: 'defense',
    });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results[0]).toEqual({
      name: 'Department of Defense',
      abbreviation: 'DOD',
      tier: 'toptier',
      toptier_name: 'Department of Defense',
      toptier_code: '097',
    });
  });

  describe('agency rows carry their own name and tier (#71)', () => {
    // Replacement endpoint agency buckets retain matched identities.
    const USGS = {
      code: '1434',
      abbreviation: 'USGS',
      name: 'U.S. Geological Survey',
      toptier_agency: {
        code: '014',
        abbreviation: 'DOI',
        name: 'Department of the Interior',
      },
    };
    const INTERIOR = {
      code: '014',
      abbreviation: 'DOI',
      name: 'Department of the Interior',
    };
    const UNDER_SECRETARY = {
      code: null,
      abbreviation: null,
      name: 'Office of the Under Secretary of the Interior',
      toptier_agency: {
        code: '014',
        abbreviation: 'DOI',
        name: 'Department of the Interior',
      },
    };
    const run = (search_text: string, rows: unknown[]) => {
      mockAutocompleteAwardingAgency.mockResolvedValueOnce({
        results: {
          toptier_agency: rows.filter((r) => !(r as Record<string, unknown>).toptier_agency),
          subtier_agency: rows.filter((r) => (r as Record<string, unknown>).toptier_agency),
          office: [{ name: 'Must not return office' }],
        },
      });
      return runToolContract(autocompleteFiltersTool, {
        type: 'awarding_agency',
        search_text,
        limit: 5,
      });
    };
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

    it('keeps a sub-agency match under its own name with its parent alongside', async () => {
      const result = await run('Geological', [USGS]);

      expect(result.isError).toBeFalsy();
      const rows = (result.structuredContent as { results: unknown[] }).results;
      expect(rows).toEqual([
        {
          name: 'U.S. Geological Survey',
          abbreviation: 'USGS',
          tier: 'subtier',
          toptier_name: 'Department of the Interior',
          toptier_code: '014',
          subtier_code: '1434',
        },
      ]);
      const text = markdownText(textOf(result));
      expect(text).toContain('U.S. Geological Survey');
      expect(text).toContain('USGS');
      expect(text).toContain('subtier');
      expect(text).toContain('Department of the Interior');
      expect(text).toContain('014');
      expect(text).toContain('1434');
      expect(text).not.toContain('Must not return office');
      expect(text).not.toContain('233');
    });

    it('distinguishes a department from a same-parent office', async () => {
      const result = await run('Interior', [INTERIOR, UNDER_SECRETARY]);

      const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
      expect(rows.map((r) => [r.name, r.tier])).toEqual([
        ['Department of the Interior', 'toptier'],
        ['Office of the Under Secretary of the Interior', 'subtier'],
      ]);
      expect(rows[0]!.name).toBe(rows[0]!.toptier_name);
      // No abbreviation upstream stays absent rather than inheriting the parent's.
      expect(rows[1]).not.toHaveProperty('abbreviation');
      expect(rows[1]!.toptier_name).toBe('Department of the Interior');
      for (const row of rows) expect(row).not.toHaveProperty('id');
    });

    it('drops id from the output schema and points toptier_name at the agency_name filters', () => {
      const row = autocompleteFiltersTool.output.shape.results.element;
      expect(row.shape).not.toHaveProperty('id');
      const toptierName = row.shape.toptier_name.description ?? '';
      expect(toptierName).toContain('agency_name');
      expect(toptierName).toMatch(/sub-agency/i);
      expect(autocompleteFiltersTool.description).not.toMatch(/\bIDs?\b/);
    });

    it.each([
      searchAwardsTool,
      spendingByCategoryTool,
      spendingByGeographyTool,
      spendingOverTimeTool,
    ])('$name: every agency_name accepts matched names and discloses shared parents', (def) => {
      const descriptions: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        for (const [key, value] of Object.entries(node)) {
          if (key === 'agency_name' && value && typeof value === 'object') {
            descriptions.push(String((value as { description?: string }).description));
          }
          walk(value);
        }
      };
      walk(z.toJSONSchema(def.input));

      expect(descriptions.length).toBeGreaterThan(0);
      for (const description of descriptions) {
        expect(description).toMatch(/top-tier/i);
        expect(description).toContain('matched name');
        expect(description).toContain('all parents');
      }
    });
  });

  it('caps the ordered agency union without deduplicating tiers or shared names and never expands nested arrays', async () => {
    mockAutocompleteAwardingAgency.mockResolvedValueOnce({
      results: {
        toptier_agency: [
          {
            name: 'Shared',
            code: '001',
            subtier_agencies: [{ name: 'Nested must stay absent' }],
            offices: [{ name: 'Nested office' }],
          },
        ],
        subtier_agency: [
          {
            name: 'Shared',
            code: '1001',
            toptier_agency: { name: 'Parent A', code: '001' },
            offices: [{ name: 'Sub office' }],
          },
          { name: 'Shared', code: null, toptier_agency: { name: 'Parent B', code: '002' } },
          { name: 'Omitted', toptier_agency: { name: 'Parent C' } },
        ],
        office: [{ name: 'Office must stay absent' }],
      },
    });
    const response = await runToolContract(autocompleteFiltersTool, {
      type: 'awarding_agency',
      search_text: 'Shared',
      limit: 3,
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      total: 3,
      truncated: true,
      cap: 3,
      results: [
        { name: 'Shared', tier: 'toptier', toptier_code: '001' },
        { name: 'Shared', tier: 'subtier', toptier_name: 'Parent A', subtier_code: '1001' },
        { name: 'Shared', tier: 'subtier', toptier_name: 'Parent B' },
      ],
    });
    const data = response.structuredContent as { results: Record<string, unknown>[] };
    expect(data.results[2]).not.toHaveProperty('subtier_code');
    const text = markdownText(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    expect(text).toContain('1001');
    expect(text).toContain('Parent B');
    expect(text).not.toMatch(/Nested|Sub office|Office must|Omitted/);
  });

  it.each([499, 500, 501])(
    'judges agency maximum saturation using %i agency rows and no offices',
    async (count) => {
      mockAutocompleteAwardingAgency.mockResolvedValueOnce({
        results: {
          toptier_agency: Array.from({ length: Math.min(count, 500) }, (_, i) => ({
            name: `Top ${i}`,
          })),
          subtier_agency: count > 500 ? [{ name: 'Sub' }] : [],
          office: Array.from({ length: 500 }, () => ({ name: 'Office' })),
        },
      });
      const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
      const result = await autocompleteFiltersTool.handler(
        autocompleteFiltersTool.input.parse({
          type: 'awarding_agency',
          search_text: 'a',
          limit: 500,
        }),
        ctx,
      );
      expect(result.results).toHaveLength(Math.min(count, 500));
      expect(getEnrichment(ctx).truncated).toBe(count > 500 ? true : undefined);
      if (count === 500) expect(getEnrichment(ctx).notice).toContain('upstream maximum of 500');
      if (count === 499) expect(getEnrichment(ctx).notice).toBeUndefined();
    },
  );

  it('returns no_match for office-only matches with a recovery hint on both surfaces', async () => {
    mockAutocompleteAwardingAgency.mockResolvedValueOnce({
      results: { toptier_agency: [], subtier_agency: [], office: [{ name: 'Office' }] },
    });
    const response = await runToolContract(autocompleteFiltersTool, {
      type: 'awarding_agency',
      search_text: 'Office',
    });
    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      error: {
        data: { reason: 'no_match', recovery: { hint: expect.stringContaining('broader') } },
      },
    });
    expect(
      markdownText(
        response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ),
    ).toContain('broader');
  });

  it('maps recipient_name to name for recipient type', async () => {
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        { recipient_name: 'Acme Corporation', recipient_level: null, uei: null, duns: null },
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({ type: 'recipient', search_text: 'acme' });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results[0]!.name).toBe('Acme Corporation');
    // recipient_id / legal_business_name don't exist on this endpoint — no id on the row
    expect(result.results[0]).not.toHaveProperty('id');
    expect(result.results[0]!.uei).toBeUndefined();
    expect(result.results[0]!.duns).toBeUndefined();
  });

  it('surfaces uei and duns for recipient matches', async () => {
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        {
          recipient_name: 'MICROSOFT CORPORATION',
          recipient_level: null,
          uei: 'FMVPEWNJGLM1',
          duns: '081466849',
        },
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'recipient',
      search_text: 'microsoft',
    });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results[0]!.name).toBe('MICROSOFT CORPORATION');
    expect(result.results[0]!.uei).toBe('FMVPEWNJGLM1');
    expect(result.results[0]!.duns).toBe('081466849');
    expect(result.results[0]).not.toHaveProperty('id');
  });

  it('caps the recipient union at limit when upstream returns one bucket per match type', async () => {
    // `autocomplete/recipient/` applies limit per bucket and unions name + UEI + DUNS hits,
    // so a request for 10 comes back with 30 rows.
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        ...Array.from({ length: 10 }, (_, i) => ({
          recipient_name: `NAME MATCH ${i}`,
          uei: null,
          duns: null,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          recipient_name: `UEI MATCH ${i}`,
          uei: `UEI${i}`,
          duns: null,
        })),
        ...Array.from({ length: 10 }, (_, i) => ({
          recipient_name: `DUNS MATCH ${i}`,
          uei: null,
          duns: `DUNS${i}`,
        })),
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'recipient',
      search_text: 'a',
      limit: 10,
    });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results).toHaveLength(10);
    expect(result.total).toBe(10);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.result_count).toBe(10);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(10);
    expect(enrichment.cap).toBe(10);
  });

  it('does not send a saturated recipient page back to limit for identifier matches', async () => {
    // Upstream fills the name bucket to `limit` on its own, so the head-slice keeps name
    // matches only and raising `limit` raises that bucket with it — the UEI and DUNS rows
    // behind it stay unreachable. Guidance that named `limit` alone would misdirect.
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        ...Array.from({ length: 5 }, (_, i) => ({
          recipient_name: `NAME MATCH ${i}`,
          uei: null,
          duns: null,
        })),
        ...Array.from({ length: 5 }, (_, i) => ({
          recipient_name: `UEI MATCH ${i}`,
          uei: `UEI${i}`,
          duns: null,
        })),
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'recipient',
      search_text: 'a',
      limit: 5,
    });
    await autocompleteFiltersTool.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toContain('search_text');
  });

  it('keeps the plain limit guidance for lookups that honor limit exactly', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: Array.from({ length: 6 }, (_, i) => ({
        naics: `54151${i}`,
        naics_description: `Computer Systems Design ${i}`,
      })),
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'naics',
      search_text: 'computer',
      limit: 5,
    });
    await autocompleteFiltersTool.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Raise limit');
    expect(notice).not.toContain('search_text');
  });

  it('leaves a recipient response under the limit untouched', async () => {
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        { recipient_name: 'LOCKHEED MARTIN CORPORATION', uei: null, duns: null },
        { recipient_name: 'LOCKHEED MARTIN SERVICES INC.', uei: null, duns: null },
      ],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'recipient',
      search_text: 'lockheed',
      limit: 10,
    });
    const result = await autocompleteFiltersTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(getEnrichment(ctx).truncated).toBeUndefined();
  });

  it('throws no_match when no results found', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'naics',
      search_text: 'nonexistent_xyz_code',
    });
    await expect(autocompleteFiltersTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('throws when service call fails', async () => {
    mockAutocompletePsc.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({ type: 'psc', search_text: 'electronics' });
    await expect(autocompleteFiltersTool.handler(input, ctx)).rejects.toThrow();
  });

  it('accepts limit up to the new max of 500 for every type', () => {
    for (const type of [
      'naics',
      'psc',
      'cfda',
      'awarding_agency',
      'recipient',
      'location',
    ] as const) {
      const input = autocompleteFiltersTool.input.parse({ type, search_text: 'x', limit: 500 });
      expect(input.limit).toBe(500);
    }
  });

  it('passes the raised limit through to the service', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [{ naics: '513210', naics_description: 'Software Publishers' }],
    });

    const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
    const input = autocompleteFiltersTool.input.parse({
      type: 'naics',
      search_text: 'soft',
      limit: 500,
    });
    await autocompleteFiltersTool.handler(input, ctx);

    expect(mockAutocompleteNaics).toHaveBeenCalledWith('soft', 500, ctx);
  });

  describe('truncation evidence (#76)', () => {
    const naicsRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        naics: `22131${i}`,
        naics_description: `Water Industry ${i}`,
      }));
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

    it('requests one row past the limit so a full page can be told from a capped one', async () => {
      mockAutocompleteNaics.mockResolvedValueOnce({ results: naicsRows(3) });
      const ctx = createMockContext({ errors: autocompleteFiltersTool.errors });
      const input = autocompleteFiltersTool.input.parse({
        type: 'naics',
        search_text: 'Water',
        limit: 10,
      });
      await autocompleteFiltersTool.handler(input, ctx);

      expect(mockAutocompleteNaics).toHaveBeenLastCalledWith('Water', 11, ctx);
    });

    it('sets no truncated when the whole match set exactly fills limit', async () => {
      // Upstream answers "Water" with the same ten codes at limit 10, 11, and 500.
      mockAutocompleteNaics.mockResolvedValueOnce({ results: naicsRows(10) });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'naics',
        search_text: 'Water',
        limit: 10,
      });

      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.results as unknown[]).length).toBe(10);
      expect(sc.truncated).toBeUndefined();
      expect(sc.shown).toBeUndefined();
      expect(sc.cap).toBeUndefined();
      expect(sc.notice).toBeUndefined();
    });

    it('sets truncated when more rows came back than limit, and slices to limit', async () => {
      mockAutocompleteNaics.mockResolvedValueOnce({ results: naicsRows(10) });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'naics',
        search_text: 'Water',
        limit: 9,
      });

      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.results as unknown[]).length).toBe(9);
      expect(sc.total).toBe(9);
      expect(sc.truncated).toBe(true);
      expect(sc.shown).toBe(9);
      expect(sc.cap).toBe(9);
      expect(sc.notice).toContain('Raise limit');
      expect(textOf(result)).toContain('Raise limit');
    });

    it('at the 500 ceiling discloses the upstream maximum instead of truncation', async () => {
      // Every autocomplete route rejects limit 501 with HTTP 400, so no probe row is available.
      mockAutocompleteNaics.mockResolvedValueOnce({ results: naicsRows(500) });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'naics',
        search_text: 'a',
        limit: 500,
      });

      expect(mockAutocompleteNaics).toHaveBeenLastCalledWith('a', 500, expect.anything());
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.results as unknown[]).length).toBe(500);
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toContain('upstream maximum of 500');
      expect(textOf(result)).toContain('upstream maximum of 500');
    });

    it('below the ceiling at 500 sets neither truncated nor the maximum notice', async () => {
      mockAutocompleteNaics.mockResolvedValueOnce({ results: naicsRows(499) });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'naics',
        search_text: 'a',
        limit: 500,
      });

      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.truncated).toBeUndefined();
      expect(sc.notice).toBeUndefined();
    });

    it('judges recipient truncation on the bucket union before slicing', async () => {
      // Name bucket short of limit, but identifier hits push the union past it.
      mockAutocompleteRecipient.mockResolvedValueOnce({
        results: [
          ...Array.from({ length: 4 }, (_, i) => ({ recipient_name: `NAME ${i}`, uei: null })),
          { recipient_name: 'UEI HIT', uei: 'UEI0', duns: null },
          { recipient_name: 'DUNS HIT', uei: null, duns: 'DUNS0' },
        ],
      });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'recipient',
        search_text: 'a',
        limit: 5,
      });

      expect(mockAutocompleteRecipient).toHaveBeenLastCalledWith('a', 6, expect.anything());
      const sc = result.structuredContent as Record<string, unknown>;
      expect((sc.results as { name: string }[]).map((r) => r.name)).toEqual([
        'NAME 0',
        'NAME 1',
        'NAME 2',
        'NAME 3',
        'UEI HIT',
      ]);
      expect(sc.truncated).toBe(true);
      expect(sc.notice).toContain('search_text');
    });

    it('leaves an exactly-full recipient union untruncated', async () => {
      mockAutocompleteRecipient.mockResolvedValueOnce({
        results: Array.from({ length: 5 }, (_, i) => ({ recipient_name: `NAME ${i}` })),
      });
      const result = await runToolContract(autocompleteFiltersTool, {
        type: 'recipient',
        search_text: 'a',
        limit: 5,
      });

      expect((result.structuredContent as Record<string, unknown>).truncated).toBeUndefined();
    });
  });

  it('formats output with codes and names', () => {
    const output = {
      type: 'naics',
      search_text: 'software',
      results: [
        { code: '513210', name: 'Software Publishers' },
        { code: '541512', name: 'Computer Systems Design Services' },
      ],
      total: 2,
    };

    const blocks = autocompleteFiltersTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('naics');
    expect(text).toContain('software');
    expect(text).toContain('513210');
    expect(text).toContain('Software Publishers');
    expect(text).toContain('**Total:** 2');
  });
});

/** `autocomplete/location/` responses below are verbatim live bodies unless named synthetic. */
describe('type location (#108)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    mockAutocompleteLocation.mockReset();
  });

  const US = 'UNITED STATES';
  const KING_COUNTY = {
    count: 4,
    results: {
      cities: [
        { city_name: 'KING COUNTY', state_name: 'TEXAS', country_name: US },
        { city_name: 'KING COUNTY', state_name: 'WASHINGTON', country_name: US },
      ],
      counties: [
        { county_name: 'KING', county_fips: '48269', state_name: 'TEXAS', country_name: US },
        { county_name: 'KING', county_fips: '53033', state_name: 'WASHINGTON', country_name: US },
      ],
    },
    messages: [''],
  };
  const SANTA_FE = {
    count: 11,
    results: {
      cities: ['CUBA', 'PERU', 'CHILE', 'SPAIN', 'BRAZIL', 'MEXICO', 'GUYANA', 'PANAMA'].map(
        (country_name) => ({ city_name: 'SANTA FE', country_name }),
      ),
      counties: [
        {
          county_name: 'SANTA FE',
          county_fips: '35049',
          state_name: 'NEW MEXICO',
          country_name: US,
        },
      ],
    },
    messages: [''],
  };
  const WA_07 = {
    count: 2,
    results: {
      districts_original: [{ original_cd: 'WA-07', state_name: 'WASHINGTON', country_name: US }],
      districts_current: [{ current_cd: 'WA-07', state_name: 'WASHINGTON', country_name: US }],
    },
    messages: [''],
  };
  const WASHINGTON = {
    count: 11,
    results: {
      cities: [
        { city_name: 'WASHINGTON', country_name: 'PERU' },
        { city_name: 'WASHINGTON', country_name: 'CUBA' },
      ],
      states: [{ state_name: 'WASHINGTON', country_name: US }],
      counties: [
        { county_name: 'WASHINGTON', county_fips: '49053', state_name: 'UTAH', country_name: US },
        { county_name: 'WASHINGTON', county_fips: '39167', state_name: 'OHIO', country_name: US },
      ],
    },
    messages: [''],
  };
  const US_DOT = {
    count: 1,
    results: { states: [{ state_name: 'U.S. VIRGIN ISLANDS', country_name: US }] },
    messages: [''],
  };
  const DENMARK = {
    count: 6,
    results: {
      countries: [{ country_name: 'DENMARK' }],
      cities: [
        { city_name: 'DENMARK', country_name: 'CANADA' },
        { city_name: 'DENMARK', state_name: 'OREGON', country_name: US },
      ],
    },
    messages: [''],
  };
  const ZIP_98101 = {
    count: 1,
    results: { zip_codes: [{ zip_code: '98101', state_name: 'WASHINGTON', country_name: US }] },
    messages: [''],
  };

  const run = (search_text: string, response: unknown, limit?: number) => {
    mockAutocompleteLocation.mockResolvedValueOnce(response);
    return runToolContract(autocompleteFiltersTool, {
      type: 'location',
      search_text,
      ...(limit === undefined ? {} : { limit }),
    });
  };
  const rowsOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    (result.structuredContent as { results: Record<string, unknown>[] }).results;
  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    markdownText(result.content.map((b) => ('text' in b ? b.text : '')).join('\n'));

  it.each([
    [
      'King County',
      KING_COUNTY,
      [
        { kind: 'county', code: '48269', name: 'KING', state: 'TX' },
        { kind: 'county', code: '53033', name: 'KING', state: 'WA' },
      ],
    ],
    ['Santa Fe', SANTA_FE, [{ kind: 'county', code: '35049', name: 'SANTA FE', state: 'NM' }]],
    ['WA-07', WA_07, [{ kind: 'district', code: '5307', name: 'WA-07', state: 'WA' }]],
    [
      'Washington',
      WASHINGTON,
      [
        { kind: 'state', code: 'WA', name: 'WASHINGTON' },
        { kind: 'county', code: '49053', name: 'WASHINGTON', state: 'UT' },
        { kind: 'county', code: '39167', name: 'WASHINGTON', state: 'OH' },
      ],
    ],
    ['U.S.', US_DOT, [{ kind: 'state', code: 'VI', name: 'U.S. VIRGIN ISLANDS' }]],
  ])('resolves "%s" to the codes its filters take, on both surfaces', async (text, body, rows) => {
    const result = await run(text, body);

    expect(result.isError).toBeFalsy();
    expect(mockAutocompleteLocation).toHaveBeenLastCalledWith(text, 11, expect.anything());
    expect(rowsOf(result)).toEqual(rows);
    expect(result.structuredContent).toMatchObject({
      type: 'location',
      total: rows.length,
      lookup_type: 'location',
      result_count: rows.length,
    });
    expect(result.structuredContent).not.toHaveProperty('truncated');
    const content = textOf(result);
    for (const row of rows) {
      for (const value of Object.values(row)) expect(content).toContain(value);
    }
    expect(content).not.toMatch(/PERU|CUBA|COUNTRY|original/i);
  });

  it('maps districts as state FIPS + district number, at-large and DC included', async () => {
    const result = await run('D', {
      results: {
        districts_current: [
          { current_cd: 'WY-00', state_name: 'WYOMING', country_name: US },
          { current_cd: 'DC-98', state_name: 'DISTRICT OF COLUMBIA', country_name: US },
          // Upstream lists codes no district carries; the code is still the shape_code form.
          { current_cd: 'DC-14', state_name: 'DISTRICT OF COLUMBIA', country_name: US },
          { current_cd: 'PR-98', state_name: 'PUERTO RICO', country_name: US },
        ],
      },
    });

    expect(rowsOf(result).map((r) => [r.code, r.name, r.state])).toEqual([
      ['5600', 'WY-00', 'WY'],
      ['1198', 'DC-98', 'DC'],
      ['1114', 'DC-14', 'DC'],
      ['7298', 'PR-98', 'PR'],
    ]);
  });

  it('produces no row for an unmapped state name, a stateless district, or an unusable county, guessing no code (synthetic)', async () => {
    const result = await run('X', {
      results: {
        states: [
          { state_name: 'FEDERATED STATES OF MICRONESIA', country_name: US },
          { state_name: 'VIRGIN ISLANDS', country_name: US },
          { state_name: 'Washington', country_name: US },
          { state_name: null, country_name: US },
          { state_name: 'GUAM', country_name: US },
        ],
        counties: [
          { county_name: 'NOWHERE', county_fips: '99001', state_name: 'NOWHERE' },
          { county_name: 'SHORT', county_fips: '5303', state_name: 'WASHINGTON' },
          { county_name: 'MISSING', county_fips: null, state_name: 'WASHINGTON' },
          { county_name: null, county_fips: '66010', state_name: 'GUAM' },
        ],
        districts_current: [
          { current_cd: 'AE-01', state_name: 'ARMED FORCES EUROPE' },
          { current_cd: 'WA07', state_name: 'WASHINGTON' },
          { current_cd: 'WA-7', state_name: 'WASHINGTON' },
          { current_cd: null, state_name: 'WASHINGTON' },
          { current_cd: 'GU-98', state_name: 'GUAM' },
        ],
      },
    });

    expect(rowsOf(result)).toEqual([
      { kind: 'state', code: 'GU', name: 'GUAM' },
      { kind: 'county', code: '66010', state: 'GU' },
      { kind: 'district', code: '6698', name: 'GU-98', state: 'GU' },
    ]);
  });

  it.each([
    ['countries and cities only', 'Denmark', DENMARK],
    ['a ZIP code only', '98101', ZIP_98101],
    ['nothing', 'Federated', { count: 0, results: {}, messages: [''] }],
    [
      'only rows no code is mapped for (synthetic)',
      'Federated',
      { results: { states: [{ state_name: 'FEDERATED STATES OF MICRONESIA', country_name: US }] } },
    ],
  ])(
    'fails as no_match naming the three kinds when the search matches %s',
    async (_, text, body) => {
      const result = await run(text, body);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'no_match',
            recovery: { hint: expect.stringContaining('countries, cities, or ZIP codes') },
          },
        },
      });
      const content = textOf(result);
      expect(content).toContain(`No US state, county, or congressional district matched "${text}"`);
      expect(content).toContain('not countries, cities, or ZIP codes');
    },
  );

  it.each([
    [1, 2],
    [10, 11],
    [99, 100],
    [100, 100],
    [500, 100],
    [501, 100],
  ])('asks upstream for at most 100 rows per kind at limit %i (sends %i)', async (limit, sent) => {
    await run('King County', KING_COUNTY, limit);

    expect(mockAutocompleteLocation).toHaveBeenLastCalledWith(
      'King County',
      sent,
      expect.anything(),
    );
  });

  it('combines states, counties, then districts under limit and discloses the rows left out', async () => {
    const result = await run(
      'W',
      {
        results: {
          states: [
            { state_name: 'WASHINGTON', country_name: US },
            { state_name: 'WYOMING', country_name: US },
          ],
          counties: [
            { county_name: 'KING', county_fips: '53033', state_name: 'WASHINGTON' },
            { county_name: 'TETON', county_fips: '56039', state_name: 'WYOMING' },
          ],
          districts_current: [{ current_cd: 'WY-00', state_name: 'WYOMING' }],
        },
      },
      3,
    );

    expect(rowsOf(result).map((r) => [r.kind, r.code])).toEqual([
      ['state', 'WA'],
      ['state', 'WY'],
      ['county', '53033'],
    ]);
    expect(result.structuredContent).toMatchObject({
      total: 3,
      truncated: true,
      shown: 3,
      cap: 3,
      notice:
        'More matches exist beyond limit. Raise limit (max 500) or use a more specific search term.',
    });
    expect(textOf(result)).toContain('More matches exist beyond limit.');
  });

  it('leaves a page that exactly fills limit from unfilled buckets untruncated', async () => {
    const result = await run('King County', KING_COUNTY, 2);

    expect(rowsOf(result)).toHaveLength(2);
    expect(result.structuredContent).not.toHaveProperty('truncated');
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('discloses truncation when a bucket holds the probe row although dropped rows leave the page short (synthetic)', async () => {
    // limit 2 asks for 3 per kind; all 3 states came back, but only one maps.
    const result = await run(
      'X',
      {
        results: {
          states: [
            { state_name: 'GUAM', country_name: US },
            { state_name: 'ATLANTIS', country_name: US },
            { state_name: 'LEMURIA', country_name: US },
          ],
        },
      },
      2,
    );

    expect(rowsOf(result)).toEqual([{ kind: 'state', code: 'GU', name: 'GUAM' }]);
    expect(result.structuredContent).toMatchObject({ truncated: true, shown: 1, cap: 2 });
  });

  describe('the 100-per-kind upstream ceiling', () => {
    const counties = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        county_name: `COUNTY ${i}`,
        county_fips: `53${String(i).padStart(3, '0')}`,
        state_name: 'WASHINGTON',
      }));
    const districts = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        current_cd: `CA-${String(i % 100).padStart(2, '0')}`,
        state_name: 'CALIFORNIA',
      }));
    const ceiling = (kinds: string) =>
      `Upstream returns at most 100 location matches of each kind, and the ${kinds} matches reached it, so more may exist. Use a more specific search term.`;

    it('says a kind reached the ceiling when its bucket filled 100 rows without a probe row', async () => {
      const result = await run('C', { results: { counties: counties(100) } }, 100);

      expect(rowsOf(result)).toHaveLength(100);
      expect(result.structuredContent).not.toHaveProperty('truncated');
      expect((result.structuredContent as { notice?: string }).notice).toBe(ceiling('county'));
      expect(textOf(result)).toContain(ceiling('county'));
    });

    it('stays silent at limit 100 when no bucket filled', async () => {
      const result = await run('C', { results: { counties: counties(99) } }, 100);

      expect(rowsOf(result)).toHaveLength(99);
      expect(result.structuredContent).not.toHaveProperty('notice');
    });

    it('treats a filled bucket at limit 99 as truncation, the probe row proving more', async () => {
      const result = await run('C', { results: { counties: counties(100) } }, 99);

      expect(result.structuredContent).toMatchObject({ truncated: true, shown: 99, cap: 99 });
      expect((result.structuredContent as { notice?: string }).notice).not.toContain('Upstream');
    });

    it('names every kind at the ceiling beside truncation guidance', async () => {
      const result = await run(
        'C',
        { results: { counties: counties(100), districts_current: districts(100) } },
        150,
      );

      expect(rowsOf(result)).toHaveLength(150);
      expect(rowsOf(result)[100]).toMatchObject({ kind: 'district', code: '0600', state: 'CA' });
      expect(result.structuredContent).toMatchObject({
        truncated: true,
        shown: 150,
        cap: 150,
        notice: `More matches exist beyond limit. Raise limit (max 500) or use a more specific search term. ${ceiling('county and district')}`,
      });
    });

    it('keeps the clamp sentence beside the ceiling sentence at limit 501', async () => {
      const result = await run('C', { results: { counties: counties(100) } }, 501);

      expect(result.structuredContent).toMatchObject({
        limitClamp: { field: 'limit', requested: 501, applied: 500 },
        notice: `limit 501 exceeds the per-call maximum of 500; this call used limit 500. ${ceiling('county')}`,
      });
      expect(result.structuredContent).not.toHaveProperty('truncated');
    });
  });

  it('formats location rows with kind, code, name, and state', () => {
    const text = (
      autocompleteFiltersTool.format!({
        type: 'location',
        search_text: 'King County',
        results: [
          { kind: 'state', code: 'VI', name: 'U.S. VIRGIN ISLANDS' },
          { kind: 'county', code: '53033', name: 'KING', state: 'WA' },
        ],
        total: 2,
      })[0] as { text: string }
    ).text;

    expect(text).toContain('**Kind:** state | **Code:** VI | **Name:** U.S. VIRGIN ISLANDS');
    expect(text).toContain('**Kind:** county | **Code:** 53033 | **Name:** KING | **State:** WA');
  });

  it('leaves the other lookup types off the location route', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [{ naics: '221310', naics_description: 'Water Supply' }],
    });

    const result = await runToolContract(autocompleteFiltersTool, {
      type: 'naics',
      search_text: 'water',
    });

    expect(mockAutocompleteLocation).not.toHaveBeenCalled();
    expect(rowsOf(result)).toEqual([{ code: '221310', name: 'Water Supply' }]);
  });
});
