/**
 * @fileoverview Tool to aggregate federal spending grouped by a dimension (NAICS, PSC, agency, etc.).
 * @module mcp-server/tools/definitions/spending-by-category.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import {
  AGENCY_FILTER_ENRICHMENT,
  AGENCY_FILTER_FIELDS,
  agencyFilterEcho,
  applyAgencyFilters,
  describeAgencyFilters,
  resolveAgencyFilters,
} from './agency-filters.js';
import { countLimit, LimitClampSchema, limitClampTrailer } from './count-limit.js';
import {
  ANALYTICS_DATE_FIELDS,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  NO_DATE_FILTER_NOTICE,
  optionalIsoDate,
} from './dates.js';
import {
  analyticsTypeMismatch,
  applyLocationFilters,
  buildFilters,
  CODE_FILTER_FIELDS,
  codeFilterEcho,
  describeCodeFilters,
  describeLocationFilters,
  LOCATION_FILTER_FIELDS,
  locationFilterEcho,
  normalizeEffectiveFilters,
  parentRecipientNotice,
  RECIPIENT_FILTER_DESCRIPTION,
  resolveLocationFilters,
} from './filters.js';
import { formatCurrency } from './formatting.js';
import { formatPaginationLine } from './pagination.js';

/** Upstream's page maximum; one above it answers HTTP 422. */
const LIMIT = countLimit({ tool: 'usaspending_spending_by_category', default: 10, cap: 100 });

