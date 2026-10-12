/**
 * @fileoverview Tests for autocomplete-filters tool.
 * @module tests/tools/autocomplete-filters.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { autocompleteFiltersTool } from '@/mcp-server/tools/definitions/autocomplete-filters.tool.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { spendingByGeographyTool } from '@/mcp-server/tools/definitions/spending-by-geography.tool.js';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';

const mockAutocompleteNaics = vi.fn();
const mockAutocompletePsc = vi.fn();
const mockAutocompleteCfda = vi.fn();
const mockAutocompleteAwardingAgency = vi.fn();
const mockAutocompleteRecipient = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    autocompleteNaics: mockAutocompleteNaics,
    autocompletePsc: mockAutocompletePsc,
    autocompleteCfda: mockAutocompleteCfda,
    autocompleteAwardingAgency: mockAutocompleteAwardingAgency,
    autocompleteRecipient: mockAutocompleteRecipient,
  }),
}));

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
      results: [
        {
          id: 1173,
          toptier_flag: true,
          toptier_agency: {
            toptier_code: '097',
            abbreviation: 'DOD',
            name: 'Department of Defense',
          },
          subtier_agency: { abbreviation: 'DOD', name: 'Department of Defense' },
        },
      ],
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
    // Live autocomplete/awarding_agency/ rows for "Geological" and "Interior".
    const USGS = {
      id: 233,
      toptier_flag: false,
      toptier_agency: {
        toptier_code: '014',
        abbreviation: 'DOI',
        name: 'Department of the Interior',
      },
      subtier_agency: { abbreviation: 'USGS', name: 'U.S. Geological Survey' },
    };
    const INTERIOR = {
      id: 209,
      toptier_flag: true,
      toptier_agency: {
        toptier_code: '014',
        abbreviation: 'DOI',
        name: 'Department of the Interior',
      },
      subtier_agency: { abbreviation: 'DOI', name: 'Department of the Interior' },
    };
    const UNDER_SECRETARY = {
      id: 211,
      toptier_flag: false,
      toptier_agency: {
        toptier_code: '014',
        abbreviation: 'DOI',
        name: 'Department of the Interior',
      },
      subtier_agency: { abbreviation: null, name: 'Office of the Under Secretary of the Interior' },
    };
    const run = (search_text: string, rows: unknown[]) => {
      mockAutocompleteAwardingAgency.mockResolvedValueOnce({ results: rows });
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
        },
      ]);
      const text = textOf(result);
      expect(text).toContain('U.S. Geological Survey');
      expect(text).toContain('USGS');
      expect(text).toContain('subtier');
      expect(text).toContain('Department of the Interior');
      expect(text).toContain('014');
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
    ])('$name: every agency_name says top-tier only and points at toptier_name', (def) => {
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
        expect(description).toContain('toptier_name');
      }
    });
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
    for (const type of ['naics', 'psc', 'cfda', 'awarding_agency', 'recipient'] as const) {
      const input = autocompleteFiltersTool.input.parse({ type, search_text: 'x', limit: 500 });
      expect(input.limit).toBe(500);
    }
  });

  it('rejects a limit above the 500 ceiling', () => {
    expect(() =>
      autocompleteFiltersTool.input.parse({ type: 'recipient', search_text: 'x', limit: 501 }),
    ).toThrow();
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
