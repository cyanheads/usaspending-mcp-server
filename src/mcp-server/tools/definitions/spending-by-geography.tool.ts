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
import { buildFilters } from './filters.js';
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
    agency_name: z.string().optional().describe('Awarding agency name filter'),
    recipient_id: z.string().optional().describe('Exact recipient hash ID to filter awards'),
    naics_codes: z.array(z.string()).optional().describe('NAICS industry codes to include'),
    time_period_start: optionalIsoDate(
      'Start of time period (YYYY-MM-DD), 2007-10-01 or later. Given alone, the period runs through today (UTC).',
    ),
    time_period_end: optionalIsoDate(
      'End of time period (YYYY-MM-DD). Given alone, the period starts at 2007-10-01, the earliest searchable date.',
    ),
  })
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

export const spendingByGeographyTool = tool('usaspending_spending_by_geography', {
  title: 'Spending by Geography',
  description:
    'Aggregate federal spending by state, county, or congressional district. Useful for per-capita analysis, regional comparisons, and mapping federal investment patterns. Geographic filters accept FIPS codes and 2-letter state abbreviations — NOT place names. Resolve place names to FIPS codes using a geocoding server (Census or OpenStreetMap) before applying location filters. Chain per-capita results with Census population data for meaningful comparisons.',
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
        'Geographic granularity: state (50 states), county (county-level), or district (congressional district)',
      ),
    filters: SpendingFiltersSchema,
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe(
        'Maximum geographic areas to return, ranked by aggregated_amount descending (1–500). The upstream endpoint is not paginated — it returns every matching area in one response — so this caps client-side. A nationwide county query matches over 3,000 areas.',
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
              .describe('Geographic identifier (FIPS state code, county FIPS, or district code)'),
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
            award_count: z.number().optional().describe('Number of awards in this area'),
          })
          .describe('Geographic area with spending totals and optional per-capita data'),
      )
      .describe('Spending totals by geographic area'),
    total: z.number().describe('Number of geographic areas returned'),
    total_areas_available: z
      .number()
      .describe('Number of geographic areas the filters matched, before limit was applied'),
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
    applied_keywords: z.string().optional().describe('Keyword filters applied (comma-separated)'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS code filters applied (comma-separated)'),
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
        'How to reach areas omitted by limit, which time-period bound was filled in when only the other was supplied, and how to broaden filters when results are empty. Absent when none applies.',
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
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_spending_by_geography', {
      scope: input.scope,
      geo_layer: input.geo_layer,
    });
    const svc = getUSASpendingService();

    const { filters, timePeriod } = buildFilters(input.filters);
    const inverted = invertedRangeMessage(timePeriod, ANALYTICS_DATE_FIELDS);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted, ctx.recoveryFor('date_range_inverted'));
    }
    // Upstream answers a start before the floor with an undeclared 422.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor, ctx.recoveryFor('date_before_earliest'));
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
      ...(typeof r.award_count === 'number' ? { award_count: r.award_count } : {}),
    }));
    // Upstream returns every matching area in one unordered page — rank before capping so the
    // head answers "which areas got the most" and the omitted tail is bounded by the last row.
    areas.sort((a, b) => (b.aggregated_amount ?? 0) - (a.aggregated_amount ?? 0));
    const results = areas.slice(0, input.limit);

    ctx.enrich({
      applied_scope: input.scope,
      applied_geo_layer: input.geo_layer,
      area_count: results.length,
      ...(input.filters?.keywords?.length
        ? { applied_keywords: input.filters.keywords.join(', ') }
        : {}),
      ...(input.filters?.agency_name ? { applied_agency_name: input.filters.agency_name } : {}),
      ...(input.filters?.naics_codes?.length
        ? { applied_naics_codes: input.filters.naics_codes.join(', ') }
        : {}),
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
    if (areas.length > results.length) {
      const ceiling = results.at(-1)?.aggregated_amount;
      const guidance = `Showing the ${results.length} highest-obligation areas of ${areas.length}. Raise limit (max 500), or narrow with agency_name, keywords, or a coarser geo_layer to reach the rest.`;
      ctx.enrich.truncated({
        shown: results.length,
        cap: input.limit,
        ...(typeof ceiling === 'number' ? { ceiling } : {}),
        guidance,
      });
      notices.push(guidance);
    }
    notices.push(filledBoundNotice(timePeriod, ANALYTICS_DATE_FIELDS));
    if (results.length === 0) {
      notices.push(
        'No spending data matched the filters for the selected geography. ' +
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
      '| Area | Code | Obligation | Population | Per Capita | Awards |',
      '|:-----|:-----|:-----------|:-----------|:-----------|:-------|',
    ];
    for (const r of result.results) {
      const amt = r.aggregated_amount !== undefined ? formatCurrency(r.aggregated_amount) : 'N/A';
      const pop = r.population !== undefined ? r.population.toLocaleString() : 'N/A';
      const perCap = r.per_capita !== undefined ? formatCurrency(r.per_capita) : 'N/A';
      const awards = r.award_count !== undefined ? String(r.award_count) : 'N/A';
      lines.push(
        `| ${r.display_name ?? 'N/A'} | ${r.shape_code ?? 'N/A'} | ${amt} | ${pop} | ${perCap} | ${awards} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
