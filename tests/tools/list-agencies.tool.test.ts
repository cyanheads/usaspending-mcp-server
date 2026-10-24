/**
 * @fileoverview Tests for list-agencies tool.
 * @module tests/tools/list-agencies.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { listAgenciesTool } from '@/mcp-server/tools/definitions/list-agencies.tool.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockListAgencies = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ listAgencies: mockListAgencies }),
}));

describe('listAgenciesTool', () => {
  it('keeps the complete provider order and missing periods when limit is omitted', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        { agency_name: 'Z', toptier_code: '002' },
        { agency_name: 'A', toptier_code: '001' },
      ],
    });
    const response = await runToolContract(listAgenciesTool, {});
    const result = listAgenciesTool.output.parse(response.structuredContent);
    expect(result.results.map((row) => row.toptier_code)).toEqual(['002', '001']);
    expect(result.total).toBe(2);
    expect(result.results[0]).not.toHaveProperty('fiscal_year');
    expect(response.structuredContent).toMatchObject({ totalCount: 2, agency_count: 2 });
    const text = markdownText(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    expect(text).toContain('2 total');
  });

  it('carries provider fiscal period labels on both surfaces without inventing missing periods', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        {
          agency_name: 'Interior',
          toptier_code: '014',
          active_fy: '2026',
          active_fq: '4',
          budget_authority_amount: 96773322454.92,
        },
        { agency_name: 'Missing', toptier_code: '999', active_fy: null, active_fq: '' },
      ],
    });
    const response = await runToolContract(listAgenciesTool, {});
    expect(response.isError).toBeFalsy();
    const data = response.structuredContent as { results: Record<string, unknown>[] };
    expect(data.results[0]).toMatchObject({
      fiscal_year: 2026,
      fiscal_quarter: 4,
      budget_authority_amount: 96773322454.92,
    });
    expect(data.results[1]).not.toHaveProperty('fiscal_year');
    expect(data.results[1]).not.toHaveProperty('fiscal_quarter');
    const text = markdownText(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    expect(text).toContain('2026');
    expect(text).toContain('\n4\n');
  });

  it('walks optional pages with a full total, partial last page, and past-end continuation on both surfaces', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      agency_name: `Agency ${i}`,
      toptier_code: `00${i}`,
    }));
    const seen: string[] = [];
    for (const [page, expected, hasNext] of [
      [1, ['000', '001'], true],
      [2, ['002', '003'], true],
      [3, ['004'], false],
      [4, [], false],
    ] as const) {
      mockListAgencies.mockResolvedValueOnce({ results: rows });
      const response = await runToolContract(listAgenciesTool, { limit: 2, page });
      expect(response.isError).toBeFalsy();
      const data = response.structuredContent as {
        results: { toptier_code: string }[];
        total: number;
        has_next: boolean;
        agency_count: number;
      };
      expect(data.results.map((row) => row.toptier_code)).toEqual(expected);
      expect(data.total).toBe(5);
      expect(response.structuredContent).toMatchObject({ totalCount: 5 });
      expect(data.agency_count).toBe(expected.length);
      expect(data.has_next).toBe(hasNext);
      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
      expect(text).toContain(`**Has next:** ${hasNext}`);
      expect(text).toContain('(5)');
      expect(markdownText(text)).toContain('5 total');
      seen.push(...data.results.map((row) => row.toptier_code));
    }
    expect(seen).toEqual(['000', '001', '002', '003', '004']);
  });

  it('ignores page without limit and accepts an uncapped limit', async () => {
    for (const args of [{ page: 99 }, { limit: 100000 }]) {
      mockListAgencies.mockResolvedValueOnce({
        results: [{ agency_name: 'A', toptier_code: '001' }],
      });
      const result = await listAgenciesTool.handler(
        listAgenciesTool.input.parse(args),
        createMockContext({ errors: listAgenciesTool.errors }),
      );
      expect(result.results).toHaveLength(1);
      expect(result.total).toBe(1);
      if ('limit' in args) expect(result).toHaveProperty('has_next', false);
      else expect(result).not.toHaveProperty('has_next');
    }
  });

  it('retains empty directories and forwards provider sorting without pagination parameters', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });
    const response = await runToolContract(listAgenciesTool, {
      limit: 10,
      sort: 'obligated_amount',
      order: 'desc',
    });
    const result = listAgenciesTool.output.parse(response.structuredContent);
    expect(mockListAgencies).toHaveBeenLastCalledWith(
      { sort: 'obligated_amount', order: 'desc' },
      expect.anything(),
    );
    expect(result).toEqual({ results: [], total: 0, has_next: false });
    expect(response.structuredContent).toMatchObject({ totalCount: 0, agency_count: 0 });
    expect(
      markdownText(
        response.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ),
    ).toContain('0 total');
  });

  it.each([{ limit: 0 }, { limit: 1.5 }, { page: 0 }, { page: 1.5 }])(
    'rejects non-positive or fractional pagination %j',
    (args) => {
      expect(listAgenciesTool.input.safeParse(args).success).toBe(false);
    },
  );
  it('returns a list of federal agencies', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        {
          agency_name: 'Department of Agriculture',
          abbreviation: 'USDA',
          toptier_code: '012',
          agency_slug: 'department-of-agriculture',
          budget_authority_amount: 150_000_000_000,
          obligated_amount: 130_000_000_000,
          outlay_amount: 120_000_000_000,
        },
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 800_000_000_000,
          obligated_amount: 750_000_000_000,
          outlay_amount: 700_000_000_000,
        },
      ],
    });

    const ctx = createMockContext({ errors: listAgenciesTool.errors });
    const input = listAgenciesTool.input.parse({});
    const result = await listAgenciesTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.agency_name).toBe('Department of Agriculture');
    expect(result.results[0]!.toptier_code).toBe('012');
    expect(result.results[0]!.agency_slug).toBe('department-of-agriculture');
    expect(result.results[0]!.budget_authority_amount).toBe(150_000_000_000);
    expect(result.total).toBe(2);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.agency_count).toBe(2);
  });

  it('returns empty results when no agencies are found', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: listAgenciesTool.errors });
    const input = listAgenciesTool.input.parse({});
    const result = await listAgenciesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('throws when service call fails', async () => {
    mockListAgencies.mockRejectedValueOnce(new Error('Service unavailable'));

    const ctx = createMockContext({ errors: listAgenciesTool.errors });
    const input = listAgenciesTool.input.parse({});
    await expect(listAgenciesTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes sort and order params through', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: listAgenciesTool.errors });
    const input = listAgenciesTool.input.parse({
      sort: 'budget_authority_amount',
      order: 'desc',
    });
    await listAgenciesTool.handler(input, ctx);

    expect(mockListAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'budget_authority_amount', order: 'desc' }),
      ctx,
    );
  });

  it('formats output as a table with codes and amounts', () => {
    const output = {
      results: [
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 800_000_000_000,
          obligated_amount: 750_000_000_000,
          outlay_amount: 700_000_000_000,
        },
      ],
      total: 1,
    };

    const blocks = listAgenciesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Department of Defense');
    expect(text).toContain('097');
    expect(text).toContain('department-of-defense');
    expect(text).toContain('800,000,000,000');
  });
});
