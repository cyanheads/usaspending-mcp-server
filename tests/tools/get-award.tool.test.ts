/**
 * @fileoverview Tests for get-award tool.
 * @module tests/tools/get-award.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getAwardTool } from '@/mcp-server/tools/definitions/get-award.tool.js';

const mockGetAward = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getAward: mockGetAward }),
}));

const fullAwardFixture = {
  generated_unique_award_id: 'CONT_AWD_FA862118F6251_9700',
  piid: 'FA862118F6251',
  type: 'D',
  type_description: 'Definitive Contract',
  category: 'contract',
  description: 'IT services contract for cloud infrastructure',
  total_obligation: 5_000_000,
  total_outlays: 4_200_000,
  base_and_all_options_value: 6_000_000,
  subaward_count: 3,
  transactions_count: 12,
  date_signed: '2018-06-01',
  period_of_performance: {
    start_date: '2018-07-01',
    end_date: '2023-06-30',
    potential_end_date: '2025-06-30',
  },
  place_of_performance: {
    city_name: 'Seattle',
    state_code: 'WA',
    country_code: 'USA',
    zip5: '98101',
  },
  recipient: {
    recipient_name: 'Acme Corp',
    uei: 'AAAAAAAAAAAA',
    recipient_hash: 'abc123',
    parent_recipient_name: 'Acme Holdings',
    business_types: ['23'],
    location: { city_name: 'Seattle', state_code: 'WA', country_code: 'USA' },
  },
  awarding_agency: {
    toptier_agency: { name: 'Department of Defense', code: '097', slug: 'department-of-defense' },
    subtier_agency: { name: 'Air Force' },
  },
  funding_agency: {
    toptier_agency: { name: 'Department of Defense', code: '097' },
    subtier_agency: { name: 'Air Force' },
  },
  account_obligations_by_defc: [{ code: 'M', amount: 500_000 }],
  latest_transaction_contract_data: {
    naics: '541512',
    naics_description: 'Computer Systems Design',
    product_or_service_code: 'D306',
    product_or_service_code_description: 'IT Services',
  },
};

describe('getAwardTool', () => {
  it('returns full award details for a valid award ID', async () => {
    mockGetAward.mockResolvedValueOnce(fullAwardFixture);

    const ctx = createMockContext();
    const input = getAwardTool.input.parse({ award_id: 'CONT_AWD_FA862118F6251_9700' });
    const result = await getAwardTool.handler(input, ctx);

    expect(result.generated_unique_award_id).toBe('CONT_AWD_FA862118F6251_9700');
    expect(result.piid).toBe('FA862118F6251');
    expect(result.category).toBe('contract');
    expect(result.total_obligation).toBe(5_000_000);
    expect(result.recipient?.recipient_name).toBe('Acme Corp');
    expect(result.recipient?.recipient_id).toBe('abc123');
    expect(result.awarding_agency?.toptier_name).toBe('Department of Defense');
    expect(result.naics?.code).toBe('541512');
    expect(result.account_obligations_by_defc).toHaveLength(1);
  });

  it('throws award_not_found for an award with no identifier fields', async () => {
    mockGetAward.mockResolvedValueOnce({ type: 'D' });

    const ctx = createMockContext({ errors: getAwardTool.errors });
    const input = getAwardTool.input.parse({ award_id: 'NONEXISTENT' });
    await expect(getAwardTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'award_not_found' },
    });
  });

  it('throws when service call fails', async () => {
    mockGetAward.mockRejectedValueOnce(new Error('Network error'));

    const ctx = createMockContext({ errors: getAwardTool.errors });
    const input = getAwardTool.input.parse({ award_id: 'CONT_AWD_TEST' });
    await expect(getAwardTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles sparse upstream payload — no contract data', async () => {
    mockGetAward.mockResolvedValueOnce({
      generated_unique_award_id: 'ASST_AWD_GRANT_001',
      fain: 'GRANT001',
      type: '02',
      type_description: 'Block Grant',
      category: 'grant',
      total_obligation: 100_000,
      latest_transaction_assistance_data: { cfda_number: '10.001', cfda_title: 'Farm Income' },
    });

    const ctx = createMockContext();
    const input = getAwardTool.input.parse({ award_id: 'ASST_AWD_GRANT_001' });
    const result = await getAwardTool.handler(input, ctx);

    expect(result.fain).toBe('GRANT001');
    expect(result.cfda?.number).toBe('10.001');
    expect(result.naics).toBeUndefined();
    expect(result.piid).toBeUndefined();
  });

  it('formats output with recipient, agency, and amount fields', () => {
    const output = {
      generated_unique_award_id: 'CONT_AWD_GEN',
      piid: 'PIID-001',
      type: 'D',
      type_description: 'Definitive Contract',
      category: 'contract',
      description: 'Test contract',
      total_obligation: 1_000_000,
      total_outlays: 900_000,
      base_and_all_options_value: 1_500_000,
      subaward_count: 2,
      transactions_count: 5,
      date_signed: '2022-01-01',
      period_of_performance: {
        start_date: '2022-02-01',
        end_date: '2024-01-31',
        potential_end_date: '2026-01-31',
      },
      place_of_performance: {
        city_name: 'Seattle',
        state_code: 'WA',
        country_code: 'USA',
        zip5: '98101',
      },
      recipient: {
        recipient_name: 'Test Corp',
        uei: 'UUUUUUUUUUUU',
        recipient_id: 'hash-abc',
        parent_recipient_name: 'Parent Inc',
        business_types: ['23'],
        location: { city_name: 'Seattle', state_code: 'WA', country_code: 'USA' },
      },
      awarding_agency: {
        toptier_name: 'DoD',
        toptier_code: '097',
        toptier_slug: 'dod',
        subtier_name: 'Army',
      },
      funding_agency: { toptier_name: 'DoD', toptier_code: '097', subtier_name: 'Army' },
      naics: { code: '541512', description: 'Computer Systems Design' },
      product_or_service_code: { code: 'D306', description: 'IT Services' },
      account_obligations_by_defc: [{ code: 'M', amount: 500_000 }],
    };

    const blocks = getAwardTool.format!(output);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CONT_AWD_GEN');
    expect(text).toContain('PIID-001');
    expect(text).toContain('Test Corp');
    expect(text).toContain('1,000,000');
    expect(text).toContain('541512');
    expect(text).toContain('DEF Code');
  });
});
