/**
 * @fileoverview Tool to search federal awards by keyword, recipient, agency, award type,
 * NAICS code, location, or date range.
 * @module mcp-server/tools/definitions/search-awards.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import {
  ANALYTICS_DATE_FIELDS,
  blankableIsoDate,
  type DateFields,
  filledBoundNotice,
  floorViolationMessage,
  invertedRangeMessage,
  optionalIsoDate,
  resolveDateRange,
} from './dates.js';
import { formatCurrency } from './formatting.js';
import { resolveHasNext } from './pagination.js';

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
 * Loan-only fields. A loan row carries no Award Amount, Total Outlays, or
 * dates, and upstream sorts only by a field the request names, so a loan search
 * requests these on top of {@link AWARD_SEARCH_FIELDS}.
 */
const LOAN_FIELDS = ['Loan Value', 'Subsidy Cost', 'Issued Date'];

const CONTRACT_SORTS = [
  'Award Amount',
  'Total Outlays',
  'Start Date',
  'End Date',
  'Recipient Name',
  'Awarding Agency',
] as const;
const LOAN_SORTS = [
  'Loan Value',
  'Subsidy Cost',
  'Issued Date',
  'Recipient Name',
  'Awarding Agency',
] as const;

type AwardSort = (typeof CONTRACT_SORTS)[number] | (typeof LOAN_SORTS)[number];

interface AwardTypeGroup {
  codes: readonly string[];
  label: string;
  sorts: readonly AwardSort[];
}

/**
 * The award-type groups `search/spending_by_award/` accepts one at a time — the
 * partition its mixed-group 422 lists, F-codes and -1 included — and the sorts
 * each group's field mapping allows; upstream answers any other sort with a 400.
 * IDVs have no End Date; loans have no amount or date fields of the contract
 * kind and sort by their own. Labels follow USAspending's type names.
 */
const AWARD_TYPE_GROUPS = {
  contracts: { label: 'contracts', codes: ['A', 'B', 'C', 'D'], sorts: CONTRACT_SORTS },
  idvs: {
    label: 'IDVs',
    codes: ['IDV_A', 'IDV_B', 'IDV_B_A', 'IDV_B_B', 'IDV_B_C', 'IDV_C', 'IDV_D', 'IDV_E'],
    sorts: CONTRACT_SORTS.filter((sort) => sort !== 'End Date'),
  },
  grants: {
    label: 'grants',
    codes: ['02', '03', '04', '05', 'F001', 'F002'],
    sorts: CONTRACT_SORTS,
  },
  direct_payments: {
    label: 'direct payments',
    codes: ['06', '10', 'F006', 'F007'],
    sorts: CONTRACT_SORTS,
  },
  loans: { label: 'loans', codes: ['07', '08', 'F003', 'F004'], sorts: LOAN_SORTS },
  other: {
    label: 'other',
    codes: ['09', '11', '-1', 'F005', 'F008', 'F009', 'F010'],
    sorts: CONTRACT_SORTS,
  },
} satisfies Record<string, AwardTypeGroup>;

/**
 * The group every code belongs to, or `undefined` when the codes span groups or
 * include one outside them — upstream's own 422 then decides, unguessed.
 */
function resolveAwardTypeGroup(codes: readonly string[]): AwardTypeGroup | undefined {
  const groups = new Set(
    codes.map((code) => Object.values(AWARD_TYPE_GROUPS).find((g) => g.codes.includes(code))),
  );
  const [only] = groups;
  return groups.size === 1 ? only : undefined;
}

/** Codes that never carry an assistance listing: contracts and IDVs. */
const NON_ASSISTANCE_CODES = new Set([
  ...AWARD_TYPE_GROUPS.contracts.codes,
  ...AWARD_TYPE_GROUPS.idvs.codes,
]);

/** The flat `time_period` object's field paths, as messages name them. */
const FLAT_DATE_FIELDS = {
  start: 'time_period.start_date',
  end: 'time_period.end_date',
} as const satisfies DateFields;

/** Assistance Listing (CFDA) number: two digits, a dot, three digits or capitals (`11.67A`). */
const ASSISTANCE_LISTING_PATTERN = /^\d{2}\.[0-9A-Z]{3}$/;

