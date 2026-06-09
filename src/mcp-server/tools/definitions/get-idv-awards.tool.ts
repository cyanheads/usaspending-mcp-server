/**
 * @fileoverview Tool to list child contracts and orders placed under an IDV (Indefinite
 * Delivery Vehicle) award.
 * @module mcp-server/tools/definitions/get-idv-awards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getIdvAwardsTool = tool('usaspending_get_idv_awards', {
  title: 'Get IDV Child Awards',
  description:
    'List child contracts and task/delivery orders placed under an IDV (Indefinite Delivery Vehicle) award. Each row includes the generated_unique_award_id to chain into usaspending_get_award for full detail. The award_id must be the generated_unique_award_id of the parent IDV — obtainable from usaspending_search_awards (generated_internal_id field) or from usaspending_get_award. IDV category awards returned by usaspending_get_award have child orders accessible via this tool.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    award_id: z
      .string()
      .min(1)
      .describe(
        'Parent IDV generated_unique_award_id (e.g., CONT_IDV_NNK14MA74C_8000) — use generated_internal_id from usaspending_search_awards or generated_unique_award_id from usaspending_get_award',
      ),
    type: z
      .enum(['child_awards', 'child_idvs', 'grandchild_awards'])
      .default('child_awards')
      .describe(
        'Type of child awards to list: child_awards = task/delivery orders, child_idvs = sub-IDVs, grandchild_awards = orders under sub-IDVs',
      ),
    sort: z
      .string()
      .default('obligated_amount')
      .describe(
        'Field to sort child awards by (e.g., obligated_amount, period_of_performance_start_date)',
      ),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum results per page (1–100)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    award_id: z.string().describe('Parent IDV award ID queried'),
    results: z
      .array(
        z
          .object({
            generated_unique_award_id: z
              .string()
              .optional()
              .describe(
                'Generated unique award ID for this child award — pass to usaspending_get_award to fetch full details',
              ),
            piid: z.string().optional().describe('Procurement Instrument Identifier'),
            award_type: z.string().optional().describe('Award type (e.g., "DELIVERY ORDER")'),
            description: z.string().optional().describe('Award description'),
            obligated_amount: z.number().optional().describe('Total obligated amount in USD'),
            period_of_performance_start_date: z
              .string()
              .optional()
              .describe('Performance start date (YYYY-MM-DD)'),
            period_of_performance_current_end_date: z
              .string()
              .optional()
              .describe('Performance current end date (YYYY-MM-DD)'),
            last_date_to_order: z
              .string()
              .optional()
              .describe('Last date to place orders against this IDV (YYYY-MM-DD, nullable)'),
            awarding_agency: z.string().optional().describe('Name of the awarding agency'),
            funding_agency: z.string().optional().describe('Name of the funding agency'),
          })
          .describe('Child award record with ID, amounts, agencies, and performance dates'),
      )
      .describe('Child awards placed under this IDV'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages of results'),
        has_previous: z.boolean().describe('Whether there are previous pages'),
        page: z.number().describe('Current page number'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata (no total count available from this endpoint)'),
  }),

  // Agent-facing context: pagination state and an optional notice for empty results.
  enrichment: {
    parent_award_id: z.string().describe('Parent IDV award ID whose children were listed'),
    current_page: z.number().describe('Current page returned'),
    has_next_page: z.boolean().describe('Whether there are more pages of child awards'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — the award may have no children of the requested type. Absent when results are present.',
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
    ctx.log.info('usaspending_get_idv_awards', {
      award_id: input.award_id,
      type: input.type,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const data = await svc.getIdvAwards(
      {
        award_id: input.award_id,
        type: input.type,
        sort: input.sort,
        order: input.order,
        limit: input.limit,
        page: input.page,
      },
      ctx,
    );

    const results = ((data.results as unknown[]) ?? []).map((r) => {
      const raw = r as Record<string, unknown>;
      return {
        ...(raw.generated_unique_award_id
          ? { generated_unique_award_id: String(raw.generated_unique_award_id) }
          : {}),
        ...(raw.piid ? { piid: String(raw.piid) } : {}),
        ...(raw.award_type ? { award_type: String(raw.award_type) } : {}),
        ...(raw.description ? { description: String(raw.description) } : {}),
        ...(typeof raw.obligated_amount === 'number'
          ? { obligated_amount: raw.obligated_amount }
          : {}),
        ...(raw.period_of_performance_start_date
          ? { period_of_performance_start_date: String(raw.period_of_performance_start_date) }
          : {}),
        ...(raw.period_of_performance_current_end_date
          ? {
              period_of_performance_current_end_date: String(
                raw.period_of_performance_current_end_date,
              ),
            }
          : {}),
        ...(raw.last_date_to_order != null
          ? { last_date_to_order: String(raw.last_date_to_order) }
          : {}),
        ...(raw.awarding_agency ? { awarding_agency: String(raw.awarding_agency) } : {}),
        ...(raw.funding_agency ? { funding_agency: String(raw.funding_agency) } : {}),
      };
    });

    const hasNext = data.hasNext ?? false;
    const hasPrevious = data.hasPrevious ?? false;
    const currentPage = typeof data.page === 'number' ? data.page : input.page;

    ctx.enrich({
      parent_award_id: input.award_id,
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No child awards of type "${input.type}" found for IDV "${input.award_id}". ` +
          `Verify the award_id is a valid IDV and try type="child_idvs" if looking for sub-IDVs.`,
      );
    }

    return {
      award_id: input.award_id,
      results,
      page_metadata: {
        has_next: hasNext,
        has_previous: hasPrevious,
        page: currentPage,
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Child Awards for IDV: ${result.award_id}`,
      `**Page:** ${result.page_metadata.page} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    ];
    for (const a of result.results) {
      lines.push('');
      lines.push(`### ${a.piid ?? a.generated_unique_award_id ?? 'Unknown'}`);
      if (a.generated_unique_award_id)
        lines.push(`**Chain ID (for get_award):** ${a.generated_unique_award_id}`);
      if (a.piid) lines.push(`**PIID:** ${a.piid}`);
      if (a.award_type) lines.push(`**Type:** ${a.award_type}`);
      if (typeof a.obligated_amount === 'number')
        lines.push(`**Obligated:** $${a.obligated_amount.toLocaleString()}`);
      if (a.awarding_agency) lines.push(`**Awarding Agency:** ${a.awarding_agency}`);
      if (a.funding_agency) lines.push(`**Funding Agency:** ${a.funding_agency}`);
      if (a.period_of_performance_start_date || a.period_of_performance_current_end_date)
        lines.push(
          `**Period:** ${a.period_of_performance_start_date ?? 'N/A'} → ${a.period_of_performance_current_end_date ?? 'N/A'}`,
        );
      if (a.last_date_to_order) lines.push(`**Last Date to Order:** ${a.last_date_to_order}`);
      if (a.description) lines.push(`**Description:** ${a.description}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
