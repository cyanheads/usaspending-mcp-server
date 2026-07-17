/**
 * @fileoverview Tool to fetch aggregated federal spending over time by fiscal year,
 * quarter, or calendar month.
 * @module mcp-server/tools/definitions/spending-over-time.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { buildFilters } from './filters.js';

export const spendingOverTimeTool = tool('usaspending_spending_over_time', {
  title: 'Spending Over Time',
  description:
    'Fetch aggregated federal obligation amounts grouped by fiscal year, fiscal quarter, or calendar month. Filter by award type, agency, recipient, keyword, or NAICS code to trace spending trends in a specific area. Returns per-period totals and optional breakdowns by award category (contracts, grants, direct payments, loans, other).',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    group: z
      .enum(['fiscal_year', 'quarter', 'month'])
      .describe(
        'Time grouping: fiscal_year (annual US govt FY: Oct–Sep), quarter (fiscal quarter), or month (calendar month)',
      ),
    filters: z
      .object({
        keywords: z.array(z.string()).optional().describe('Full-text keyword filters'),
        award_type_codes: z
          .array(z.string())
          .optional()
          .describe(
            'Award type code filters (A/B/C/D, 02–05, etc.). All codes must belong to a single group. When omitted, defaults to contracts (A, B, C, D).',
          ),
        agency_name: z.string().optional().describe('Awarding agency name filter'),
        recipient_id: z.string().optional().describe('Exact recipient hash ID filter'),
        naics_codes: z.array(z.string()).optional().describe('NAICS code filters'),
        time_period_start: z.string().optional().describe('Start of the time window (YYYY-MM-DD)'),
        time_period_end: z.string().optional().describe('End of the time window (YYYY-MM-DD)'),
      })
      .optional()
      .describe(
        'Filters to scope the time-series aggregation. Defaults to contract awards when omitted.',
      ),
    subawards: z
      .boolean()
      .default(false)
      .describe('Aggregate subaward data instead of prime award data'),
  }),

  output: z.object({
    group: z.string().describe('Time grouping used'),
    results: z
      .array(
        z
          .object({
            time_period: z
              .object({
                fiscal_year: z.string().optional().describe('Fiscal year (e.g., 2024)'),
                quarter: z.string().optional().describe('Fiscal quarter (1–4)'),
                month: z.string().optional().describe('Calendar month (1–12)'),
                calendar_year: z.string().optional().describe('Calendar year'),
              })
              .describe('Time period for this row'),
            aggregated_amount: z
              .number()
              .optional()
              .describe('Total obligation amount in USD for this period'),
            contracts: z
              .number()
              .optional()
              .describe('Contract obligation amount in USD for this period'),
            grants: z
              .number()
              .optional()
              .describe('Grant obligation amount in USD for this period'),
            direct_payments: z
              .number()
              .optional()
              .describe('Direct payment obligation amount in USD for this period'),
            loans: z.number().optional().describe('Loan obligation amount in USD for this period'),
            other: z
              .number()
              .optional()
              .describe('Other financial assistance obligation amount in USD for this period'),
          })
          .describe('Time period row with total obligations and optional award-type breakdowns'),
      )
      .describe('Time-series of obligation totals'),
    total_periods: z.number().describe('Number of time periods returned'),
  }),

  // Agent-facing context: time grouping, period count, and optional recovery notice for empty results.
  enrichment: {
    time_group: z.string().describe('Time grouping applied: fiscal_year, quarter, or month'),
    period_count: z.number().describe('Number of time periods returned'),
    applied_keywords: z.string().optional().describe('Keyword filters applied (comma-separated)'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS code filters applied (comma-separated)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start date filter applied (YYYY-MM-DD)'),
    applied_time_period_end: z.string().optional().describe('End date filter applied (YYYY-MM-DD)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no periods are returned — suggests broadening filters. Absent when results are present.',
      ),
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_spending_over_time', { group: input.group });
    const svc = getUSASpendingService();

    const filtersInput = {
      ...input.filters,
      award_type_codes: input.filters?.award_type_codes?.length
        ? input.filters.award_type_codes
        : ['A', 'B', 'C', 'D'],
    };
    const filters = buildFilters(filtersInput);
    const data = await svc.spendingOverTime(
      { group: input.group, filters, subawards: input.subawards },
      ctx,
    );

    const results = (data.results ?? []).map((r) => {
      const tp = r.time_period ?? {};
      const month = tp.month ?? tp.calendar_month;
      return {
        time_period: {
          ...(tp.fiscal_year ? { fiscal_year: tp.fiscal_year } : {}),
          ...(tp.quarter ? { quarter: tp.quarter } : {}),
          ...(month ? { month } : {}),
          ...(tp.calendar_year ? { calendar_year: tp.calendar_year } : {}),
        },
        ...(typeof r.aggregated_amount === 'number'
          ? { aggregated_amount: r.aggregated_amount }
          : {}),
        ...(typeof r.Contract_Obligations === 'number'
          ? { contracts: r.Contract_Obligations }
          : {}),
        ...(typeof r.Grant_Obligations === 'number' ? { grants: r.Grant_Obligations } : {}),
        ...(typeof r['Direct Payment_Obligations'] === 'number'
          ? { direct_payments: r['Direct Payment_Obligations'] }
          : {}),
        ...(typeof r.Loan_Obligations === 'number' ? { loans: r.Loan_Obligations } : {}),
        ...(typeof r.Other_Obligations === 'number' ? { other: r.Other_Obligations } : {}),
      };
    });

    ctx.enrich({
      time_group: input.group,
      period_count: results.length,
      ...(input.filters?.keywords?.length
        ? { applied_keywords: input.filters.keywords.join(', ') }
        : {}),
      ...(input.filters?.agency_name ? { applied_agency_name: input.filters.agency_name } : {}),
      ...(input.filters?.naics_codes?.length
        ? { applied_naics_codes: input.filters.naics_codes.join(', ') }
        : {}),
      ...(input.filters?.time_period_start
        ? { applied_time_period_start: input.filters.time_period_start }
        : {}),
      ...(input.filters?.time_period_end
        ? { applied_time_period_end: input.filters.time_period_end }
        : {}),
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        'No spending data periods returned. Try a broader time period or remove keyword/agency filters to get more data points.',
      );
    }

    return { group: input.group, results, total_periods: results.length };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending Over Time (${result.group})`,
      `**Periods:** ${result.total_periods}`,
      '',
      '| Period | Fiscal Year | Cal Year | Total | Contracts | Grants | Direct Pmts | Loans | Other |',
      '|:-------|:------------|:---------|:------|:----------|:-------|:------------|:------|:------|',
    ];

    for (const r of result.results) {
      const tp = r.time_period;
      let period = tp.fiscal_year ?? '';
      if (tp.quarter) period += ` Q${tp.quarter}`;
      if (tp.month) period += ` M${tp.month}`;
      const fy = tp.fiscal_year ?? 'N/A';
      const cy = tp.calendar_year ?? 'N/A';
      const amt =
        r.aggregated_amount !== undefined ? `$${r.aggregated_amount.toLocaleString()}` : 'N/A';
      const c = r.contracts !== undefined ? `$${r.contracts.toLocaleString()}` : 'N/A';
      const g = r.grants !== undefined ? `$${r.grants.toLocaleString()}` : 'N/A';
      const dp = r.direct_payments !== undefined ? `$${r.direct_payments.toLocaleString()}` : 'N/A';
      const l = r.loans !== undefined ? `$${r.loans.toLocaleString()}` : 'N/A';
      const o = r.other !== undefined ? `$${r.other.toLocaleString()}` : 'N/A';
      lines.push(`| ${period} | ${fy} | ${cy} | ${amt} | ${c} | ${g} | ${dp} | ${l} | ${o} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
