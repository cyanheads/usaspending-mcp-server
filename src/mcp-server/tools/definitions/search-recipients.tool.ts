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
    'Search for organizations or individuals receiving federal funds by name or UEI (Unique Entity Identifier). Returns recipient IDs (UUID hashes), total award amounts, business type classifications, and location data. Recipient IDs from this tool can be passed to usaspending_get_recipient for full profiles. Recipient level: P = parent organization, C = child entity, R = standalone.',
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
      .describe('Maximum results to return (1–100)'),
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
            state: z.string().optional().describe('State code of recipient address'),
            location: z
              .object({
                city_name: z.string().optional().describe('City of recipient address'),
                state_code: z.string().optional().describe('State code'),
                country_code: z.string().optional().describe('Country code'),
              })
              .optional()
              .describe('Recipient address location'),
          })
          .describe('Recipient entry with ID, name, and award totals'),
      )
      .describe('Matching recipients'),
    total: z.number().describe('Number of results returned'),
  }),

  // Agent-facing search context: result count and an optional recovery notice
  // for empty searches. Populated via ctx.enrich() so it reaches both surfaces.
  enrichment: {
    recipient_count: z.number().describe('Number of matching recipients returned'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — suggests how to broaden the search. Absent when results are present.',
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
    ctx.log.info('usaspending_search_recipients', { keyword: input.keyword, limit: input.limit });
    const svc = getUSASpendingService();
    const rawResults = await svc.searchRecipients(
      {
        keyword: input.keyword,
        ...(input.award_type !== undefined ? { award_type: input.award_type } : {}),
        limit: input.limit,
      },
      ctx,
    );

    const results = rawResults.map((r) => ({
      ...(r.id ? { id: r.id } : {}),
      ...(r.name ? { name: r.name } : {}),
      ...(r.uei ? { uei: r.uei } : {}),
      ...(r.duns ? { duns: r.duns } : {}),
      ...(r.recipient_level ? { recipient_level: r.recipient_level } : {}),
      ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
      ...(r.state_province ? { state: r.state_province } : {}),
      ...(r.location
        ? {
            location: {
              ...(r.location.city_name ? { city_name: r.location.city_name } : {}),
              ...(r.location.state_code ? { state_code: r.location.state_code } : {}),
              ...(r.location.country_code ? { country_code: r.location.country_code } : {}),
            },
          }
        : {}),
    }));

    ctx.enrich({ recipient_count: results.length });

    if (results.length === 0) {
      ctx.enrich.notice(
        `No recipients matched "${input.keyword}". Try a partial name, different spelling, or use a UEI number directly.`,
      );
    }

    return { results, total: results.length };
  },

  format: (result) => {
    const lines: string[] = [`## Recipient Search Results (${result.total})`];
    for (const r of result.results) {
      lines.push('');
      lines.push(`### ${r.name ?? r.id ?? 'Unknown'}`);
      if (r.id) lines.push(`**Recipient ID (for get_recipient):** ${r.id}`);
      if (r.uei) lines.push(`**UEI:** ${r.uei}`);
      if (r.duns) lines.push(`**DUNS:** ${r.duns}`);
      if (r.recipient_level) lines.push(`**Level:** ${r.recipient_level}`);
      if (typeof r.amount === 'number')
        lines.push(`**Award Amount:** $${r.amount.toLocaleString()}`);
      if (r.state) lines.push(`**State:** ${r.state}`);
      if (r.location) {
        const loc = r.location;
        lines.push(
          `**Location:** ${[loc.city_name, loc.state_code, loc.country_code].filter(Boolean).join(', ')}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
