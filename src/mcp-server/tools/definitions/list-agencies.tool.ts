/**
 * @fileoverview Tool to list all top-tier federal agencies with budget and obligation data.
 * @module mcp-server/tools/definitions/list-agencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatCurrency } from './formatting.js';

export const listAgenciesTool = tool('usaspending_list_agencies', {
  title: 'List Federal Agencies',
  description:
    'List top-tier federal agencies with toptier codes, agency slugs, budget authority amounts, and obligation totals for the latest reported period. Returns the full directory unless limit is supplied; optional pagination slices the provider-sorted directory. Use this as the entry point for agency navigation — toptier codes and agency slugs are required inputs for usaspending_get_agency and agency-based filters on spending analysis tools.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    sort: z
      .enum(['agency_name', 'budget_authority_amount', 'obligated_amount', 'outlay_amount'])
      .default('agency_name')
      .describe(
        'Sort field: agency_name (alphabetical), budget_authority_amount, obligated_amount, or outlay_amount',
      ),
    order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction: asc or desc'),
    limit: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Agencies per page; omitted returns the full directory. No maximum.'),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Page number when limit is supplied (defaults to page 1); ignored without limit.'),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            agency_name: z.string().describe('Full agency name'),
            abbreviation: z.string().optional().describe('Agency abbreviation or acronym'),
            toptier_code: z
              .string()
              .describe(
                'Three-digit toptier agency code (e.g., 097 for DoD) — required by usaspending_get_agency',
              ),
            agency_slug: z
              .string()
              .optional()
              .describe(
                'URL-friendly agency slug (e.g., department-of-defense) — accepted by usaspending_get_agency',
              ),
            budget_authority_amount: z
              .number()
              .optional()
              .describe('Total budget authority amount in USD for the latest reported period'),
            obligated_amount: z
              .number()
              .optional()
              .describe('Total obligated amount in USD for the latest reported period'),
            outlay_amount: z
              .number()
              .optional()
              .describe('Total outlay amount in USD for the latest reported period'),
            fiscal_year: z
              .number()
              .optional()
              .describe('Provider reporting fiscal year for the latest reported period'),
            fiscal_quarter: z
              .number()
              .optional()
              .describe('Provider reporting fiscal quarter for the latest reported period'),
          })
          .describe('Agency entry with codes, slugs, and fiscal year budget data'),
      )
      .describe('List of top-tier federal agencies with budget and obligation data'),
    total: z.number().describe('Total number of agencies in the full directory before pagination'),
    has_next: z
      .boolean()
      .optional()
      .describe('Whether another page exists; present only when limit is supplied'),
  }),

  // Returned row count stays distinct from the full-directory total when paginated.
  enrichment: {
    agency_count: z.number().describe('Total number of top-tier federal agencies returned'),
    totalCount: z
      .number()
      .describe('Total number of agencies in the full directory before pagination'),
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
      recovery: 'Retry the request; this listing is one fixed payload with nothing to narrow.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_list_agencies', { sort: input.sort, order: input.order });
    const svc = getUSASpendingService();
    const data = await svc.listAgencies({ sort: input.sort, order: input.order }, ctx);
    const results = (data.results ?? []).map((a) => ({
      agency_name: a.agency_name ?? 'Unknown',
      ...(a.abbreviation ? { abbreviation: a.abbreviation } : {}),
      toptier_code: a.toptier_code ?? '',
      ...(a.agency_slug ? { agency_slug: a.agency_slug } : {}),
      ...(a.active_fy?.trim() ? { fiscal_year: z.coerce.number().int().parse(a.active_fy) } : {}),
      ...(a.active_fq?.trim()
        ? { fiscal_quarter: z.coerce.number().int().min(1).max(4).parse(a.active_fq) }
        : {}),
      ...(typeof a.budget_authority_amount === 'number'
        ? { budget_authority_amount: a.budget_authority_amount }
        : {}),
      ...(typeof a.obligated_amount === 'number' ? { obligated_amount: a.obligated_amount } : {}),
      ...(typeof a.outlay_amount === 'number' ? { outlay_amount: a.outlay_amount } : {}),
    }));
    const offset = input.limit === undefined ? 0 : ((input.page ?? 1) - 1) * input.limit;
    const pageResults =
      input.limit === undefined ? results : results.slice(offset, offset + input.limit);
    ctx.enrich.total(results.length);
    ctx.enrich({ agency_count: pageResults.length });
    return {
      results: pageResults,
      total: results.length,
      ...(input.limit === undefined
        ? {}
        : { has_next: offset + pageResults.length < results.length }),
    };
  },

  format: (result) => {
    const lines = [
      `## Federal Agencies (${result.total})`,
      '',
      '| Agency | Code | Slug | Fiscal Year | Fiscal Quarter | Budget Authority | Obligated | Outlays |',
      '|:-------|:-----|:-----|:------------|:---------------|:----------------|:----------|:--------|',
    ];
    for (const a of result.results) {
      const budget =
        a.budget_authority_amount !== undefined ? formatCurrency(a.budget_authority_amount) : 'N/A';
      const obligated =
        a.obligated_amount !== undefined ? formatCurrency(a.obligated_amount) : 'N/A';
      const outlays = a.outlay_amount !== undefined ? formatCurrency(a.outlay_amount) : 'N/A';
      lines.push(
        `| ${escapeMarkdownInline(a.agency_name)}${a.abbreviation ? ` (${escapeMarkdownInline(a.abbreviation)})` : ''} | ${escapeMarkdownInline(a.toptier_code)} | ${escapeMarkdownInline(a.agency_slug ?? 'N/A')} | ${a.fiscal_year ?? 'N/A'} | ${a.fiscal_quarter ?? 'N/A'} | ${budget} | ${obligated} | ${outlays} |`,
      );
    }
    if (result.has_next !== undefined) lines.push('', `**Has next:** ${result.has_next}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
