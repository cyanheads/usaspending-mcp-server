/**
 * @fileoverview Tool to fetch an agency's overview, budget data, and sub-agency breakdown.
 * @module mcp-server/tools/definitions/get-agency.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdownLink } from '@cyanheads/mcp-ts-core/utils';
import type { RawBudgetaryResources } from '@/services/usaspending/types.js';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatCurrency } from './formatting.js';
import { formatPaginationLine } from './pagination.js';

/** Sub-agency breakdown page size (the endpoint's natural page cap). */
const SUB_AGENCY_PAGE_LIMIT = 10;

/**
 * How long the sub-agency request waits for the budget year before falling back to
 * upstream's default year. `budgetary_resources/` answered in 0.2–2.8 s across
 * agencies 014, 097, 012, and 075; the cap bounds the worst case at roughly this
 * plus one request budget instead of two request budgets back to back. A budget
 * answer past the cap leaves the breakdown on upstream's default year, which
 * `sub_agency_fiscal_year` discloses.
 */
const BUDGET_YEAR_WAIT_MS = 5_000;

const UnavailableSectionSchema = z
  .object({
    section: z
      .enum(['budgetary_resources', 'sub_agencies'])
      .describe(
        'budgetary_resources: fiscal_year and the budget, obligation, and outlay totals. sub_agencies: the sub-agency breakdown and its pagination.',
      ),
    reason: z
      .enum(['api_unavailable', 'api_timeout', 'upstream_error'])
      .describe(
        'api_unavailable: USAspending was unreachable or answered with a server error. api_timeout: no answer before the request deadline. upstream_error: USAspending rejected the request.',
      ),
    retryable: z.boolean().describe('Whether retrying the call may load this section.'),
    message: z.string().describe('The failure message for this section.'),
  })
  .describe('A section omitted from the result because its request failed');

type UnavailableSection = z.infer<typeof UnavailableSectionSchema>;

/**
 * The budget row the totals report: the most recent fiscal year carrying at least one
 * amount. A new fiscal year opens with a row whose amounts are all null until the
 * agency first reports, so that row is skipped; a 0 is data.
 */
function selectBudgetRow(rows: RawBudgetaryResources[] | undefined) {
  return [...(rows ?? [])]
    .sort((a, b) => (b.fiscal_year ?? 0) - (a.fiscal_year ?? 0))
    .find((row) =>
      [row.agency_budgetary_resources, row.agency_total_obligated, row.agency_total_outlayed].some(
        (amount) => typeof amount === 'number',
      ),
    );
}

