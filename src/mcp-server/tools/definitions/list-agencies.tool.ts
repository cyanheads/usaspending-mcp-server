/**
 * @fileoverview Tool to list all top-tier federal agencies with budget and obligation data.
 * @module mcp-server/tools/definitions/list-agencies.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const listAgenciesTool = tool('usaspending_list_agencies', {
  title: 'List Federal Agencies',
  description:
    'List all top-tier federal agencies with toptier codes, agency slugs, budget authority amounts, and obligation totals for the current fiscal year. Use this as the entry point for agency navigation — toptier codes and agency slugs are required inputs for usaspending_get_agency and agency-based filters on spending analysis tools.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    sort: z
      .enum(['agency_name', 'budget_authority_amount', 'obligated_amount', 'outlay_amount'])
      .default('agency_name')
      .describe(
        'Sort field: agency_name (alphabetical), budget_authority_amount, obligated_amount, or outlay_amount',
      ),
    order: z.enum(['asc', 'desc']).default('asc').describe('Sort direction: asc or desc'),
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
              .describe('Total budget authority amount in USD for the current fiscal year'),
            obligated_amount: z
              .number()
              .optional()
              .describe('Total obligated amount in USD for the current fiscal year'),
            outlay_amount: z
              .number()
              .optional()
              .describe('Total outlay amount in USD for the current fiscal year'),
          })
          .describe('Agency entry with codes, slugs, and fiscal year budget data'),
      )
      .describe('List of top-tier federal agencies with budget and obligation data'),
    total: z.number().describe('Total number of agencies returned'),
  }),

  // Agent-facing list context: total agency count for orientation.
  enrichment: {
    agency_count: z.number().describe('Total number of top-tier federal agencies returned'),
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
    ctx.log.info('usaspending_list_agencies', { sort: input.sort, order: input.order });
    const svc = getUSASpendingService();
    const data = await svc.listAgencies({ sort: input.sort, order: input.order }, ctx);
    const results = (data.results ?? []).map((a) => ({
      agency_name: a.agency_name ?? 'Unknown',
      ...(a.abbreviation ? { abbreviation: a.abbreviation } : {}),
      toptier_code: a.toptier_code ?? '',
      ...(a.agency_slug ? { agency_slug: a.agency_slug } : {}),
      ...(typeof a.budget_authority_amount === 'number'
        ? { budget_authority_amount: a.budget_authority_amount }
        : {}),
      ...(typeof a.obligated_amount === 'number' ? { obligated_amount: a.obligated_amount } : {}),
      ...(typeof a.outlay_amount === 'number' ? { outlay_amount: a.outlay_amount } : {}),
    }));
    ctx.enrich({ agency_count: results.length });
    return { results, total: results.length };
  },

  format: (result) => {
    const lines = [
      `## Federal Agencies (${result.total})`,
      '',
      '| Agency | Code | Slug | Budget Authority | Obligated | Outlays |',
      '|:-------|:-----|:-----|:----------------|:----------|:--------|',
    ];
    for (const a of result.results) {
      const budget =
        a.budget_authority_amount !== undefined
          ? `$${a.budget_authority_amount.toLocaleString()}`
          : 'N/A';
      const obligated =
        a.obligated_amount !== undefined ? `$${a.obligated_amount.toLocaleString()}` : 'N/A';
      const outlays =
        a.outlay_amount !== undefined ? `$${a.outlay_amount.toLocaleString()}` : 'N/A';
      lines.push(
        `| ${a.agency_name}${a.abbreviation ? ` (${a.abbreviation})` : ''} | ${a.toptier_code} | ${a.agency_slug ?? 'N/A'} | ${budget} | ${obligated} | ${outlays} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