export const spendingByCategoryTool = tool('usaspending_spending_by_category', {
  title: 'Spending by Category',
  description:
    'Aggregate federal spending grouped by a specific dimension: NAICS industry code, PSC product/service code, awarding or funding agency or subagency, CFDA assistance program, recipient, federal account, or Disaster Emergency Fund Code (DEF). Returns top items with obligation amounts — useful for trend and breakdown analysis. Filter by keyword, award type, agency, recipient, NAICS code, Assistance Listing, PSC, DEF code, place of performance or recipient location, or date range. federal_account and defc amounts are whole transaction obligations, counted under every federal account or DEF code the award carries, so rows overlap and never sum to a total; on defc, filters.def_codes selects awards but the rows still list every code those awards carry. Chain NAICS, PSC, CFDA, and DEF codes back into these filters, into usaspending_search_awards filters, or into usaspending_autocomplete_filters lookups; a federal_account code (AGENCY-MAIN, e.g. 047-4534) opens in usaspending_get_federal_account. Agency rows carry agency_slug, which opens the agency in usaspending_get_agency — on a subagency row, its parent department. recipient_duns rows carry recipient_id, which opens the recipient profile in usaspending_get_recipient, and uei.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    category: z
      .enum([
        'naics',
        'psc',
        'awarding_agency',
        'awarding_subagency',
        'funding_agency',
        'funding_subagency',
        'cfda',
        'recipient_duns',
        'federal_account',
        'defc',
      ])
      .describe(
        'Breakdown dimension: naics (industry), psc (product/service code), awarding_agency, awarding_subagency, funding_agency, funding_subagency, cfda (assistance programs), recipient_duns (recipients), federal_account (appropriations accounts; code is the AGENCY-MAIN account code usaspending_get_federal_account takes), or defc (Disaster Emergency Fund Codes; code is the DEF code the def_codes filters take). federal_account and defc amounts are whole transaction obligations, counted under every account or DEF code the award carries, so rows overlap and never sum to a total; on defc, filters.def_codes selects awards but the rows still list every code those awards carry.',
      ),
    filters: z
      .object({
        keywords: z
          .array(z.string())
          .optional()
          .describe(
            'Full-text keyword filters; each effective term needs at least three characters, including significant whitespace',
          ),
        award_type_codes: z
          .array(z.string())
          .optional()
          .describe('Award type code filters (A/B/C/D, 02–05, etc.)'),
        ...AGENCY_FILTER_FIELDS,
        recipient_id: z.string().optional().describe(RECIPIENT_FILTER_DESCRIPTION),
        naics_codes: z
          .array(z.string())
          .optional()
          .describe(
            'NAICS codes: canonical 2, 4, or 6 digits; recognized ASCII integer aliases normalize whitespace, plus, leading zeros and digit underscores; unclassified spellings remain provider-validated',
          ),
        ...CODE_FILTER_FIELDS,
        ...LOCATION_FILTER_FIELDS,
        time_period_start: optionalIsoDate(
          'Start date (YYYY-MM-DD), 2007-10-01 or later. Given alone, the window runs through today (UTC).',
        ),
        time_period_end: optionalIsoDate(
          'End date (YYYY-MM-DD). Given alone, the window starts at 2007-10-01, the earliest searchable date.',
        ),
      })
      .strict()
      .optional()
      .describe(
        "Optional filters to scope the aggregation. With neither date bound, results use USAspending's available coverage without a date filter.",
      ),
    limit: LIMIT.schema.describe('Items per page. Default 10, at most 100 per call.'),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  output: z.object({
    category: z.string().describe('Breakdown dimension used'),
    results: z
      .array(
        z
          .object({
            id: z
              .string()
              .optional()
              .describe(
                'Item identifier (varies by category); absent on recipient_duns and defc rows',
              ),
            code: z
              .string()
              .optional()
              .describe(
                'Code value: NAICS, PSC, agency code, CFDA number, recipient DUNS, federal account code (AGENCY-MAIN, e.g. 047-4534), or DEF code (e.g. Z)',
              ),
            name: z.string().optional().describe('Item name or description'),
            agency_slug: z
              .string()
              .optional()
              .describe(
                "Agency slug (awarding_agency, awarding_subagency, funding_agency, funding_subagency rows; on a subagency row, its parent department's) — pass to usaspending_get_agency as agency_slug. Absent when upstream has none.",
              ),
            amount: z.number().optional().describe('Total obligation amount in USD'),
            recipient_id: z
              .string()
              .optional()
              .describe(
                'Recipient hash ID (recipient_duns rows) — pass to usaspending_get_recipient for the profile. Absent when upstream has none.',
              ),
            uei: z
              .string()
              .optional()
              .describe(
                'Recipient Unique Entity Identifier (recipient_duns rows). Absent when upstream has none.',
              ),
          })
          .describe('Category item with code, name, and obligation amount'),
      )
      .describe('Top items in this category by obligation amount'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total items'),
        limit: z.number().describe('Items per page'),
      })
      .describe('Pagination metadata'),
  }),

  // Agent-facing context: pagination totals and a recovery notice for empty pages.
  enrichment: {
    applied_award_type_codes: z
      .string()
      .optional()
      .describe('Award type codes sent, comma-separated'),
    applied_recipient_id: z
      .string()
      .optional()
      .describe('Normalized recipient hash and level sent'),
    totalCount: z
      .number()
      .optional()
      .describe('Total number of items in this category (when available)'),
    page: z.number().describe('Current page returned'),
    has_next: z.boolean().describe('Whether there are more pages'),
    applied_keywords: z.string().optional().describe('Keyword filters applied (comma-separated)'),
    ...AGENCY_FILTER_ENRICHMENT,
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
    applied_location: z
      .string()
      .optional()
      .describe(
        'Place of performance location sent, as normalized (e.g. country=USA, state=NM, county=049)',
      ),
    applied_recipient_location: z
      .string()
      .optional()
      .describe('Recipient location sent, as normalized (e.g. country=USA, state=WA)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start date sent (YYYY-MM-DD), including a filled-in start'),
    applied_time_period_end: z
      .string()
      .optional()
      .describe('End date sent (YYYY-MM-DD), including a filled-in end'),
    limitClamp: LimitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Discloses a reduced limit, the use of available coverage without a date filter or any filled date bound, and parent recipient attribution scope. On empty results, names active scope filters and how to broaden them.',
      ),
  },

  enrichmentTrailer: {
    limitClamp: limitClampTrailer,
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
  },

  errors: [
    {
      reason: 'invalid_keyword',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An effective keyword has fewer than three characters.',
      retryable: false,
      recovery: 'Supply keywords of at least three characters; whitespace is significant.',
    },
    {
      reason: 'invalid_naics_code',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An effective NAICS code is known to be invalid.',
      retryable: false,
      recovery:
        'Use a 2, 4, or 6 digit NAICS code from usaspending_autocomplete_filters type=naics.',
    },
    {
      reason: 'invalid_recipient_id',
      code: JsonRpcErrorCode.ValidationError,
      when: 'An active analytics recipient_id is malformed.',
      retryable: false,
      recovery:
        'Use recipient_id from usaspending_search_recipients: hexadecimal 8-4-4-4-12 hash followed by uppercase -P, -C, or -R.',
    },
    {
      reason: 'invalid_location',
      code: JsonRpcErrorCode.ValidationError,
      when: 'filters.place_of_performance_location or filters.recipient_location names an unknown US state, a county without a state or under an armed-forces code, a county or FIPS-number state under a non-USA country, or parts that place it in different states.',
      retryable: false,
      recovery:
        "Under country USA (the default) or a US territory code, send state as a postal code (NM) or 2-digit FIPS code (35), and county as 3 digits with that state or as the 5-digit state + county code (35049). Under another country, send state as that country's own 2-letter subdivision code and no county.",
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
      recovery:
        'Narrow the query — a shorter time_period in filters, or a smaller limit — then retry.',
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
    const limit = LIMIT.apply(ctx, 'limit', input.limit);
    ctx.log.info('usaspending_spending_by_category', {
      category: input.category,
      limit: limit.applied,
      page: input.page,
    });
    const svc = getUSASpendingService();

    const effective = normalizeEffectiveFilters(input.filters ?? {});
    if ('reason' in effective) throw ctx.fail(effective.reason, effective.message);
    const located = resolveLocationFilters(input.filters ?? {});
    if (!located.ok) throw ctx.fail('invalid_location', located.message);
    const { locations } = located;
    const { filters, timePeriod, codes } = buildFilters({ ...input.filters, ...effective });
    applyLocationFilters(filters, locations);
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
    const agencies = await resolveAgencyFilters(svc, input.filters, ctx);
    applyAgencyFilters(filters, agencies.names);
    const data = await svc.spendingByCategory(
      input.category,
      { filters, limit: limit.applied, page: input.page },
      ctx,
    );

    const results = (data.results ?? []).map((r) => ({
      ...(r.id != null ? { id: String(r.id) } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.name || r.description ? { name: r.name ?? r.description ?? undefined } : {}),
      ...(r.agency_slug ? { agency_slug: r.agency_slug } : {}),
      ...(typeof r.amount === 'number' ? { amount: r.amount } : {}),
      ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
      ...(r.uei ? { uei: r.uei } : {}),
    }));

    const pageMeta = data.page_metadata ?? {};
    /**
     * Direct read, verified: `search/spending_by_category/{category}/` reported
     * `hasNext` truthfully on the interior, exactly-full final, and past-the-end pages
     * of small result sets, and kept doing so at offsets 10,000 through 50,000 — it has
     * no cutoff there, and answers HTTP 503 past ~200,000 rather than a misleading flag.
     * The endpoint publishes no `total`, so the read below never fires against the live API.
     */
    const page_metadata = {
      has_next: pageMeta.hasNext ?? false,
      page: pageMeta.page ?? input.page,
      ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
      limit: limit.applied,
    };

    if (typeof page_metadata.total === 'number') ctx.enrich.total(page_metadata.total);
    ctx.enrich({
      page: page_metadata.page,
      has_next: page_metadata.has_next,
      ...(input.filters?.keywords?.length
        ? { applied_keywords: input.filters.keywords.join(', ') }
        : {}),
      ...agencyFilterEcho(agencies.names),
      ...(effective.recipient_id ? { applied_recipient_id: effective.recipient_id } : {}),
      ...(filters.award_type_codes
        ? { applied_award_type_codes: filters.award_type_codes.join(', ') }
        : {}),
      ...(effective.naics_codes?.length
        ? { applied_naics_codes: effective.naics_codes.join(', ') }
        : {}),
      ...codeFilterEcho(codes),
      ...locationFilterEcho(locations),
      ...(timePeriod
        ? {
            applied_time_period_start: timePeriod.start_date,
            applied_time_period_end: timePeriod.end_date,
          }
        : {}),
    });

    // enrich.notice is last-wins, so every notice source joins into one string.
    const notices = [
      limit.notice,
      timePeriod ? filledBoundNotice(timePeriod, ANALYTICS_DATE_FIELDS) : NO_DATE_FILTER_NOTICE,
      ...agencies.notices,
      parentRecipientNotice(effective.recipient_id),
    ];
    if (results.length === 0) {
      const codeParts = [...describeCodeFilters(codes), ...describeAgencyFilters(agencies.names)];
      if (effective.recipient_id) codeParts.push(`recipient_id=${effective.recipient_id}`);
      codeParts.push(...describeLocationFilters(locations));
      notices.push(
        `No ${input.category} data matched the filters${codeParts.length ? ` (${codeParts.join(', ')})` : ''}. Try broadening filters or selecting a different category.`,
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

    return { category: input.category, results, page_metadata };
  },

  format: (result) => {
    const lines: string[] = [
      `## Spending by Category: ${escapeMarkdownInline(result.category)}`,
      formatPaginationLine(result.page_metadata),
    ];
    if (result.results.length > 0) {
      /**
       * Recipient identifiers and agency slugs get their own columns only when a row
       * carries one, so other categories keep their table; a missing one is an empty cell.
       */
      const recipientCols = result.results.some((r) => r.recipient_id || r.uei);
      const slugCol = result.results.some((r) => r.agency_slug);
      const header = [
        'Rank',
        'ID',
        'Name',
        'Code',
        ...(recipientCols ? ['UEI', 'Recipient ID'] : []),
        ...(slugCol ? ['Agency Slug'] : []),
        'Obligation',
      ];
      lines.push('', `| ${header.join(' | ')} |`);
      lines.push(`|${header.map((h) => `:${'-'.repeat(h.length + 1)}`).join('|')}|`);
      // Ranks continue across pages: page 2 at limit 3 starts at 4.
      const firstRank = (result.page_metadata.page - 1) * result.page_metadata.limit + 1;
      result.results.forEach((r, i) => {
        const cells = [
          String(firstRank + i),
          escapeMarkdownInline(r.id ?? 'N/A'),
          escapeMarkdownInline(r.name ?? 'N/A'),
          escapeMarkdownInline(r.code ?? 'N/A'),
          ...(recipientCols
            ? [escapeMarkdownInline(r.uei ?? ''), escapeMarkdownInline(r.recipient_id ?? '')]
            : []),
          ...(slugCol ? [escapeMarkdownInline(r.agency_slug ?? '')] : []),
          r.amount !== undefined ? formatCurrency(r.amount) : 'N/A',
        ];
        lines.push(`| ${cells.join(' | ')} |`);
      });
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
