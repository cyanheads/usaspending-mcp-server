/**
 * @fileoverview Tool to fetch disaster and emergency supplemental spending
 * broken down by agency, CFDA program, recipient, or geography.
 * @module mcp-server/tools/definitions/disaster-spending.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import type {
  DisasterBreakdownRequest,
  RawDisasterBreakdownResponse,
  RawDisasterResult,
  RawDisasterTotals,
} from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { countLimit, LimitClampSchema, limitClampTrailer } from './count-limit.js';
import { CODE_FILTER_FIELDS, normalizeCodeFilters } from './filters.js';
import { formatCurrency } from './formatting.js';
import { emptyPageNotice, formatPaginationLine } from './pagination.js';

/**
 * The breakdown endpoints' page maximum. The same input pages the geography ranking,
 * which the upstream returns whole, so one cap serves every dimension.
 */
const LIMIT = countLimit({ tool: 'usaspending_disaster_spending', default: 10, cap: 100 });

/**
 * `disaster/recipient/spending/` reports this number as a ceiling, not a count.
 * Unrelated broad `def_codes` filters all land on exactly 10,000 while a narrow one
 * reports an honest count, and the set is saturated at that point: with broad COVID
 * codes the page at offset 9,900 comes back full with `hasNext: false` and the next page
 * is empty. Rows past the 10,000th are unreachable, and a caller reading the total has no
 * way to tell a cap from a count — hence the disclosure below.
 */
const RECIPIENT_TOTAL_CEILING = 10_000;

/**
 * Keeps the upstream breakdown totals that are real numbers. Members vary by
 * dimension and spending_type, and none is ever derived from the page of rows —
 * an absent or null member stays absent, and an empty set yields no totals.
 */
