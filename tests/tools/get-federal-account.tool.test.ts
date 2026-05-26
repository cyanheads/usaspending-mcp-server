/**
 * @fileoverview Tests for get-federal-account tool.
 * @module tests/tools/get-federal-account.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getFederalAccountTool } from '@/mcp-server/tools/definitions/get-federal-account.tool.js';

const mockGetFederalAccount = vi.fn();
const mockGetFederalAccountSnapshot = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getFederalAccount: mockGetFederalAccount,
    getFederalAccountSnapshot: mockGetFederalAccountSnapshot,
  }),
}));

describe('getFederalAccountTool', () => {
  it('returns federal account details with fiscal year snapshot', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Operation and Maintenance, Air Force',
      federal_account_code: '097-0100',
      agency_identifier: '097',
      main_account_code: '0100',
      managing_agency: 'Department of Defense',
      managing_agency_acronym: 'DOD',
      budget_function: 'National Defense',
      budget_subfunction: 'Department of Defense--Military',
      description: 'Air Force O&M funding',
    });
    mockGetFederalAccountSnapshot.mockResolvedValueOnce({
      total_obligations: 15_000_000_000,
      total_outlays: 13_500_000_000,
      total_budgetary_resources: 18_000_000_000,
      unobligated_balance: 3_000_000_000,
      budget_authority_amount: 16_000_000_000,
    });

    const ctx = createMockContext();
    const input = getFederalAccountTool.input.parse({ account_code: '097-0100' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.account_title).toBe('Operation and Maintenance, Air Force');
    expect(result.federal_account_code).toBe('097-0100');
    expect(result.managing_agency).toBe('Department of Defense');
    expect(result.fiscal_year_snapshot?.total_obligations).toBe(15_000_000_000);
    expect(result.fiscal_year_snapshot?.unobligated_balance).toBe(3_000_000_000);
  });

  it('returns account without snapshot when snapshot call fails', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Test Account',
      federal_account_code: '097-0200',
      agency_identifier: '097',
    });
    mockGetFederalAccountSnapshot.mockRejectedValueOnce(new Error('Not found'));

    const ctx = createMockContext();
    const input = getFederalAccountTool.input.parse({ account_code: '097-0200' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.account_title).toBe('Test Account');
    expect(result.fiscal_year_snapshot).toBeUndefined();
  });

  it('throws account_not_found when no account_title returned', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({});
    mockGetFederalAccountSnapshot.mockResolvedValueOnce(null);

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '999-9999' });
    await expect(getFederalAccountTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'account_not_found' },
    });
  });

  it('throws when service call fails', async () => {
    mockGetFederalAccount.mockRejectedValueOnce(new Error('API error'));
    mockGetFederalAccountSnapshot.mockResolvedValueOnce(null);

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0100' });
    await expect(getFederalAccountTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with account details and snapshot', () => {
    const output = {
      account_title: 'Operation and Maintenance, Air Force',
      federal_account_code: '097-0100',
      agency_identifier: '097',
      main_account_code: '0100',
      managing_agency: 'Department of Defense',
      managing_agency_acronym: 'DOD',
      budget_function: 'National Defense',
      budget_subfunction: 'DoD Military',
      description: 'Air Force O&M',
      fiscal_year_snapshot: {
        total_obligations: 15_000_000_000,
        total_outlays: 13_500_000_000,
        total_budgetary_resources: 18_000_000_000,
        unobligated_balance: 3_000_000_000,
        budget_authority_amount: 16_000_000_000,
      },
    };

    const blocks = getFederalAccountTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('097-0100');
    expect(text).toContain('Department of Defense');
    expect(text).toContain('15,000,000,000');
    expect(text).toContain('National Defense');
  });
});
