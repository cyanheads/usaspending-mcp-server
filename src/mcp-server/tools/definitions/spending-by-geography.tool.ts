/**
 * @fileoverview Tool to aggregate federal spending by state, county, or congressional district.
 * @module mcp-server/tools/definitions/spending-by-geography.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { buildFilters } from './filters.js';

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
        'Award type codes: A/B/C/D (contracts), 02–05 (grants), 06/10 (direct payments), 07/08 (loans)',
      ),
    agency_name: z.string().optional().describe('Awarding agency name filter'),
    recipient_id: z.string().optional().describe('Exact recipient hash ID to filter awards'),
    naics_codes: z.array(z.string()).optional().describe('NAICS industry codes to include'),
    time_period_start: z
      .string()
      .optional()
      .describe('Start of time period in ISO 8601 format (YYYY-MM-DD)'),
    time_period_end: z
      .string()
      .optional()
      .describe('End of time period in ISO 8601 format (YYYY-MM-DD)'),
  })
  .optional()
  .describe('Optional filters to scope the spending aggregation');

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
  }),

  // Agent-facing context: scope, layer, count, and an optional recovery notice for empty results.
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
      .describe('Start date filter applied (YYYY-MM-DD)'),
    applied_time_period_end: z.string().optional().describe('End date filter applied (YYYY-MM-DD)'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when results are empty — suggests how to broaden filters. Absent when results are present.',
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
    ctx.log.info('usaspending_spending_by_geography', {
      scope: input.scope,
      geo_layer: input.geo_layer,
    });
    const svc = getUSASpendingService();

    const filters = buildFilters(input.filters);
    const data = await svc.spendingByGeography(
      {
        scope: input.scope,
        geo_layer: input.geo_layer,
        filters,
        subawards: input.subawards,
      },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r.shape_code ? { shape_code: r.shape_code } : {}),
      ...(r.display_name ? { display_name: r.display_name } : {}),
      ...(typeof r.aggregated_amount === 'number'
        ? { aggregated_amount: r.aggregated_amount }
        : {}),
      ...(typeof r.population === 'number' ? { population: r.population } : {}),
      ...(typeof r.per_capita === 'number' ? { per_capita: r.per_capita } : {}),
      ...(typeof r.award_count === 'number' ? { award_count: r.award_count } : {}),
    }));

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
      ...(input.filters?.time_period_start
        ? { applied_time_period_start: input.filters.time_period_start }
        : {}),
      ...(input.filters?.time_period_end
        ? { applied_time_period_end: input.filters.time_period_end }
        : {}),
    });

    if (results.length === 0) {
      ctx.enrich.notice(
        'No spending data matched the filters for the selected geography. ' +
          'Try broader filters, a different scope (place_of_performance vs recipient_location), or remove the time period constraint.',
      );
    }

    return {
      scope: input.scope,
      geo_layer: input.geo_layer,
      results,
      total: results.length,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Federal Spending by Geography`,
      `**Scope:** ${result.scope} | **Layer:** ${result.geo_layer} | **Areas:** ${result.total}`,
      '',
      '| Area | Code | Obligation | Population | Per Capita | Awards |',
      '|:-----|:-----|:-----------|:-----------|:-----------|:-------|',
    ];
    for (const r of result.results) {
      const amt =
        r.aggregated_amount !== undefined ? `$${r.aggregated_amount.toLocaleString()}` : 'N/A';
      const pop = r.population !== undefined ? r.population.toLocaleString() : 'N/A';
      const perCap = r.per_capita !== undefined ? `$${r.per_capita.toLocaleString()}` : 'N/A';
      const awards = r.award_count !== undefined ? String(r.award_count) : 'N/A';
      lines.push(
        `| ${r.display_name ?? 'N/A'} | ${r.shape_code ?? 'N/A'} | ${amt} | ${pop} | ${perCap} | ${awards} |`,
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
