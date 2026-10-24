/**
 * @fileoverview Tool to aggregate federal spending grouped by a dimension (NAICS, PSC, agency, etc.).
 * @module mcp-server/tools/definitions/spending-by-category.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import {
  ANALYTICS_DATE_FIELDS,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  optionalIsoDate,
} from './dates.js';
import {
  analyticsTypeMismatch,
  buildFilters,
  CODE_FILTER_FIELDS,
  codeFilterEcho,
  describeCodeFilters,
} from './filters.js';
import { formatCurrency } from './formatting.js';
import { formatPaginationLine } from './pagination.js';

export const spendingByCategoryTool = tool('usaspending_spending_by_category', {
  title: 'Spending by Category',
  description:
    'Aggregate federal spending grouped by a specific dimension: NAICS industry code, PSC product/service code, awarding agency, funding agency, CFDA assistance program, or recipient. Returns top items with obligation amounts — useful for trend and breakdown analysis. Filter by keyword, award type, agency, recipient, NAICS code, Assistance Listing, PSC, DEF code, or date range. Chain NAICS, PSC, and CFDA codes back into these filters, into usaspending_search_awards filters, or into usaspending_autocomplete_filters lookups. recipient_duns rows carry recipient_id, which opens the recipient profile in usaspending_get_recipient, and uei.',
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
      ])
      .describe(
        'Breakdown dimension: naics (industry), psc (product/service code), awarding_agency, awarding_subagency, funding_agency, funding_subagency, cfda (assistance programs), or recipient_duns (recipients)',
      ),
    filters: z
      .object({
        keywords: z.array(z.string()).optional().describe('Full-text keyword filters'),
        award_type_codes: z
          .array(z.string())
          .optional()
          .describe('Award type code filters (A/B/C/D, 02–05, etc.)'),
        agency_name: z
          .string()
          .optional()
          .describe(
            'Awarding top-tier or sub-tier agency name — use the matched name from usaspending_autocomplete_filters type=awarding_agency; use toptier_name to select the whole parent department. A sub-tier name shared by several parents matches under all parents.',
          ),
        recipient_id: z.string().optional().describe('Exact recipient hash ID filter'),
        naics_codes: z.array(z.string()).optional().describe('NAICS code filters'),
        ...CODE_FILTER_FIELDS,
        time_period_start: optionalIsoDate(
          'Start date (YYYY-MM-DD), 2007-10-01 or later. Given alone, the window runs through today (UTC).',
        ),
        time_period_end: optionalIsoDate(
          'End date (YYYY-MM-DD). Given alone, the window starts at 2007-10-01, the earliest searchable date.',
        ),
      })
      .strict()
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
            code: z
              .string()
              .optional()
              .describe('Code value (NAICS, PSC, CFDA number, recipient DUNS, etc.)'),
            name: z.string().optional().describe('Item name or description'),
            amount: z.number().optional().describe('Total obligation amount in USD'),
            recipient_id: z
              .string()
              .optional()
              .describe(
                'Recipient hash ID (recipient_duns rows) — pass to usaspending_get_recipient for the profile. Absent when upstream has none.',
              ),
            uei: z
              .string()
              .optional()
              .describe(
                'Recipient Unique Entity Identifier (recipient_duns rows). Absent when upstream has none.',
              ),
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
    applied_assistance_listings: z
      .string()
      .optional()
      .describe('Assistance Listing numbers sent (comma-separated)'),
    applied_psc_codes: z
      .string()
      .optional()
      .describe('PSC codes sent, uppercased (comma-separated)'),
    applied_def_codes: z
      .string()
      .optional()
      .describe('DEF codes sent, uppercased (comma-separated)'),
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
        'Names a date bound that was filled in because only the other was supplied, and — when results are empty — names any Assistance Listing, PSC, or DEF codes sent and suggests how to broaden filters. Absent when neither applies.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
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
    {
      reason: 'assistance_listings_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters.assistance_listings was given while every code in filters.award_type_codes is a contract or IDV code.',
      retryable: false,
      recovery:
        'Add an assistance group to filters.award_type_codes — grants 02/03/04/05/F001/F002, direct payments 06/10/F006/F007, loans 07/08/F003/F004, or other assistance 09/11/-1/F005/F008/F009/F010 — or leave award_type_codes out to cover every award type.',
    },
    {
      reason: 'psc_codes_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters.psc_codes was given while every code in filters.award_type_codes is an assistance code.',
      retryable: false,
      recovery:
        'Add contracts A/B/C/D or IDVs IDV_A/IDV_B/IDV_B_A/IDV_B_B/IDV_B_C/IDV_C/IDV_D/IDV_E to filters.award_type_codes, or leave award_type_codes out to cover every award type.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_spending_by_category', {
      category: input.category,
      limit: input.limit,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const { filters, timePeriod, codes } = buildFilters(input.filters);
    const inverted = invertedRangeMessage(timePeriod, ANALYTICS_DATE_FIELDS);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted);
    }
    // Upstream answers a start before the floor with an undeclared 422.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor);
    }
    // Upstream answers a code filter no award type here can carry with $0 and no message.
    const mismatch = analyticsTypeMismatch(
      codes,
      input.filters?.award_type_codes,
      'filters.award_type_codes',
    );
    if (mismatch?.filter === 'assistance_listings') {
      throw ctx.fail('assistance_listings_type_mismatch', mismatch.message);
    }
    if (mismatch?.filter === 'psc_codes') {
      throw ctx.fail('psc_codes_type_mismatch', mismatch.message);
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
      ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
      ...(r.uei ? { uei: r.uei } : {}),
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
      ...codeFilterEcho(codes),
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
      const codeParts = describeCodeFilters(codes);
      notices.push(
        `No ${input.category} data matched the filters${codeParts.length ? ` (${codeParts.join(', ')})` : ''}. Try broadening filters or selecting a different category.`,
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return { category: input.category, results, page_metadata };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending by Category: ${escapeMarkdownInline(result.category)}`,
      formatPaginationLine(result.page_metadata),
    ];
    if (result.results.length > 0) {
      /**
       * Recipient identifiers get their own columns only when a row carries one, so
       * other categories keep their table; a missing one is an empty cell.
       */
      const recipientCols = result.results.some((r) => r.recipient_id || r.uei);
      lines.push('');
      if (recipientCols) {
        lines.push('| Rank | ID | Name | Code | UEI | Recipient ID | Obligation |');
        lines.push('|:-----|:---|:-----|:-----|:----|:-------------|:-----------|');
      } else {
        lines.push('| Rank | ID | Name | Code | Obligation |');
        lines.push('|:-----|:---|:-----|:-----|:-----------|');
      }
      result.results.forEach((r, i) => {
        const amt = r.amount !== undefined ? formatCurrency(r.amount) : 'N/A';
        const recipient = recipientCols
          ? ` ${escapeMarkdownInline(r.uei ?? '')} | ${escapeMarkdownInline(r.recipient_id ?? '')} |`
          : '';
        lines.push(
          `| ${i + 1} | ${escapeMarkdownInline(r.id ?? 'N/A')} | ${escapeMarkdownInline(r.name ?? 'N/A')} | ${escapeMarkdownInline(r.code ?? 'N/A')} |${recipient} ${amt} |`,
        );
      });
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
