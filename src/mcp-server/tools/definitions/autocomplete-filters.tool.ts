/**
 * @fileoverview Tool to look up valid code values for filter fields: NAICS, PSC, CFDA,
 * agency names, recipient names, and US state, county, and congressional district codes.
 * @module mcp-server/tools/definitions/autocomplete-filters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import {
  LOCATION_AUTOCOMPLETE_LIMIT_MAX,
  type RawAgencyAutocomplete,
  type RawLocationAutocompleteResponse,
} from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { countLimit, LimitClampSchema, limitClampTrailer } from './count-limit.js';
import { postalForStateFips, postalForUpstreamStateName, stateFipsForPostal } from './locations.js';

/** Capped at the largest `limit` the code and name autocomplete routes accept; 501 is rejected with HTTP 400. */
const LIMIT = countLimit({ tool: 'usaspending_autocomplete_filters', default: 10, cap: 500 });

/** A congressional district as `autocomplete/location/` writes it: postal code, dash, two-digit district. */
const CURRENT_DISTRICT = /^([A-Z]{2})-(\d{2})$/;

type LocationKind = 'state' | 'county' | 'district';

/**
 * Rows a location filter or `shape_codes` takes, in table order: states (postal code,
 * from upstream's name), counties (5-digit FIPS code, state from its prefix), current
 * districts (state FIPS + district number). A row whose state the postal ↔ FIPS table
 * lacks is dropped, never guessed. `full` names each bucket that came back holding
 * `requested` rows, so more of that kind may exist.
 */
function mapLocationBuckets(resp: RawLocationAutocompleteResponse, requested: number) {
  const states = resp.results?.states ?? [];
  const counties = resp.results?.counties ?? [];
  const districts = resp.results?.districts_current ?? [];
  const rows = [
    ...states.flatMap(({ state_name: name }) => {
      const postal = name ? postalForUpstreamStateName(name) : undefined;
      return name && postal ? [{ kind: 'state' as const, code: postal, name }] : [];
    }),
    ...counties.flatMap(({ county_fips: fips, county_name: name }) => {
      const state = fips && /^\d{5}$/.test(fips) ? postalForStateFips(fips.slice(0, 2)) : undefined;
      return fips && state
        ? [{ kind: 'county' as const, code: fips, ...(name ? { name } : {}), state }]
        : [];
    }),
    ...districts.flatMap(({ current_cd }) => {
      const match = current_cd ? CURRENT_DISTRICT.exec(current_cd) : null;
      const fips = match?.[1] ? stateFipsForPostal(match[1]) : undefined;
      return match?.[1] && fips
        ? [
            {
              kind: 'district' as const,
              code: `${fips}${match[2]}`,
              name: match[0],
              state: match[1],
            },
          ]
        : [];
    }),
  ];
  const buckets: [LocationKind, unknown[]][] = [
    ['state', states],
    ['county', counties],
    ['district', districts],
  ];
  const full = buckets.filter(([, bucket]) => bucket.length >= requested).map(([kind]) => kind);
  return { rows, full };
}

