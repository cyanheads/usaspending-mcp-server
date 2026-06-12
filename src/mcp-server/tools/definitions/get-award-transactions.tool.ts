/**
 * @fileoverview Tool to list individual transactions (modifications, amendments) on an award.
 * @module mcp-server/tools/definitions/get-award-transactions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getAwardTransactionsTool = tool('usaspending_get_award_transactions', {
  title: 'Get Award Transactions',
  description:
    'List individual transactions (contract modifications, grant amendments) on a federal award. Each transaction represents a change event — obligation modifications, performance period extensions, scope changes, etc. Use this to trace the spending history and obligation changes over the life of an award. Award IDs come from usaspending_search_awards (generated_internal_id field).',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    award_id: z
      .string()
      .min(1)
      .describe('Generated unique award ID (generated_internal_id from usaspending_search_awards)'),
    sort: z
      .enum(['action_date', 'federal_action_obligation', 'modification_number'])
      .default('action_date')
      .describe('Sort field for transactions'),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum transactions per page (1–100)'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    award_id: z.string().describe('Award ID queried'),
    results: z
      .array(
        z
          .object({
            id: z.number().optional().describe('Transaction internal ID'),
            type: z.string().optional().describe('Transaction type code'),
            type_description: z.string().optional().describe('Transaction type description'),
            action_date: z.string().optional().describe('Transaction action date (YYYY-MM-DD)'),
            action_type: z.string().optional().describe('Action type code'),
            action_type_description: z.string().optional().describe('Action type description'),
            federal_action_obligation: z
              .number()
              .optional()
              .describe(
                'Obligation change in USD for this transaction (positive = increase, negative = deobligation)',
              ),
            modification_number: z.string().optional().describe('Modification number or amendment'),
            description: z.string().optional().describe('Transaction description'),
            recipient_name: z.string().optional().describe('Recipient name at time of transaction'),
            awarding_agency_name: z.string().optional().describe('Awarding agency name'),
          })
          .describe('Transaction record with modification details and obligation change'),
      )
      .describe('List of transactions for this award'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total transaction count'),
        limit: z.number().describe('Transactions per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: pagination state for the transaction listing.
  enrichment: {
    queried_award_id: z.string().describe('Award ID whose transactions were listed'),
    totalCount: z
      .number()
      .optional()
      .describe('Total transaction count across all pages (when available)'),
    current_page: z.number().describe('Current page returned'),
    has_next_page: z.boolean().describe('Whether there are more pages of transactions'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no transactions were returned — suggests checking transactions_count from usaspending_get_award first. Absent when results are present.',
      ),
  },

  errors: [
    {
      reason: 'award_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No award exists for the given award ID.',
      recovery:
        'Verify the award_id is a generated_internal_id from usaspending_search_awards results.',
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
    ctx.log.info('usaspending_get_award_transactions', {
      award_id: input.award_id,
      page: input.page,
    });
    const svc = getUSASpendingService();
    const data = await svc.getAwardTransactions(
      {
        award_id: input.award_id,
        sort: input.sort,
        order: input.order,
        limit: input.limit,
        page: input.page,
      },
      ctx,
    );

    const results = (data.results ?? []).map((t) => ({
      ...(typeof t.id === 'number' ? { id: t.id } : {}),
      ...(t.type ? { type: t.type } : {}),
      ...(t.type_description ? { type_description: t.type_description } : {}),
      ...(t.action_date ? { action_date: t.action_date } : {}),
      ...(t.action_type ? { action_type: t.action_type } : {}),
      ...(t.action_type_description ? { action_type_description: t.action_type_description } : {}),
      ...(typeof t.federal_action_obligation === 'number'
        ? { federal_action_obligation: t.federal_action_obligation }
        : {}),
      ...(t.modification_number ? { modification_number: t.modification_number } : {}),
      ...(t.description ? { description: t.description } : {}),
      ...(t.recipient_name ? { recipient_name: t.recipient_name } : {}),
      ...(t.awarding_agency_name ? { awarding_agency_name: t.awarding_agency_name } : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    const hasNext = pageMeta.hasNext ?? false;
    const currentPage = pageMeta.page ?? input.page;
    if (typeof pageMeta.total === 'number') ctx.enrich.total(pageMeta.total);
    ctx.enrich({
      queried_award_id: input.award_id,
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No transactions found for award ${input.award_id}. Check transactions_count from usaspending_get_award to confirm transaction history exists.`,
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
      `## Transactions for Award: ${result.award_id}`,
      `**Page:** ${result.page_metadata.page}${result.page_metadata.total !== undefined ? ` of ~${result.page_metadata.total} total` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    ];
    for (const t of result.results) {
      lines.push('');
      lines.push(`### Mod ${t.modification_number ?? t.id ?? 'N/A'} — ${t.action_date ?? 'N/A'}`);
      if (t.id !== undefined) lines.push(`**ID:** ${t.id}`);
      if (t.type) lines.push(`**Type Code:** ${t.type}`);
      if (t.type_description) lines.push(`**Type:** ${t.type_description}`);
      if (t.action_type) lines.push(`**Action Code:** ${t.action_type}`);
      if (t.action_type_description) lines.push(`**Action:** ${t.action_type_description}`);
      if (typeof t.federal_action_obligation === 'number')
        lines.push(
          `**Obligation Change:** ${t.federal_action_obligation >= 0 ? '+' : ''}$${t.federal_action_obligation.toLocaleString()}`,
        );
      if (t.description) lines.push(`**Description:** ${t.description}`);
      if (t.recipient_name) lines.push(`**Recipient:** ${t.recipient_name}`);
      if (t.awarding_agency_name) lines.push(`**Agency:** ${t.awarding_agency_name}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