/**
 * Page-number pagination on search/spending_by_award/ caps at a 50,000-result offset
 * (page × limit). Past that boundary the endpoint requires keyset (after-cursor)
 * pagination via last_record_sort_value + last_record_unique_id.
 */
const MAX_PAGE_OFFSET = 50_000;

/**
 * Result offset (page × limit) past which search/spending_by_award/ stops emitting
 * usable pagination metadata. From this offset on, every page still returns its full
 * rows but reports `hasNext: false` with `last_record_unique_id: null` and
 * `last_record_sort_value: "None"` — so page-number paging keeps working up to
 * MAX_PAGE_OFFSET while the keyset cursor becomes unobtainable. A caller who needs
 * the cursor must capture it before crossing this line.
 */
const CURSOR_WINDOW_OFFSET = 10_000;

export const searchAwardsTool = tool('usaspending_search_awards', {
  title: 'Search Federal Awards',
  description:
    'Search federal awards by keyword, recipient, agency, award type, NAICS code, assistance listing (CFDA) number, location, or date range. Returns ranked award summaries including recipient names, amounts, awarding agencies, and generated award IDs for use with usaspending_get_award; loan rows carry loan value, subsidy cost, and issue date in place of award amount and dates. Award types: A/B/C/D = contracts, IDV_A–IDV_E = IDVs, 02/03/04/05/F001/F002 = grants, 06/10/F006/F007 = direct payments, 07/08/F003/F004 = loans, 09/11/-1/F005/F008/F009/F010 = other assistance. Dates must be ISO 8601 (YYYY-MM-DD). Earliest data: 2007-10-01 via search API. DoD contracts have a 90-day publication lag.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    keyword: z
      .string()
      .optional()
      .describe('Full-text search across award descriptions, recipient names, and place names'),
    award_type_codes: z
      .array(z.string())
      .min(1)
      .default(['A', 'B', 'C', 'D'])
      .describe(
        'Filter by award type codes. All codes must belong to a single group: A/B/C/D (contracts), IDV_A/IDV_B/IDV_B_A/IDV_B_B/IDV_B_C/IDV_C/IDV_D/IDV_E (IDVs), 02/03/04/05/F001/F002 (grants), 06/10/F006/F007 (direct payments), 07/08/F003/F004 (loans), 09/11/-1/F005/F008/F009/F010 (other assistance). Defaults to contracts. Mixing groups causes a 422 error. The group decides which sort values apply.',
      ),
    agency_name: z
      .string()
      .optional()
      .describe(
        'Filter to a specific awarding agency by name (e.g., "Department of Defense"). Use usaspending_autocomplete_filters type=awarding_agency to find exact names.',
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
        'Filter by NAICS industry codes (e.g., ["541512"]). Use usaspending_autocomplete_filters type=naics to look up codes.',
      ),
    assistance_listings: z
      .array(
        z
          .string()
          .regex(
            ASSISTANCE_LISTING_PATTERN,
            'Expected an Assistance Listing number as NN.NNN (e.g. 93.866 or 11.67A)',
          )
          .describe('Assistance Listing number, e.g. 93.866'),
      )
      .optional()
      .describe(
        'Filter by Assistance Listing (CFDA) program numbers, e.g. ["93.866"]: two digits, a dot, then three digits or capital letters (11.67A). Matches an award when any of its listings equals one of these exactly; several values match any of them. A row\'s primary listing can differ from the one requested, and its amount is the whole award, not that listing\'s share. Assistance award types only — set award_type_codes to grants, direct payments, loans, or other assistance; contracts and IDVs carry no listings, so pairing them (including the default award_type_codes) is rejected. Use usaspending_autocomplete_filters type=cfda to look up numbers.',
      ),
    time_period: z
      .object({
        start_date: blankableIsoDate(
          'Start date in ISO 8601 format (YYYY-MM-DD); earliest valid: 2007-10-01. Blank ("") leaves the start open, filled with 2007-10-01.',
        ),
        end_date: blankableIsoDate(
          'End date in ISO 8601 format (YYYY-MM-DD). Blank ("") leaves the end open, filled with today (UTC).',
        ),
      })
      .optional()
      .describe(
        'Filter awards by date range (action date). Both blank means no date filter; one blank end is filled and named in the notice.',
      ),
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
        'Loan Value',
        'Subsidy Cost',
        'Issued Date',
        'Recipient Name',
        'Awarding Agency',
      ])
      .optional()
      .describe(
        'Sort field for results. Loans (07/08/F003/F004) sort by Loan Value, Subsidy Cost, Issued Date, Recipient Name, or Awarding Agency, defaulting to Loan Value. Every other group sorts by Award Amount, Total Outlays, Start Date, End Date, Recipient Name, or Awarding Agency, defaulting to Award Amount — except IDVs, which have no End Date. A sort the group does not support is rejected before the search runs.',
      ),
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
        `Page number (1-based). Page-number pagination caps at a ${MAX_PAGE_OFFSET.toLocaleString()}-result offset (page × limit), but the keyset cursor below is only returned while the offset stays under ${CURSOR_WINDOW_OFFSET.toLocaleString()} — capture the cursor pair before paging past that, or the only way forward is page numbers.`,
      ),
    last_record_sort_value: z
      .string()
      .optional()
      .describe(
        `Keyset-pagination cursor: the last_record_sort_value from a prior response page_metadata. Provide together with last_record_unique_id to fetch the next page past the ${MAX_PAGE_OFFSET.toLocaleString()}-result page-number cap. The upstream stops emitting the pair once page × limit reaches ${CURSOR_WINDOW_OFFSET.toLocaleString()}, so take it from a page below that offset. When both cursor fields are supplied, page is ignored.`,
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
            'Award type codes; all must belong to one group (A/B/C/D contracts, IDV_A–IDV_E IDVs, 02/03/04/05/F001/F002 grants, 06/10/F006/F007 direct payments, 07/08/F003/F004 loans, 09/11/-1/F005/F008/F009/F010 other assistance). When non-empty, overrides the top-level award_type_codes and decides which sort values apply; an empty array falls back to the top-level value.',
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
        time_period_start: optionalIsoDate(
          'Start date (YYYY-MM-DD); earliest valid 2007-10-01. Given alone, the range runs through today (UTC).',
        ),
        time_period_end: optionalIsoDate(
          'End date (YYYY-MM-DD). Given alone, the range starts at 2007-10-01, the earliest searchable date.',
        ),
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
            loan_value: z
              .number()
              .optional()
              .describe('Face value of the loan in USD (loans only — they carry no award_amount)'),
            subsidy_cost: z
              .number()
              .optional()
              .describe(
                'Original subsidy cost of the loan in USD — the estimated long-term cost to the government (loans only)',
              ),
            issued_date: z
              .string()
              .optional()
              .describe(
                'Date the loan was issued (YYYY-MM-DD; loans only — they carry no start or end date)',
              ),
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
        has_next: z
          .boolean()
          .describe(
            `Whether more results may remain — true on a full page even when the upstream flag reports none, since this endpoint under-reports continuation on a final full page and on every page past a ${CURSOR_WINDOW_OFFSET.toLocaleString()}-result offset. A short or empty page marks the end.`,
          ),
        page: z.number().describe('Current page number'),
        limit: z.number().describe('Results per page'),
        last_record_sort_value: z
          .string()
          .optional()
          .describe(
            `Keyset-pagination cursor for the next page — pass back as last_record_sort_value to continue past the ${MAX_PAGE_OFFSET.toLocaleString()}-result page limit. Absent once page × limit reaches ${CURSOR_WINDOW_OFFSET.toLocaleString()}, where the upstream stops emitting the pair.`,
          ),
        last_record_unique_id: z
          .number()
          .optional()
          .describe(
            'Keyset-pagination cursor for the next page — pass back as last_record_unique_id alongside last_record_sort_value. Absent on the same pages that omit last_record_sort_value.',
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
    has_next: z
      .boolean()
      .describe(
        'Whether more results may remain — set on a full page even when the upstream flag reports none.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when this page was capped at `limit` and more results may remain (continue via page or the cursor).',
      ),
    shown: z.number().optional().describe('Number of awards returned on this page.'),
    cap: z.number().optional().describe('Per-page cap (limit) applied to this page.'),
    upstream_messages: z
      .array(z.string())
      .optional()
      .describe(
        'Notices the USAspending API returned with this response — e.g. a supplied filter it ignored because this endpoint does not support it. Every successful response also carries a standing advisory that search covers 2007-10-01 onward; that advisory is boilerplate, not a verdict on the dates requested. Present whenever the API returns any messages.',
      ),
    applied_keyword: z.string().optional().describe('Keyword filter applied to this search'),
    applied_agency_name: z.string().optional().describe('Awarding agency name filter applied'),
    applied_naics_codes: z
      .string()
      .optional()
      .describe('NAICS codes filter applied (comma-separated)'),
    applied_assistance_listings: z
      .string()
      .optional()
      .describe('Assistance Listing numbers filter applied (comma-separated)'),
    applied_time_period_start: z
      .string()
      .optional()
      .describe('Start of the date range sent (YYYY-MM-DD), including a filled-in start'),
    applied_time_period_end: z
      .string()
      .optional()
      .describe('End of the date range sent (YYYY-MM-DD), including a filled-in end'),
    notice: z
      .string()
      .optional()
      .describe(
        'How to page on when more results may remain, which date bound was filled in when only the other was supplied, and — when results are empty — the applied filters with how to broaden. Absent when none applies.',
      ),
  },

  // upstream_messages is an array — supply a markdown renderer so the content[] trailer
  // shows a bullet list instead of a one-line JSON blob (structuredContent is unaffected).
  // The heading is emitted from inside render(): the trailer renderer treats render as a
  // full escape hatch and never consults a sibling `label`, so an unheaded bullet list
  // would otherwise sit unattributed between the surrounding `**key:** value` lines.
  enrichmentTrailer: {
    upstream_messages: {
      /**
       * The trailing empty element closes the bullet list with a blank line. The
       * framework joins trailer entries with a single `\n`, so without it the next
       * entry (`**applied_keyword:** …` and friends, which follow this key in the
       * enrichment insertion order) lands on the line directly after the last
       * bullet, where a strict markdown renderer reads it as a lazy continuation
       * of that bullet instead of its own line.
       */
      render: (msgs) => ['**API notices:**', ...(msgs ?? []).map((m) => `- ${m}`), ''].join('\n'),
    },
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
        'Narrow the search — a shorter time_period, fewer award_type_codes, or a smaller limit — then retry.',
    },
    {
      reason: 'pagination_limit_exceeded',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page multiplied by limit exceeds the endpoint 50,000-result page window and no cursor was supplied.',
      retryable: false,
      recovery: `Continue past ${MAX_PAGE_OFFSET.toLocaleString()} results with keyset pagination, using a cursor taken from a page below a ${CURSOR_WINDOW_OFFSET.toLocaleString()}-result offset — that is where the endpoint stops emitting last_record_sort_value and last_record_unique_id. Re-page from within that window to obtain the pair.`,
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
      reason: 'date_range_inverted',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both ends of the date range were supplied and the start date falls after the end date.',
      retryable: false,
      recovery: 'Swap the two dates so the start date is on or before the end date, then retry.',
    },
    {
      reason: 'unsupported_sort',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The sort value is not one the award type group supports.',
      retryable: false,
      recovery:
        'Re-request with one of the sorts the error lists for this award type group, or omit sort to use the group default (Loan Value for loans, Award Amount otherwise).',
    },
    {
      reason: 'assistance_listings_type_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'assistance_listings was given while the award type codes include contract or IDV codes, or were left at the contract default.',
      retryable: false,
      recovery:
        'Set award_type_codes to one assistance group — grants 02/03/04/05/F001/F002, direct payments 06/10/F006/F007, loans 07/08/F003/F004, or other assistance 09/11/-1/F005/F008/F009/F010 — alongside assistance_listings.',
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
        ctx.recoveryFor('pagination_limit_exceeded'),
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
    const awardTypeCodes = f?.award_type_codes?.length
      ? f.award_type_codes
      : input.award_type_codes;
    const agencyName = f?.agency_name || input.agency_name;
    const recipientName = f?.recipient_name || input.recipient_name;
    const naicsCodes =
      f?.naics_codes && f.naics_codes.length > 0 ? f.naics_codes : input.naics_codes;
    // Both input paths (the flat time_period and the nested filters.time_period_*)
    // merge here, nested winning per bound; a blank reads as absent. A lone bound
    // is filled to a two-ended range, padded, so a half-blank flat pair is a lone
    // bound and a fully blank one is no range at all.
    const timePeriod = resolveDateRange(
      f?.time_period_start || input.time_period?.start_date,
      f?.time_period_end || input.time_period?.end_date,
    );
    // Messages name the path each bound came from. Only a lone bound is filled,
    // so the omitted field belongs to the same path as the one supplied.
    const dateFields: DateFields = {
      start: f?.time_period_start ? ANALYTICS_DATE_FIELDS.start : FLAT_DATE_FIELDS.start,
      end: f?.time_period_end ? ANALYTICS_DATE_FIELDS.end : FLAT_DATE_FIELDS.end,
    };
    const filledFields: DateFields =
      f?.time_period_start || f?.time_period_end ? ANALYTICS_DATE_FIELDS : FLAT_DATE_FIELDS;

    // Upstream ignores an inverted range here and returns rows outside it, so the
    // echo would claim a window that was never applied.
    const inverted = invertedRangeMessage(timePeriod, dateFields);
    if (inverted) {
      throw ctx.fail('date_range_inverted', inverted, ctx.recoveryFor('date_range_inverted'));
    }

    // Upstream rejects a start before the floor with its own 422; failing here
    // instead carries the declared reason and the bulk-download recovery.
    const beforeFloor = floorViolationMessage(timePeriod);
    if (beforeFloor) {
      throw ctx.fail('date_before_earliest', beforeFloor, ctx.recoveryFor('date_before_earliest'));
    }

    // Contracts and IDVs carry no listings: upstream answers 200 with zero rows and
    // no message, which reads as "no such awards" rather than a mismatched filter.
    const listings = input.assistance_listings?.length ? input.assistance_listings : undefined;
    if (listings && awardTypeCodes.some((code) => NON_ASSISTANCE_CODES.has(code))) {
      throw ctx.fail(
        'assistance_listings_type_mismatch',
        `assistance_listings match only assistance awards, but award_type_codes [${awardTypeCodes.join(', ')}] include contract or IDV codes, which carry no listings. award_type_codes defaults to contracts when omitted.`,
        ctx.recoveryFor('assistance_listings_type_mismatch'),
      );
    }

    // Upstream checks the sort against the group's field mapping and answers 400
    // outside it. Codes spanning groups skip the check: upstream's 422 decides.
    const group = resolveAwardTypeGroup(awardTypeCodes);
    const isLoan = group === AWARD_TYPE_GROUPS.loans;
    const sort = input.sort ?? (isLoan ? 'Loan Value' : 'Award Amount');
    if (group && !group.sorts.includes(sort)) {
      throw ctx.fail(
        'unsupported_sort',
        `Sort "${sort}" is not available for ${group.label} (award_type_codes ${awardTypeCodes.join(', ')}). Supported sorts for ${group.label}: ${group.sorts.join(', ')}.`,
        ctx.recoveryFor('unsupported_sort'),
      );
    }

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
    if (listings) filters.program_numbers = listings;
    if (timePeriod) {
      filters.time_period = [{ start_date: timePeriod.start_date, end_date: timePeriod.end_date }];
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
        fields: isLoan ? [...AWARD_SEARCH_FIELDS, ...LOAN_FIELDS] : AWARD_SEARCH_FIELDS,
        sort,
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
      ...(typeof r['Loan Value'] === 'number' ? { loan_value: r['Loan Value'] } : {}),
      ...(typeof r['Subsidy Cost'] === 'number' ? { subsidy_cost: r['Subsidy Cost'] } : {}),
      ...(r['Issued Date'] ? { issued_date: String(r['Issued Date']) } : {}),
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
    // Past a 10,000-result offset this endpoint keeps returning full pages while
    // reporting hasNext: false, so forwarding the flag verbatim ends pagination with
    // tens of thousands of matches still behind it. Page fullness is the honest signal.
    const hasNext = resolveHasNext(pageMeta.hasNext, results.length, input.limit);
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
      ...(listings ? { applied_assistance_listings: listings.join(', ') } : {}),
      ...(timePeriod
        ? {
            applied_time_period_start: timePeriod.start_date,
            applied_time_period_end: timePeriod.end_date,
          }
        : {}),
    });

    // enrich.notice is last-wins, and enrich.truncated writes the notice too, so
    // every notice source joins into one string written at the end.
    const notices: (string | undefined)[] = [];

    // Disclose page-based truncation: a capped page with more results behind has_next
    // (this endpoint returns no total, so the cap/shown pair is the honest signal).
    if (page_metadata.has_next) {
      const guidance = `More results may remain — request the next page, or chain last_record_sort_value + last_record_unique_id from page_metadata to page past the ${MAX_PAGE_OFFSET.toLocaleString()}-result page-number limit. The cursor pair stops being returned once page × limit reaches ${CURSOR_WINDOW_OFFSET.toLocaleString()}, so capture it before then; a short or empty page marks the true end.`;
      ctx.enrich.truncated({ shown: results.length, cap: input.limit, guidance });
      notices.push(guidance);
    }
    notices.push(filledBoundNotice(timePeriod, filledFields));

    if (results.length === 0) {
      const filterParts: string[] = [];
      if (keywords?.length) filterParts.push(`keyword="${keywords.join(', ')}"`);
      if (agencyName) filterParts.push(`agency="${agencyName}"`);
      if (listings) filterParts.push(`assistance_listings=${listings.join(',')}`);
      if (awardTypeCodes?.length) {
        filterParts.push(`types=${awardTypeCodes.join(',')}`);
      }
      notices.push(
        filterParts.length > 0
          ? `No awards matched: ${filterParts.join(', ')}. Try removing filters or broadening the date range.`
          : 'No awards matched your search. Try a different keyword or remove filters.',
      );
    }
    const notice = notices.filter(Boolean).join(' ');
    if (notice) ctx.enrich.notice(notice);

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
        lines.push(`**Amount:** ${formatCurrency(r.award_amount)}`);
      if (typeof r.total_outlays === 'number')
        lines.push(`**Outlays:** ${formatCurrency(r.total_outlays)}`);
      if (typeof r.loan_value === 'number')
        lines.push(`**Loan Value:** ${formatCurrency(r.loan_value)}`);
      if (typeof r.subsidy_cost === 'number')
        lines.push(`**Subsidy Cost:** ${formatCurrency(r.subsidy_cost)}`);
      if (r.issued_date) lines.push(`**Issued:** ${r.issued_date}`);
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
    if (result.page_metadata.has_next) {
      lines.push('');
      if (
        result.page_metadata.last_record_sort_value !== undefined &&
        result.page_metadata.last_record_unique_id !== undefined
      ) {
        lines.push(
          `**Next-page cursor:** last_record_sort_value=\`${result.page_metadata.last_record_sort_value}\`, last_record_unique_id=\`${result.page_metadata.last_record_unique_id}\` — pass both to page past the ${MAX_PAGE_OFFSET.toLocaleString()}-result limit.`,
        );
      } else {
        // The cursor is withheld both past the CURSOR_WINDOW_OFFSET boundary and on a
        // final page (the "None"/null sentinels), so this branch must not attribute its
        // absence to the boundary — it fires on any exactly-full last page too. And at
        // the MAX_PAGE_OFFSET cap there is no next page to direct to: the handler's own
        // pagination_limit_exceeded guard rejects it.
        const nextPage = result.page_metadata.page + 1;
        lines.push(
          nextPage * result.page_metadata.limit > MAX_PAGE_OFFSET
            ? `**No further pages reachable:** this page sits at the ${MAX_PAGE_OFFSET.toLocaleString()}-result page-number cap and no keyset cursor was returned, so nothing beyond it can be read. Narrow the filters to bring the result set inside the window.`
            : `**Next page:** request page ${nextPage}. No keyset cursor was returned for this page — the endpoint withholds the pair on a final page and on every page past a ${CURSOR_WINDOW_OFFSET.toLocaleString()}-result offset, so continue by page number; a short or empty page marks the true end.`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
