/**
 * @fileoverview Tests for search-federal-accounts tool.
 * @module tests/tools/search-federal-accounts.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { searchFederalAccountsTool } from '@/mcp-server/tools/definitions/search-federal-accounts.tool.js';

const mockSearchFederalAccounts = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchFederalAccounts: mockSearchFederalAccounts }),
}));

describe('searchFederalAccountsTool', () => {
  it('returns accounts for a keyword search', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({
      count: 42,
      page: 1,
      hasNext: true,
      hasPrevious: false,
      results: [
        {
          account_id: 6052,
          account_number: '097-8097',
          account_name: 'Department of Defense Military Retirement Fund',
          agency_identifier: '097',
          managing_agency: 'Department of Defense',
          managing_agency_acronym: 'DOD',
          budgetary_resources: 257716000000.0,
        },
      ],
    });

    const ctx = createMockContext();
    const input = searchFederalAccountsTool.input.parse({ keyword: 'defense', limit: 5 });
    const result = await searchFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].account_number).toBe('097-8097');
    expect(result.results[0].account_name).toBe('Department of Defense Military Retirement Fund');
    expect(result.results[0].managing_agency).toBe('Department of Defense');
    expect(result.results[0].managing_agency_acronym).toBe('DOD');
    expect(result.results[0].budgetary_resources).toBe(257716000000.0);
    expect(result.page_metadata.count).toBe(42);
    expect(result.page_metadata.has_next).toBe(true);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.total).toBe(42);
    expect(enrichment.page).toBe(1);
    expect(enrichment.has_next).toBe(true);
  });

  it('populates empty-results notice when no accounts match', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({
      count: 0,
      page: 1,
      hasNext: false,
      results: [],
    });

    const ctx = createMockContext();
    const input = searchFederalAccountsTool.input.parse({
      keyword: 'zzznomatch',
      agency_identifier: '999',
    });
    const result = await searchFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('zzznomatch');
  });

  it('handles sparse account — optional fields omitted by upstream', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({
      count: 1,
      page: 1,
      hasNext: false,
      results: [
        {
          account_number: '012-3456',
          account_name: 'Sparse Agency Fund',
          // agency_identifier, managing_agency, managing_agency_acronym, budgetary_resources omitted
        },
      ],
    });

    const ctx = createMockContext();
    const input = searchFederalAccountsTool.input.parse({ keyword: 'sparse' });
    const result = await searchFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0].account_number).toBe('012-3456');
    expect(result.results[0].agency_identifier).toBeUndefined();
    expect(result.results[0].managing_agency).toBeUndefined();
    expect(result.results[0].managing_agency_acronym).toBeUndefined();
    expect(result.results[0].budgetary_resources).toBeUndefined();
  });

  it('throws when service call fails', async () => {
    mockSearchFederalAccounts.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: searchFederalAccountsTool.errors });
    const input = searchFederalAccountsTool.input.parse({ keyword: 'defense' });
    await expect(searchFederalAccountsTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with all account fields', () => {
    const output = {
      results: [
        {
          account_number: '097-8097',
          account_name: 'DoD Military Retirement Fund',
          agency_identifier: '097',
          managing_agency: 'Department of Defense',
          managing_agency_acronym: 'DOD',
          budgetary_resources: 257716000000,
        },
      ],
      page_metadata: { count: 1, page: 1, has_next: false, limit: 10 },
    };

    const blocks = searchFederalAccountsTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('097-8097');
    expect(text).toContain('DoD Military Retirement Fund');
    expect(text).toContain('Department of Defense');
    expect(text).toContain('DOD');
    expect(text).toContain('257');
  });
});