export const autocompleteFiltersTool = tool('usaspending_autocomplete_filters', {
  title: 'Autocomplete Codes and Names',
  description:
    'Look up valid code values for filter fields by searching free-text descriptions. Use the type parameter to select the lookup table: naics (NAICS industry codes), psc (product/service codes), cfda (CFDA/Assistance Listing program numbers), awarding_agency (agency and sub-agency names, each with its tier and top-tier parent — agency_name filters take the matched name; a sub-tier name shared by several parents matches under all parents), recipient (recipient names with UEI/DUNS), or location (US state, county, and congressional district names, resolved to the codes the location filters and usaspending_spending_by_geography shape_codes take). Call this before filtering awards when you know a description but not the exact code. Returns matching codes and names for use in other tool filters.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    type: z
      .enum(['naics', 'psc', 'cfda', 'awarding_agency', 'recipient', 'location'])
      .describe(
        'Lookup table to search: naics (industry codes), psc (product/service codes, for the psc_codes filter), cfda (Assistance Listing program numbers, for the assistance_listings filter), awarding_agency (agency and sub-agency names), recipient (recipient names), location (US states with DC and the territories, counties, and current congressional districts, matched from the start of their name: "King County", "Santa Fe", "WA-07"; countries, cities, and ZIP codes are not returned). The psc_codes and assistance_listings filters are taken by usaspending_search_awards and by the filters object of usaspending_spending_by_category, usaspending_spending_by_geography, and usaspending_spending_over_time.',
      ),
    search_text: z
      .string()
      .min(1)
      .describe(
        'Free-text search string — use a description, keyword, or partial code to find matches',
      ),
    limit: LIMIT.schema.describe(
      'Maximum number of results to return. Default 10, at most 500 per call. Agency matches combine independently capped top-tier then sub-tier buckets, preserving their order without deduplicating names; offices are excluded. Location matches combine state, then county, then district rows, and upstream returns at most 100 of each kind. The recipient lookup unions three upstream match buckets (name, UEI, DUNS) and can return up to 3x this value, so its results are capped to this limit before returning — the cap keeps them in bucket order, so name matches fill the page first and identifier matches appear only in whatever room is left. To resolve a specific UEI or DUNS, pass the identifier itself as search_text. Every lookup returns at most limit rows.',
    ),
  }),

  output: z.object({
    type: z.string().describe('Lookup table searched'),
    search_text: z.string().describe('Search text used'),
    results: z
      .array(
        z
          .object({
            kind: z
              .enum(['state', 'county', 'district'])
              .optional()
              .describe(
                'location only: what the row names — a US state, DC, or territory; a county; or a current congressional district',
              ),
            code: z
              .string()
              .optional()
              .describe(
                "Code value (NAICS code, PSC code, Assistance Listing/CFDA number, or location code); use this in filter parameters — an Assistance Listing number goes in usaspending_search_awards assistance_listings. A location row's code by kind: state, the 2-letter postal code for a location filter's state and state shape_codes; county, the 5-digit state + county FIPS code for a location filter's county and county shape_codes; district, the 4-digit state FIPS + district number for district shape_codes on usaspending_spending_by_geography. Agency rows carry toptier_code instead.",
              ),
            name: z
              .string()
              .optional()
              .describe(
                "Human-readable name or description; for awarding_agency, the matched agency's own name, which for a sub-agency differs from toptier_name; for location, upstream's uppercase name (WASHINGTON, KING, WA-07)",
              ),
            state: z
              .string()
              .optional()
              .describe(
                'location only: the 2-letter postal code of the state a county or district lies in',
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
            'Matched entry — code/name for code lookups, name with tier and top-tier parent for agencies, name plus optional UEI/DUNS for recipients, kind/code/name plus state for locations',
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
    limitClamp: LimitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'A reduced limit; how to reach the matches left out when truncated; and that an upstream maximum was reached so more matches may exist — all 500 slots filled at limit 500, or 100 rows of one location kind. Absent when none applies.',
      ),
  },

  enrichmentTrailer: {
    limitClamp: limitClampTrailer,
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
  },

  errors: [
    {
      reason: 'no_match',
      code: JsonRpcErrorCode.NotFound,
      when: 'No codes or names matched the search text; for location, no US state, county, or congressional district did.',
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
    const limit = LIMIT.apply(ctx, 'limit', input.limit);
    const notices = limit.notice ? [limit.notice] : [];
    const svc = getUSASpendingService();

    type ResultItem = {
      kind?: LocationKind;
      code?: string;
      name?: string;
      state?: string;
      abbreviation?: string;
      tier?: 'toptier' | 'subtier';
      toptier_name?: string;
      toptier_code?: string;
      subtier_code?: string;
      uei?: string;
      duns?: string;
    };
    let rawResults: ResultItem[] = [];
    /** Location buckets that came back holding `requested` rows: more of that kind may exist. */
    let fullLocationKinds: LocationKind[] = [];
    /**
     * One row past `limit` tells a capped list from one that exactly fills the page. Every
     * code and name route rejects `limit` above 500 with HTTP 400, and the location route
     * fails above 100, so at that ceiling there is no room for the extra row and a full
     * page or bucket can only say the ceiling was reached.
     */
    const requested = Math.min(
      limit.applied + 1,
      input.type === 'location' ? LOCATION_AUTOCOMPLETE_LIMIT_MAX : LIMIT.cap,
    );

    if (input.type === 'location') {
      const resp = await svc.autocompleteLocation(input.search_text, requested, ctx);
      const mapped = mapLocationBuckets(resp, requested);
      rawResults = mapped.rows;
      fullLocationKinds = mapped.full;
    } else if (input.type === 'naics') {
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
     * union top-tier then sub-tier rows. Location autocomplete caps each kind; union
     * states, counties, then districts. Judge truncation on the relevant bucket union
     * before the combined caller slice to `limit`.
     */
    const received = rawResults.length;
    rawResults = rawResults.slice(0, limit.applied);

    if (rawResults.length === 0 && input.type === 'location') {
      throw ctx.fail(
        'no_match',
        `No US state, county, or congressional district matched "${input.search_text}"`,
        {
          recovery: {
            hint: `The location lookup resolves US states, counties, and congressional districts only, not countries, cities, or ZIP codes. Names match from their start: search "King County", "District of Columbia", or "WA-07", or check the spelling.`,
          },
        },
      );
    }
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
      limit.applied < LIMIT.cap
        ? `Raise limit (max ${LIMIT.cap}) or use a more specific search term.`
        : 'Use a more specific search term.';
    /**
     * A location bucket holding the probe row proves more matches of its kind even when
     * rows dropped for an unmapped state leave fewer than `limit` kept. A bucket that
     * filled the 100-row ceiling without a probe row can only say the ceiling was reached.
     */
    const truncated =
      received > limit.applied || (requested > limit.applied && fullLocationKinds.length > 0);
    const kindsAtCeiling = requested <= limit.applied ? fullLocationKinds : [];
    if (truncated) {
      /**
       * The recipient cap is a head-slice over name-then-UEI-then-DUNS, and upstream
       * fills the name bucket to the requested size on its own whenever the corpus
       * allows. So a saturated recipient page holds name matches only, and raising
       * `limit` raises the name bucket with it — it never reaches the identifier buckets
       * behind it. Pointing that caller at `limit` alone would misdirect them.
       */
      notices.push(
        input.type === 'recipient'
          ? `More matches exist beyond limit. ${narrow} Matches on a UEI or DUNS are not reachable this way once name matches fill the page; to resolve one, pass the identifier itself as search_text.`
          : `More matches exist beyond limit. ${narrow}`,
      );
    } else if (
      input.type !== 'location' &&
      requested === limit.applied &&
      received === limit.applied
    ) {
      notices.push(
        `Returned the upstream maximum of ${LIMIT.cap} matches, so more may exist. ${narrow}`,
      );
    }
    if (kindsAtCeiling.length > 0) {
      notices.push(
        `Upstream returns at most ${LOCATION_AUTOCOMPLETE_LIMIT_MAX} location matches of each kind, and the ${kindsAtCeiling.join(' and ')} matches reached it, so more may exist. Use a more specific search term.`,
      );
    }
    // `notice` is last-wins and `truncated({ guidance })` writes it too, so every sentence joins into one write.
    if (truncated) {
      ctx.enrich.truncated({
        shown: rawResults.length,
        cap: limit.applied,
        guidance: notices.join(' '),
      });
    } else if (notices.length) {
      ctx.enrich.notice(notices.join(' '));
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
      if (r.kind) parts.push(`**Kind:** ${escapeMarkdownInline(r.kind)}`);
      if (r.code) parts.push(`**Code:** ${escapeMarkdownInline(r.code)}`);
      if (r.name)
        parts.push(
          `**Name:** ${escapeMarkdownInline(r.name)}${r.abbreviation ? ` (${escapeMarkdownInline(r.abbreviation)})` : ''}`,
        );
      if (r.state) parts.push(`**State:** ${escapeMarkdownInline(r.state)}`);
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
