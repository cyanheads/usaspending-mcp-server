/**
 * @fileoverview Tests for get-agency tool.
 * @module tests/tools/get-agency.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getAgencyTool } from '@/mcp-server/tools/definitions/get-agency.tool.js';

const mockGetAgency = vi.fn();
const mockGetAgencySubAgencies = vi.fn();
const mockGetAgencyBudgetaryResources = vi.fn();
const mockListAgencies = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getAgency: mockGetAgency,
    getAgencySubAgencies: mockGetAgencySubAgencies,
    getAgencyBudgetaryResources: mockGetAgencyBudgetaryResources,
    listAgencies: mockListAgencies,
  }),
}));

// The agency overview endpoint carries no budget/obligation/transaction totals.
const agencyFixture = {
  name: 'Department of Defense',
  abbreviation: 'DOD',
  agency_id: 517,
  mission: 'Provide the military forces needed to deter war and ensure national security.',
  sub_agency_count: 12,
  website: 'https://www.defense.gov',
  def_codes: [{ code: 'M', public_law: '116-136', title: 'CARES Act' }],
};

const subAgenciesFixture = {
  results: [
    {
      name: 'Department of the Army',
      abbreviation: 'ARMY',
      total_obligations: 200_000_000_000,
      transaction_count: 1_500_000,
      new_award_count: 50_000,
    },
    {
      name: 'Department of the Navy',
      abbreviation: 'NAVY',
      total_obligations: 150_000_000_000,
      transaction_count: 1_000_000,
      new_award_count: 35_000,
    },
  ],
  page_metadata: { page: 1, total: 25, limit: 10, hasNext: true, hasPrevious: false },
};

// Budget/obligation/outlay totals come from the budgetary-resources endpoint. Years are
// deliberately out of order so the tool must select the most recent (FY 2026).
const budgetFixture = {
  agency_data_by_year: [
    {
      fiscal_year: 2025,
      agency_budgetary_resources: 1_900_000_000_000,
      agency_total_obligated: 1_800_000_000_000,
      agency_total_outlayed: 1_700_000_000_000,
    },
    {
      fiscal_year: 2026,
      agency_budgetary_resources: 2_098_732_693_771,
      agency_total_obligated: 1_481_933_755_483,
      agency_total_outlayed: 1_328_539_963_417,
    },
  ],
};

mockGetAgencyBudgetaryResources.mockResolvedValue(budgetFixture);

describe('getAgencyTool', () => {
  it('returns agency details by toptier_code', async () => {
    mockGetAgency.mockResolvedValueOnce(agencyFixture);
    mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

    const ctx = createMockContext();
    const input = getAgencyTool.input.parse({ toptier_code: '097' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.abbreviation).toBe('DOD');
    expect(result.toptier_code).toBe('097');
    // #29a/#29c: budget totals come from the budgetary-resources endpoint (most recent FY 2026),
    // with agency_total_outlayed mapped to outlay_amount. The overview-sourced fields are gone.
    expect(result.fiscal_year).toBe(2026);
    expect(result.budgetary_resources_amount).toBe(2_098_732_693_771);
    expect(result.obligated_amount).toBe(1_481_933_755_483);
    expect(result.outlay_amount).toBe(1_328_539_963_417);
    expect(result).not.toHaveProperty('budget_authority_amount');
    expect(result).not.toHaveProperty('transactions_count');
    expect(result.sub_agencies).toHaveLength(2);
    expect(result.sub_agencies![0].name).toBe('Department of the Army');
    expect(result.sub_agencies![0].total_obligations).toBe(200_000_000_000);
    // #29b: sub-agency pagination metadata is surfaced (was discarded), and the page input
    // is threaded through to the service.
    expect(result.sub_agency_page_metadata).toEqual({
      total: 25,
      page: 1,
      has_next: true,
      limit: 10,
    });
    expect(mockGetAgencySubAgencies).toHaveBeenCalledWith(
      '097',
      expect.objectContaining({ page: 1, limit: 10 }),
      ctx,
    );
    expect(result.def_codes).toHaveLength(1);
  });

  it('resolves agency_slug to toptier_code', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        {
          agency_slug: 'department-of-defense',
          agency_name: 'Department of Defense',
          toptier_code: '097',
        },
      ],
    });
    mockGetAgency.mockResolvedValueOnce(agencyFixture);
    mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

    const ctx = createMockContext();
    const input = getAgencyTool.input.parse({ agency_slug: 'department-of-defense' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.toptier_code).toBe('097');
  });

  it('throws missing_input when neither toptier_code nor agency_slug provided', async () => {
    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({});
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_input' },
    });
  });

  it('throws agency_not_found for unknown slug', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ agency_slug: 'nonexistent-agency' });
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
  });

  it('throws agency_not_found when API returns no name', async () => {
    mockGetAgency.mockResolvedValueOnce({});
    mockGetAgencySubAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ toptier_code: '999' });
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
  });

  it('handles sub-agency service failure by falling back to empty list', async () => {
    mockGetAgency.mockResolvedValueOnce(agencyFixture);
    mockGetAgencySubAgencies.mockRejectedValueOnce(new Error('Sub-agencies service down'));

    const ctx = createMockContext();
    const input = getAgencyTool.input.parse({ toptier_code: '097' });
    const result = await getAgencyTool.handler(input, ctx);

    // Handler catches sub-agency failure and returns empty list rather than throwing
    expect(result.name).toBe('Department of Defense');
    expect(result.sub_agencies).toBeUndefined();
    expect(result.sub_agency_page_metadata).toBeUndefined();
    // Budget still resolves independently of the sub-agency failure.
    expect(result.budgetary_resources_amount).toBe(2_098_732_693_771);
  });

  it('returns agency without sub-agencies when results are empty', async () => {
    mockGetAgency.mockResolvedValueOnce({
      ...agencyFixture,
      def_codes: undefined,
    });
    mockGetAgencySubAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext();
    const input = getAgencyTool.input.parse({ toptier_code: '097' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.sub_agencies).toBeUndefined();
    expect(result.def_codes).toBeUndefined();
  });

  it('formats output with agency details and sub-agency breakdown', () => {
    const output = {
      name: 'Department of Defense',
      abbreviation: 'DOD',
      toptier_code: '097',
      agency_id: 517,
      mission: 'Deter war and ensure national security.',
      fiscal_year: 2026,
      budgetary_resources_amount: 2_098_732_693_771,
      obligated_amount: 1_481_933_755_483,
      outlay_amount: 1_328_539_963_417,
      subtier_agency_count: 12,
      website: 'https://www.defense.gov',
      sub_agencies: [
        {
          name: 'Department of the Army',
          abbreviation: 'ARMY',
          total_obligations: 200_000_000_000,
          transaction_count: 1_500_000,
          new_award_count: 50_000,
        },
      ],
      sub_agency_page_metadata: { total: 25, page: 1, has_next: true, limit: 10 },
      def_codes: [{ code: 'M', public_law: '116-136', title: 'CARES Act' }],
    };

    const blocks = getAgencyTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Department of Defense');
    expect(text).toContain('097');
    expect(text).toContain('2,098,732,693,771');
    expect(text).toContain('200,000,000,000');
    expect(text).toContain('Army');
    expect(text).toContain('Has next:');
    expect(text).toContain('CARES Act');
  });
});
