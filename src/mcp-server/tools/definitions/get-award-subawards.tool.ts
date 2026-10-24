/**
 * @fileoverview Tool to list subawards under a prime federal award.
 * @module mcp-server/tools/definitions/get-award-subawards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatCurrency } from './formatting.js';
import { formatPaginationLine } from './pagination.js';

export const getAwardSubawardsTool = tool('usaspending_get_award_subawards', {
  title: 'Get Award Subawards',
  description:
    'List subaward contracts or grants under a prime federal award. Reveals the sub-contractor or sub-grantee layer — the organizations that actually perform the work. Each row shows the subaward number, amount, description, action date, and recipient. Check subaward_count on usaspending_get_award first to confirm subawards exist before calling this tool.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    award_id: z
      .string()
      .min(1)
      .describe('Generated unique award ID (generated_internal_id from usaspending_search_awards)'),
    sort: z
      .enum(['subaward_number', 'description', 'action_date', 'amount', 'recipient_name'])
      .default('action_date')
      .describe('Sort field for subawards'),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum subawards per page (1–100)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    award_id: z.string().describe('Prime award ID queried'),
    results: z
      .array(
        z
          .object({
            id: z.number().optional().describe('Subaward internal ID'),
            subaward_number: z.string().optional().describe('Subaward number or identifier'),
            description: z.string().optional().describe('Subaward description'),
            action_date: z.string().optional().describe('Subaward action date (YYYY-MM-DD)'),
            amount: z.number().optional().describe('Subaward amount in USD'),
            recipient_name: z.string().optional().describe('Subcontractor or sub-grantee name'),
          })
          .describe('Subaward record with identifier, amount, recipient, date, and description'),
      )
      .describe('List of subawards under this prime award'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total subaward count'),
        limit: z.number().describe('Subawards per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: pagination state for the subaward listing.
  enrichment: {
    prime_award_id: z.string().describe('Prime award ID whose subawards were listed'),
    totalCount: z
      .number()
      .optional()
      .describe('Total subaward count across all pages (when available)'),
    current_page: z.number().describe('Current page returned'),
    has_next_page: z.boolean().describe('Whether there are more pages of subawards'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no subawards were returned — suggests checking subaward_count from usaspending_get_award first. Absent when results are present.',
      ),
  },

  /**
   * No not-found reason: the subawards endpoint answers an unknown award_id with
   * HTTP 200 and zero rows, and an award with no subawards is a legitimate empty
   * result. Both are disclosed as an enrichment notice rather than a failure.
   */
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
      recovery: 'Retry with a smaller limit so the upstream assembles a lighter page.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_get_award_subawards', { award_id: input.award_id, page: input.page });
    const svc = getUSASpendingService();
    const data = await svc.getAwardSubawards(
      {
        award_id: input.award_id,
        sort: input.sort,
        order: input.order,
        limit: input.limit,
        page: input.page,
      },
      ctx,
    );

    const results = (data.results ?? []).map((s) => ({
      ...(typeof s.id === 'number' ? { id: s.id } : {}),
      ...(s.subaward_number ? { subaward_number: s.subaward_number } : {}),
      ...(s.description ? { description: s.description } : {}),
      ...(s.action_date ? { action_date: s.action_date } : {}),
      ...(typeof s.amount === 'number' ? { amount: s.amount } : {}),
      ...(s.recipient_name ? { recipient_name: s.recipient_name } : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    /**
     * Direct read, verified: `subawards/` was paged to the end of a 3-row result set at
     * limits 1 and 3, reporting `hasNext` truthfully on the interior, exactly-full
     * final, and past-the-end pages. It publishes no `total`, so `hasNext` is the only
     * continuation signal a caller gets — and it is a correct one.
     */
    const hasNext = pageMeta.hasNext ?? false;
    const currentPage = pageMeta.page ?? input.page;
    if (typeof pageMeta.total === 'number') ctx.enrich.total(pageMeta.total);
    ctx.enrich({
      prime_award_id: input.award_id,
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No subawards found for award ${input.award_id}. Check subaward_count from usaspending_get_award to confirm sub-records exist before querying.`,
      );
    }

    return {
      award_id: input.award_id,
      results,
      page_metadata: {
        has_next: hasNext,
        page: currentPage,
        ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Subawards for Award: ${escapeMarkdownInline(result.award_id)}`,
      formatPaginationLine(result.page_metadata),
    ];
    for (const s of result.results) {
      lines.push('');
      lines.push(`### ${escapeMarkdownInline(s.recipient_name ?? s.subaward_number ?? 'Unknown')}`);
      if (s.id !== undefined) lines.push(`**ID:** ${escapeMarkdownInline(String(s.id))}`);
      if (s.subaward_number)
        lines.push(`**Subaward #:** ${escapeMarkdownInline(s.subaward_number)}`);
      if (typeof s.amount === 'number') lines.push(`**Amount:** ${formatCurrency(s.amount)}`);
      if (s.action_date) lines.push(`**Date:** ${escapeMarkdownInline(s.action_date)}`);
      if (s.description) lines.push(`**Description:** ${escapeMarkdownInline(s.description)}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
