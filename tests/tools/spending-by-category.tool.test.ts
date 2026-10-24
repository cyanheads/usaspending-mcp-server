/**
 * @fileoverview Tests for spending-by-category tool.
 * @module tests/tools/spending-by-category.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';

const mockSpendingByCategory = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ spendingByCategory: mockSpendingByCategory }),
}));

const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

const FY2025_CONTRACTS = {
  award_type_codes: ['A', 'B', 'C', 'D'],
  time_period_start: '2024-10-01',
  time_period_end: '2025-09-30',
};

describe('spendingByCategoryTool category enum (#80)', () => {
  it('wires both agency tiers and echoes the matched name even for an empty result', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({ results: [], page_metadata: {} });
    const response = await runToolContract(spendingByCategoryTool, {
      category: 'awarding_agency',
      filters: { agency_name: 'U.S. Geological Survey' },
    });
    expect(response.isError).toBeFalsy();
    expect(mockSpendingByCategory.mock.lastCall?.[1].filters.agencies).toEqual([
      { type: 'awarding', tier: 'toptier', name: 'U.S. Geological Survey' },
      { type: 'awarding', tier: 'subtier', name: 'U.S. Geological Survey' },
    ]);
    expect(response.structuredContent).toMatchObject({
      results: [],
      applied_agency_name: 'U.S. Geological Survey',
    });
    expect(textOf(response)).toContain('U.S. Geological Survey');
  });
  it('offers exactly the categories USAspending serves', () => {
    expect(spendingByCategoryTool.input.shape.category.options).toEqual([
      'naics',
      'psc',
      'awarding_agency',
      'awarding_subagency',
      'funding_agency',
      'funding_subagency',
      'cfda',
      'recipient_duns',
    ]);
  });

  it('rejects recipient_parent_duns before any request is sent', async () => {
    mockSpendingByCategory.mockClear();
    mockSpendingByCategory.mockResolvedValueOnce({ results: [], page_metadata: {} });
    // Sent as an agent would, past the narrowed type.
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'recipient_parent_duns',
      filters: FY2025_CONTRACTS,
      limit: 5,
    } as never);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: -32602, data: { issues: [{ path: ['category'] }] } },
    });
    expect(textOf(result)).toContain('category: Invalid option');
    expect(mockSpendingByCategory).not.toHaveBeenCalled();
    mockSpendingByCategory.mockReset();
  });
});

/** `search/spending_by_category/recipient_duns/` rows as the live endpoint returns them (FY2025 contracts). */
const LIVE_RECIPIENT_ROWS = [
  {
    amount: 34_099_542_924.06,
    recipient_id: '6cf5fb1b-4988-d087-5dc1-70939d8fc6c4-C',
    name: 'LOCKHEED MARTIN CORPORATION',
    code: '008016958',
    uei: 'G4KDGE4JFFK7',
    total_outlays: null,
  },
  {
    amount: 1_250_000,
    recipient_id: '41694631-0b0f-72ed-221b-29193c88f0d2-C',
    name: 'LEGACY DUNS-ONLY RECIPIENT',
    code: '785030714',
    uei: null,
    total_outlays: null,
  },
  {
    amount: 900_000,
    recipient_id: null,
    name: 'MULTIPLE RECIPIENTS',
    code: null,
    uei: null,
    total_outlays: null,
  },
];

describe('spendingByCategoryTool recipient identifiers (#83)', () => {
  it('carries recipient_id and uei on recipient_duns rows through both surfaces', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: LIVE_RECIPIENT_ROWS,
      page_metadata: { page: 1, next: 2, previous: null, hasNext: true, hasPrevious: false },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'recipient_duns',
      filters: FY2025_CONTRACTS,
      limit: 3,
    });

    expect(result.isError).toBeFalsy();
    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows[0]).toEqual({
      recipient_id: '6cf5fb1b-4988-d087-5dc1-70939d8fc6c4-C',
      uei: 'G4KDGE4JFFK7',
      code: '008016958',
      name: 'LOCKHEED MARTIN CORPORATION',
      amount: 34_099_542_924.06,
    });
    // A null upstream value is omitted, never carried as null.
    expect(rows[1]).toEqual({
      recipient_id: '41694631-0b0f-72ed-221b-29193c88f0d2-C',
      code: '785030714',
      name: 'LEGACY DUNS-ONLY RECIPIENT',
      amount: 1_250_000,
    });
    expect(rows[2]).toEqual({ name: 'MULTIPLE RECIPIENTS', amount: 900_000 });

    const text = textOf(result);
    expect(text).toContain('6cf5fb1b-4988-d087-5dc1-70939d8fc6c4-C');
    expect(text).toContain('G4KDGE4JFFK7');
    expect(text).toContain('41694631-0b0f-72ed-221b-29193c88f0d2-C');
    expect(text).not.toMatch(/null|undefined/);
    // The absent UEI and recipient ID render as empty cells, not placeholders.
    expect(text).toContain('| 3 | N/A | MULTIPLE RECIPIENTS | N/A |  |  | $900,000 |');
  });

  it('leaves rows of other categories unchanged', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        {
          id: 806,
          code: 'HHS',
          name: 'Department of Health and Human Services',
          agency_slug: 'department-of-health-and-human-services',
          amount: 846_833_468_055.73,
          total_outlays: null,
        },
      ],
      page_metadata: { page: 1, hasNext: false },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'awarding_agency',
      filters: FY2025_CONTRACTS,
    });
    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows).toEqual([
      {
        id: '806',
        code: 'HHS',
        name: 'Department of Health and Human Services',
        amount: 846_833_468_055.73,
      },
    ]);
    const text = textOf(result);
    expect(text).toContain('| Rank | ID | Name | Code | Obligation |');
    expect(text).toContain(
      '| 1 | 806 | Department of Health and Human Services | HHS | $846,833,468,055.73 |',
    );
  });
});

