/**
 * @fileoverview Tests for get-federal-account-breakdown tool.
 * @module tests/tools/get-federal-account-breakdown.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFederalAccountBreakdownTool } from '@/mcp-server/tools/definitions/get-federal-account-breakdown.tool.js';

const mockProgramActivities = vi.fn();
const mockObjectClasses = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getFederalAccountProgramActivities: mockProgramActivities,
    getFederalAccountObjectClasses: mockObjectClasses,
  }),
}));

describe('getFederalAccountBreakdownTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns program activity rows carrying the type field', async () => {
    // Verbatim live rows for 097-0100 program_activities/total.
    mockProgramActivities.mockResolvedValueOnce({
      results: [
        {
          code: '0004',
          obligations: 288_208_446_567.76,
          name: 'ADMINISTRATION AND SERVICE-WIDE ACTIVITIES',
          type: 'PAC/PAN',
        },
        { code: '0001', obligations: 65_558_004_676.6, name: 'OPERATING FORCES', type: 'PAC/PAN' },
      ],
      page_metadata: {
        page: 1,
        total: 32,
        limit: 2,
        next: 2,
        previous: null,
        hasNext: true,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext();
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '097-0100',
      dimension: 'program_activity',
      limit: 2,
    });
    const result = await getFederalAccountBreakdownTool.handler(input, ctx);

    expect(result.account_code).toBe('097-0100');
    expect(result.dimension).toBe('program_activity');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].code).toBe('0004');
    expect(result.results[0].name).toBe('ADMINISTRATION AND SERVICE-WIDE ACTIVITIES');
    expect(result.results[0].obligations).toBe(288_208_446_567.76);
    expect(result.results[0].type).toBe('PAC/PAN');

    // page_metadata.total — this endpoint family reports `total`, not `count`.
    expect(result.page_metadata.total).toBe(32);
    expect(result.page_metadata.has_next).toBe(true);
    expect(result.page_metadata.has_previous).toBe(false);

    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(32);
    expect(enrichment.applied_dimension).toBe('program_activity');
    expect(enrichment.has_next_page).toBe(true);
  });

  it('keeps enrichment keys disjoint from output keys', () => {
    // The effective output schema is output.extend(enrichment) — a shared key would
    // silently override the output field.
    const outputKeys = Object.keys(getFederalAccountBreakdownTool.output.shape);
    const enrichmentKeys = Object.keys(getFederalAccountBreakdownTool.enrichment ?? {});
    expect(enrichmentKeys.filter((k) => outputKeys.includes(k))).toEqual([]);
  });

  it('returns object class rows, which carry no type field', async () => {
    // Verbatim live rows for 097-0100 object_classes/total — no `type` key upstream.
    mockObjectClasses.mockResolvedValueOnce({
      results: [
        {
          code: '25.2',
          obligations: 99_427_954_049.93,
          name: 'Other services from non-Federal sources',
        },
        { code: '11.1', obligations: 92_174_590_800.42, name: 'Full-time permanent' },
      ],
      page_metadata: {
        page: 1,
        total: 35,
        limit: 2,
        next: 2,
        previous: null,
        hasNext: true,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext();
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '097-0100',
      dimension: 'object_class',
      limit: 2,
    });
    const result = await getFederalAccountBreakdownTool.handler(input, ctx);

    expect(result.dimension).toBe('object_class');
    expect(result.results[0].code).toBe('25.2');
    expect(result.results[0].obligations).toBe(99_427_954_049.93);
    // type must stay absent rather than be invented for this dimension.
    expect(result.results[0].type).toBeUndefined();
    expect(result.page_metadata.total).toBe(35);
  });

  it('dispatches each dimension to its own endpoint', async () => {
    const empty = { results: [], page_metadata: { page: 1, total: 0, hasNext: false } };

    mockProgramActivities.mockResolvedValueOnce(empty);
    await getFederalAccountBreakdownTool.handler(
      getFederalAccountBreakdownTool.input.parse({
        account_code: '097-0100',
        dimension: 'program_activity',
      }),
      createMockContext(),
    );
    expect(mockProgramActivities).toHaveBeenCalledTimes(1);
    expect(mockObjectClasses).not.toHaveBeenCalled();
    expect(mockProgramActivities).toHaveBeenCalledWith(
      '097-0100',
      { limit: 10, page: 1 },
      expect.anything(),
    );

    mockObjectClasses.mockResolvedValueOnce(empty);
    await getFederalAccountBreakdownTool.handler(
      getFederalAccountBreakdownTool.input.parse({
        account_code: '097-0100',
        dimension: 'object_class',
      }),
      createMockContext(),
    );
    expect(mockObjectClasses).toHaveBeenCalledTimes(1);
    expect(mockProgramActivities).toHaveBeenCalledTimes(1);
  });

  it('reports the final page as having no next', async () => {
    // Live: object_classes/total page 4 of 4 for 097-0100 — 5 rows of 35.
    mockObjectClasses.mockResolvedValueOnce({
      results: Array.from({ length: 5 }, (_, i) => ({ code: `9${i}.0`, obligations: i })),
      page_metadata: {
        page: 4,
        total: 35,
        limit: 10,
        next: null,
        previous: 3,
        hasNext: false,
        hasPrevious: true,
      },
    });

    const ctx = createMockContext();
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '097-0100',
      dimension: 'object_class',
      limit: 10,
      page: 4,
    });
    const result = await getFederalAccountBreakdownTool.handler(input, ctx);

    expect(result.results).toHaveLength(5);
    expect(result.page_metadata.page).toBe(4);
    expect(result.page_metadata.has_next).toBe(false);
    expect(result.page_metadata.has_previous).toBe(true);
    expect(getEnrichment(ctx).has_next_page).toBe(false);
  });

  /**
   * Both breakdown endpoints answer a nonexistent account code with HTTP 200 and
   * `total: 0` — byte-identical to a real account with no obligations on the axis.
   * There is no miss signal to map, so this is a notice rather than a thrown
   * not-found. (The sibling GET federal_accounts/{code}/ does 400 on a miss, which
   * is why usaspending_get_federal_account can keep its account_not_found contract.)
   */
  it('surfaces a nonexistent account code as an empty-result notice, not a throw', async () => {
    mockProgramActivities.mockResolvedValueOnce({
      results: [],
      page_metadata: {
        page: 1,
        total: 0,
        limit: 10,
        next: null,
        previous: null,
        hasNext: false,
        hasPrevious: false,
      },
    });

    const ctx = createMockContext({ errors: getFederalAccountBreakdownTool.errors });
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '999-9999',
      dimension: 'program_activity',
    });
    const result = await getFederalAccountBreakdownTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    const enrichment = getEnrichment(ctx);
    expect(typeof enrichment.notice).toBe('string');
    expect(enrichment.notice).toContain('999-9999');
    expect(enrichment.notice).toContain('usaspending_search_federal_accounts');
    // The notice points at the other axis as the next thing to try.
    expect(enrichment.notice).toContain('object_class');
  });

  it('declares no not-found reason — the upstream gives no such signal', () => {
    // A declared reason that can never fire is an unreachable recovery contract.
    const reasons = (getFederalAccountBreakdownTool.errors ?? []).map((e) => e.reason);
    expect(reasons).toEqual(['api_unavailable']);
  });

  it('handles a sparse row — fields omitted by upstream', async () => {
    mockProgramActivities.mockResolvedValueOnce({
      results: [{ code: '0001' }],
      page_metadata: { page: 1, hasNext: false },
    });

    const ctx = createMockContext();
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '097-0100',
      dimension: 'program_activity',
    });
    const result = await getFederalAccountBreakdownTool.handler(input, ctx);

    expect(result.results[0].code).toBe('0001');
    expect(result.results[0].name).toBeUndefined();
    expect(result.results[0].obligations).toBeUndefined();
    expect(result.results[0].type).toBeUndefined();
    // No upstream total — must not be invented.
    expect(result.page_metadata.total).toBeUndefined();
    expect(getEnrichment(ctx).totalCount).toBeUndefined();
  });

  it('throws when service call fails', async () => {
    mockProgramActivities.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getFederalAccountBreakdownTool.errors });
    const input = getFederalAccountBreakdownTool.input.parse({
      account_code: '097-0100',
      dimension: 'program_activity',
    });
    await expect(getFederalAccountBreakdownTool.handler(input, ctx)).rejects.toThrow();
  });

  it('renders every output field in content[] at parity with structuredContent', () => {
    const output = {
      account_code: '097-0100',
      dimension: 'program_activity',
      results: [
        {
          code: '0004',
          name: 'ADMINISTRATION AND SERVICE-WIDE ACTIVITIES',
          obligations: 288_208_446_567.76,
          type: 'PAC/PAN',
        },
      ],
      page_metadata: { total: 32, page: 1, has_next: true, has_previous: false, limit: 10 },
    };

    const blocks = getFederalAccountBreakdownTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('097-0100');
    expect(text).toContain('program_activity');
    expect(text).toContain('0004');
    expect(text).toContain('ADMINISTRATION AND SERVICE-WIDE ACTIVITIES');
    expect(text).toContain('288,208,446,567.76');
    expect(text).toContain('PAC/PAN');
    expect(text).toContain('32');
  });

  it('renders an object class row without inventing a type', () => {
    const output = {
      account_code: '097-0100',
      dimension: 'object_class',
      results: [
        {
          code: '25.2',
          name: 'Other services from non-Federal sources',
          obligations: 99_427_954_049.93,
        },
      ],
      page_metadata: { total: 35, page: 1, has_next: true, has_previous: false, limit: 10 },
    };

    const blocks = getFederalAccountBreakdownTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('25.2');
    expect(text).toContain('Other services from non-Federal sources');
    // Type is a program-activity concept; object-class rows have none, so the column is
    // dropped rather than rendered empty. An all-N/A column reads as missing data instead
    // of an inapplicable concept.
    expect(text).not.toContain('Type');
    expect(text).not.toContain('PAC/PAN');
    expect(text).not.toContain('PARK');
  });

  it('keeps the type column when a row carries a type', () => {
    const output = {
      account_code: '097-0100',
      dimension: 'program_activity',
      results: [
        {
          code: '0004',
          name: 'ADMINISTRATION AND SERVICE-WIDE ACTIVITIES',
          obligations: 288_208_446_567.76,
          type: 'PAC/PAN',
        },
      ],
      page_metadata: { total: 32, page: 1, has_next: true, has_previous: false, limit: 10 },
    };

    const blocks = getFederalAccountBreakdownTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('| Type |');
    expect(text).toContain('PAC/PAN');
  });
});
