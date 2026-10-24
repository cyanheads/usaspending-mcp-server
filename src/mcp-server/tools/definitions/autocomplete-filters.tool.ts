/**
 * @fileoverview Tool to look up valid code values for filter fields: NAICS, PSC, CFDA,
 * agency names, and recipient names.
 * @module mcp-server/tools/definitions/autocomplete-filters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type { RawAgencyAutocomplete } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

/** Largest `limit` every autocomplete route accepts; 501 is rejected with HTTP 400. */
const UPSTREAM_LIMIT_MAX = 500;

export const autocompleteFiltersTool = tool('usaspending_autocomplete_filters', {
  title: 'Autocomplete Codes and Names',
  description:
    'Look up valid code values for filter fields by searching free-text descriptions. Use the type parameter to select the lookup table: naics (NAICS industry codes), psc (product/service codes), cfda (CFDA/Assistance Listing program numbers), awarding_agency (agency and sub-agency names, each with its tier and top-tier parent — agency_name filters take the matched name; a sub-tier name shared by several parents matches under all parents), or recipient (recipient names with UEI/DUNS). Call this before filtering awards when you know a description but not the exact code. Returns matching codes and names for use in other tool filters.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    type: z
      .enum(['naics', 'psc', 'cfda', 'awarding_agency', 'recipient'])
      .describe(
        'Lookup table to search: naics (industry codes), psc (product/service codes, for the psc_codes filter), cfda (Assistance Listing program numbers, for the assistance_listings filter), awarding_agency (agency and sub-agency names), recipient (recipient names). Both filters are taken by usaspending_search_awards and by the filters object of usaspending_spending_by_category, usaspending_spending_by_geography, and usaspending_spending_over_time.',
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
      .max(UPSTREAM_LIMIT_MAX)
      .default(10)
      .describe(
        'Maximum number of results to return (1–500), enforced client-side. Agency matches combine independently capped top-tier then sub-tier buckets, preserving their order without deduplicating names; offices are excluded. The recipient lookup unions three upstream match buckets (name, UEI, DUNS) and can return up to 3x this value, so its results are capped to this limit before returning — the cap keeps them in bucket order, so name matches fill the page first and identifier matches appear only in whatever room is left. To resolve a specific UEI or DUNS, pass the identifier itself as search_text. Every lookup returns at most limit rows.',
      ),
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
                'Code value (NAICS code, PSC code, or Assistance Listing/CFDA number); use this in filter parameters — an Assistance Listing number goes in usaspending_search_awards assistance_listings. Agency rows carry toptier_code instead.',
              ),
            name: z
              .string()
              .optional()
              .describe(
                "Human-readable name or description; for awarding_agency, the matched agency's own name, which for a sub-agency differs from toptier_name",
              ),
            abbreviation: z
              .string()
              .optional()
              .describe(
                "awarding_agency only: the matched agency's own abbreviation, when it has one",
              ),
            tier: z
              .enum(['toptier', 'subtier'])
              .optional()
              .describe(
                'awarding_agency only: toptier for a department-level agency, subtier for a component under one',
              ),
            toptier_name: z
              .string()
              .optional()
              .describe(
                'awarding_agency only: the top-tier parent name. Use the matched name in agency_name on usaspending_search_awards and spending analytics to select the sub-agency; use toptier_name intentionally to select its whole parent department.',
              ),
            toptier_code: z
              .string()
              .optional()
              .describe(
                'awarding_agency only: the 3-digit top-tier agency code, accepted by usaspending_get_agency',
              ),
            subtier_code: z
              .string()
              .optional()
              .describe('awarding_agency only: the matched sub-tier agency code, when supplied'),
            uei: z
              .string()
              .optional()
              .describe(
                'Unique Entity Identifier (SAM.gov) — recipient type only; populated when the search text matches a UEI',
              ),
            duns: z
              .string()
              .optional()
              .describe(
                'DUNS number (legacy) — recipient type only; populated when the search text matches a DUNS',
              ),
          })
          .describe(
            'Matched entry — code/name for code lookups, name with tier and top-tier parent for agencies, name plus optional UEI/DUNS for recipients',
          ),
      )
      .describe('Matching codes and names'),
    total: z.number().describe('Number of results returned'),
  }),

  // Agent-facing context: echoed query parameters and result count. The autocomplete
  // endpoints return no total, so the handler asks for one row past the limit and
  // discloses truncation only when that row (or a recipient bucket overflow) came back.
  enrichment: {
    lookup_type: z.string().describe('Lookup table that was searched'),
    query: z.string().describe('Search text sent to the autocomplete API'),
    result_count: z.number().describe('Number of matching results returned'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when more matches exist beyond the limit and were left out. Absent when every match was returned.',
      ),
    shown: z.number().optional().describe('Number of results returned, when truncated.'),
    cap: z.number().optional().describe('The limit that was applied, when truncated.'),
    notice: z
      .string()
      .optional()
      .describe(
        'How to reach the matches left out when truncated, or — when limit is 500 and all 500 slots filled — that the upstream maximum was reached and more matches may exist. Absent otherwise.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
  },

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
      thrownBy: 'service',
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
    {
      reason: 'api_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'USAspending.gov did not respond before the request deadline elapsed.',
      retryable: true,
      thrownBy: 'service',
      recovery: 'Retry with a longer search_text and a smaller limit to shrink the match set.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_autocomplete_filters', {
      type: input.type,
      search_text: input.search_text,
    });
    const svc = getUSASpendingService();

    type ResultItem = {
      code?: string;
      name?: string;
      abbreviation?: string;
      tier?: 'toptier' | 'subtier';
      toptier_name?: string;
      toptier_code?: string;
      subtier_code?: string;
      uei?: string;
      duns?: string;
    };
    let rawResults: ResultItem[] = [];
    /**
     * One row past `limit` tells a capped list from one that exactly fills the page. Every
     * autocomplete route rejects `limit` above 500 with HTTP 400, so at 500 there is no
     * room for the extra row and a full page can only say the ceiling was reached.
     */
    const requested = Math.min(input.limit + 1, UPSTREAM_LIMIT_MAX);

    if (input.type === 'naics') {
      const resp = await svc.autocompleteNaics(input.search_text, requested, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.naics ? { code: r.naics } : {}),
        ...(r.naics_description ? { name: r.naics_description } : {}),
      }));
    } else if (input.type === 'psc') {
      const resp = await svc.autocompletePsc(input.search_text, requested, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.product_or_service_code ? { code: r.product_or_service_code } : {}),
        ...(r.psc_description ? { name: r.psc_description } : {}),
      }));
    } else if (input.type === 'cfda') {
      const resp = await svc.autocompleteCfda(input.search_text, requested, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.program_number ? { code: r.program_number } : {}),
        ...(r.program_title
          ? { name: r.program_title }
          : r.popular_name
            ? { name: r.popular_name }
            : {}),
      }));
    } else if (input.type === 'awarding_agency') {
      const resp = await svc.autocompleteAwardingAgency(input.search_text, requested, ctx);
      const mapAgency = (r: RawAgencyAutocomplete, tier: 'toptier' | 'subtier'): ResultItem => {
        const parent = tier === 'toptier' ? r : r.toptier_agency;
        return {
          ...(r.name ? { name: r.name } : {}),
          ...(r.abbreviation ? { abbreviation: r.abbreviation } : {}),
          tier,
          ...(parent?.name ? { toptier_name: parent.name } : {}),
          ...(parent?.code ? { toptier_code: parent.code } : {}),
          ...(tier === 'subtier' && r.code ? { subtier_code: r.code } : {}),
        };
      };
      rawResults = [
        ...(resp.results?.toptier_agency ?? []).map((r) => mapAgency(r, 'toptier')),
        ...(resp.results?.subtier_agency ?? []).map((r) => mapAgency(r, 'subtier')),
      ];
    } else {
      // recipient
      const resp = await svc.autocompleteRecipient(input.search_text, requested, ctx);
      rawResults = (resp.results ?? []).map((r) => ({
        ...(r.recipient_name ? { name: r.recipient_name } : {}),
        ...(r.uei ? { uei: r.uei } : {}),
        ...(r.duns ? { duns: r.duns } : {}),
      }));
    }

    /**
     * `autocomplete/recipient/` applies `limit` per match bucket (name, UEI, DUNS) and
     * unions them. Agency autocomplete caps each tier independently; omit offices and
     * union top-tier then sub-tier rows. Judge truncation on the relevant bucket union
     * before the combined caller slice to `limit`.
     */
    const received = rawResults.length;
    rawResults = rawResults.slice(0, input.limit);

    if (rawResults.length === 0) {
      throw ctx.fail('no_match', `No ${input.type} results matched "${input.search_text}"`, {
        recovery: {
          hint: `Try a broader search term for "${input.search_text}", or check spelling and use shorter keywords.`,
        },
      });
    }

    ctx.enrich({
      lookup_type: input.type,
      query: input.search_text,
      result_count: rawResults.length,
    });
    const narrow =
      input.limit < UPSTREAM_LIMIT_MAX
        ? `Raise limit (max ${UPSTREAM_LIMIT_MAX}) or use a more specific search term.`
        : 'Use a more specific search term.';
    if (received > input.limit) {
      ctx.enrich.truncated({
        shown: rawResults.length,
        cap: input.limit,
        /**
         * The recipient cap is a head-slice over name-then-UEI-then-DUNS, and upstream
         * fills the name bucket to the requested size on its own whenever the corpus
         * allows. So a saturated recipient page holds name matches only, and raising
         * `limit` raises the name bucket with it — it never reaches the identifier buckets
         * behind it. Pointing that caller at `limit` alone would misdirect them.
         */
        guidance:
          input.type === 'recipient'
            ? `More matches exist beyond limit. ${narrow} Matches on a UEI or DUNS are not reachable this way once name matches fill the page; to resolve one, pass the identifier itself as search_text.`
            : `More matches exist beyond limit. ${narrow}`,
      });
    } else if (requested === input.limit && received === input.limit) {
      ctx.enrich.notice(
        `Returned the upstream maximum of ${UPSTREAM_LIMIT_MAX} matches, so more may exist. ${narrow}`,
      );
    }
    return {
      type: input.type,
      search_text: input.search_text,
      results: rawResults,
      total: rawResults.length,
    };
  },

  format: (result) => {
    const lines = [
      `## Autocomplete: ${escapeMarkdownInline(result.type)} — "${escapeMarkdownInline(result.search_text)}"`,
      '',
    ];
    for (const r of result.results) {
      const parts: string[] = [];
      if (r.code) parts.push(`**Code:** ${escapeMarkdownInline(r.code)}`);
      if (r.name)
        parts.push(
          `**Name:** ${escapeMarkdownInline(r.name)}${r.abbreviation ? ` (${escapeMarkdownInline(r.abbreviation)})` : ''}`,
        );
      if (r.tier) parts.push(`**Tier:** ${escapeMarkdownInline(r.tier)}`);
      if (r.toptier_name)
        parts.push(
          `**Top-tier agency:** ${escapeMarkdownInline(r.toptier_name)}${r.toptier_code ? ` (toptier_code ${escapeMarkdownInline(r.toptier_code)})` : ''}`,
        );
      if (r.uei) parts.push(`**UEI:** ${escapeMarkdownInline(r.uei)}`);
      if (r.subtier_code) parts.push(`**Sub-tier code:** ${escapeMarkdownInline(r.subtier_code)}`);
      if (r.duns) parts.push(`**DUNS:** ${escapeMarkdownInline(r.duns)}`);
      lines.push(`- ${parts.join(' | ')}`);
    }
    lines.push(`\n**Total:** ${result.total}`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