describe('spendingByCategoryTool', () => {
  it('returns NAICS breakdown results', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        {
          id: '541512',
          code: '541512',
          name: 'Computer Systems Design Services',
          amount: 2_000_000_000,
        },
        { id: '336411', code: '336411', name: 'Aircraft Manufacturing', amount: 1_500_000_000 },
      ],
      page_metadata: { hasNext: false, page: 1, total: 2, limit: 10 },
    });

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({ category: 'naics', limit: 10 });
    const result = await spendingByCategoryTool.handler(input, ctx);

    expect(result.category).toBe('naics');
    expect(result.results).toHaveLength(2);
    expect(result.results[0]!.code).toBe('541512');
    expect(result.results[0]!.name).toBe('Computer Systems Design Services');
    expect(result.results[0]!.amount).toBe(2_000_000_000);
    expect(result.page_metadata.has_next).toBe(false);
  });

  it('populates enrichment notice when no results found', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [],
      page_metadata: { hasNext: false, page: 1, total: 0, limit: 10 },
    });

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({ category: 'psc' });
    const result = await spendingByCategoryTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('psc');
  });

  it('populates enrichment with pagination context', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        { id: '541512', code: '541512', name: 'Computer Systems Design', amount: 2_000_000_000 },
      ],
      page_metadata: { hasNext: true, page: 1, total: 50, limit: 10 },
    });

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({ category: 'naics', limit: 10 });
    await spendingByCategoryTool.handler(input, ctx);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(50);
    expect(enrichment.page).toBe(1);
    expect(enrichment.has_next).toBe(true);
  });

  it('throws when service call fails', async () => {
    mockSpendingByCategory.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({ category: 'awarding_agency' });
    await expect(spendingByCategoryTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes filters through to service', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [{ id: '097', code: '097', name: 'DoD', amount: 500_000_000 }],
      page_metadata: { hasNext: false, page: 1, total: 1, limit: 10 },
    });

    const ctx = createMockContext({ errors: spendingByCategoryTool.errors });
    const input = spendingByCategoryTool.input.parse({
      category: 'awarding_agency',
      filters: {
        time_period_start: '2023-01-01',
        time_period_end: '2023-12-31',
        award_type_codes: ['A', 'B'],
      },
      limit: 5,
    });
    await spendingByCategoryTool.handler(input, ctx);

    expect(mockSpendingByCategory).toHaveBeenCalledWith(
      'awarding_agency',
      expect.objectContaining({
        filters: expect.objectContaining({ award_type_codes: ['A', 'B'] }),
        limit: 5,
      }),
      ctx,
    );

    const enrichment = getEnrichment(ctx);
    expect(enrichment.applied_time_period_start).toBe('2023-01-01');
    expect(enrichment.applied_time_period_end).toBe('2023-12-31');
  });

  it('formats output with category codes and amounts', () => {
    const output = {
      category: 'naics',
      results: [
        {
          id: '541512',
          code: '541512',
          name: 'Computer Systems Design Services',
          amount: 2_000_000_000,
        },
      ],
      page_metadata: { has_next: false, page: 1, total: 1, limit: 10 },
    };

    const blocks = spendingByCategoryTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('naics');
    expect(text).toContain('541512');
    expect(text).toContain('2,000,000,000');
    expect(text).toContain('Computer Systems Design Services');
  });

  it('renders the item total as a labeled count, not a page count (issue #34)', () => {
    // total=50 is the item total; it must be labeled, not interpolated after "Page:" as a page count.
    const output = {
      category: 'naics',
      results: [{ id: '541512', code: '541512', name: 'Computer Systems Design', amount: 1_234 }],
      page_metadata: { has_next: true, page: 1, total: 50, limit: 5 },
    };

    const text = (spendingByCategoryTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('**Total items:** ~50');
    expect(text).not.toContain(' of ~');
  });
});
