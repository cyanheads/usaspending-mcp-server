/**
 * @fileoverview Tool to search federal awards by keyword, recipient, agency, award type,
 * NAICS code, location, or date range.
 * @module mcp-server/tools/definitions/search-awards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

/** Award search default fields — covers summary + chaining IDs. */
const AWARD_SEARCH_FIELDS = [
  'Award ID',
  'Recipient Name',
  'Award Amount',
  'Total Outlays',
  'Awarding Agency',
  'Awarding Sub Agency',
  'Award Type',
  'Contract Award Type',
  'Start Date',
  'End Date',
  'Description',
  'generated_internal_id',
  'Last Modified Date',
  'Funding Agency',
  'Place of Performance City Code',
  'Place of Performance State Code',
  'Place of Performance Country Code',
  'Awarding Agency Code',
  'agency_slug',
];

/**
 * Page-number pagination on search/spending_by_award/ caps at a 50,000-result offset
 * (page × limit). Past that boundary the endpoint requires keyset (after-cursor)
 * pagination via last_record_sort_value + last_record_unique_id.
 */
const MAX_PAGE_OFFSET = 50_000;

export const searchAwardsTool = tool('usaspending_search_awards', {
  title: 'Search Federal Awards',
  description:
    'Search federal awards by keyword, recipient, agency, award type, NAICS code, location, or date range. Returns ranked award summaries including recipient names, amounts, awarding agencies, and generated award IDs for use with usaspending_get_award. Award types: A/B/C/D = contracts, 02/03/04/05 = grants, 06/10 = direct payments, 07/08 = loans, IDV_A/IDV_B/IDV_C/IDV_D/IDV_E = IDVs. Dates must be ISO 8601 (YYYY-MM-DD). Earliest data: 2007-10-01 via search API. DoD contracts have a 90-day publication lag.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    keyword: z
      .string()
      .optional()
      .describe('Full-text search across award descriptions, recipient names, and place names'),
    award_type_codes: z
      .array(z.string())
      .default(['A', 'B', 'C', 'D'])
      .describe(
        'Filter by award type codes. All codes must belong to a single group: A/B/C/D (contracts), 02/03/04/05 (grants), 06/10 (direct payments), 07/08 (loans), IDV_A–IDV_E (IDVs). Defaults to contracts. Mixing groups across categories causes a 422 error.',
      ),
    agency_name: z
      .string()
      .optional()
      .describe(
        'Filter to a specific awarding agency by name (e.g., "Department of Defense"). Use usaspending_autocomplete type=awarding_agency to find exact names.',
      ),
    recipient_name: z
      .string()
      .optional()
      .describe(
        "Filter by recipient name (partial match); maps to this endpoint's recipient_search_text. This endpoint has no recipient_id filter — use usaspending_search_recipients to look up a recipient by name.",
      ),
    naics_codes: z
      .array(z.string())
      .optional()
      .describe(
        'Filter by NAICS industry codes (e.g., ["541512"]). Use usaspending_autocomplete type=naics to look up codes.',
      ),
    time_period: z
      .object({
        start_date: z
          .string()
          .describe('Start date in ISO 8601 format (YYYY-MM-DD); earliest valid: 2007-10-01'),
        end_date: z.string().describe('End date in ISO 8601 format (YYYY-MM-DD)'),
      })
      .optional()
      .describe('Filter awards by date range (action date)'),
    location_filter: z
      .object({
        country: z.string().optional().describe('ISO 3166-1 alpha-3 country code (e.g., USA)'),
        state: z.string().optional().describe('Two-letter US state abbreviation (e.g., CA)'),
        county: z
          .string()
          .optional()
          .describe('FIPS county code (e.g., 06037 for Los Angeles County)'),
        city: z.string().optional().describe('City name'),
      })
      .optional()
      .describe(
        'Filter by place of performance location. Uses FIPS codes and 2-letter state abbreviations, not place names — use a geocoding server to resolve names to codes first.',
      ),
    sort: z
      .enum([
        'Award Amount',
        'Total Outlays',
        'Start Date',
        'End Date',
        'Recipient Name',
        'Awarding Agency',
      ])
      .default('Award Amount')
      .describe('Sort field for results'),
    order: z.enum(['asc', 'desc']).default('desc').describe('Sort direction'),
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
        'Page number (1-based). Page-number pagination caps at a 50,000-result offset (page × limit); to read past that, use the cursor fields below.',
      ),
    last_record_sort_value: z
      .string()
      .optional()
      .describe(
        'Keyset-pagination cursor: the last_record_sort_value from a prior response page_metadata. Provide together with last_record_unique_id to fetch the next page past the 50,000-result page-number cap. When both cursor fields are supplied, page is ignored.',
      ),
    last_record_unique_id: z
      .number()
      .int()
      .optional()
      .describe(
        'Keyset-pagination cursor: the last_record_unique_id from a prior response page_metadata. Provide together with last_record_sort_value.',
      ),
    filters: z
      .object({
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            'Full-text search terms across award descriptions, recipient names, and places',
          ),
        award_type_codes: z
          .array(z.string())
          .optional()
          .describe(
            'Award type codes; all must belong to one group (A/B/C/D, 02/03/04/05, 06/10, 07/08, IDV_A–IDV_E)',
          ),
        agency_name: z
          .string()
          .optional()
          .describe('Awarding agency name (toptier), e.g., "Department of Defense"'),
        recipient_name: z
          .string()
          .optional()
          .describe(
            'Recipient name search (partial match); maps to recipient_search_text. Use instead of recipient_id, which this endpoint ignores.',
          ),
        naics_codes: z
          .array(z.string())
          .optional()
          .describe('NAICS industry codes to require, e.g., ["541512"]'),
        time_period_start: z
          .string()
          .optional()
          .describe(
            'Start date (YYYY-MM-DD); earliest valid 2007-10-01. Requires time_period_end.',
          ),
        time_period_end: z
          .string()
          .optional()
          .describe('End date (YYYY-MM-DD). Requires time_period_start.'),
      })
      .optional()
      .describe(
        'Optional analytics-style filter object mirroring the shape the spending analytics tools accept, for reusing one filter set across tools. When both this object and the equivalent top-level flat filters are given, this object wins per-field. recipient_id is intentionally not accepted — this endpoint silently ignores it; filter by recipient via recipient_name.',
      ),
  }),

  output: z.object({
    results: z
      .array(
        z
          .object({
            award_id: z
              .string()
              .optional()
              .describe('Display award ID (piid, fain, or uri) — NOT the chaining ID'),
            generated_internal_id: z
              .string()
              .optional()
              .describe(
                'Generated unique award ID — pass to usaspending_get_award to fetch full details',
              ),
            recipient_name: z.string().optional().describe('Name of the award recipient'),
            award_amount: z.number().optional().describe('Total award amount in USD'),
            total_outlays: z.number().optional().describe('Total outlays in USD'),
            awarding_agency: z.string().optional().describe('Name of the awarding agency'),
            awarding_sub_agency: z.string().optional().describe('Name of the awarding sub-agency'),
            agency_slug: z
              .string()
              .optional()
              .describe(
                'URL-friendly awarding-agency slug (e.g., national-aeronautics-and-space-administration) — pass to usaspending_get_agency as agency_slug. Absent when the agency has no profile page.',
              ),
            award_type: z.string().optional().describe('Award type description'),
            start_date: z.string().optional().describe('Award start date (YYYY-MM-DD)'),
            end_date: z.string().optional().describe('Award end date (YYYY-MM-DD)'),
            description: z.string().optional().describe('Award description'),
            funding_agency: z.string().optional().describe('Name of the funding agency'),
            place_of_performance: z
              .object({
                city: z.string().optional().describe('City of performance'),
                state: z.string().optional().describe('State code of performance'),
                country: z.string().optional().describe('Country code of performance'),
              })
              .optional()
              .describe('Place of performance location'),
          })
          .describe('Award summary with amounts, agencies, and chaining IDs'),
      )
      .describe('Matching award summaries'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages of results'),
        page: z.number().describe('Current page number'),
        limit: z.number().describe('Results per page'),
        last_record_sort_value: z
          .string()
          .optional()
          .describe(
            'Keyset-pagination cursor for the next page — pass back as last_record_sort_value to continue past the 50,000-result page limit',
          ),
        last_record_unique_id: z
          .number()
          .optional()
          .describe(
            'Keyset-pagination cursor for the next page — pass back as last_record_unique_id alongside last_record_sort_value',
          ),
      })
      .describe(
        'Pagination metadata. This endpoint does not return a total match count; use has_next and the cursor pair to page.',
      ),
  }),

  // Agent-facing search context: applied filters, upstream API notices, and an optional
  // recovery notice for empty pages. Populated via ctx.enrich() so it reaches both
  // structuredContent and content[] without a format() entry.
  enrichment: {
    page: z.number().describe('Current page number returned'),
    has_next: z.boolean().describe('Whether there are more pages of results'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page was capped at `limit` and more results remain (continue via page or the cursor).',
      ),
    shown: z.number().optional().describe('Number of awards returned on this page.'),
    cap: z.number().optional().describe('Per-page cap (limit) applied to this page.'),
    upstream_messages: z
      .array(z.string())
      .optional()
      .describe(
        'Notices the USAspending API returned for this request — e.g. a supplied filter that was ignored because this endpoint does not support it, or the 2007-10-01 date-floor note. Present whenever the API returns any messages.',
      ),
    applied_keyword: z.string().optional().describe('Keyword filter applied to this search'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS codes filter applied (comma-separated)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start date filter applied (YYYY-MM-DD)'),
    applied_time_period_end: z.string().optional().describe('End date filter applied (YYYY-MM-DD)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — echoes applied filters and suggests how to broaden. Absent when results are present.',
      ),
  },

  // upstream_messages is an array — supply a markdown renderer so the content[] trailer
  // shows a bullet list instead of a one-line JSON blob (structuredContent is unaffected).
  enrichmentTrailer: {
    upstream_messages: {
      label: 'API notices',
      render: (msgs) => (msgs ?? []).map((m) => `- ${m}`).join('\n'),
    },
  },

  errors: [
    {
      reason: 'api_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'USAspending.gov API is unreachable or returns an error.',
      retryable: true,
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
    {
      reason: 'pagination_limit_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page multiplied by limit exceeds the endpoint 50,000-result page window and no cursor was supplied.',
      retryable: false,
      recovery:
        'Continue past 50,000 results with keyset pagination: pass last_record_sort_value and last_record_unique_id from the most recent page_metadata instead of page.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_search_awards', {
      keyword: input.keyword,
      limit: input.limit,
      page: input.page,
    });
    const svc = getUSASpendingService();

    // Keyset pagination: both cursor values must be supplied together, else the lone
    // value would be silently dropped. When present, the cursor supersedes `page`.
    const hasSortValue = input.last_record_sort_value !== undefined;
    const hasUniqueId = input.last_record_unique_id !== undefined;
    if (hasSortValue !== hasUniqueId) {
      throw validationError(
        'Cursor pagination requires both last_record_sort_value and last_record_unique_id — provide both (from a prior page_metadata) or neither.',
      );
    }
    const usingCursor = hasSortValue && hasUniqueId;

    // Page-number pagination caps at a 50,000-result offset; fail fast with the cursor
    // recovery path instead of letting the upstream 422 bubble up unclassified.
    if (!usingCursor && input.page * input.limit > MAX_PAGE_OFFSET) {
      throw ctx.fail(
        'pagination_limit_exceeded',
        `Requested page ${input.page} at limit ${input.limit} exceeds this endpoint's ${MAX_PAGE_OFFSET.toLocaleString()}-result page-number window.`,
        {
          recovery: {
            hint: 'Re-request with last_record_sort_value and last_record_unique_id from the most recent page_metadata to continue via keyset pagination.',
          },
        },
      );
    }

    // Merge the analytics-style `filters` object over the flat inputs (nested wins
    // per-field). recipient_id is intentionally never mapped: search/spending_by_award/
    // silently ignores it (it comes back in the response `messages` as unused).
    const f = input.filters;
    const keywords =
      f?.keywords && f.keywords.length > 0
        ? f.keywords
        : input.keyword
          ? [input.keyword]
          : undefined;
    const awardTypeCodes =
      f?.award_type_codes && f.award_type_codes.length > 0
        ? f.award_type_codes
        : input.award_type_codes;
    const agencyName = f?.agency_name || input.agency_name;
    const recipientName = f?.recipient_name || input.recipient_name;
    const naicsCodes =
      f?.naics_codes && f.naics_codes.length > 0 ? f.naics_codes : input.naics_codes;
    const startDate = f?.time_period_start || input.time_period?.start_date;
    const endDate = f?.time_period_end || input.time_period?.end_date;

    const filters: Record<string, unknown> = {};
    if (keywords?.length) filters.keywords = keywords;
    filters.award_type_codes = awardTypeCodes;
    if (agencyName) {
      filters.agencies = [{ type: 'awarding', tier: 'toptier', name: agencyName }];
    }
    if (recipientName) filters.recipient_search_text = [recipientName];
    if (naicsCodes?.length) {
      filters.naics_codes = { require: naicsCodes };
    }
    if (startDate && endDate) {
      filters.time_period = [{ start_date: startDate, end_date: endDate }];
    }
    if (
      input.location_filter &&
      (input.location_filter.country ||
        input.location_filter.state ||
        input.location_filter.county ||
        input.location_filter.city)
    ) {
      const loc: Record<string, string> = {};
      if (input.location_filter.country) loc.country = input.location_filter.country;
      if (input.location_filter.state) loc.state = input.location_filter.state;
      if (input.location_filter.county) loc.county = input.location_filter.county;
      if (input.location_filter.city) loc.city = input.location_filter.city;
      filters.place_of_performance_locations = [loc];
    }

    const data = await svc.searchAwards(
      {
        filters,
        fields: AWARD_SEARCH_FIELDS,
        sort: input.sort,
        order: input.order,
        limit: input.limit,
        // page and cursor are mutually exclusive; omit page when paging by cursor.
        // Re-test both fields inline so exactOptionalPropertyTypes narrows away `undefined`.
        ...(input.last_record_sort_value !== undefined && input.last_record_unique_id !== undefined
          ? {
              last_record_sort_value: input.last_record_sort_value,
              last_record_unique_id: input.last_record_unique_id,
            }
          : { page: input.page }),
      },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r['Award ID'] ? { award_id: String(r['Award ID']) } : {}),
      ...(r.generated_internal_id
        ? { generated_internal_id: String(r.generated_internal_id) }
        : {}),
      ...(r['Recipient Name'] ? { recipient_name: String(r['Recipient Name']) } : {}),
      ...(typeof r['Award Amount'] === 'number' ? { award_amount: r['Award Amount'] } : {}),
      ...(typeof r['Total Outlays'] === 'number' ? { total_outlays: r['Total Outlays'] } : {}),
      ...(r['Awarding Agency'] ? { awarding_agency: String(r['Awarding Agency']) } : {}),
      ...(r['Awarding Sub Agency']
        ? { awarding_sub_agency: String(r['Awarding Sub Agency']) }
        : {}),
      ...(r.agency_slug ? { agency_slug: String(r.agency_slug) } : {}),
      ...(r['Award Type'] || r['Contract Award Type']
        ? { award_type: String(r['Award Type'] ?? r['Contract Award Type']) }
        : {}),
      ...(r['Start Date'] ? { start_date: String(r['Start Date']) } : {}),
      ...(r['End Date'] ? { end_date: String(r['End Date']) } : {}),
      ...(r.Description ? { description: String(r.Description) } : {}),
      ...(r['Funding Agency'] ? { funding_agency: String(r['Funding Agency']) } : {}),
      ...(r['Place of Performance City Code'] ||
      r['Place of Performance State Code'] ||
      r['Place of Performance Country Code']
        ? {
            place_of_performance: {
              ...(r['Place of Performance City Code']
                ? { city: String(r['Place of Performance City Code']) }
                : {}),
              ...(r['Place of Performance State Code']
                ? { state: String(r['Place of Performance State Code']) }
                : {}),
              ...(r['Place of Performance Country Code']
                ? { country: String(r['Place of Performance Country Code']) }
                : {}),
            },
          }
        : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    const hasNext = pageMeta.hasNext ?? false;
    // The keyset cursor is usable only on interior pages. On the final page the upstream
    // returns last_record_unique_id: null and last_record_sort_value: "None" (a stringified
    // Python None) — a bare `!== undefined` forwards that null and crashes the z.number()
    // output schema on any search that reaches its last page, including a routine empty
    // result (#39). Emit the pair only when a next page exists and both values are genuinely
    // usable; the inlined type guards also narrow the values for exactOptionalPropertyTypes.
    const sortCursor = pageMeta.last_record_sort_value;
    const uniqueCursor = pageMeta.last_record_unique_id;
    const page_metadata = {
      has_next: hasNext,
      page: pageMeta.page ?? input.page,
      limit: input.limit,
      ...(hasNext &&
      typeof sortCursor === 'string' &&
      sortCursor !== 'None' &&
      typeof uniqueCursor === 'number'
        ? { last_record_sort_value: sortCursor, last_record_unique_id: uniqueCursor }
        : {}),
    };

    ctx.enrich({
      page: page_metadata.page,
      has_next: page_metadata.has_next,
      ...(data.messages?.length ? { upstream_messages: data.messages } : {}),
      ...(keywords?.length ? { applied_keyword: keywords.join(', ') } : {}),
      ...(agencyName ? { applied_agency_name: agencyName } : {}),
      ...(naicsCodes?.length ? { applied_naics_codes: naicsCodes.join(', ') } : {}),
      ...(startDate ? { applied_time_period_start: startDate } : {}),
      ...(endDate ? { applied_time_period_end: endDate } : {}),
    });

    // Disclose page-based truncation: a capped page with more results behind has_next
    // (this endpoint returns no total, so the cap/shown pair is the honest signal).
    if (page_metadata.has_next) {
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        guidance:
          'More results remain — request the next page, or page past the 50,000-result limit with last_record_sort_value + last_record_unique_id from page_metadata.',
      });
    }

    if (results.length === 0) {
      const filterParts: string[] = [];
      if (keywords?.length) filterParts.push(`keyword="${keywords.join(', ')}"`);
      if (agencyName) filterParts.push(`agency="${agencyName}"`);
      if (awardTypeCodes?.length) {
        filterParts.push(`types=${awardTypeCodes.join(',')}`);
      }
      const notice =
        filterParts.length > 0
          ? `No awards matched: ${filterParts.join(', ')}. Try removing filters or broadening the date range.`
          : 'No awards matched your search. Try a different keyword or remove filters.';
      ctx.enrich.notice(notice);
    }

    return { results, page_metadata };
  },

  format: (result) => {
    const lines: string[] = ['## Federal Award Search Results'];
    lines.push(
      `\n**Results:** ${result.results.length} | **Page:** ${result.page_metadata.page} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    );
    for (const r of result.results) {
      lines.push('');
      lines.push(`### ${r.recipient_name ?? r.award_id ?? r.generated_internal_id ?? 'Unknown'}`);
      if (r.award_id) lines.push(`**Award ID:** ${r.award_id}`);
      if (r.generated_internal_id)
        lines.push(`**Chain ID (for get_award):** ${r.generated_internal_id}`);
      if (r.agency_slug) lines.push(`**Agency Slug (for get_agency):** ${r.agency_slug}`);
      if (typeof r.award_amount === 'number')
        lines.push(`**Amount:** $${r.award_amount.toLocaleString()}`);
      if (typeof r.total_outlays === 'number')
        lines.push(`**Outlays:** $${r.total_outlays.toLocaleString()}`);
      if (r.award_type) lines.push(`**Type:** ${r.award_type}`);
      if (r.awarding_agency)
        lines.push(
          `**Awarding Agency:** ${r.awarding_agency}${r.awarding_sub_agency ? ` / ${r.awarding_sub_agency}` : ''}`,
        );
      if (r.funding_agency) lines.push(`**Funding Agency:** ${r.funding_agency}`);
      if (r.start_date || r.end_date)
        lines.push(`**Period:** ${r.start_date ?? 'N/A'} → ${r.end_date ?? 'N/A'}`);
      if (r.description) lines.push(`**Description:** ${r.description}`);
      if (r.place_of_performance) {
        const pop = r.place_of_performance;
        lines.push(
          `**Place of Performance:** ${[pop.city, pop.state, pop.country].filter(Boolean).join(', ')}`,
        );
      }
    }
    if (
      result.page_metadata.has_next &&
      result.page_metadata.last_record_sort_value !== undefined &&
      result.page_metadata.last_record_unique_id !== undefined
    ) {
      lines.push('');
      lines.push(
        `**Next-page cursor:** last_record_sort_value=\`${result.page_metadata.last_record_sort_value}\`, last_record_unique_id=\`${result.page_metadata.last_record_unique_id}\` — pass both to page past the 50,000-result limit.`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