export const getAgencyTool = tool('usaspending_get_agency', {
  title: 'Get Agency Overview',
  description:
    "Fetch an agency's fiscal-year overview including mission, budgetary resources, obligation and outlay totals (for the most recent fiscal year with reported budget data), sub-agency count, and DEF codes for disaster/emergency funding. Also returns a paginated sub-agency breakdown with obligation and transaction counts for the same fiscal year as the budget totals (the current fiscal year when no budget year is available within 5 seconds); sub_agency_fiscal_year names the year it covers. Accepts exactly one of a 3-digit toptier_code (e.g., 097 for DoD, 012 for Agriculture) or an agency_slug (e.g., department-of-defense) — both appear in usaspending_list_agencies results and award search results. When the budget or sub-agency request fails, the overview is still returned and unavailable_sections names each missing section with its reason.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    toptier_code: z
      .string()
      .optional()
      .describe(
        '3-digit toptier agency code (e.g., 097, 012) — from usaspending_list_agencies. Use either toptier_code or agency_slug, not both.',
      ),
    agency_slug: z
      .string()
      .optional()
      .describe(
        'URL-friendly agency slug (e.g., department-of-defense) — from usaspending_list_agencies or award search results. Use either toptier_code or agency_slug, not both.',
      ),
    page: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe(
        'Sub-agency breakdown page (1-based, 10 per page). Use with sub_agency_page_metadata.has_next to page through the full list.',
      ),
  }),

  output: z.object({
    name: z.string().optional().describe('Agency full name'),
    abbreviation: z.string().optional().describe('Agency abbreviation'),
    toptier_code: z.string().optional().describe('3-digit toptier agency code'),
    agency_id: z.number().optional().describe('Internal agency ID'),
    mission: z.string().optional().describe('Agency mission statement'),
    fiscal_year: z
      .number()
      .optional()
      .describe(
        'Fiscal year the budgetary totals below reflect: the most recent year with reported budget data, which can trail the current fiscal year (a new year has no amounts until the agency first reports in it)',
      ),
    budgetary_resources_amount: z
      .number()
      .optional()
      .describe('Total budgetary resources in USD for the fiscal year'),
    obligated_amount: z
      .number()
      .optional()
      .describe('Total amount obligated in USD for the fiscal year'),
    outlay_amount: z.number().optional().describe('Total outlays in USD for the fiscal year'),
    subtier_agency_count: z
      .number()
      .optional()
      .describe('Number of sub-agencies within this toptier agency'),
    sub_agencies: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Sub-agency name'),
            abbreviation: z.string().optional().describe('Sub-agency abbreviation'),
            total_obligations: z.number().optional().describe('Sub-agency obligation total in USD'),
            transaction_count: z.number().optional().describe('Sub-agency transaction count'),
            new_award_count: z.number().optional().describe('New awards count'),
          })
          .describe('Sub-agency entry with obligations and transaction counts'),
      )
      .optional()
      .describe('Sub-agency breakdown within this toptier agency (one page)'),
    sub_agency_fiscal_year: z
      .number()
      .optional()
      .describe(
        'Fiscal year the sub-agency breakdown covers, as upstream reports it: the same year as fiscal_year, or the current fiscal year when no budget year was available within 5 seconds — so it can differ from fiscal_year even when both are present. Absent when the sub-agency request failed, or when upstream reports no year for a breakdown requested without one.',
      ),
    sub_agency_page_metadata: z
      .object({
        total: z.number().optional().describe('Total sub-agencies across all pages'),
        page: z.number().describe('Current sub-agency page number'),
        has_next: z.boolean().describe('Whether more sub-agency pages are available'),
        limit: z.number().describe('Sub-agencies per page'),
      })
      .optional()
      .describe('Pagination metadata for the sub-agency breakdown'),
    def_codes: z
      .array(
        z
          .object({
            code: z.string().optional().describe('DEF code identifying an emergency supplemental'),
            public_law: z.string().optional().describe('Public law number'),
            title: z.string().optional().describe('Emergency or disaster title'),
          })
          .describe('DEF code entry with public law and title'),
      )
      .optional()
      .describe('Disaster/Emergency Funding (DEF) codes applicable to this agency'),
    website: z.string().optional().describe('Agency website URL'),
  }),

  // Agent-facing context: sub-agency pagination state, truncation guidance, and failed sections.
  enrichment: {
    sub_agency_page: z
      .number()
      .optional()
      .describe('Current sub-agency page returned. Absent when the sub-agency request failed.'),
    has_more_sub_agencies: z
      .boolean()
      .optional()
      .describe(
        'Whether more sub-agency pages are available. Absent when the sub-agency request failed, since pagination is then unknown.',
      ),
    sub_agency_total: z
      .number()
      .optional()
      .describe('Total sub-agencies across all pages (when available)'),
    unavailable_sections: z
      .array(UnavailableSectionSchema)
      .optional()
      .describe(
        'Sections omitted because their request failed while the agency overview loaded. Absent when every section loaded.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'How to page for more sub-agencies when the breakdown is truncated, and which sections failed to load and whether a retry may recover them. Absent when neither applies.',
      ),
  },

  enrichmentTrailer: {
    notice: { render: (notice) => (notice ? `> ${escapeMarkdownInline(notice)}` : '') },
    unavailable_sections: {
      render: (sections) =>
        [
          '**Unavailable sections:**',
          ...(sections ?? []).map(
            (s) =>
              `- ${escapeMarkdownInline(s.section)}: ${escapeMarkdownInline(s.reason)}${s.retryable ? ' (retryable)' : ''} — ${escapeMarkdownInline(s.message)}`,
          ),
        ].join('\n'),
    },
  },

  errors: [
    {
      reason: 'agency_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No agency found for the given toptier_code or agency_slug.',
      recovery:
        'Use usaspending_list_agencies to browse available agencies and find the correct code or slug.',
    },
    {
      reason: 'missing_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither toptier_code nor agency_slug was provided.',
      recovery:
        'Provide either a toptier_code (e.g., 097) or agency_slug (e.g., department-of-defense) — usaspending_list_agencies lists both.',
    },
    {
      reason: 'conflicting_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Both toptier_code and agency_slug were provided.',
      recovery:
        'Send exactly one identifier: a toptier_code (e.g., 097) or agency_slug (e.g., department-of-defense), not both.',
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
        'Retry the request after a few seconds; USAspending did not answer the agency lookup in time.',
    },
  ],

  async handler(input, ctx) {
    if (!input.toptier_code?.trim() && !input.agency_slug?.trim()) {
      throw ctx.fail('missing_input', 'Either toptier_code or agency_slug is required');
    }
    if (input.toptier_code?.trim() && input.agency_slug?.trim()) {
      throw ctx.fail('conflicting_input', 'Received both toptier_code and agency_slug');
    }

    const svc = getUSASpendingService();
    let toptierCode = input.toptier_code?.trim();

    // Resolve slug → toptier_code if needed
    if (!toptierCode && input.agency_slug?.trim()) {
      const slug = input.agency_slug.trim().toLowerCase();
      ctx.log.info('usaspending_get_agency resolving slug', { slug });
      const agencies = await svc.listAgencies({}, ctx);
      const match = (agencies.results ?? []).find(
        (a) =>
          a.agency_slug?.toLowerCase() === slug ||
          a.agency_name?.toLowerCase().replace(/\s+/g, '-') === slug,
      );
      if (!match?.toptier_code) {
        throw ctx.fail('agency_not_found', `No agency found with slug: ${input.agency_slug}`);
      }
      toptierCode = match.toptier_code;
    }

    ctx.log.info('usaspending_get_agency', { toptier_code: toptierCode });
    if (!toptierCode) {
      throw ctx.fail('missing_input', 'Either toptier_code or agency_slug is required');
    }
    const code = toptierCode;
    const budgetRequest = svc.getAgencyBudgetaryResources(code, ctx);
    /**
     * The breakdown waits on the budget so it covers the same fiscal year as the totals,
     * by the same rule on every page. Without a budget year — the request failed, no
     * year carries data, or no answer inside BUDGET_YEAR_WAIT_MS — upstream's default
     * (current) year is used, and sub_agency_fiscal_year discloses it. The budget
     * request keeps running for the totals either way. Cancellation during the wait
     * stops the chain before the sub-agency request is issued.
     */
    const budgetYear = new Promise<number | undefined>((resolve, reject) => {
      const timer = setTimeout(() => resolve(undefined), BUDGET_YEAR_WAIT_MS);
      budgetRequest.then(
        (budget) => {
          clearTimeout(timer);
          resolve(selectBudgetRow(budget.agency_data_by_year)?.fiscal_year ?? undefined);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (ctx.signal.aborted) reject(err);
          else resolve(undefined);
        },
      );
    });
    const subRequest = budgetYear.then(async (fiscalYear) => ({
      requestedYear: fiscalYear,
      page: await svc.getAgencySubAgencies(
        code,
        {
          page: input.page,
          limit: SUB_AGENCY_PAGE_LIMIT,
          ...(fiscalYear !== undefined ? { fiscal_year: fiscalYear } : {}),
        },
        ctx,
      ),
    }));
    const overviewRequest = svc.getAgency(code, ctx);
    // Settled up front, so a leg that rejects after the overview fails is still handled.
    const legs = Promise.allSettled([subRequest, budgetRequest]);

    /**
     * The overview decides the call and is awaited alone, so its failure surfaces as
     * soon as it settles rather than after the slower legs. It also decides existence:
     * a nonexistent agency 404s on every leg, and its miss must surface as
     * agency_not_found rather than as two unavailable sections.
     */
    const detail = await overviewRequest;
    if (!detail?.name) {
      throw ctx.fail('agency_not_found', `Agency not found: ${toptierCode}`);
    }
    const [subLeg, budgetLeg] = await legs;

    /**
     * A failed budget or sub-agency request degrades to a disclosed partial result
     * rather than failing the call, since the overview alone still answers. Caller
     * cancellation and unclassified (non-upstream) errors are rethrown.
     */
    const unavailable: UnavailableSection[] = [];
    const settleLeg = <T>(section: UnavailableSection['section'], leg: PromiseSettledResult<T>) => {
      if (leg.status === 'fulfilled') return leg.value;
      const err: unknown = leg.reason;
      if (ctx.signal.aborted || !(err instanceof McpError)) throw err;
      const reason = err.data?.reason;
      unavailable.push({
        section,
        reason:
          reason === 'api_unavailable' || reason === 'api_timeout' ? reason : 'upstream_error',
        retryable: err.data?.retryable === true,
        message: err.message,
      });
      return;
    };
    const budgetData = settleLeg('budgetary_resources', budgetLeg);
    const subLegData = settleLeg('sub_agencies', subLeg);
    const subAgenciesData = subLegData?.page;

    const currentBudget = selectBudgetRow(budgetData?.agency_data_by_year);
    // The year upstream says the breakdown covers; the year requested when it does not say.
    const subYear =
      typeof subAgenciesData?.fiscal_year === 'number'
        ? subAgenciesData.fiscal_year
        : subLegData?.requestedYear;

    const subAgencies = (subAgenciesData?.results ?? [])
      .map((s) => ({
        ...(s.name ? { name: s.name } : {}),
        ...(s.abbreviation ? { abbreviation: s.abbreviation } : {}),
        ...(typeof s.total_obligations === 'number'
          ? { total_obligations: s.total_obligations }
          : {}),
        ...(typeof s.transaction_count === 'number'
          ? { transaction_count: s.transaction_count }
          : {}),
        ...(typeof s.new_award_count === 'number' ? { new_award_count: s.new_award_count } : {}),
      }))
      .filter((s) => s.name);

    const subMeta = subAgenciesData?.page_metadata ?? {};
    const subPage = subMeta.page ?? input.page;
    /**
     * Direct read, verified: `agency/{code}/sub_agency/` was paged to the end of a
     * 10-row result set at limits 1 and 5, reporting `hasNext` truthfully on the
     * interior, exactly-full final, and past-the-end pages.
     */
    const subHasNext = subMeta.hasNext ?? false;
    const subTotal = typeof subMeta.total === 'number' ? subMeta.total : undefined;

    // `ctx.enrich.notice` is last-wins, so every notice source is composed into one string.
    const notices: string[] = [];
    if (subAgenciesData) {
      ctx.enrich({
        sub_agency_page: subPage,
        has_more_sub_agencies: subHasNext,
        ...(subTotal !== undefined ? { sub_agency_total: subTotal } : {}),
      });
      if (subHasNext) {
        notices.push(
          `Showing sub-agency page ${subPage}${subTotal !== undefined ? ` of ${subTotal} total` : ''}. Call again with page=${subPage + 1} for more sub-agencies.`,
        );
      }
    }
    if (unavailable.length > 0) {
      ctx.enrich({ unavailable_sections: unavailable });
      const retryable = unavailable.filter((s) => s.retryable).map((s) => s.section);
      notices.push(
        `Partial result: ${unavailable.map((s) => `${s.section} (${s.reason})`).join(' and ')} could not be fetched, so ${unavailable.length === 1 ? 'its fields are' : 'their fields are'} omitted. ${
          retryable.length > 0
            ? `Retry the call to load ${retryable.join(' and ')}.`
            : 'Retrying is unlikely to help.'
        }`,
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    return {
      ...(detail.name ? { name: detail.name } : {}),
      ...(detail.abbreviation ? { abbreviation: detail.abbreviation } : {}),
      toptier_code: toptierCode,
      ...(typeof detail.agency_id === 'number' ? { agency_id: detail.agency_id } : {}),
      ...(detail.mission || detail.agency_overview?.mission
        ? { mission: (detail.mission ?? detail.agency_overview?.mission) || undefined }
        : {}),
      ...(typeof currentBudget?.fiscal_year === 'number'
        ? { fiscal_year: currentBudget.fiscal_year }
        : {}),
      ...(typeof currentBudget?.agency_budgetary_resources === 'number'
        ? { budgetary_resources_amount: currentBudget.agency_budgetary_resources }
        : {}),
      ...(typeof currentBudget?.agency_total_obligated === 'number'
        ? { obligated_amount: currentBudget.agency_total_obligated }
        : {}),
      ...(typeof currentBudget?.agency_total_outlayed === 'number'
        ? { outlay_amount: currentBudget.agency_total_outlayed }
        : {}),
      ...(typeof detail.sub_agency_count === 'number'
        ? { subtier_agency_count: detail.sub_agency_count }
        : typeof detail.subtier_agency_count === 'number'
          ? { subtier_agency_count: detail.subtier_agency_count }
          : {}),
      ...(subAgencies.length > 0 ? { sub_agencies: subAgencies } : {}),
      ...(subYear !== undefined ? { sub_agency_fiscal_year: subYear } : {}),
      ...(subAgencies.length > 0
        ? {
            sub_agency_page_metadata: {
              ...(subTotal !== undefined ? { total: subTotal } : {}),
              page: subPage,
              has_next: subHasNext,
              limit: subMeta.limit ?? SUB_AGENCY_PAGE_LIMIT,
            },
          }
        : {}),
      ...(detail.def_codes?.length
        ? {
            def_codes: detail.def_codes.map((d) => ({
              ...(d.code ? { code: d.code } : {}),
              ...(d.public_law ? { public_law: d.public_law } : {}),
              ...(d.title ? { title: d.title } : {}),
            })),
          }
        : {}),
      ...(detail.website ? { website: detail.website } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Agency: ${escapeMarkdownInline(result.name ?? 'Unknown')}${result.abbreviation ? ` (${escapeMarkdownInline(result.abbreviation)})` : ''}`,
    ];
    if (result.toptier_code)
      lines.push(`**Toptier Code:** ${escapeMarkdownInline(result.toptier_code)}`);
    if (typeof result.agency_id === 'number') lines.push(`**Agency ID:** ${result.agency_id}`);
    if (result.mission) lines.push(`**Mission:** ${escapeMarkdownInline(result.mission)}`);
    if (typeof result.fiscal_year === 'number')
      lines.push(`**Fiscal Year:** ${result.fiscal_year}`);
    if (typeof result.budgetary_resources_amount === 'number')
      lines.push(`**Budgetary Resources:** ${formatCurrency(result.budgetary_resources_amount)}`);
    if (typeof result.obligated_amount === 'number')
      lines.push(`**Obligated:** ${formatCurrency(result.obligated_amount)}`);
    if (typeof result.outlay_amount === 'number')
      lines.push(`**Outlays:** ${formatCurrency(result.outlay_amount)}`);
    if (typeof result.subtier_agency_count === 'number')
      lines.push(`**Sub-agencies:** ${result.subtier_agency_count}`);
    if (typeof result.sub_agency_fiscal_year === 'number')
      lines.push(`**Sub-Agency Fiscal Year:** ${result.sub_agency_fiscal_year}`);
    if (result.website) lines.push(`**Website:** ${markdownLink(result.website, result.website)}`);

    if (result.sub_agencies?.length || result.sub_agency_page_metadata) {
      lines.push('\n### Sub-Agency Breakdown');
      if (result.sub_agency_page_metadata)
        lines.push(formatPaginationLine(result.sub_agency_page_metadata));
    }
    if (result.sub_agencies?.length) {
      lines.push('| Sub-Agency | Obligations | Transactions | New Awards |');
      lines.push('|:-----------|:------------|:-------------|:-----------|');
      for (const s of result.sub_agencies) {
        const oblig =
          typeof s.total_obligations === 'number' ? formatCurrency(s.total_obligations) : 'N/A';
        const txns =
          typeof s.transaction_count === 'number' ? s.transaction_count.toLocaleString() : 'N/A';
        const newAwards =
          typeof s.new_award_count === 'number' ? s.new_award_count.toLocaleString() : 'N/A';
        lines.push(
          `| ${escapeMarkdownInline(s.name ?? 'N/A')}${s.abbreviation ? ` (${escapeMarkdownInline(s.abbreviation)})` : ''} | ${oblig} | ${txns} | ${newAwards} |`,
        );
      }
    }

    if (result.def_codes?.length) {
      lines.push('\n### Disaster/Emergency Funding Codes');
      for (const d of result.def_codes) {
        lines.push(
          `- **${escapeMarkdownInline(d.code ?? 'N/A')}** — ${escapeMarkdownInline(d.title ?? 'N/A')}${d.public_law ? ` (${escapeMarkdownInline(d.public_law)})` : ''}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
