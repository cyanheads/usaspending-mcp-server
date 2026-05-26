/**
 * @fileoverview Tests for autocomplete tool.
 * @module tests/tools/autocomplete.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
  it('returns NAICS codes for a keyword search', async () => {
    mockAutocompleteNaics.mockResolvedValueOnce({
      results: [
        { code: '541512', description: 'Computer Systems Design Services' },
        { code: '541511', description: 'Custom Computer Programming Services' },
      ],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'naics', search_text: 'computer systems' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.type).toBe('naics');
    expect(result.search_text).toBe('computer systems');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].code).toBe('541512');
    expect(result.results[0].name).toBe('Computer Systems Design Services');
    expect(result.total).toBe(2);
  });

  it('returns agency names for awarding_agency type', async () => {
    mockAutocompleteAwardingAgency.mockResolvedValueOnce({
      results: [
        { id: 517, agency_name: 'Department of Defense' },
        { id: 1, agency_name: 'Department of Agriculture' },
      ],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({
      type: 'awarding_agency',
      search_text: 'department',
    });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].id).toBe('517');
    expect(result.results[0].name).toBe('Department of Defense');
  });

  it('returns recipient names for recipient type', async () => {
    mockAutocompleteRecipient.mockResolvedValueOnce({
      results: [{ recipient_id: 'abc123-P', legal_business_name: 'Acme Corporation' }],
    });

    const ctx = createMockContext();
    const input = autocompleteTool.input.parse({ type: 'recipient', search_text: 'acme' });
    const result = await autocompleteTool.handler(input, ctx);

    expect(result.results[0].id).toBe('abc123-P');
    expect(result.results[0].name).toBe('Acme Corporation');
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

  it('formats output with codes and names', () => {
    const output = {
      type: 'naics',
      search_text: 'computer',
      results: [
        { code: '541512', name: 'Computer Systems Design Services' },
        { code: '541511', name: 'Custom Computer Programming Services' },
      ],
      total: 2,
    };

    const blocks = autocompleteTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('naics');
    expect(text).toContain('computer');
    expect(text).toContain('541512');
    expect(text).toContain('Computer Systems Design Services');
    expect(text).toContain('**Total:** 2');
  });
});
