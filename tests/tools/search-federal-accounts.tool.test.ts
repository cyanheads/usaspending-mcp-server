/**
 * @fileoverview Tests for search-federal-accounts tool.
 * @module tests/tools/search-federal-accounts.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { searchFederalAccountsTool } from '@/mcp-server/tools/definitions/search-federal-accounts.tool.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockSearchFederalAccounts = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ searchFederalAccounts: mockSearchFederalAccounts }),
}));

describe('searchFederalAccountsTool', () => {
  beforeEach(() => {
    mockSearchFederalAccounts.mockReset();
  });
  // Budgetary-resource values captured from the FY2024/FY2025 upstream controls.
  it.each([
    [2024, 10_735_613_505.05],
    [2025, 11_130_641_014.63],
  ])(
    'forwards FY%i alongside agency filters and preserves the returned year on both surfaces',
    async (year, resources) => {
      mockSearchFederalAccounts.mockResolvedValueOnce({
        fy: String(year),
        count: 2,
        results: [
          { account_number: '014-0680', budgetary_resources: resources },
          { account_number: '014-5430', budgetary_resources: 0 },
        ],
      });
      const result = await runToolContract(searchFederalAccountsTool, {
        agency_identifier: '014',
        fiscal_year: year,
      });
      expect(mockSearchFederalAccounts).toHaveBeenLastCalledWith(
        expect.objectContaining({ filters: { agency_identifier: '014', fy: String(year) } }),
        expect.anything(),
      );
      expect(result.structuredContent).toMatchObject({
        fiscal_year: year,
        results: [{ budgetary_resources: resources }, { budgetary_resources: 0 }],
      });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'text',
            text: expect.stringContaining(`**Fiscal Year:** ${year}`),
          }),
        ]),
      );
      const rendered = markdownText(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      );
      expect(rendered).toContain('Fiscal Year:');
      expect(rendered).toContain(String(year));
    },
  );

  it('rejects a nonblank string year before calling the service', async () => {
    const result = await runToolContract(searchFederalAccountsTool, { fiscal_year: '2025' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(mockSearchFederalAccounts).not.toHaveBeenCalled();
  });

  it('preserves the effective year on an empty search', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({ fy: 2025, count: 0, results: [] });
    const result = await runToolContract(searchFederalAccountsTool, { fiscal_year: 2025 });
    expect(result.structuredContent).toMatchObject({
      fiscal_year: 2025,
      results: [],
      notice: expect.any(String),
    });
    expect(JSON.stringify(result.content)).toContain('2025');
  });

  it('treats a blank year as omitted', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({ results: [] });
    const result = await runToolContract(searchFederalAccountsTool, { fiscal_year: '  ' });
    expect(result.isError).not.toBe(true);
    expect(mockSearchFederalAccounts).toHaveBeenLastCalledWith(
      { sort: { field: 'budgetary_resources', direction: 'desc' }, page: 1, limit: 10 },
      expect.anything(),
    );
  });
  it('preserves the unfiltered default request', async () => {
    mockSearchFederalAccounts.mockResolvedValueOnce({
      fy: '2025',
      results: [{ account_number: '014-0680', account_name: 'Water Resources' }],
    });
    const result = await runToolContract(searchFederalAccountsTool, {});
    expect(mockSearchFederalAccounts).toHaveBeenLastCalledWith(
      { sort: { field: 'budgetary_resources', direction: 'desc' }, page: 1, limit: 10 },
      expect.anything(),
    );
    expect(result.isError).not.toBe(true);
    expect(searchFederalAccountsTool.output.parse(result.structuredContent)).toEqual({
      fiscal_year: 2025,
      results: [{ account_number: '014-0680', account_name: 'Water Resources' }],
      page_metadata: { page: 1, has_next: false, limit: 10 },
    });
    expect(
      markdownText(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ),
    ).toContain('Water Resources');
  });
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

    const ctx = createMockContext({ errors: searchFederalAccountsTool.errors });
    const input = searchFederalAccountsTool.input.parse({ keyword: 'defense', limit: 5 });
    const result = await searchFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.account_number).toBe('097-8097');
    expect(result.results[0]!.account_name).toBe('Department of Defense Military Retirement Fund');
    expect(result.results[0]!.managing_agency).toBe('Department of Defense');
    expect(result.results[0]!.managing_agency_acronym).toBe('DOD');
    expect(result.results[0]!.budgetary_resources).toBe(257716000000.0);
    expect(result.page_metadata.count).toBe(42);
    expect(result.page_metadata.has_next).toBe(true);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(42);
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

    const ctx = createMockContext({ errors: searchFederalAccountsTool.errors });
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

    const ctx = createMockContext({ errors: searchFederalAccountsTool.errors });
    const input = searchFederalAccountsTool.input.parse({ keyword: 'sparse' });
    const result = await searchFederalAccountsTool.handler(input, ctx);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.account_number).toBe('012-3456');
    expect(result.results[0]!.agency_identifier).toBeUndefined();
    expect(result.results[0]!.managing_agency).toBeUndefined();
    expect(result.results[0]!.managing_agency_acronym).toBeUndefined();
    expect(result.results[0]!.budgetary_resources).toBeUndefined();
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

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // count=200 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      results: [{ account_number: '012-3456', account_name: 'Sparse Fund' }],
      page_metadata: { count: 200, page: 1, has_next: true, limit: 2 },
    };

    const text = (searchFederalAccountsTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~200');
    expect(text).not.toContain(' of ~');
  });
});
