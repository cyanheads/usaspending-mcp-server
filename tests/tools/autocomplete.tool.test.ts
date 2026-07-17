/**
 * @fileoverview Tests for autocomplete tool.
 * @module tests/tools/autocomplete.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { autocompleteTool } from '@/mcp-server/tools/definitions/autocomplete.tool.js';

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

describe('autocompleteTool', () => {
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

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'naics', search_text: 'software' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.type).toBe('naics');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].code).toBe('513210');
    expect(result.results[0].name).toBe('Software Publishers');
    expect(result.total).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.lookup_type).toBe('naics');
    expect(enrichment.query).toBe('software');
    expect(enrichment.result_count).toBe(2);
  });

  it('discloses truncation when results fill the limit', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: Array.from({ length: 5 }, (_, i) => ({
        naics: `5135${i}0`,
        naics_description: `Industry ${i}`,
      })),
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'naics', search_text: 'soft', limit: 5 });
    await autocompleteTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(5);
    expect(enrichment.cap).toBe(5);
  });

  it('maps psc field names correctly', async () => {
    mockAutocompletePsc.mockResolvedValueOnce({
      results: [{ product_or_service_code: 'AC60', psc_description: 'R&D-ELECTRONICS & COMM EQ' }],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'psc', search_text: 'electronics' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].code).toBe('AC60');
    expect(result.results[0].name).toBe('R&D-ELECTRONICS & COMM EQ');
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

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'cfda', search_text: 'housing' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].code).toBe('10.405');
    expect(result.results[0].name).toBe('Farm Labor Housing Loans and Grants');
  });

  it('maps awarding_agency nested toptier_agency.name', async () => {
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

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'awarding_agency', search_text: 'defense' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].id).toBe('1173');
    expect(result.results[0].name).toBe('Department of Defense');
  });

  it('maps recipient_name to name for recipient type', async () => {
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [
        { recipient_name: 'Acme Corporation', recipient_level: null, uei: null, duns: null },
      ],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'recipient', search_text: 'acme' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].name).toBe('Acme Corporation');
    // recipient_id / legal_business_name don't exist on this endpoint — id stays unset
    expect(result.results[0].id).toBeUndefined();
    expect(result.results[0].uei).toBeUndefined();
    expect(result.results[0].duns).toBeUndefined();
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

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'recipient', search_text: 'microsoft' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].name).toBe('MICROSOFT CORPORATION');
    expect(result.results[0].uei).toBe('FMVPEWNJGLM1');
    expect(result.results[0].duns).toBe('081466849');
    expect(result.results[0].id).toBeUndefined();
  });

  it('throws no_match when no results found', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: autocompleteTool.errors });
    const input = autocompleteTool.input.parse({
      type: 'naics',
      search_text: 'nonexistent_xyz_code',
    });
    await expect(autocompleteTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_match' },
    });
  });

  it('throws when service call fails', async () => {
    mockAutocompletePsc.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: autocompleteTool.errors });
    const input = autocompleteTool.input.parse({ type: 'psc', search_text: 'electronics' });
    await expect(autocompleteTool.handler(input, ctx)).rejects.toThrow();
  });

  it('accepts limit up to the new max of 500 for every type', () => {
    for (const type of ['naics', 'psc', 'cfda', 'awarding_agency', 'recipient'] as const) {
      const input = autocompleteTool.input.parse({ type, search_text: 'x', limit: 500 });
      expect(input.limit).toBe(500);
    }
  });

  it('rejects a limit above the 500 ceiling', () => {
    expect(() =>
      autocompleteTool.input.parse({ type: 'recipient', search_text: 'x', limit: 501 }),
    ).toThrow();
  });

  it('passes the raised limit through to the service', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [{ naics: '513210', naics_description: 'Software Publishers' }],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'naics', search_text: 'soft', limit: 500 });
    await autocompleteTool.handler(input, ctx);

    expect(mockAutocompleteNaics).toHaveBeenCalledWith('soft', 500, ctx);
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

    const blocks = autocompleteTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('naics');
    expect(text).toContain('software');
    expect(text).toContain('513210');
    expect(text).toContain('Software Publishers');
    expect(text).toContain('**Total:** 2');
  });
});
