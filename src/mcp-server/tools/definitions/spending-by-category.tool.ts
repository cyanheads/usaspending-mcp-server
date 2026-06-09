/**
 * @fileoverview Tool to aggregate federal spending grouped by a dimension (NAICS, PSC, agency, etc.).
 * @module mcp-server/tools/definitions/spending-by-category.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { buildFilters } from './filters.js';

export const spendingByCategoryTool = tool('usaspending_spending_by_category', {
  title: 'Spending by Category',
  description:
    'Aggregate federal spending grouped by a specific dimension: NAICS industry code, PSC product/service code, awarding agency, funding agency, CFDA assistance program, or recipient. Returns top items with obligation amounts — useful for trend and breakdown analysis. Chain NAICS codes into usaspending_search_awards filters or usaspending_autocomplete lookups.',
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
        time_period_start: z.string().optional().describe('Start date (YYYY-MM-DD)'),
        time_period_end: z.string().optional().describe('End date (YYYY-MM-DD)'),
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
    total: z
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
      .describe('Start date filter applied (YYYY-MM-DD)'),
    applied_time_period_end: z.string().optional().describe('End date filter applied (YYYY-MM-DD)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — suggests how to broaden filters. Absent when results are present.',
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
    ctx.log.info('usaspending_spending_by_category', {
      category: input.category,
      limit: input.limit,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const filters = buildFilters(input.filters);
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
    const page_metadata = {
      has_next: pageMeta.hasNext ?? false,
      page: pageMeta.page ?? input.page,
      ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
      limit: input.limit,
    };

    ctx.enrich({
      total: page_metadata.total,
      page: page_metadata.page,
      has_next: page_metadata.has_next,
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
        `No ${input.category} data matched the filters. Try broadening filters or selecting a different category.`,
      );
    }

    return { category: input.category, results, page_metadata };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending by Category: ${result.category}`,
      `**Page:** ${result.page_metadata.page}${result.page_metadata.total !== undefined ? ` of ~${result.page_metadata.total}` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    ];
    if (result.results.length > 0) {
      lines.push('');
      lines.push('| Rank | ID | Name | Code | Obligation |');
      lines.push('|:-----|:---|:-----|:-----|:-----------|');
      result.results.forEach((r, i) => {
        const amt = r.amount !== undefined ? `$${r.amount.toLocaleString()}` : 'N/A';
        lines.push(
          `| ${i + 1} | ${r.id ?? 'N/A'} | ${r.name ?? 'N/A'} | ${r.code ?? 'N/A'} | ${amt} |`,
        );
      });
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
