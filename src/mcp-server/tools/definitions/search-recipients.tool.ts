/**
 * @fileoverview Tool to search for federal award recipients by name or UEI.
 * @module mcp-server/tools/definitions/search-recipients.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const searchRecipientsTool = tool('usaspending_search_recipients', {
  title: 'Search Award Recipients',
  description:
    'Search for organizations or individuals receiving federal funds by name, UEI (Unique Entity Identifier), or DUNS. Returns recipient hash IDs, UEI/DUNS identifiers, total award amounts, and hierarchy level. Results are paginated — use page to retrieve matches beyond the first page; page_metadata.total reports the full match count. Recipient hash IDs from this tool can be passed to usaspending_get_recipient for full profiles. Recipient level: P = parent organization, C = child entity, R = standalone.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    keyword: z
      .string()
      .min(1)
      .describe('Name, UEI, DUNS, or keyword to search for — partial matches are supported'),
    award_type: z
      .enum(['contracts', 'grants', 'direct_payments', 'loans', 'other_financial_assistance'])
      .optional()
      .describe('Filter by award type category to scope the total amounts returned'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(10)
      .describe('Maximum results per page (1–100)'),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Page number (1-based) — request the next page to retrieve matches beyond the first',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            id: z
              .string()
              .optional()
              .describe(
                'Recipient hash ID (UUID format with level suffix: -P parent, -C child, -R standalone) — pass to usaspending_get_recipient for full profile',
              ),
            name: z.string().optional().describe('Recipient legal business name'),
            uei: z.string().optional().describe('Unique Entity Identifier (SAM.gov)'),
            duns: z.string().optional().describe('DUNS number (legacy, being phased out)'),
            recipient_level: z
              .string()
              .optional()
              .describe('Hierarchy level: P = parent, C = child, R = standalone'),
            amount: z
              .number()
              .optional()
              .describe('Total award amount in USD for the selected award type'),
          })
          .describe('Recipient entry with ID, name, and award totals'),
      )
      .describe('Matching recipients'),
    page_metadata: z
      .object({
        total: z.number().optional().describe('Total matching recipients across all pages'),
        page: z.number().describe('Current page number'),
        has_next: z.boolean().describe('Whether there are more pages of results'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata — page through with the page input to reach later matches'),
  }),

  // Agent-facing search context: per-page count, total match count, current page, and
  // an optional recovery notice. Populated via ctx.enrich() so it reaches both surfaces.
  // The recipient endpoint returns a real total and a reliable hasNext, so continuation
  // is disclosed by pagination state rather than a hit-the-cap heuristic.
  enrichment: {
    recipient_count: z.number().describe('Number of matching recipients returned on this page'),
    totalCount: z.number().optional().describe('Total matching recipients across all pages'),
    page: z.number().describe('Current page number returned'),
    has_next: z.boolean().describe('Whether there are more pages of results'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint — how to continue to the next page when more results exist, or how to broaden the search when empty. Absent when the full match set fits on this page.',
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
    ctx.log.info('usaspending_search_recipients', {
      keyword: input.keyword,
      page: input.page,
      limit: input.limit,
    });
    const svc = getUSASpendingService();
    const data = await svc.searchRecipients(
      {
        keyword: input.keyword,
        ...(input.award_type !== undefined ? { award_type: input.award_type } : {}),
        limit: input.limit,
        page: input.page,
      },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.uei ? { uei: r.uei } : {}),
      ...(r.duns ? { duns: r.duns } : {}),
      ...(r.recipient_level ? { recipient_level: r.recipient_level } : {}),
      ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
    }));

    const meta = data.page_metadata ?? {};
    const total = typeof meta.total === 'number' ? meta.total : undefined;
    const currentPage = typeof meta.page === 'number' ? meta.page : input.page;
    const hasNext = meta.hasNext ?? false;

    ctx.enrich({ recipient_count: results.length, page: currentPage, has_next: hasNext });
    if (total !== undefined) ctx.enrich.total(total);

    if (results.length === 0) {
      const pageNote = input.page > 1 ? ` on page ${input.page}` : '';
      ctx.enrich.notice(
        `No recipients matched "${input.keyword}"${pageNote}. Try a partial name, different spelling, or a UEI number directly.`,
      );
    } else if (hasNext) {
      const totalNote = total !== undefined ? ` (${total.toLocaleString()} total)` : '';
      ctx.enrich.notice(
        `More recipients match${totalNote}. Request page ${currentPage + 1} to continue.`,
      );
    }

    return {
      results,
      page_metadata: {
        ...(total !== undefined ? { total } : {}),
        page: currentPage,
        has_next: hasNext,
        limit: input.limit,
      },
    };
  },

  format: (result) => {
    const lines: string[] = ['## Recipient Search Results'];
    lines.push(
      `\n**Results:** ${result.results.length} | **Page:** ${result.page_metadata.page}${result.page_metadata.total !== undefined ? ` of ~${result.page_metadata.total.toLocaleString()}` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    );
    for (const r of result.results) {
      lines.push('');
      lines.push(`### ${r.name ?? r.id ?? 'Unknown'}`);
      if (r.id) lines.push(`**Recipient ID (for get_recipient):** ${r.id}`);
      if (r.uei) lines.push(`**UEI:** ${r.uei}`);
      if (r.duns) lines.push(`**DUNS:** ${r.duns}`);
      if (r.recipient_level) lines.push(`**Level:** ${r.recipient_level}`);
      if (typeof r.amount === 'number')
        lines.push(`**Award Amount:** $${r.amount.toLocaleString()}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
