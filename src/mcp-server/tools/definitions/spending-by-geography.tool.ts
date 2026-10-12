/**
 * @fileoverview Tool to aggregate federal spending by state, county, or congressional district.
 * @module mcp-server/tools/definitions/spending-by-geography.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import {
  ANALYTICS_DATE_FIELDS,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  optionalIsoDate,
} from './dates.js';
import {
  analyticsTypeMismatch,
  buildFilters,
  CODE_FILTER_FIELDS,
  codeFilterEcho,
  describeCodeFilters,
} from './filters.js';
import { formatCurrency } from './formatting.js';

/** Common filter fields for spending analytics tools */
const SpendingFiltersSchema = z
  .object({
    keywords: z
      .array(z.string())
      .optional()
      .describe('Full-text keyword filter (e.g., ["cybersecurity", "cloud"])'),
    award_type_codes: z
      .array(z.string())
      .optional()
      .describe(
        'Award type codes: A/B/C/D (contracts), IDV_A–IDV_E (IDVs), 02–05 (grants), 06/10 (direct payments), 07/08 (loans), 09/11 (insurance and other assistance), -1 (unspecified). Groups may be mixed here. Omit to aggregate every type.',
      ),
    agency_name: z
      .string()
      .optional()
      .describe(
        'Awarding agency name filter, top-tier only (e.g., "Department of Defense") — the toptier_name from usaspending_autocomplete_filters type=awarding_agency; a sub-agency name matches nothing',
      ),
    recipient_id: z.string().optional().describe('Exact recipient hash ID to filter awards'),
    naics_codes: z.array(z.string()).optional().describe('NAICS industry codes to include'),
    ...CODE_FILTER_FIELDS,
    time_period_start: optionalIsoDate(
      'Start of time period (YYYY-MM-DD), 2007-10-01 or later. Given alone, the period runs through today (UTC).',
    ),
    time_period_end: optionalIsoDate(
      'End of time period (YYYY-MM-DD). Given alone, the period starts at 2007-10-01, the earliest searchable date.',
    ),
  })
  .strict()
  .optional()
  .describe('Optional filters to scope the spending aggregation');

/**
 * Every award type code `search/spending_by_geography/` accepts, minus the `no intersection`
 * sentinel. Sent when the caller supplies no filters at all: the endpoint answers HTTP 500 to an
 * empty `filters` object, and narrowing the default to contracts (A/B/C/D) would drop grants,
 * direct payments, loans, and insurance — roughly 85% of total federal obligations — without
 * telling the caller. The full set keeps "no filter" meaning "everything".
 */
const ALL_AWARD_TYPE_CODES = [
  'A',
  'B',
  'C',
  'D',
  'IDV_A',
  'IDV_B',
  'IDV_B_A',
  'IDV_B_B',
  'IDV_B_C',
  'IDV_C',
  'IDV_D',
  'IDV_E',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  'F001',
  'F002',
  'F003',
  'F004',
  'F005',
  'F006',
  'F007',
  'F008',
  'F009',
  'F010',
  '-1',
] as const;

/** The `shape_code` form each layer returns, and so the form `shape_codes` selects by. */
const SHAPE_CODE_FORM = {
  state: 'a 2-letter postal code ("NY")',
  county: 'a 5-digit state + county FIPS code ("36117")',
  district: 'a 4-digit state FIPS + district number ("3623")',
} as const;

