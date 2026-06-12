/**
 * @fileoverview Tool to search federal awards by keyword, recipient, agency, award type,
 * NAICS code, location, or date range.
 * @module mcp-server/tools/definitions/search-awards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
];

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
        'Filter by recipient name (partial match). Use usaspending_search_recipients for precise recipient_id filtering.',
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
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
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
        total: z.number().optional().describe('Total number of matching awards'),
        limit: z.number().describe('Results per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing search context: pagination totals and an optional recovery notice
  // for empty pages. Populated via ctx.enrich() so it reaches both structuredContent
  // and content[] without a format() entry.
  enrichment: {
    totalCount: z
      .number()
      .optional()
      .describe('Total number of matching awards across all pages (when available)'),
    page: z.number().describe('Current page number returned'),
    has_next: z.boolean().describe('Whether there are more pages of results'),
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
    ctx.log.info('usaspending_search_awards', {
      keyword: input.keyword,
      limit: input.limit,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const filters: Record<string, unknown> = {};
    if (input.keyword) filters.keywords = [input.keyword];
    filters.award_type_codes = input.award_type_codes;
    if (input.agency_name) {
      filters.agencies = [{ type: 'awarding', tier: 'toptier', name: input.agency_name }];
    }
    if (input.recipient_name) filters.recipient_search_text = [input.recipient_name];
    if (input.naics_codes?.length) {
      filters.naics_codes = { require: input.naics_codes };
    }
    if (input.time_period?.start_date && input.time_period?.end_date) {
      filters.time_period = [
        { start_date: input.time_period.start_date, end_date: input.time_period.end_date },
      ];
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
        page: input.page,
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
    const page_metadata = {
      has_next: pageMeta.hasNext ?? false,
      page: pageMeta.page ?? input.page,
      ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
      limit: input.limit,
    };

    if (typeof page_metadata.total === 'number') ctx.enrich.total(page_metadata.total);
    ctx.enrich({
      page: page_metadata.page,
      has_next: page_metadata.has_next,
      ...(input.keyword ? { applied_keyword: input.keyword } : {}),
      ...(input.agency_name ? { applied_agency_name: input.agency_name } : {}),
      ...(input.naics_codes?.length ? { applied_naics_codes: input.naics_codes.join(', ') } : {}),
      ...(input.time_period?.start_date
        ? { applied_time_period_start: input.time_period.start_date }
        : {}),
      ...(input.time_period?.end_date
        ? { applied_time_period_end: input.time_period.end_date }
        : {}),
    });

    if (results.length === 0) {
      const filterParts: string[] = [];
      if (input.keyword) filterParts.push(`keyword="${input.keyword}"`);
      if (input.agency_name) filterParts.push(`agency="${input.agency_name}"`);
      if (input.award_type_codes?.length) {
        filterParts.push(`types=${input.award_type_codes.join(',')}`);
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
      `\n**Results:** ${result.results.length} | **Page:** ${result.page_metadata.page}${result.page_metadata.total !== undefined ? ` of ~${result.page_metadata.total}` : ''} | **Per page:** ${result.page_metadata.limit} | **Has next:** ${result.page_metadata.has_next ? 'Yes' : 'No'}`,
    );
    for (const r of result.results) {
      lines.push('');
      lines.push(`### ${r.recipient_name ?? r.award_id ?? r.generated_internal_id ?? 'Unknown'}`);
      if (r.award_id) lines.push(`**Award ID:** ${r.award_id}`);
      if (r.generated_internal_id)
        lines.push(`**Chain ID (for get_award):** ${r.generated_internal_id}`);
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
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