function mapTotals(totals: RawDisasterTotals | null | undefined) {
  if (!totals) return;
  const mapped = {
    ...(typeof totals.obligation === 'number' ? { obligation: totals.obligation } : {}),
    ...(typeof totals.outlay === 'number' ? { outlay: totals.outlay } : {}),
    ...(typeof totals.total_budgetary_resources === 'number'
      ? { total_budgetary_resources: totals.total_budgetary_resources }
      : {}),
    ...(typeof totals.award_count === 'number' ? { award_count: totals.award_count } : {}),
  };
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/**
 * One usable id per row. `disaster/recipient/spending/` sends an array of
 * recipient hash IDs (a child-level `-C` beside a recipient-level `-R`, for
 * one); the `-R` entry is what `usaspending_get_recipient` resolves, so it wins,
 * else the first entry. A scalar id passes through as a string.
 */
function rowId(id: RawDisasterResult['id']): string | undefined {
  if (Array.isArray(id)) {
    const ids = id.map(String);
    return ids.find((entry) => entry.endsWith('-R')) ?? ids[0];
  }
  return id == null ? undefined : String(id);
}

const ZERO_TOTAL_NOTICE =
  'No data found for the specified DEF codes and dimension. Try different DEF codes or another breakdown dimension — def_codes is required for all non-overview dimensions and cannot be removed.';

/** Amount scope is independent of which awards match the requested funding codes. */
function amountCoverage(codes: string[], supported: string[] | undefined) {
  if (supported === undefined) return { status: 'unknown' as const };
  const supported_def_codes = codes.filter((code) => supported.includes(code));
  const unsupported_def_codes = codes.filter((code) => !supported.includes(code));
  return {
    status:
      unsupported_def_codes.length === 0
        ? ('complete' as const)
        : supported_def_codes.length
          ? ('partial' as const)
          : ('unavailable' as const),
    supported_def_codes,
    unsupported_def_codes,
  };
}

/** Every displayed monetary field shares this scope; row membership and counts do not. */
const AMOUNT_COVERAGE_SCHEMA = z.object({
  status: z
    .enum(['complete', 'partial', 'unavailable', 'unknown'])
    .describe(
      'Coverage of requested DEF codes by monetary fields, not provider record completeness',
    ),
  supported_def_codes: z
    .array(z.string().describe('DEF code included in amounts'))
    .optional()
    .describe('Requested codes included in amounts; omitted when unknown'),
  unsupported_def_codes: z
    .array(z.string().describe('DEF code excluded from amounts'))
    .optional()
    .describe('Requested codes excluded from amounts; omitted when unknown'),
});

export const disasterSpendingTool = tool('usaspending_disaster_spending', {
  title: 'Disaster and Emergency Spending',
  description:
    'Fetch disaster and emergency supplemental spending broken down by agency, CFDA assistance program, recipient, or geography, or request an overview. Find DEF codes in usaspending_autocomplete_filters with type def_code. Filter by those codes to select emergency appropriations, then check amount_coverage before interpreting amounts: award breakdowns and geography cover the provider COVID grouping, while overview and agency total cover all requested codes. Rows and award counts can match codes outside the monetary scope.',
  annotations: { readOnlyHint: true, openWorldHint: true, idempotentHint: true },

  input: z.object({
    dimension: z
      .enum(['overview', 'agency', 'cfda', 'recipient', 'geography'])
      .describe(
        'Breakdown axis: overview (top-level totals and DEF code funding), agency (by awarding agency), cfda (by assistance program), recipient (by recipient), geography (by state/county)',
      ),
    spending_type: z
      .enum(['award', 'total'])
      .default('award')
      .describe(
        'Data type for the agency dimension: award (award-level obligations and outlays) or total (includes direct non-award spending, plus total budgetary resources). Ignored for cfda, recipient, and overview, which report award-level amounts either way; the geography dimension is not user-controllable and always reports obligation-based amounts.',
      ),
    filters: z
      .object({
        def_codes: CODE_FILTER_FIELDS.def_codes.describe(
          'DEF codes, 1–3 letters or digits, sent uppercased. Optional for overview; required for breakdowns. Amount coverage is reported separately: award breakdowns and geography aggregate only the provider COVID grouping; matching rows and counts may include other codes. Overview and agency total cover all requested codes. Find codes in usaspending_autocomplete_filters with type def_code.',
        ),
        award_type_codes: z.array(z.string()).optional().describe('Award type code filters'),
        query: z
          .string()
          .optional()
          .describe(
            'Recipient search text, trimmed before sending. Omitted or blank means no query filter. Ignored with a notice on other dimensions.',
          ),
        geo_layer: z
          .enum(['state', 'county'])
          .optional()
          .describe('Geographic layer for geography dimension (state or county)'),
      })
      .strict()
      .optional()
      .describe(
        'Filters — def_codes is required for all non-overview dimensions (agency, cfda, recipient, geography)',
      ),
    limit: LIMIT.schema.describe(
      'Results per page. Default 10, at most 100 per call. Breakdowns rank obligations descending before pagination; geography ranks aggregated_amount. Agency award without award_type_codes collects all provider pages before ranking, so a smaller limit does not reduce that upstream work. Ignored for overview.',
    ),
    page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
  }),

  // Agent-facing context: the dimension applied and pagination for non-overview dimensions.
  enrichment: {
    applied_dimension: z.string().describe('Breakdown dimension applied'),
    applied_def_codes: z.string().optional().describe('DEF codes applied (comma-separated)'),
    applied_query: z.string().optional().describe('Trimmed recipient query sent upstream'),
    totalCount: z
      .number()
      .optional()
      .describe('Total items for paginated dimensions (when available)'),
    current_page: z.number().optional().describe('Current page (non-overview dimensions)'),
    has_next_page: z.boolean().optional().describe('Whether there are more pages'),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'recipient: true when the upstream capped the reachable result set rather than counting it. geography: true when more areas rank below this page.',
      ),
    shown: z.number().optional().describe('Number of results returned on this page.'),
    cap: z
      .number()
      .optional()
      .describe(
        'recipient: the result-set ceiling the upstream applied. geography: the page size (limit).',
      ),
    truncationCeiling: z
      .number()
      .optional()
      .describe(
        'geography: the lowest aggregated_amount on this page within amount_coverage — no area on a later page has a higher reported value.',
      ),
    limitClamp: LimitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Upstream messages, ignored filters, a reduced limit, empty-page recovery, and guidance for recipient ceilings or remaining geography areas.',
      ),
  },

  output: z.object({
    amount_coverage: AMOUNT_COVERAGE_SCHEMA.optional().describe(
      'Scope of all monetary fields, including geography amounts/per-capita and totals; independent of row membership and counts',
    ),
    dimension: z.string().describe('Breakdown dimension returned'),
    spending_type: z
      .string()
      .describe(
        'Data type returned — award/total for agency; the requested value echoed for cfda and recipient, whose amounts do not vary with it; obligation for geography; spending for overview',
      ),
    overview: z
      .object({
        total_budget_authority: z
          .number()
          .optional()
          .describe('Total budget authority in USD across all emergency supplementals'),
        award_obligations: z.number().optional().describe('Total award obligations in USD'),
        award_outlays: z.number().optional().describe('Total award outlays in USD'),
        face_value_of_loans: z.number().optional().describe('Face value of loan guarantees in USD'),
        total_obligations: z.number().optional().describe('Total obligations in USD'),
        total_outlays: z.number().optional().describe('Total outlays in USD'),
        unobligated_balance: z.number().optional().describe('Unobligated balance in USD'),
        funding_by_def_code: z
          .array(
            z
              .object({
                def_code: z.string().optional().describe('DEF code'),
                amount: z.number().optional().describe('Funding amount in USD for this DEF code'),
                label: z.string().optional().describe('DEF code label or title'),
                public_law: z.string().optional().describe('Public law number'),
              })
              .describe('DEF code funding entry with amount and public law reference'),
          )
          .optional()
          .describe('Funding amounts broken down by DEF code (emergency appropriation)'),
      })
      .optional()
      .describe('Top-level overview totals (dimension=overview only)'),
    totals: z
      .object({
        obligation: z
          .number()
          .optional()
          .describe('Obligations in USD across the matching result set, within amount_coverage'),
        outlay: z
          .number()
          .optional()
          .describe('Outlays in USD across the matching result set, within amount_coverage'),
        total_budgetary_resources: z
          .number()
          .optional()
          .describe(
            'Total budgetary resources in USD across the result set (agency dimension with spending_type total)',
          ),
        award_count: z
          .number()
          .optional()
          .describe('Number of awards across the result set (award-level breakdowns)'),
      })
      .optional()
      .describe(
        'Totals across every matching row, as reported upstream — not a sum of this page. Present for the agency, cfda, and recipient dimensions; the members depend on dimension and spending_type. Absent for overview and geography.',
      ),
    results: z
      .array(
        z
          .object({
            id: z
              .string()
              .optional()
              .describe(
                'Item ID. On the recipient dimension, a recipient hash ID for usaspending_get_recipient — the recipient-level (-R) ID when the recipient has several.',
              ),
            code: z.string().optional().describe('Code (agency code, CFDA number, DEF code, etc.)'),
            name: z.string().optional().describe('Item name or description'),
            obligation: z.number().optional().describe('Obligation amount in USD'),
            outlay: z.number().optional().describe('Outlay amount in USD'),
            total_budgetary_resources: z
              .number()
              .optional()
              .describe(
                'Total budgetary resources in USD for this row (agency dimension with spending_type total)',
              ),
            award_count: z.number().optional().describe('Number of awards'),
            face_value_of_loan: z
              .number()
              .optional()
              .describe('Face value of loan guarantees in USD (loans spending_type)'),
            shape_code: z
              .string()
              .optional()
              .describe(
                'Geographic code (geography dimension). Absent on the unattributed row: spending with no recorded place of performance, which still ranks and counts as an area.',
              ),
            display_name: z
              .string()
              .optional()
              .describe(
                'Geographic display name (geography dimension); absent on the unattributed row',
              ),
            aggregated_amount: z
              .number()
              .optional()
              .describe('Obligation-based spending amount in USD (geography dimension)'),
            population: z
              .number()
              .optional()
              .describe('Population of the geographic area (geography dimension)'),
            per_capita: z
              .number()
              .optional()
              .describe('Obligation-based spending per capita in USD (geography dimension)'),
          })
          .describe(
            'Disaster spending breakdown entry by dimension (agency, CFDA, recipient, or geography)',
          ),
      )
      .describe('Breakdown results (empty for overview dimension)'),
    page_metadata: z
      .object({
        has_next: z.boolean().describe('Whether there are more pages'),
        page: z.number().describe('Current page'),
        total: z.number().optional().describe('Total items'),
        limit: z.number().describe('Items per page'),
      })
      .optional()
      .describe('Pagination metadata (non-overview dimensions)'),
  }),

  enrichmentTrailer: {
    limitClamp: limitClampTrailer,
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
  },

  errors: [
    {
      reason: 'missing_def_codes',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A non-overview dimension has no DEF codes.',
      retryable: false,
      recovery:
        'Find codes in usaspending_autocomplete_filters with type def_code. Provide at least one code in filters.def_codes, or use dimension "overview" without codes.',
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
        'By dimension — agency award without filters.award_type_codes: pass fewer filters.def_codes or retry later; all provider pages must be collected before ranking, so a smaller limit does not reduce that work. agency total, agency award with filters.award_type_codes, cfda, recipient: pass fewer filters.def_codes or a smaller limit, then retry. geography: pass fewer filters.def_codes, then retry. overview: narrow with optional filters.def_codes; filtered requests can still time out, so retry later, or call dimension "agency" with filters.def_codes (e.g. ["L"]), spending_type "total", and limit 100 for per-agency obligations and outlays plus overall totals.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_disaster_spending', {
      dimension: input.dimension,
      spending_type: input.spending_type,
    });

    if (input.dimension !== 'overview' && !input.filters?.def_codes?.length) {
      throw ctx.fail(
        'missing_def_codes',
        `def_codes is required when dimension is "${input.dimension}". Provide at least one DEF code in filters.def_codes (e.g., ["L", "M", "N", "O", "P"] for COVID-19). Find codes in usaspending_autocomplete_filters with type def_code.`,
        { dimension: input.dimension, missing_field: 'filters.def_codes' },
      );
    }

    const svc = getUSASpendingService();
    const deadlineAt = svc.disasterDeadline();
    const defCodes = normalizeCodeFilters({ def_codes: input.filters?.def_codes }).def_codes;
    const notices: string[] = [];
    const query = input.filters?.query?.trim();
    const ignoredFilters: string[] = [];
    if (query && input.dimension !== 'recipient') ignoredFilters.push('filters.query');
    if (input.filters?.geo_layer && input.dimension !== 'geography')
      ignoredFilters.push('filters.geo_layer');
    if (input.filters?.award_type_codes?.length && input.dimension === 'overview')
      ignoredFilters.push('filters.award_type_codes');
    if (ignoredFilters.length)
      notices.push(`Ignored for dimension "${input.dimension}": ${ignoredFilters.join(', ')}.`);
    if (defCodes?.length) ctx.enrich({ applied_def_codes: defCodes.join(', ') });
    if (query && input.dimension === 'recipient') ctx.enrich({ applied_query: query });

    const baseBody: Record<string, unknown> = {};
    const filterBody: Record<string, unknown> = {};
    if (defCodes?.length) filterBody.def_codes = defCodes;
    if (input.filters?.award_type_codes?.length)
      filterBody.award_type_codes = input.filters.award_type_codes;
    if (query && input.dimension === 'recipient') filterBody.query = query;
    if (Object.keys(filterBody).length > 0) baseBody.filter = filterBody;

    if (input.dimension === 'overview') {
      const data = await svc.getDisasterOverview(ctx, defCodes);
      const funding = (data.funding ?? []).map((f) => ({
        ...(f.def_code ? { def_code: f.def_code } : {}),
        ...(typeof f.amount === 'number' ? { amount: f.amount } : {}),
        ...(f.label ? { label: f.label } : {}),
        ...(f.public_law ? { public_law: f.public_law } : {}),
      }));
      const spending = data.spending ?? {};
      ctx.enrich({ applied_dimension: 'overview' });
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      return {
        dimension: 'overview',
        amount_coverage: {
          status: 'complete' as const,
          ...(defCodes ? { supported_def_codes: defCodes, unsupported_def_codes: [] } : {}),
        },
        spending_type: 'spending',
        overview: {
          ...(typeof data.total_budget_authority === 'number'
            ? { total_budget_authority: data.total_budget_authority }
            : {}),
          ...(typeof spending.award_obligations === 'number'
            ? { award_obligations: spending.award_obligations }
            : {}),
          ...(typeof spending.award_outlays === 'number'
            ? { award_outlays: spending.award_outlays }
            : {}),
          ...(typeof spending.face_value_of_loans === 'number'
            ? { face_value_of_loans: spending.face_value_of_loans }
            : {}),
          ...(typeof spending.total_obligations === 'number'
            ? { total_obligations: spending.total_obligations }
            : {}),
          ...(typeof spending.total_outlays === 'number'
            ? { total_outlays: spending.total_outlays }
            : {}),
          ...(typeof spending.unobligated_balance === 'number'
            ? { unobligated_balance: spending.unobligated_balance }
            : {}),
          ...(funding.length > 0 ? { funding_by_def_code: funding } : {}),
        },
        results: [],
      };
    }

    // Overview, returned above, ignores limit, so only paged dimensions clamp it.
    const limit = LIMIT.apply(ctx, 'limit', input.limit);
    if (limit.notice) notices.push(limit.notice);

    // Disaster breakdown endpoints require pagination nested under a `pagination` key;
    // top-level limit/page are silently ignored (upstream always returns its default page).
    const paginationBody: DisasterBreakdownRequest = {
      ...baseBody,
      pagination: { page: input.page, limit: limit.applied, sort: 'obligation', order: 'desc' },
    };

    const coverageForBreakdown = async () => {
      const coverage = amountCoverage(
        defCodes ?? [],
        input.dimension === 'agency' && input.spending_type === 'total'
          ? defCodes
          : await svc.getDisasterAmountCodes(ctx, deadlineAt),
      );
      if (coverage.status !== 'complete') {
        const scope =
          coverage.status === 'unknown'
            ? 'The DEF reference is unavailable; monetary coverage is unknown.'
            : coverage.status === 'unavailable'
              ? 'Amounts are unavailable for the requested DEF codes; retained zeros are not evidence of zero actual spending.'
              : 'Amounts cover only the supported COVID DEF codes; other requested codes are excluded from monetary values.';
        notices.push(
          `${scope} Row membership and award counts can cover more codes than amounts. This scope applies to obligations, outlays, totals and derived geography amounts/per-capita. Use agency spending_type total for all-code financial activity, or general category/geography DEF filters for whole matching award amounts, not DEF-funded shares.`,
        );
      }
      return coverage;
    };

    let rawResults: RawDisasterBreakdownResponse;

    if (input.dimension === 'agency') {
      rawResults = await svc.getDisasterByAgency(
        input.spending_type,
        paginationBody,
        ctx,
        deadlineAt,
      );
    } else if (input.dimension === 'cfda') {
      rawResults = await svc.getDisasterByCfda(paginationBody, ctx, deadlineAt);
    } else if (input.dimension === 'recipient') {
      rawResults = await svc.getDisasterByRecipient(
        input.spending_type,
        paginationBody,
        ctx,
        deadlineAt,
      );
    } else {
      /**
       * geography — this endpoint requires a spending_type from a vocabulary distinct from
       * the breakdown dimensions (obligation | outlay | face_value_of_loan); omitting it
       * returns HTTP 422. Default to obligation — total obligated dollars, the comparable
       * default measure — and report that as the effective spending_type.
       */
      const geoSpendingType = 'obligation';
      const geoBody = {
        ...baseBody,
        geo_layer: input.filters?.geo_layer ?? 'state',
        scope: 'place_of_performance',
        spending_type: geoSpendingType,
      };
      const data = await svc.getDisasterByGeography(geoBody, ctx, deadlineAt);
      const coverage = await coverageForBreakdown();
      const areas = (data.results ?? []).map((r) => ({
        ...(r.shape_code ? { shape_code: r.shape_code } : {}),
        ...(r.display_name ? { display_name: r.display_name } : {}),
        ...(typeof r.amount === 'number' ? { aggregated_amount: r.amount } : {}),
        ...(typeof r.award_count === 'number' ? { award_count: r.award_count } : {}),
        ...(typeof r.population === 'number' ? { population: r.population } : {}),
        ...(typeof r.per_capita === 'number' ? { per_capita: r.per_capita } : {}),
      }));
      /**
       * The endpoint is not paginated: it returns every area whatever paging the request
       * carries, so the page is ranked and sliced here. The unattributed row (no
       * shape_code) stays in the ranking and the count; a code sorts before it on a tie.
       */
      areas.sort(
        (a, b) =>
          (b.aggregated_amount ?? 0) - (a.aggregated_amount ?? 0) ||
          (a.shape_code === undefined ? 1 : 0) - (b.shape_code === undefined ? 1 : 0) ||
          (a.shape_code ?? '').localeCompare(b.shape_code ?? ''),
      );
      const total = areas.length;
      const start = (input.page - 1) * limit.applied;
      const pageAreas = areas.slice(start, start + limit.applied);
      const hasNext = input.page * limit.applied < total;

      ctx.enrich.total(total);
      ctx.enrich({
        applied_dimension: 'geography',
        current_page: input.page,
        has_next_page: hasNext,
      });
      if (hasNext) {
        const ceiling = pageAreas.at(-1)?.aggregated_amount;
        notices.push(
          `${(total - input.page * limit.applied).toLocaleString()} more of ${total.toLocaleString()} areas rank below this page${ceiling !== undefined ? `, none above ${formatCurrency(ceiling)} in the reported amount scope` : ''}. Request page ${input.page + 1} to continue${limit.applied < LIMIT.cap ? `, or raise limit (max ${LIMIT.cap})` : ''}.`,
        );
        ctx.enrich.truncated({
          shown: pageAreas.length,
          cap: limit.applied,
          ...(ceiling !== undefined ? { ceiling } : {}),
          guidance: notices.join(' '),
        });
      }
      if (pageAreas.length === 0)
        notices.push(emptyPageNotice(input.page, limit.applied, total, ZERO_TOTAL_NOTICE));
      if (notices.length) ctx.enrich.notice(notices.join(' '));
      return {
        dimension: 'geography',
        amount_coverage: coverage,
        spending_type: geoSpendingType,
        results: pageAreas,
        page_metadata: { has_next: hasNext, page: input.page, total, limit: limit.applied },
      };
    }

    const coverage = await coverageForBreakdown();
    const results = (rawResults.results ?? []).map((r) => ({
      ...(rowId(r.id) !== undefined ? { id: rowId(r.id) } : {}),
      ...(r.code ? { code: r.code } : {}),
      ...(r.name || r.description ? { name: r.name ?? r.description ?? undefined } : {}),
      ...(typeof r.obligation === 'number' ? { obligation: r.obligation } : {}),
      ...(typeof r.outlay === 'number' ? { outlay: r.outlay } : {}),
      ...(typeof r.total_budgetary_resources === 'number'
        ? { total_budgetary_resources: r.total_budgetary_resources }
        : {}),
      ...(typeof r.award_count === 'number' ? { award_count: r.award_count } : {}),
      ...(typeof r.face_value_of_loan === 'number'
        ? { face_value_of_loan: r.face_value_of_loan }
        : {}),
    }));
    const totals = mapTotals(rawResults.totals);

    const pageMeta = rawResults.page_metadata ?? {};
    /**
     * Direct read, verified: the agency, cfda, and recipient breakdown endpoints were
     * each paged to the end of a real result set and reported `hasNext` truthfully at
     * every boundary — interior full page, exactly-full final page, and the empty page
     * past it. Routing through `resolveHasNext()` would report a wrong `has_next: true`
     * on any result set whose size is an exact multiple of `limit`.
     */
    const hasNext = pageMeta.hasNext ?? false;
    const currentPage = pageMeta.page ?? input.page;
    if (typeof pageMeta.total === 'number') ctx.enrich.total(pageMeta.total);
    ctx.enrich({
      applied_dimension: input.dimension,
      current_page: currentPage,
      has_next_page: hasNext,
    });

    if (input.dimension === 'recipient' && pageMeta.total === RECIPIENT_TOTAL_CEILING) {
      const ceiling = RECIPIENT_TOTAL_CEILING.toLocaleString();
      notices.push(
        `The recipient breakdown caps its reachable result set at ${ceiling} and reports that ceiling as the total. It is a lower bound on possible matches, not an exact count — recipients past the ${ceiling}th cannot be paged to. Narrow with filters.query, or fewer filters.def_codes, to bring the result set below the ceiling and get a countable total.`,
      );
      ctx.enrich.truncated({
        shown: results.length,
        cap: RECIPIENT_TOTAL_CEILING,
        guidance: notices.join(' '),
      });
    }
    notices.push(...(rawResults.messages ?? []));
    if (results.length === 0)
      notices.push(emptyPageNotice(currentPage, limit.applied, pageMeta.total, ZERO_TOTAL_NOTICE));
    if (notices.length) ctx.enrich.notice(notices.join(' '));

    return {
      dimension: input.dimension,
      amount_coverage: coverage,
      spending_type: input.spending_type,
      ...(totals ? { totals } : {}),
      results,
      page_metadata: {
        has_next: hasNext,
        page: currentPage,
        ...(typeof pageMeta.total === 'number' ? { total: pageMeta.total } : {}),
        limit: limit.applied,
      },
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Disaster/Emergency Spending — ${escapeMarkdownInline(result.dimension)}${result.spending_type !== 'spending' ? ` (${escapeMarkdownInline(result.spending_type)})` : ''}`,
    ];
    if (result.amount_coverage) {
      const coverage = result.amount_coverage;
      lines.push(
        `**Amount coverage:** ${coverage.status} (monetary fields only; row membership and counts have separate scope).`,
      );
      if (coverage.supported_def_codes)
        lines.push(
          `**Supported DEF codes:** ${coverage.supported_def_codes.map(escapeMarkdownInline).join(', ') || '(none)'}`,
        );
      if (coverage.unsupported_def_codes)
        lines.push(
          `**Unsupported DEF codes:** ${coverage.unsupported_def_codes.map(escapeMarkdownInline).join(', ') || '(none)'}`,
        );
    }

    if (result.overview) {
      const o = result.overview;
      if (o.total_budget_authority !== undefined)
        lines.push(`**Total Budget Authority:** ${formatCurrency(o.total_budget_authority)}`);
      if (o.total_obligations !== undefined)
        lines.push(`**Total Obligations:** ${formatCurrency(o.total_obligations)}`);
      if (o.total_outlays !== undefined)
        lines.push(`**Total Outlays:** ${formatCurrency(o.total_outlays)}`);
      if (o.award_obligations !== undefined)
        lines.push(`**Award Obligations:** ${formatCurrency(o.award_obligations)}`);
      if (o.award_outlays !== undefined)
        lines.push(`**Award Outlays:** ${formatCurrency(o.award_outlays)}`);
      if (o.face_value_of_loans !== undefined)
        lines.push(`**Face Value of Loans:** ${formatCurrency(o.face_value_of_loans)}`);
      if (o.unobligated_balance !== undefined)
        lines.push(`**Unobligated Balance:** ${formatCurrency(o.unobligated_balance)}`);

      if (o.funding_by_def_code?.length) {
        lines.push('\n### Funding by DEF Code');
        for (const f of o.funding_by_def_code) {
          const amt = f.amount !== undefined ? formatCurrency(f.amount) : 'N/A';
          lines.push(
            `- **${escapeMarkdownInline(f.def_code ?? 'N/A')}** — ${escapeMarkdownInline(f.label ?? 'N/A')} (${escapeMarkdownInline(f.public_law ?? 'N/A')}): ${amt}`,
          );
        }
      }
    }

    if (result.totals) {
      const t = result.totals;
      const parts = [
        t.obligation !== undefined ? `Obligation ${formatCurrency(t.obligation)}` : undefined,
        t.outlay !== undefined ? `Outlay ${formatCurrency(t.outlay)}` : undefined,
        t.total_budgetary_resources !== undefined
          ? `Budgetary Resources ${formatCurrency(t.total_budgetary_resources)}`
          : undefined,
        t.award_count !== undefined ? `Awards ${t.award_count.toLocaleString()}` : undefined,
      ].filter(Boolean);
      lines.push(`**Totals:** ${parts.join(' · ')} _(all matching rows, not this page)_`);
    }

    if (result.page_metadata) {
      lines.push(formatPaginationLine(result.page_metadata));
    }

    if (result.results.length > 0) {
      // Only the agency breakdown under spending_type total carries per-row budgetary
      // resources; elsewhere the column would be all N/A.
      const showBudgetary = result.results.some((r) => r.total_budgetary_resources !== undefined);
      lines.push('');
      lines.push(
        `| Name/Display | ID | Code | Shape | Obligation | Outlay |${showBudgetary ? ' Budgetary Resources |' : ''} Aggregated | Population | Per Capita | Loans | Awards |`,
      );
      lines.push(
        `|:-------------|:---|:-----|:------|:-----------|:-------|${showBudgetary ? ':--------------------|' : ''}:-----------|:-----------|:-----------|:------|:-------|`,
      );
      for (const r of result.results) {
        const label =
          result.dimension === 'geography' && r.shape_code === undefined
            ? 'Unattributed (no place of performance recorded)'
            : r.display_name && r.name && r.display_name !== r.name
              ? `${r.display_name} (${r.name})`
              : (r.display_name ?? r.name ?? 'N/A');
        const id = r.id ?? 'N/A';
        const code = r.code ?? 'N/A';
        const shape = r.shape_code ?? 'N/A';
        const oblig = r.obligation !== undefined ? formatCurrency(r.obligation) : 'N/A';
        const outlay = r.outlay !== undefined ? formatCurrency(r.outlay) : 'N/A';
        const budgetary = showBudgetary
          ? ` ${r.total_budgetary_resources !== undefined ? formatCurrency(r.total_budgetary_resources) : 'N/A'} |`
          : '';
        const agg = r.aggregated_amount !== undefined ? formatCurrency(r.aggregated_amount) : 'N/A';
        const population = r.population !== undefined ? r.population.toLocaleString() : 'N/A';
        const perCapita = r.per_capita !== undefined ? formatCurrency(r.per_capita) : 'N/A';
        const loans =
          r.face_value_of_loan !== undefined ? formatCurrency(r.face_value_of_loan) : 'N/A';
        const awards = r.award_count !== undefined ? String(r.award_count) : 'N/A';
        lines.push(
          `| ${escapeMarkdownInline(label)} | ${escapeMarkdownInline(id)} | ${escapeMarkdownInline(code)} | ${escapeMarkdownInline(shape)} | ${oblig} | ${outlay} |${budgetary} ${agg} | ${population} | ${perCapita} | ${loans} | ${awards} |`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
