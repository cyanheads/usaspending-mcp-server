/**
 * @fileoverview Tool to list subawards under a prime federal award.
 * @module mcp-server/tools/definitions/get-award-subawards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

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
            recipient_uei: z.string().optional().describe('Sub-recipient Unique Entity Identifier'),
            place_of_performance: z
              .object({
                city: z.string().optional().describe('City of performance'),
                state: z.string().optional().describe('State code'),
                country: z.string().optional().describe('Country code'),
              })
              .optional()
              .describe('Subaward place of performance'),
          })
          .describe('Subaward record with amount, recipient, and location'),
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
    subaward_total: z
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

  errors: [
    {
      reason: 'award_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No award exists for the given award ID, or the award has no subawards.',
      recovery:
        'Confirm subaward_count is > 0 from usaspending_get_award before querying subawards.',
    },
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
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
      ...(s.recipient_uei ? { recipient_uei: s.recipient_uei } : {}),
      ...(s.place_of_performance?.city_name ||
      s.place_of_performance?.state_code ||
      s.place_of_performance?.country_code
        ? {
            place_of_performance: {
              ...(s.place_of_performance?.city_name
                ? { city: s.place_of_performance.city_name }
                : {}),
              ...(s.place_of_performance?.state_code
                ? { state: s.place_of_performance.state_code }
                : {}),
              ...(s.place_of_performance?.country_code
                ? { country: s.place_of_performance.country_code }
                : {}),
            },
          }
        : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    const hasNext = pageMeta.hasNext ?? false;
    const currentPage = pageMeta.page ?? input.page;
    ctx.enrich({
      prime_award_id: input.award_id,
      ...(typeof pageMeta.total === 'number' ? { subaward_total: pageMeta.total } : {}),
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
      `## Subawards for Award: ${result.award_id}`,
      `**Page:** ${result.page_metadata.page}${result.page_metadata.total !== undefined ? ` of ~${result.page_metadata.total} total` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    ];
    for (const s of result.results) {
      lines.push('');
      lines.push(`### ${s.recipient_name ?? s.subaward_number ?? 'Unknown'}`);
      if (s.id !== undefined) lines.push(`**ID:** ${s.id}`);
      if (s.subaward_number) lines.push(`**Subaward #:** ${s.subaward_number}`);
      if (typeof s.amount === 'number') lines.push(`**Amount:** $${s.amount.toLocaleString()}`);
      if (s.action_date) lines.push(`**Date:** ${s.action_date}`);
      if (s.recipient_uei) lines.push(`**UEI:** ${s.recipient_uei}`);
      if (s.description) lines.push(`**Description:** ${s.description}`);
      if (s.place_of_performance) {
        const p = s.place_of_performance;
        lines.push(`**Place:** ${[p.city, p.state, p.country].filter(Boolean).join(', ')}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
