/**
 * @fileoverview Tests for spending-over-time tool.
 * @module tests/tools/spending-over-time.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { spendingOverTimeTool } from '@/mcp-server/tools/definitions/spending-over-time.tool.js';

const mockSpendingOverTime = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ spendingOverTime: mockSpendingOverTime }),
}));

describe('spendingOverTimeTool', () => {
  it('returns fiscal year spending time series', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        {
          time_period: { fiscal_year: '2022', calendar_year: '2021' },
          aggregated_amount: 500_000_000_000,
          Contract_Obligations: 300_000_000_000,
          Grant_Obligations: 100_000_000_000,
        },
        {
          time_period: { fiscal_year: '2023', calendar_year: '2022' },
          aggregated_amount: 550_000_000_000,
          Contract_Obligations: 330_000_000_000,
          Grant_Obligations: 110_000_000_000,
        },
      ],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'fiscal_year' });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.group).toBe('fiscal_year');
    expect(result.results).toHaveLength(2);
    expect(result.results[0].time_period.fiscal_year).toBe('2022');
    expect(result.results[0].aggregated_amount).toBe(500_000_000_000);
    expect(result.results[0].contracts).toBe(300_000_000_000);
    expect(result.total_periods).toBe(2);
  });

  it('throws no_data when API returns empty results', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: spendingOverTimeTool.errors });
    const input = spendingOverTimeTool.input.parse({
      group: 'quarter',
      filters: { keywords: ['nonexistent_xyz_123'] },
    });
    await expect(spendingOverTimeTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  it('throws when service call fails', async () => {
    mockSpendingOverTime.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: spendingOverTimeTool.errors });
    const input = spendingOverTimeTool.input.parse({ group: 'month' });
    await expect(spendingOverTimeTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles quarter-level grouping with time_period fields', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        {
          time_period: { fiscal_year: '2023', quarter: '1', calendar_year: '2022' },
          aggregated_amount: 150_000_000_000,
        },
      ],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'quarter' });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.results[0].time_period.quarter).toBe('1');
    expect(result.results[0].time_period.fiscal_year).toBe('2023');
  });

  it('formats output with time periods and amounts', () => {
    const output = {
      group: 'fiscal_year',
      results: [
        {
          time_period: { fiscal_year: '2022', calendar_year: '2021' },
          aggregated_amount: 500_000_000_000,
          contracts: 300_000_000_000,
          grants: 100_000_000_000,
          direct_payments: 50_000_000_000,
          loans: 25_000_000_000,
          other: 25_000_000_000,
        },
      ],
      total_periods: 1,
    };

    const blocks = spendingOverTimeTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('fiscal_year');
    expect(text).toContain('2022');
    expect(text).toContain('500,000,000,000');
    expect(text).toContain('300,000,000,000');
  });
});
