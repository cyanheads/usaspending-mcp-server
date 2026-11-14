/**
 * @fileoverview Tests for spending-by-category tool.
 * @module tests/tools/spending-by-category.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spendingByCategoryTool } from '@/mcp-server/tools/definitions/spending-by-category.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockSpendingByCategory = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    spendingByCategory: mockSpendingByCategory,
    autocompleteAwardingAgency: async () => ({ results: {} }),
  }),
}));

// A case that fails before its call would leave its queued answer for the next case.
beforeEach(() => mockSpendingByCategory.mockReset());

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
  it('offers the categories this tool aggregates by — not every one upstream serves', () => {
    expect(spendingByCategoryTool.input.shape.category.options).toEqual([
      'naics',
      'psc',
      'awarding_agency',
      'awarding_subagency',
      'funding_agency',
      'funding_subagency',
      'cfda',
      'recipient_duns',
      'federal_account',
      'defc',
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

  it('carries agency_slug on agency rows through both surfaces (#113)', async () => {
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
        agency_slug: 'department-of-health-and-human-services',
        amount: 846_833_468_055.73,
      },
    ]);
    const text = textOf(result);
    expect(text).toContain('| Rank | ID | Name | Code | Agency Slug | Obligation |');
    expect(text).toContain(
      '| 1 | 806 | Department of Health and Human Services | HHS | department-of-health-and-human-services | $846,833,468,055.73 |',
    );
  });
});

/** `search/spending_by_category/awarding_subagency/` rows as the live endpoint returns them (FY2025 contracts). */
const LIVE_SUBAGENCY_ROWS = [
  {
    id: 1174,
    code: 'USN',
    name: 'Department of the Navy',
    agency_id: 126,
    agency_abbreviation: 'DOD',
    agency_name: 'Department of Defense',
    agency_slug: 'department-of-defense',
    subagency_slug: 'department-of-the-navy',
    amount: 176_568_285_348.02,
    total_outlays: null,
  },
  // Upstream nulls the slugs of an agency with no published profile.
  {
    id: 99,
    code: 'XX00',
    name: 'Unpublished Sub-tier',
    agency_id: 99,
    agency_abbreviation: null,
    agency_name: null,
    agency_slug: null,
    subagency_slug: null,
    amount: 5,
    total_outlays: null,
  },
];

describe('spendingByCategoryTool agency slugs, new categories, and page ranks (#113)', () => {
  it("gives a subagency row its parent department's slug and omits a null one", async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: LIVE_SUBAGENCY_ROWS,
      page_metadata: { page: 1, hasNext: false },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'awarding_subagency',
      filters: FY2025_CONTRACTS,
    });

    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows).toEqual([
      {
        id: '1174',
        code: 'USN',
        name: 'Department of the Navy',
        agency_slug: 'department-of-defense',
        amount: 176_568_285_348.02,
      },
      { id: '99', code: 'XX00', name: 'Unpublished Sub-tier', amount: 5 },
    ]);
    const text = textOf(result);
    expect(text).toContain(
      '| 1 | 1174 | Department of the Navy | USN | department-of-defense | $176,568,285,348.02 |',
    );
    // The absent slug is an empty cell, not a placeholder.
    expect(text).toContain('| 2 | 99 | Unpublished Sub-tier | XX00 |  | $5 |');
    expect(text).not.toMatch(/null|undefined|subagency_slug|department-of-the-navy/);
  });

  it('keeps a category without slugs on its original table', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [{ id: 21, code: '541512', name: 'Computer Systems Design', amount: 7 }],
      page_metadata: { page: 1, hasNext: false },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'naics',
      filters: FY2025_CONTRACTS,
    });

    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows).toEqual([
      { id: '21', code: '541512', name: 'Computer Systems Design', amount: 7 },
    ]);
    const text = textOf(result);
    expect(text).toContain('| Rank | ID | Name | Code | Obligation |');
    expect(text).toContain('| 1 | 21 | Computer Systems Design | 541512 | $7 |');
  });

  it('aggregates by federal account, carrying the AGENCY-MAIN code', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      category: 'federal_account',
      results: [
        {
          id: 4730,
          code: '047-4534',
          name: 'Acquisition Services Fund, General Services Administration',
          amount: 5_206_008_715.99,
          total_outlays: null,
        },
      ],
      page_metadata: { page: 1, hasNext: true },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'federal_account',
      filters: { ...FY2025_CONTRACTS, naics_codes: ['541512'] },
      limit: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpendingByCategory.mock.lastCall?.[0]).toBe('federal_account');
    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows).toEqual([
      {
        id: '4730',
        code: '047-4534',
        name: 'Acquisition Services Fund, General Services Administration',
        amount: 5_206_008_715.99,
      },
    ]);
    expect(textOf(result)).toContain(
      '| 1 | 4730 | Acquisition Services Fund, General Services Administration | 047-4534 | $5,206,008,715.99 |',
    );
  });

  it('aggregates by DEF code, omitting the null id', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      category: 'defc',
      results: [
        {
          id: null,
          code: 'Z',
          name: 'Infrastructure Investment and Jobs Act',
          amount: 115_770_950_693.21,
          total_outlays: null,
        },
      ],
      page_metadata: { page: 1, hasNext: true },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'defc',
      filters: { time_period_start: '2024-10-01', time_period_end: '2025-09-30', def_codes: ['z'] },
      limit: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpendingByCategory.mock.lastCall?.[0]).toBe('defc');
    expect(mockSpendingByCategory.mock.lastCall?.[1].filters.def_codes).toEqual(['Z']);
    const rows = (result.structuredContent as { results: Record<string, unknown>[] }).results;
    expect(rows).toEqual([
      { code: 'Z', name: 'Infrastructure Investment and Jobs Act', amount: 115_770_950_693.21 },
    ]);
    expect(textOf(result)).toContain(
      '| 1 | N/A | Infrastructure Investment and Jobs Act | Z | $115,770,950,693.21 |',
    );
  });

  it('states that federal_account and defc rows overlap and how def_codes reads on defc', () => {
    const category = spendingByCategoryTool.input.shape.category.description ?? '';
    for (const text of [spendingByCategoryTool.description, category]) {
      expect(text).toContain('federal_account');
      expect(text).toContain('defc');
      expect(text).toMatch(/never sum to a total/);
      expect(text).toMatch(/def_codes selects awards/);
    }
  });

  it.each([
    [1, ['1', '2', '3']],
    [2, ['4', '5', '6']],
    [5, ['13', '14', '15']],
  ])('numbers page %i ranks from where the page starts', async (page, ranks) => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [
        { code: '524114', name: 'Direct Health and Medical Insurance Carriers', amount: 3 },
        { code: '561210', name: 'Facilities Support Services', amount: 2 },
        { code: '336611', name: 'Ship Building and Repairing', amount: 1 },
      ],
      page_metadata: { page, hasNext: true },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'naics',
      filters: FY2025_CONTRACTS,
      limit: 3,
      page,
    });

    const text = textOf(result);
    expect(text).toContain(`| ${ranks[0]} | N/A | Direct Health and Medical Insurance Carriers |`);
    expect(text).toContain(`| ${ranks[1]} | N/A | Facilities Support Services |`);
    expect(text).toContain(`| ${ranks[2]} | N/A | Ship Building and Repairing |`);
  });
});

