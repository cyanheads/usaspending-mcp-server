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
const mockListAgencies = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getAgency: mockGetAgency,
    getAgencySubAgencies: mockGetAgencySubAgencies,
    listAgencies: mockListAgencies,
  }),
}));

const agencyFixture = {
  name: 'Department of Defense',
  abbreviation: 'DOD',
  agency_id: 517,
  mission: 'Provide the military forces needed to deter war and ensure national security.',
  budget_authority_amount: 800_000_000_000,
  obligated_amount: 750_000_000_000,
  transactions_count: 5_000_000,
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
};

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
    expect(result.budget_authority_amount).toBe(800_000_000_000);
    expect(result.sub_agencies).toHaveLength(2);
    expect(result.sub_agencies![0].name).toBe('Department of the Army');
    expect(result.sub_agencies![0].total_obligations).toBe(200_000_000_000);
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
      code: JsonRpcErrorCode.InvalidParams,
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

  it('formats output with agency details and sub-agency breakdown', () => {
    const output = {
      name: 'Department of Defense',
      abbreviation: 'DOD',
      toptier_code: '097',
      agency_id: 517,
      mission: 'Deter war and ensure national security.',
      budget_authority_amount: 800_000_000_000,
      obligated_amount: 750_000_000_000,
      transactions_count: 5_000_000,
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
      def_codes: [{ code: 'M', public_law: '116-136', title: 'CARES Act' }],
    };

    const blocks = getAgencyTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Department of Defense');
    expect(text).toContain('097');
    expect(text).toContain('200,000,000,000');
    expect(text).toContain('Army');
    expect(text).toContain('CARES Act');
  });
});
