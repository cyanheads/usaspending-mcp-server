/**
 * @fileoverview Tool to look up valid code values for filter fields: NAICS, PSC, CFDA,
 * agency names, and recipient names.
 * @module mcp-server/tools/definitions/autocomplete.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RawAgencyAutocomplete } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const autocompleteTool = tool('usaspending_autocomplete', {
  title: 'Autocomplete Codes and Names',
  description:
    'Look up valid code values for filter fields by searching free-text descriptions. Use the type parameter to select the lookup table: naics (NAICS industry codes), psc (product/service codes), cfda (CFDA/Assistance Listing program numbers), awarding_agency (agency names and IDs), or recipient (recipient names and IDs). Call this before filtering awards when you know a description but not the exact code. Returns matching codes and names for use in other tool filters.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    type: z
      .enum(['naics', 'psc', 'cfda', 'awarding_agency', 'recipient'])
      .describe(
        'Lookup table to search: naics (industry codes), psc (product/service codes), cfda (assistance programs), awarding_agency (agency names), recipient (recipient names)',
      ),
    search_text: z
      .string()
      .min(1)
      .describe(
        'Free-text search string — use a description, keyword, or partial code to find matches',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(10)
      .describe('Maximum number of results to return (1–50)'),
  }),

  output: z.object({
    type: z.string().describe('Lookup table searched'),
    search_text: z.string().describe('Search text used'),
    results: z
      .array(
        z
          .object({
            code: z
              .string()
              .optional()
              .describe(
                'Code value (NAICS code, PSC code, CFDA number, or agency code); use this in filter parameters',
              ),
            name: z.string().optional().describe('Human-readable name or description'),
            id: z
              .string()
              .optional()
              .describe('Numeric or string ID (for agency and recipient types)'),
          })
          .describe('Matched code entry with optional code, name, and ID fields'),
      )
      .describe('Matching codes and names'),
    total: z.number().describe('Number of results returned'),
  }),

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No codes or names matched the search text.',
      recovery: 'Try a broader search term, different spelling, or shorter keyword fragment.',
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
    ctx.log.info('usaspending_autocomplete', { type: input.type, search_text: input.search_text });
    const svc = getUSASpendingService();

    type ResultItem = { code?: string; name?: string; id?: string };
    let rawResults: ResultItem[] = [];

    if (input.type === 'naics') {
      const resp = await svc.autocompleteNaics(input.search_text, input.limit, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.naics ? { code: r.naics } : {}),
        ...(r.naics_description ? { name: r.naics_description } : {}),
      }));
    } else if (input.type === 'psc') {
      const resp = await svc.autocompletePsc(input.search_text, input.limit, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.product_or_service_code ? { code: r.product_or_service_code } : {}),
        ...(r.psc_description ? { name: r.psc_description } : {}),
      }));
    } else if (input.type === 'cfda') {
      const resp = await svc.autocompleteCfda(input.search_text, input.limit, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.program_number ? { code: r.program_number } : {}),
        ...(r.program_title
          ? { name: r.program_title }
          : r.popular_name
            ? { name: r.popular_name }
            : {}),
      }));
    } else if (input.type === 'awarding_agency') {
      const resp = await svc.autocompleteAwardingAgency(input.search_text, input.limit, ctx);
      rawResults = (resp.results ?? []).map((r: RawAgencyAutocomplete) => ({
        ...(r.id != null ? { id: String(r.id) } : {}),
        ...(r.toptier_agency?.name ? { name: r.toptier_agency.name } : {}),
      }));
    } else {
      // recipient
      const resp = await svc.autocompleteRecipient(input.search_text, input.limit, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.recipient_id ? { id: r.recipient_id } : {}),
        ...(r.legal_business_name ? { name: r.legal_business_name } : {}),
      }));
    }

    if (rawResults.length === 0) {
      throw ctx.fail('no_match', `No ${input.type} results matched "${input.search_text}"`, {
        recovery: {
          hint: `Try a broader search term for "${input.search_text}", or check spelling and use shorter keywords.`,
        },
      });
    }

    return {
      type: input.type,
      search_text: input.search_text,
      results: rawResults,
      total: rawResults.length,
    };
  },

  format: (result) => {
    const lines = [`## Autocomplete: ${result.type} — "${result.search_text}"`, ''];
    for (const r of result.results) {
      const parts: string[] = [];
      if (r.code) parts.push(`**Code:** ${r.code}`);
      if (r.id) parts.push(`**ID:** ${r.id}`);
      if (r.name) parts.push(`**Name:** ${r.name}`);
      lines.push(`- ${parts.join(' | ')}`);
    }
    lines.push(`\n**Total:** ${result.total}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
