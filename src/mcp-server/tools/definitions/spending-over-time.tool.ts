/**
 * @fileoverview Tool to fetch aggregated federal spending over time by fiscal year,
 * fiscal quarter, or fiscal month.
 * @module mcp-server/tools/definitions/spending-over-time.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import {
  ANALYTICS_DATE_FIELDS,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  optionalIsoDate,
} from './dates.js';
import { buildFilters } from './filters.js';
import { formatCurrency } from './formatting.js';

export const spendingOverTimeTool = tool('usaspending_spending_over_time', {
  title: 'Spending Over Time',
  description:
    'Fetch aggregated federal obligation amounts grouped by fiscal year, fiscal quarter, or fiscal month. All grouping is relative to the US government fiscal year (Oct–Sep), so fiscal month 1 is October, not January. Filter by award type, agency, recipient, keyword, or NAICS code to trace spending trends in a specific area. Returns per-period totals and optional breakdowns by award category (contracts, grants, direct payments, IDVs, loans, other).',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    group: z
      .enum(['fiscal_year', 'quarter', 'month'])
      .describe(
        'Time grouping: fiscal_year (annual US govt FY: Oct–Sep), quarter (fiscal quarter), or month (fiscal month — an ordinal within the fiscal year, where 1 = October)',
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
        time_period_start: optionalIsoDate(
          'Start of the time window (YYYY-MM-DD), 2007-10-01 or later. Given alone, the window runs through today (UTC).',
        ),
        time_period_end: optionalIsoDate(
          'End of the time window (YYYY-MM-DD). Given alone, the window starts at 2007-10-01, the earliest searchable date.',
        ),
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
                month: z
                  .string()
                  .optional()
                  .describe(
                    'Fiscal month: an ordinal within fiscal_year, 1–12, where 1 = October and 12 = September. Fiscal month 1 of FY2025 is October 2024 — not January.',
                  ),
              })
              .describe(
                'Time period for this row. Populated per the requested grouping: fiscal_year alone, fiscal_year + quarter, or fiscal_year + month.',
              ),
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
            idvs: z
              .number()
              .optional()
              .describe(
                'IDV (Indefinite Delivery Vehicle) obligation amount in USD for this period',
              ),
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
      .describe('Start of the time window sent (YYYY-MM-DD), including a filled-in start'),
    applied_time_period_end: z
      .string()
      .optional()
      .describe('End of the time window sent (YYYY-MM-DD), including a filled-in end'),
    notice: z
      .string()
      .optional()
      .describe(
        'Names a time-window bound that was filled in because only the other was supplied, and suggests broadening filters when no periods are returned. Absent when neither applies.',
      ),
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      thrownBy: 'service',
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
    {
      reason: 'api_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'USAspending.gov did not respond before the request deadline elapsed.',
      retryable: true,
      thrownBy: 'service',
      recovery:
        'Narrow the filters — a shorter time_period or a coarser group — then retry the aggregation.',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both filters.time_period_start and filters.time_period_end were supplied and the start falls after the end.',
      retryable: false,
      recovery: 'Swap the two dates so the start date is on or before the end date, then retry.',
    },
    {
      reason: 'date_before_earliest',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved start date precedes the 2007-10-01 earliest date this endpoint can search.',
      retryable: false,
      recovery:
        'Re-request with a start date of 2007-10-01 or later. For award data back to 2000-10-01, use the Custom Award Download feature on usaspending.gov or the bulk_download API endpoints.',
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
    const { filters, timePeriod } = buildFilters(filtersInput);
    const inverted = invertedRangeMessage(timePeriod, ANALYTICS_DATE_FIELDS);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted, ctx.recoveryFor('date_range_inverted'));
    }
    // Upstream answers a start before the floor with an undeclared 422.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor, ctx.recoveryFor('date_before_earliest'));
    }
    const data = await svc.spendingOverTime(
      { group: input.group, filters, subawards: input.subawards },
      ctx,
    );

    const results = (data.results ?? []).map((r) => {
      const tp = r.time_period ?? {};
      return {
        time_period: {
          ...(tp.fiscal_year ? { fiscal_year: tp.fiscal_year } : {}),
          ...(tp.quarter ? { quarter: tp.quarter } : {}),
          ...(tp.month ? { month: tp.month } : {}),
        },
        ...(typeof r.aggregated_amount === 'number'
          ? { aggregated_amount: r.aggregated_amount }
          : {}),
        ...(typeof r.Contract_Obligations === 'number'
          ? { contracts: r.Contract_Obligations }
          : {}),
        ...(typeof r.Grant_Obligations === 'number' ? { grants: r.Grant_Obligations } : {}),
        ...(typeof r.Direct_Obligations === 'number'
          ? { direct_payments: r.Direct_Obligations }
          : {}),
        ...(typeof r.Idv_Obligations === 'number' ? { idvs: r.Idv_Obligations } : {}),
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
      ...(timePeriod
        ? {
            applied_time_period_start: timePeriod.start_date,
            applied_time_period_end: timePeriod.end_date,
          }
        : {}),
    });

    // enrich.notice is last-wins, so every notice source joins into one string.
    const notices = [filledBoundNotice(timePeriod, ANALYTICS_DATE_FIELDS)];
    if (results.length === 0) {
      notices.push(
        'No spending data periods returned. Try a broader time period or remove keyword/agency filters to get more data points.',
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return { group: input.group, results, total_periods: results.length };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending Over Time (${result.group})`,
      `**Periods:** ${result.total_periods}`,
    ];

    // Explain the FM token only when rows actually carry one, so the legend and
    // the rendering can never disagree.
    if (result.results.some((r) => r.time_period.month)) {
      lines.push(
        '',
        '_FM = fiscal month: an ordinal within the fiscal year, where FM1 = October and FM12 = September._',
      );
    }

    lines.push(
      '',
      '| Period | Fiscal Year | Total | Contracts | Grants | Direct Pmts | IDVs | Loans | Other |',
      '|:-------|:------------|:------|:----------|:-------|:------------|:-----|:------|:------|',
    );

    for (const r of result.results) {
      const tp = r.time_period;
      let period = tp.fiscal_year ?? '';
      if (tp.quarter) period += ` Q${tp.quarter}`;
      if (tp.month) period += ` FM${tp.month}`;
      const fy = tp.fiscal_year ?? 'N/A';
      const amt = r.aggregated_amount !== undefined ? formatCurrency(r.aggregated_amount) : 'N/A';
      const c = r.contracts !== undefined ? formatCurrency(r.contracts) : 'N/A';
      const g = r.grants !== undefined ? formatCurrency(r.grants) : 'N/A';
      const dp = r.direct_payments !== undefined ? formatCurrency(r.direct_payments) : 'N/A';
      const idv = r.idvs !== undefined ? formatCurrency(r.idvs) : 'N/A';
      const l = r.loans !== undefined ? formatCurrency(r.loans) : 'N/A';
      const o = r.other !== undefined ? formatCurrency(r.other) : 'N/A';
      lines.push(`| ${period} | ${fy} | ${amt} | ${c} | ${g} | ${dp} | ${idv} | ${l} | ${o} |`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