describe('spendingByCategoryTool limit above the 100 cap (#99)', () => {
  afterEach(() => vi.unstubAllEnvs());

  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ code: `C${i}`, name: `Item ${i}`, amount: n - i }));

  it('reads limit 101 at page 2 as limit 100: request, page_metadata, ranks, limitClamp, notice', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: rows(100),
      page_metadata: { page: 2, hasNext: true },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'naics',
      filters: FY2025_CONTRACTS,
      limit: 101,
      page: 2,
    });

    expect(result.isError).toBeFalsy();
    expect(mockSpendingByCategory.mock.lastCall?.[1]).toMatchObject({ limit: 100, page: 2 });
    expect(result.structuredContent).toMatchObject({
      page_metadata: { limit: 100, page: 2, has_next: true },
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
      notice: 'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    });
    const raw = textOf(result);
    expect(raw).toContain('**Limit clamp:** `limit` requested 101, applied 100');
    // Page 2 of 100-row pages starts at rank 101, not 102.
    expect(raw).toContain('| 101 | N/A | Item 0 | C0 |');
    expect(raw).toContain('| 200 | N/A | Item 99 | C99 |');
    expect(markdownText(raw)).toContain(
      'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    );
  });

  it('keeps the clamp sentence beside the filled-bound and empty-result notices', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: [],
      page_metadata: { page: 1, hasNext: false },
    });
    const result = await runToolContract(spendingByCategoryTool, {
      category: 'psc',
      filters: { time_period_start: '2024-10-01', psc_codes: ['zz'] },
      limit: 500,
    });

    const notice = (result.structuredContent as { notice?: string }).notice;
    expect(notice).toContain('limit 500 exceeds the per-call maximum of 100');
    expect(notice).toContain('time_period_end');
    expect(notice).toContain('No psc data matched the filters (psc_codes=ZZ)');
  });

  it('reports no clamp at the cap', async () => {
    mockSpendingByCategory.mockResolvedValueOnce({
      results: rows(1),
      page_metadata: { page: 1, hasNext: false },
    });
    const result = await runToolContract(spendingByCategoryTool, { category: 'naics', limit: 100 });

    expect(mockSpendingByCategory.mock.lastCall?.[1]).toMatchObject({ limit: 100 });
    expect(result.structuredContent).not.toHaveProperty('limitClamp');
    expect(result.structuredContent).toHaveProperty(
      'notice',
      "Results use USAspending's available coverage without a date filter.",
    );
  });

  it('advertises no maximum by default, and maximum 100 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
    expect(advertisedProperty(spendingByCategoryTool.input, 'limit')).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Items per page. Default 10, at most 100 per call.',
    });

    const strict = await loadWithClampLimits(
      'false',
      async () =>
        (await import('@/mcp-server/tools/definitions/spending-by-category.tool.js'))
          .spendingByCategoryTool,
    );

    expect(advertisedProperty(strict.input, 'limit')).toMatchObject({ maximum: 100 });
    const rejected = await runToolContract(strict, { category: 'naics', limit: 101 });
    expect(rejected.isError).toBe(true);
    expect(markdownText(textOf(rejected))).toContain('Too big: expected number to be <=100');
    expect(mockSpendingByCategory).not.toHaveBeenCalled();
  });

  it('still rejects zero and non-integer limits', async () => {
    for (const limit of [0, -1, 1.5]) {
      const result = await runToolContract(spendingByCategoryTool, { category: 'naics', limit });
      expect(result.isError).toBe(true);
    }
    expect(mockSpendingByCategory).not.toHaveBeenCalled();
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
