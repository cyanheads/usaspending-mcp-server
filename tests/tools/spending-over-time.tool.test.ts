/**
 * @fileoverview Tests for spending-over-time tool.
 * @module tests/tools/spending-over-time.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
          time_period: { fiscal_year: '2022' },
          aggregated_amount: 500_000_000_000,
          Contract_Obligations: 300_000_000_000,
          Grant_Obligations: 100_000_000_000,
        },
        {
          time_period: { fiscal_year: '2023' },
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
    const enrichment = getEnrichment(ctx);
    expect(enrichment.time_group).toBe('fiscal_year');
    expect(enrichment.period_count).toBe(2);
  });

  it('returns structured empty response with notice when API returns no periods', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({
      group: 'quarter',
      filters: { keywords: ['nonexistent_xyz_123'] },
    });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total_periods).toBe(0);
    expect(result.group).toBe('quarter');
    const enrichment = getEnrichment(ctx);
    expect(enrichment.period_count).toBe(0);
    expect(enrichment.notice).toContain('No spending data periods returned');
    expect(enrichment.applied_keywords).toBe('nonexistent_xyz_123');
  });

  it('defaults award_type_codes to contracts when filters is omitted', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [{ time_period: { fiscal_year: '2024' }, aggregated_amount: 100_000_000 }],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'fiscal_year' });
    await spendingOverTimeTool.handler(input, ctx);

    expect(mockSpendingOverTime).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ award_type_codes: ['A', 'B', 'C', 'D'] }),
      }),
      ctx,
    );
  });

  it('throws when service call fails', async () => {
    mockSpendingOverTime.mockRejectedValueOnce(new Error('Service error'));

    const ctx = createMockContext({ errors: spendingOverTimeTool.errors });
    const input = spendingOverTimeTool.input.parse({ group: 'month' });
    await expect(spendingOverTimeTool.handler(input, ctx)).rejects.toThrow();
  });

  it('handles quarter-level grouping with time_period fields', async () => {
    // Upstream returns {fiscal_year, quarter} for group=quarter — never calendar_year.
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        {
          time_period: { fiscal_year: '2023', quarter: '1' },
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

  it('passes the fiscal-month ordinal through unconverted', async () => {
    // The live shape for group=month: FY2025 months 1–3 are Oct–Dec 2024. The
    // ordinal is passed through as-is rather than converted to a calendar month.
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        { time_period: { fiscal_year: '2025', month: '1' }, aggregated_amount: 50_000_000 },
        { time_period: { fiscal_year: '2025', month: '2' }, aggregated_amount: 60_000_000 },
      ],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'month' });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.group).toBe('month');
    expect(result.results[0].time_period.month).toBe('1');
    expect(result.results[0].time_period.fiscal_year).toBe('2025');
    expect(result.results[1].time_period.month).toBe('2');
  });

  it('emits no calendar_year on any exposed group mode', async () => {
    // calendar_year is unreachable: upstream only populates it under group=calendar_year,
    // which this tool's input enum does not expose. Guards against it creeping back in.
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        { time_period: { fiscal_year: '2025', month: '1' }, aggregated_amount: 50_000_000 },
      ],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'month' });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.results[0].time_period).toStrictEqual({ fiscal_year: '2025', month: '1' });
    expect(result.results[0].time_period).not.toHaveProperty('calendar_year');
  });

  it('maps all award breakdown fields (loans, direct_payments, other)', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [
        {
          time_period: { fiscal_year: '2023' },
          aggregated_amount: 600_000_000,
          Loan_Obligations: 200_000_000,
          'Direct Payment_Obligations': 150_000_000,
          Other_Obligations: 50_000_000,
        },
      ],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'fiscal_year' });
    const result = await spendingOverTimeTool.handler(input, ctx);

    expect(result.results[0].loans).toBe(200_000_000);
    expect(result.results[0].direct_payments).toBe(150_000_000);
    expect(result.results[0].other).toBe(50_000_000);
  });

  it('subawards=true is forwarded to service', async () => {
    mockSpendingOverTime.mockResolvedValueOnce({
      results: [{ time_period: { fiscal_year: '2023' }, aggregated_amount: 100_000 }],
    });

    const ctx = createMockContext();
    const input = spendingOverTimeTool.input.parse({ group: 'fiscal_year', subawards: true });
    await spendingOverTimeTool.handler(input, ctx);

    expect(mockSpendingOverTime).toHaveBeenCalledWith(
      expect.objectContaining({ subawards: true }),
      ctx,
    );
  });

  it('formats output with time periods and amounts', () => {
    const output = {
      group: 'fiscal_year',
      results: [
        {
          time_period: { fiscal_year: '2022' },
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

  it('renders no always-empty calendar-year column', () => {
    const output = {
      group: 'fiscal_year',
      results: [{ time_period: { fiscal_year: '2022' }, aggregated_amount: 500_000_000_000 }],
      total_periods: 1,
    };

    const text = (spendingOverTimeTool.format!(output)[0] as { text: string }).text;
    expect(text).not.toContain('Cal Year');
    // The FY row has no month, so the fiscal-month legend must stay out of it.
    expect(text).not.toContain('FM');
  });

  it('renders month rows as fiscal months with a legend', () => {
    const output = {
      group: 'month',
      results: [
        { time_period: { fiscal_year: '2025', month: '1' }, aggregated_amount: 50_000_000 },
        { time_period: { fiscal_year: '2025', month: '2' }, aggregated_amount: 60_000_000 },
      ],
      total_periods: 2,
    };

    const text = (spendingOverTimeTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('2025 FM1');
    expect(text).toContain('2025 FM2');
    expect(text).toContain('FM1 = October');
    // The old rendering presented the ordinal as a bare calendar month.
    expect(text).not.toContain('| 2025 M1 |');
  });

  it('renders quarter rows unaffected by the fiscal-month change', () => {
    const output = {
      group: 'quarter',
      results: [
        { time_period: { fiscal_year: '2023', quarter: '1' }, aggregated_amount: 150_000_000 },
      ],
      total_periods: 1,
    };

    const text = (spendingOverTimeTool.format!(output)[0] as { text: string }).text;
    expect(text).toContain('2023 Q1');
    expect(text).toContain('150,000,000');
    expect(text).not.toContain('FM');
  });
});
