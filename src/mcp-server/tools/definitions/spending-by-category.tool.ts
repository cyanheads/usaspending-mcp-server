/**
 * @fileoverview Tool to aggregate federal spending grouped by a dimension (NAICS, PSC, agency, etc.).
 * @module mcp-server/tools/definitions/spending-by-category.tool
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
import { formatPaginationLine } from './pagination.js';

export const spendingByCategoryTool = tool('usaspending_spending_by_category', {
  title: 'Spending by Category',
  description:
    'Aggregate federal spending grouped by a specific dimension: NAICS industry code, PSC product/service code, awarding agency, funding agency, CFDA assistance program, or recipient. Returns top items with obligation amounts — useful for trend and breakdown analysis. Chain NAICS codes into usaspending_search_awards filters or usaspending_autocomplete_filters lookups.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    category: z
      .enum([
        'naics',
        'psc',
        'awarding_agency',
        'awarding_subagency',
        'funding_agency',
        'funding_subagency',
        'cfda',
        'recipient_duns',
        'recipient_parent_duns',
      ])
      .describe(
        'Breakdown dimension: naics (industry), psc (product/service code), awarding_agency, awarding_subagency, funding_agency, funding_subagency, cfda (assistance programs), recipient_duns, or recipient_parent_duns',
      ),
    filters: z
      .object({
        keywords: z.array(z.string()).optional().describe('Full-text keyword filters'),
        award_type_codes: z
          .array(z.string())
          .optional()
          .describe('Award type code filters (A/B/C/D, 02–05, etc.)'),
        agency_name: z.string().optional().describe('Awarding agency name filter'),
        recipient_id: z.string().optional().describe('Exact recipient hash ID filter'),
        naics_codes: z.array(z.string()).optional().describe('NAICS code filters'),
        time_period_start: optionalIsoDate(
          'Start date (YYYY-MM-DD), 2007-10-01 or later. Given alone, the window runs through today (UTC).',
        ),
        time_period_end: optionalIsoDate(
          'End date (YYYY-MM-DD). Given alone, the window starts at 2007-10-01, the earliest searchable date.',
        ),
      })
      .optional()
      .describe('Optional filters to scope the aggregation'),
    limit: z.number().int().min(1).max(100).default(10).describe('Maximum items to return (1–100)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    category: z.string().describe('Breakdown dimension used'),
    results: z
      .array(
        z
          .object({
            id: z.string().optional().describe('Item identifier (varies by category)'),
            code: z.string().optional().describe('Code value (NAICS, PSC, CFDA number, etc.)'),
            name: z.string().optional().describe('Item name or description'),
            amount: z.number().optional().describe('Total obligation amount in USD'),
          })
          .describe('Category item with code, name, and obligation amount'),
      )
      .describe('Top items in this category by obligation amount'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total items'),
        limit: z.number().describe('Items per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: pagination totals and a recovery notice for empty pages.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total number of items in this category (when available)'),
    page: z.number().describe('Current page returned'),
    has_next: z.boolean().describe('Whether there are more pages'),
    applied_keywords: z.string().optional().describe('Keyword filters applied (comma-separated)'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS code filters applied (comma-separated)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start date sent (YYYY-MM-DD), including a filled-in start'),
    applied_time_period_end: z
      .string()
      .optional()
      .describe('End date sent (YYYY-MM-DD), including a filled-in end'),
    notice: z
      .string()
      .optional()
      .describe(
        'Names a date bound that was filled in because only the other was supplied, and suggests how to broaden filters when results are empty. Absent when neither applies.',
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
        'Narrow the query — a shorter time_period in filters, or a smaller limit — then retry.',
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
    ctx.log.info('usaspending_spending_by_category', {
      category: input.category,
      limit: input.limit,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const { filters, timePeriod } = buildFilters(input.filters);
    const inverted = invertedRangeMessage(timePeriod, ANALYTICS_DATE_FIELDS);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted, ctx.recoveryFor('date_range_inverted'));
    }
    // Upstream answers a start before the floor with an undeclared 422.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor, ctx.recoveryFor('date_before_earliest'));
    }
    const data = await svc.spendingByCategory(
      input.category,
      { filters, limit: input.limit, page: input.page },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r.id != null ? { id: String(r.id) } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.name || r.description ? { name: r.name ?? r.description ?? undefined } : {}),
      ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    /**
     * Direct read, verified: `search/spending_by_category/{category}/` reported
     * `hasNext` truthfully on the interior, exactly-full final, and past-the-end pages
     * of small result sets, and kept doing so at offsets 10,000 through 50,000 — it has
     * no cutoff there, and answers HTTP 503 past ~200,000 rather than a misleading flag.
     * The endpoint publishes no `total`, so the read below never fires against the live API.
     */
    const page_metadata = {
      has_next: pageMeta.hasNext ?? false,
      page: pageMeta.page ?? input.page,
      ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
      limit: input.limit,
    };

    if (typeof page_metadata.total === 'number') ctx.enrich.total(page_metadata.total);
    ctx.enrich({
      page: page_metadata.page,
      has_next: page_metadata.has_next,
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
        `No ${input.category} data matched the filters. Try broadening filters or selecting a different category.`,
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return { category: input.category, results, page_metadata };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending by Category: ${result.category}`,
      formatPaginationLine(result.page_metadata),
    ];
    if (result.results.length > 0) {
      lines.push('');
      lines.push('| Rank | ID | Name | Code | Obligation |');
      lines.push('|:-----|:---|:-----|:-----|:-----------|');
      result.results.forEach((r, i) => {
        const amt = r.amount !== undefined ? formatCurrency(r.amount) : 'N/A';
        lines.push(
          `| ${i + 1} | ${r.id ?? 'N/A'} | ${r.name ?? 'N/A'} | ${r.code ?? 'N/A'} | ${amt} |`,
        );
      });
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