export const spendingByGeographyTool = tool('usaspending_spending_by_geography', {
  title: 'Spending by Geography',
  description:
    'Aggregate federal spending by state, county, or congressional district. Useful for per-capita analysis, regional comparisons, and mapping federal investment patterns. Filter by keyword, award type, agency, recipient, NAICS code, Assistance Listing, PSC, DEF code, or date range. Areas are ranked by obligation and capped at limit; to retrieve specific areas, including ones ranked past the cap, list their codes in shape_codes — a 2-letter postal code for state, a 5-digit state + county FIPS code for county, or a 4-digit state FIPS + district number for district — NOT place names. Resolve place names to these codes using a geocoding server (Census or OpenStreetMap) first. Chain per-capita results with Census population data for meaningful comparisons.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    scope: z
      .enum(['place_of_performance', 'recipient_location'])
      .describe(
        'Which location to aggregate by: place_of_performance (where work is done) or recipient_location (where the recipient is based)',
      ),
    geo_layer: z
      .enum(['state', 'county', 'district'])
      .describe(
        'Geographic granularity: state (states, DC, and territories), county (county-level), or district (congressional district)',
      ),
    filters: SpendingFiltersSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        'Maximum geographic areas to return, ranked by aggregated_amount descending (1–500). The upstream endpoint is not paginated — it returns every matching area in one response — so this caps client-side. A nationwide county query matches over 3,000 areas; use shape_codes to retrieve one ranked past the cap.',
      ),
    shape_codes: z
      .array(
        z
          .string()
          .regex(/^(?:[A-Za-z]{2}|\d{4,5})$/)
          .describe(
            'One area code: 2-letter postal code (e.g. "NY"), 5-digit county FIPS (e.g. "36117"), or 4-digit district code (e.g. "3623")',
          ),
      )
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Return only these areas (1–500 codes), in the shape_code form this tool returns for geo_layer: 2-letter postal code for state ("NY"), 5-digit state + county FIPS for county ("36117" is Wayne County, NY), or 4-digit state FIPS + 2-digit district number for district ("3623" is NY-23, "5600" is Wyoming\'s at-large seat). Selection runs over every area the filters matched, so it reaches areas ranked past limit; selected areas stay ranked by aggregated_amount and capped at limit. A code that matches no area is named in the notice.',
      ),
    subawards: z
      .boolean()
      .default(false)
      .describe('Include subaward data instead of prime award data'),
  }),

  output: z.object({
    scope: z.string().describe('Location scope used for aggregation'),
    geo_layer: z.string().describe('Geographic granularity used'),
    results: z
      .array(
        z
          .object({
            shape_code: z
              .string()
              .optional()
              .describe(
                'Area code, the form shape_codes takes: 2-letter postal code (state), 5-digit state + county FIPS (county), or 4-digit state FIPS + district number (district). Absent on the row for spending with no recorded location.',
              ),
            display_name: z
              .string()
              .optional()
              .describe('Human-readable name for the geographic area'),
            aggregated_amount: z
              .number()
              .optional()
              .describe('Total obligation amount in USD for this geographic area'),
            population: z
              .number()
              .optional()
              .describe('Population of the geographic area (when available)'),
            per_capita: z
              .number()
              .optional()
              .describe('Per-capita obligation amount in USD (aggregated_amount / population)'),
          })
          .describe('Geographic area with spending totals and optional per-capita data'),
      )
      .describe('Spending totals by geographic area'),
    total: z.number().describe('Number of geographic areas returned'),
    total_areas_available: z
      .number()
      .describe(
        'Number of geographic areas the filters matched, before shape_codes selection and limit were applied',
      ),
  }),

  // Agent-facing context: scope, layer, count, the applied filters, disclosure of the
  // no-filter award-type default, the client-side cap, and a recovery notice for empty results.
  enrichment: {
    applied_scope: z
      .string()
      .describe('Location scope applied: place_of_performance or recipient_location'),
    applied_geo_layer: z
      .string()
      .describe('Geographic granularity applied: state, county, or district'),
    area_count: z.number().describe('Number of geographic areas returned'),
    applied_shape_codes: z
      .string()
      .optional()
      .describe(
        'Area codes listed in shape_codes, letters uppercased and duplicates removed (comma-separated)',
      ),
    applied_keywords: z.string().optional().describe('Keyword filters applied (comma-separated)'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS code filters applied (comma-separated)'),
    applied_assistance_listings: z
      .string()
      .optional()
      .describe('Assistance Listing numbers sent (comma-separated)'),
    applied_psc_codes: z
      .string()
      .optional()
      .describe('PSC codes sent, uppercased (comma-separated)'),
    applied_def_codes: z
      .string()
      .optional()
      .describe('DEF codes sent, uppercased (comma-separated)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start of the time period sent (YYYY-MM-DD), including a filled-in start'),
    applied_time_period_end: z
      .string()
      .optional()
      .describe('End of the time period sent (YYYY-MM-DD), including a filled-in end'),
    applied_award_type_default: z
      .string()
      .optional()
      .describe(
        'Disclosure that no filters were supplied, so award_type_codes defaulted to the complete set. Absent when the caller supplied at least one filter.',
      ),
    truncated: z.boolean().optional().describe('True when the area list was capped at limit.'),
    shown: z.number().optional().describe('Number of geographic areas returned.'),
    cap: z.number().optional().describe('The limit that was applied.'),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'Obligation amount of the lowest-ranked area shown — an upper bound on omitted ones.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'How to reach areas omitted by limit, which shape_codes matched no area, which time-period bound was filled in when only the other was supplied, and — when the filters matched no area — any Assistance Listing, PSC, or DEF codes sent and how to broaden filters. Absent when none applies.',
      ),
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
      recovery:
        'Narrow the filters — a shorter time_period or a coarser geo_layer — then retry the aggregation.',
    },
    {
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both filters.time_period_start and filters.time_period_end were supplied and the start falls after the end.',
      retryable: false,
      recovery: 'Swap the two dates so the start date is on or before the end date, then retry.',
    },
    {
      reason: 'date_before_earliest',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved start date precedes the 2007-10-01 earliest date this endpoint can search.',
      retryable: false,
      recovery:
        'Re-request with a start date of 2007-10-01 or later. For award data back to 2000-10-01, use the Custom Award Download feature on usaspending.gov or the bulk_download API endpoints.',
    },
    {
      reason: 'assistance_listings_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters.assistance_listings was given while every code in filters.award_type_codes is a contract or IDV code.',
      retryable: false,
      recovery:
        'Add an assistance group to filters.award_type_codes — grants 02/03/04/05/F001/F002, direct payments 06/10/F006/F007, loans 07/08/F003/F004, or other assistance 09/11/-1/F005/F008/F009/F010 — or leave award_type_codes out to cover every award type.',
    },
    {
      reason: 'psc_codes_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters.psc_codes was given while every code in filters.award_type_codes is an assistance code.',
      retryable: false,
      recovery:
        'Add contracts A/B/C/D or IDVs IDV_A/IDV_B/IDV_B_A/IDV_B_B/IDV_B_C/IDV_C/IDV_D/IDV_E to filters.award_type_codes, or leave award_type_codes out to cover every award type.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_spending_by_geography', {
      scope: input.scope,
      geo_layer: input.geo_layer,
    });
    const svc = getUSASpendingService();

    const { filters, timePeriod, codes } = buildFilters(input.filters);
    const inverted = invertedRangeMessage(timePeriod, ANALYTICS_DATE_FIELDS);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted);
    }
    // Upstream answers a start before the floor with an undeclared 422.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor);
    }
    // Upstream answers a code filter no award type here can carry with $0 and no message.
    const mismatch = analyticsTypeMismatch(
      codes,
      input.filters?.award_type_codes,
      'filters.award_type_codes',
    );
    if (mismatch?.filter === 'assistance_listings') {
      throw ctx.fail('assistance_listings_type_mismatch', mismatch.message);
    }
    if (mismatch?.filter === 'psc_codes') {
      throw ctx.fail('psc_codes_type_mismatch', mismatch.message);
    }
    // The endpoint answers HTTP 500 to `filters: {}`; any one populated key satisfies it.
    const defaultedAwardTypes = Object.keys(filters).length === 0;
    if (defaultedAwardTypes) filters.award_type_codes = ALL_AWARD_TYPE_CODES;

    const data = await svc.spendingByGeography(
      {
        scope: input.scope,
        geo_layer: input.geo_layer,
        filters,
        subawards: input.subawards,
      },
      ctx,
    );

    const areas = (data.results ?? []).map((r) => ({
      ...(r.shape_code ? { shape_code: r.shape_code } : {}),
      ...(r.display_name ? { display_name: r.display_name } : {}),
      ...(typeof r.aggregated_amount === 'number'
        ? { aggregated_amount: r.aggregated_amount }
        : {}),
      ...(typeof r.population === 'number' ? { population: r.population } : {}),
      ...(typeof r.per_capita === 'number' ? { per_capita: r.per_capita } : {}),
    }));
    // Upstream returns every matching area in one unordered page — rank before capping so the
    // head answers "which areas got the most" and the omitted tail is bounded by the last row.
    areas.sort((a, b) => (b.aggregated_amount ?? 0) - (a.aggregated_amount ?? 0));
    /**
     * Selection runs over the whole aggregate already in hand. Upstream's geo_layer_filters
     * runs after the same full aggregation, so it would save no upstream work.
     */
    const wanted =
      input.shape_codes && new Set(input.shape_codes.map((code) => code.toUpperCase()));
    const selected = wanted
      ? areas.filter((a) => a.shape_code !== undefined && wanted.has(a.shape_code))
      : areas;
    const results = selected.slice(0, input.limit);
    const matchedCodes = new Set(selected.map((a) => a.shape_code));
    const unmatched = wanted ? [...wanted].filter((code) => !matchedCodes.has(code)) : [];

    ctx.enrich({
      applied_scope: input.scope,
      applied_geo_layer: input.geo_layer,
      area_count: results.length,
      ...(wanted ? { applied_shape_codes: [...wanted].join(', ') } : {}),
      ...(input.filters?.keywords?.length
        ? { applied_keywords: input.filters.keywords.join(', ') }
        : {}),
      ...(input.filters?.agency_name ? { applied_agency_name: input.filters.agency_name } : {}),
      ...(input.filters?.naics_codes?.length
        ? { applied_naics_codes: input.filters.naics_codes.join(', ') }
        : {}),
      ...codeFilterEcho(codes),
      ...(timePeriod
        ? {
            applied_time_period_start: timePeriod.start_date,
            applied_time_period_end: timePeriod.end_date,
          }
        : {}),
      ...(defaultedAwardTypes
        ? {
            applied_award_type_default:
              'No filters were supplied, so award_type_codes defaulted to the complete set — contracts, IDVs, grants, direct payments, loans, insurance, other financial assistance, and unspecified. The endpoint rejects an empty filter set.',
          }
        : {}),
    });

    // enrich.notice is last-wins, and enrich.truncated writes the notice too, so
    // every notice source joins into one string written after both.
    const notices: (string | undefined)[] = [];
    if (selected.length > results.length) {
      const ceiling = results.at(-1)?.aggregated_amount;
      const guidance = wanted
        ? `Showing the ${results.length} highest-obligation of the ${selected.length} selected areas. Raise limit to ${selected.length} to see every selected area.`
        : `Showing the ${results.length} highest-obligation areas of ${areas.length}. ${input.limit < 500 ? 'Raise limit (max 500), list' : 'List'} an omitted area's code in shape_codes, or narrow with agency_name, keywords, or a coarser geo_layer to reach the rest.`;
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        ...(typeof ceiling === 'number' ? { ceiling } : {}),
        guidance,
      });
      notices.push(guidance);
    }
    if (unmatched.length > 0) {
      notices.push(
        `shape_codes ${unmatched.join(', ')} matched no ${input.geo_layer} area for these filters. A ${input.geo_layer} code is ${SHAPE_CODE_FORM[input.geo_layer]}, and an area with no spending under the filters is not listed.`,
      );
    }
    notices.push(filledBoundNotice(timePeriod, ANALYTICS_DATE_FIELDS));
    if (areas.length === 0) {
      const codeParts = describeCodeFilters(codes);
      notices.push(
        `No spending data matched the filters${codeParts.length ? ` (${codeParts.join(', ')})` : ''} for the selected geography. ` +
          'Try broader filters, a different scope (place_of_performance vs recipient_location), or remove the time period constraint.',
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return {
      scope: input.scope,
      geo_layer: input.geo_layer,
      results,
      total: results.length,
      total_areas_available: areas.length,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Federal Spending by Geography`,
      `**Scope:** ${result.scope} | **Layer:** ${result.geo_layer} | **Areas:** ${result.total} of ${result.total_areas_available} matched`,
      '',
      '| Area | Code | Obligation | Population | Per Capita |',
      '|:-----|:-----|:-----------|:-----------|:-----------|',
    ];
    for (const r of result.results) {
      const amt = r.aggregated_amount !== undefined ? formatCurrency(r.aggregated_amount) : 'N/A';
      const pop = r.population !== undefined ? r.population.toLocaleString() : 'N/A';
      const perCap = r.per_capita !== undefined ? formatCurrency(r.per_capita) : 'N/A';
      lines.push(
        `| ${r.display_name ?? 'N/A'} | ${r.shape_code ?? 'N/A'} | ${amt} | ${pop} | ${perCap} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
