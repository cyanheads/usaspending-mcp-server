/**
 * @fileoverview Tool to fetch full details of a federal award by its generated ID.
 * @module mcp-server/tools/definitions/get-award.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';
import { formatCurrency } from './formatting.js';

type Present<T> = { [K in keyof T]?: Exclude<T[K], null | undefined> };

/**
 * Keeps the members upstream populated — dropping null, undefined, and empty
 * strings, keeping zeros — and returns undefined when none are left, so an
 * all-null upstream block emits no key rather than `{}`.
 */
function compact<T extends Record<string, string | number | null | undefined>>(
  fields: T,
): Present<T> | undefined {
  const entries = Object.entries(fields).filter(
    ([, value]) => value !== null && value !== undefined && value !== '',
  );
  return entries.length ? (Object.fromEntries(entries) as Present<T>) : undefined;
}

export const getAwardTool = tool('usaspending_get_award', {
  title: 'Get Award Details',
  description:
    'Fetch full details of a federal award by its generated unique award ID. Returns contract or assistance award data including recipient identity (UEI, parent organization, business categories), agency hierarchy, period of performance, place of performance, Assistance Listings with the obligation under each, loan face value and subsidy cost for loans, funding account linkages (account_obligations_by_defc), parent IDV information, and subaward count. Use generated_internal_id values from usaspending_search_awards as input. Recipient and parent recipient hashes can be passed to usaspending_get_recipient; NAICS codes can be used in usaspending_search_awards filters, and Assistance Listing numbers in its assistance_listings filter. For IDV-category awards (category="idv"), use usaspending_get_idv_awards to list the child contracts and task/delivery orders placed under them.',
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    award_id: z
      .string()
      .min(1)
      .describe(
        'Generated unique award ID (e.g., CONT_AWD_FA862118F6251_9700_FA862115D6276_9700) — use generated_internal_id from usaspending_search_awards',
      ),
  }),

  output: z.object({
    generated_unique_award_id: z.string().optional().describe('Generated unique award ID'),
    piid: z.string().optional().describe('Procurement Instrument Identifier (for contracts)'),
    fain: z.string().optional().describe('Federal Award Identification Number (for assistance)'),
    type: z.string().optional().describe('Award type code'),
    type_description: z.string().optional().describe('Human-readable award type'),
    category: z
      .string()
      .optional()
      .describe('Award category: contract, idv, grant, loans, direct payment, insurance, or other'),
    description: z.string().optional().describe('Award description'),
    total_obligation: z.number().optional().describe('Total obligation amount in USD'),
    total_outlays: z.number().optional().describe('Total outlay amount in USD'),
    total_account_obligation: z
      .number()
      .optional()
      .describe('Total federal-account obligation in USD'),
    total_account_outlay: z.number().optional().describe('Total federal-account outlay in USD'),
    base_exercised_options: z
      .number()
      .optional()
      .describe('Base and exercised options value in USD when reported for contracts or IDVs'),
    base_and_all_options_value: z
      .number()
      .optional()
      .describe('Base and all options value in USD (contracts)'),
    total_loan_value: z
      .number()
      .optional()
      .describe(
        'Face value of the loan in USD (category "loans" only). A loan reports its value here, not in total_obligation, which is often 0.',
      ),
    total_subsidy_cost: z
      .number()
      .optional()
      .describe(
        'Estimated cost to the government of the loan subsidy in USD (category "loans" only)',
      ),
    subaward_count: z
      .number()
      .optional()
      .describe('Number of subawards; use with usaspending_get_award_subawards'),
    date_signed: z.string().optional().describe('Date award was signed (YYYY-MM-DD)'),
    period_of_performance: z
      .object({
        start_date: z.string().optional().describe('Performance start date (YYYY-MM-DD)'),
        end_date: z.string().optional().describe('Performance end date (YYYY-MM-DD)'),
        potential_end_date: z
          .string()
          .optional()
          .describe('Potential end date including options (YYYY-MM-DD)'),
      })
      .optional()
      .describe('Period of performance dates'),
    place_of_performance: z
      .object({
        city_name: z.string().optional().describe('City of performance'),
        state_code: z.string().optional().describe('State code of performance'),
        country_code: z
          .string()
          .optional()
          .describe('Three-letter country code of performance (e.g. USA)'),
        zip5: z.string().optional().describe('ZIP code of performance'),
        congressional_code: z
          .string()
          .optional()
          .describe('Congressional district of performance, preserving leading zeros'),
        county_name: z.string().optional().describe('County of performance'),
      })
      .optional()
      .describe('Place of performance; absent when upstream reports no location fields'),
    recipient: z
      .object({
        recipient_name: z.string().optional().describe('Recipient legal business name'),
        uei: z.string().optional().describe('Recipient Unique Entity Identifier'),
        recipient_id: z
          .string()
          .optional()
          .describe('Recipient hash ID — pass to usaspending_get_recipient for full profile'),
        parent_recipient_name: z.string().optional().describe('Parent organization name'),
        parent_uei: z.string().optional().describe('Parent organization Unique Entity Identifier'),
        parent_recipient_id: z
          .string()
          .optional()
          .describe(
            'Parent recipient hash ID (ends in -P) — pass to usaspending_get_recipient for the parent organization profile',
          ),
        business_categories: z
          .array(z.string())
          .optional()
          .describe(
            'Recipient business category names (e.g. "Higher Education", "U.S. Local Government") — not the codes usaspending_get_recipient returns as business_types',
          ),
        location: z
          .object({
            city_name: z.string().optional().describe('Recipient city'),
            state_code: z.string().optional().describe('Recipient state code'),
            zip5: z.string().optional().describe('Recipient ZIP code, preserving leading zeros'),
            congressional_code: z
              .string()
              .optional()
              .describe('Recipient congressional district, preserving leading zeros'),
            county_name: z.string().optional().describe('Recipient county'),
            country_code: z
              .string()
              .optional()
              .describe('Recipient three-letter country code (e.g. USA)'),
          })
          .optional()
          .describe('Recipient address; absent when upstream reports no location fields'),
      })
      .optional()
      .describe('Recipient details'),
    awarding_agency: z
      .object({
        toptier_name: z.string().optional().describe('Top-tier agency name'),
        toptier_code: z.string().optional().describe('Top-tier agency code'),
        toptier_slug: z.string().optional().describe('Top-tier agency slug'),
        subtier_name: z.string().optional().describe('Sub-tier agency name'),
      })
      .optional()
      .describe('Awarding agency hierarchy'),
    funding_agency: z
      .object({
        toptier_name: z.string().optional().describe('Top-tier funding agency name'),
        toptier_code: z.string().optional().describe('Top-tier funding agency code'),
        subtier_name: z.string().optional().describe('Sub-tier funding agency name'),
      })
      .optional()
      .describe('Funding agency hierarchy'),
    parent_award: z
      .object({
        award_id: z.string().optional().describe('Parent award display ID'),
        generated_unique_award_id: z
          .string()
          .optional()
          .describe(
            'Parent award chaining ID — pass to usaspending_get_award for parent IDV details',
          ),
        agency_name: z.string().optional().describe('Parent award agency name'),
        type_description: z.string().optional().describe('Parent award type description'),
      })
      .optional()
      .describe('Parent IDV information (contracts only)'),
    naics: z
      .object({
        code: z.string().optional().describe('NAICS industry code'),
        description: z.string().optional().describe('NAICS industry description'),
      })
      .optional()
      .describe('NAICS code (contracts)'),
    product_or_service_code: z
      .object({
        code: z.string().optional().describe('PSC product or service code'),
        description: z.string().optional().describe('PSC description'),
      })
      .optional()
      .describe('Product or service code (contracts)'),
    assistance_listings: z
      .array(
        z
          .object({
            number: z
              .string()
              .optional()
              .describe(
                'Assistance Listing (CFDA) number, e.g. 93.855 — usable in usaspending_search_awards assistance_listings',
              ),
            title: z.string().optional().describe('Assistance Listing program title'),
            obligation: z
              .number()
              .optional()
              .describe('Federal obligation in USD made under this listing'),
          })
          .describe('One Assistance Listing funding the award'),
      )
      .optional()
      .describe(
        'Every Assistance Listing (CFDA program) funding the award, in upstream order; absent for contracts and IDVs',
      ),
    account_outlays_by_defc: z
      .array(
        z
          .object({
            code: z.string().optional().describe('DEF code identifying the emergency supplemental'),
            amount: z.number().optional().describe('Outlay amount in USD for this DEF code'),
          })
          .describe('DEF code entry with code and outlay amount'),
      )
      .optional()
      .describe('Federal-account outlays by Disaster/Emergency Funding code in upstream order'),
    account_obligations_by_defc: z
      .array(
        z
          .object({
            code: z.string().optional().describe('DEF code identifying the emergency supplemental'),
            amount: z.number().optional().describe('Obligation amount in USD for this DEF code'),
          })
          .describe('DEF code entry with code and obligation amount'),
      )
      .optional()
      .describe(
        'Funding breakdown by Disaster/Emergency Funding (DEF) code — links to disaster appropriations',
      ),
  }),

  errors: [
    {
      reason: 'award_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No award exists for the given award ID.',
      recovery:
        'Verify the award_id from usaspending_search_awards results. IDs are case-sensitive and use the generated_internal_id format.',
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
        'Retry the request; award detail is a single record, so there is nothing to narrow.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_get_award', { award_id: input.award_id });
    const svc = getUSASpendingService();
    const r = await svc.getAward(input.award_id, ctx);

    if (!r || (!r.generated_unique_award_id && !r.piid && !r.fain)) {
      throw ctx.fail('award_not_found', `Award not found: ${input.award_id}`);
    }

    const contractData = r.latest_transaction_contract_data;
    const pop = r.place_of_performance;
    const rcp = r.recipient;

    const periodOfPerformance = compact({
      start_date: r.period_of_performance?.start_date,
      end_date: r.period_of_performance?.end_date,
      /**
       * Upstream returns this one as "YYYY-MM-DD HH:MM:SS" while its siblings are plain
       * dates; the time component is always midnight, so drop it for a single shape.
       */
      potential_end_date: r.period_of_performance?.potential_end_date?.slice(0, 10),
    });
    const placeOfPerformance = compact({
      city_name: pop?.city_name,
      state_code: pop?.state_code,
      country_code: pop?.location_country_code,
      zip5: pop?.zip5,
      congressional_code: pop?.congressional_code,
      county_name: pop?.county_name,
    });
    const recipientLocation = compact({
      city_name: rcp?.location?.city_name,
      state_code: rcp?.location?.state_code,
      country_code: rcp?.location?.location_country_code,
      zip5: rcp?.location?.zip5,
      congressional_code: rcp?.location?.congressional_code,
      county_name: rcp?.location?.county_name,
    });
    const businessCategories = rcp?.business_categories?.length
      ? rcp.business_categories
      : undefined;
    const recipientIdentity = compact({
      recipient_name: rcp?.recipient_name,
      uei: rcp?.recipient_uei,
      recipient_id: rcp?.recipient_hash,
      parent_recipient_name: rcp?.parent_recipient_name,
      parent_uei: rcp?.parent_recipient_uei,
      parent_recipient_id: rcp?.parent_recipient_hash,
    });
    const recipient =
      recipientIdentity || businessCategories || recipientLocation
        ? {
            ...recipientIdentity,
            ...(businessCategories ? { business_categories: businessCategories } : {}),
            ...(recipientLocation ? { location: recipientLocation } : {}),
          }
        : undefined;
    const awardingAgency = compact({
      toptier_name: r.awarding_agency?.toptier_agency?.name,
      toptier_code: r.awarding_agency?.toptier_agency?.code,
      toptier_slug: r.awarding_agency?.toptier_agency?.slug,
      subtier_name: r.awarding_agency?.subtier_agency?.name,
    });
    const fundingAgency = compact({
      toptier_name: r.funding_agency?.toptier_agency?.name,
      toptier_code: r.funding_agency?.toptier_agency?.code,
      subtier_name: r.funding_agency?.subtier_agency?.name,
    });
    const parentAward = compact({
      award_id: r.parent_award?.piid,
      generated_unique_award_id: r.parent_award?.generated_unique_award_id,
      agency_name: r.parent_award?.agency_name,
      type_description: r.parent_award?.idv_type_description,
    });
    const assistanceListings = (r.cfda_info ?? []).flatMap((listing) => {
      const entry = compact({
        number: listing.cfda_number,
        title: listing.cfda_title,
        obligation: listing.federal_action_obligation_amount,
      });
      return entry ? [entry] : [];
    });
    // Non-loan awards carry placeholder zeros in these fields.
    const isLoan = r.category === 'loans';
    const accountOutlays = (r.account_outlays_by_defc ?? []).flatMap((row) => {
      const entry = compact({ code: row.code, amount: row.amount });
      return entry ? [entry] : [];
    });

    return {
      ...(r.generated_unique_award_id
        ? { generated_unique_award_id: r.generated_unique_award_id }
        : {}),
      ...(r.piid ? { piid: r.piid } : {}),
      ...(r.fain ? { fain: r.fain } : {}),
      ...(r.type ? { type: r.type } : {}),
      ...(r.type_description ? { type_description: r.type_description } : {}),
      ...(r.category ? { category: r.category } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(typeof r.total_obligation === 'number' ? { total_obligation: r.total_obligation } : {}),
      ...(typeof r.total_outlay === 'number' ? { total_outlays: r.total_outlay } : {}),
      ...(typeof r.total_account_obligation === 'number'
        ? { total_account_obligation: r.total_account_obligation }
        : {}),
      ...(typeof r.total_account_outlay === 'number'
        ? { total_account_outlay: r.total_account_outlay }
        : {}),
      ...(typeof r.base_exercised_options === 'number'
        ? { base_exercised_options: r.base_exercised_options }
        : {}),
      ...(accountOutlays.length ? { account_outlays_by_defc: accountOutlays } : {}),
      ...(typeof r.base_and_all_options === 'number'
        ? { base_and_all_options_value: r.base_and_all_options }
        : {}),
      ...(isLoan && typeof r.total_loan_value === 'number'
        ? { total_loan_value: r.total_loan_value }
        : {}),
      ...(isLoan && typeof r.total_subsidy_cost === 'number'
        ? { total_subsidy_cost: r.total_subsidy_cost }
        : {}),
      ...(typeof r.subaward_count === 'number' ? { subaward_count: r.subaward_count } : {}),
      ...(r.date_signed ? { date_signed: r.date_signed } : {}),
      ...(periodOfPerformance ? { period_of_performance: periodOfPerformance } : {}),
      ...(placeOfPerformance ? { place_of_performance: placeOfPerformance } : {}),
      ...(recipient ? { recipient } : {}),
      ...(awardingAgency ? { awarding_agency: awardingAgency } : {}),
      ...(fundingAgency ? { funding_agency: fundingAgency } : {}),
      ...(parentAward ? { parent_award: parentAward } : {}),
      ...(contractData?.naics
        ? {
            naics: {
              code: contractData.naics,
              ...(contractData.naics_description
                ? { description: contractData.naics_description }
                : {}),
            },
          }
        : {}),
      ...(contractData?.product_or_service_code
        ? {
            product_or_service_code: {
              code: contractData.product_or_service_code,
              ...(contractData.product_or_service_description
                ? { description: contractData.product_or_service_description }
                : {}),
            },
          }
        : {}),
      ...(assistanceListings.length ? { assistance_listings: assistanceListings } : {}),
      ...(r.account_obligations_by_defc?.length
        ? {
            account_obligations_by_defc: r.account_obligations_by_defc
              .filter((d) => d.code || typeof d.amount === 'number')
              .map((d) => ({
                ...(d.code ? { code: d.code } : {}),
                ...(typeof d.amount === 'number' ? { amount: d.amount } : {}),
              })),
          }
        : {}),
    };
  },

  format: (result) => {
    const lines: string[] = ['## Award Details'];
    if (result.generated_unique_award_id)
      lines.push(`**Award ID:** ${escapeMarkdownInline(result.generated_unique_award_id)}`);
    if (result.piid) lines.push(`**PIID:** ${escapeMarkdownInline(result.piid)}`);
    if (result.fain) lines.push(`**FAIN:** ${escapeMarkdownInline(result.fain)}`);
    if (result.type) lines.push(`**Type Code:** ${escapeMarkdownInline(result.type)}`);
    if (result.type_description)
      lines.push(`**Type:** ${escapeMarkdownInline(result.type_description)}`);
    if (result.category) lines.push(`**Category:** ${escapeMarkdownInline(result.category)}`);
    if (result.description)
      lines.push(`**Description:** ${escapeMarkdownInline(result.description)}`);
    if (typeof result.total_obligation === 'number')
      lines.push(`**Total Obligation:** ${formatCurrency(result.total_obligation)}`);
    if (typeof result.total_outlays === 'number')
      lines.push(`**Total Outlays:** ${formatCurrency(result.total_outlays)}`);
    if (typeof result.total_account_obligation === 'number')
      lines.push(
        `**Total Account Obligation:** ${formatCurrency(result.total_account_obligation)}`,
      );
    if (typeof result.total_account_outlay === 'number')
      lines.push(`**Total Account Outlay:** ${formatCurrency(result.total_account_outlay)}`);
    if (typeof result.base_exercised_options === 'number')
      lines.push(`**Base + Exercised Options:** ${formatCurrency(result.base_exercised_options)}`);
    if (typeof result.base_and_all_options_value === 'number')
      lines.push(`**Base + All Options:** ${formatCurrency(result.base_and_all_options_value)}`);
    if (typeof result.total_loan_value === 'number')
      lines.push(`**Total Loan Value:** ${formatCurrency(result.total_loan_value)}`);
    if (typeof result.total_subsidy_cost === 'number')
      lines.push(`**Total Subsidy Cost:** ${formatCurrency(result.total_subsidy_cost)}`);
    if (result.date_signed)
      lines.push(`**Date Signed:** ${escapeMarkdownInline(result.date_signed)}`);

    if (result.period_of_performance) {
      const p = result.period_of_performance;
      lines.push(
        `**Period:** ${escapeMarkdownInline(p.start_date ?? 'N/A')} → ${escapeMarkdownInline(p.end_date ?? 'N/A')}${p.potential_end_date ? ` (potential: ${escapeMarkdownInline(p.potential_end_date)})` : ''}`,
      );
    }

    if (result.place_of_performance) {
      const pop = result.place_of_performance;
      const loc = [pop.city_name, pop.state_code, pop.zip5, pop.country_code]
        .filter(Boolean)
        .join(', ');
      if (loc) lines.push(`**Place of Performance:** ${escapeMarkdownInline(loc)}`);
      if (pop.congressional_code)
        lines.push(
          `**Performance Congressional District:** ${escapeMarkdownInline(pop.congressional_code)}`,
        );
      if (pop.county_name)
        lines.push(`**Performance County:** ${escapeMarkdownInline(pop.county_name)}`);
    }

    if (result.recipient) {
      lines.push('\n### Recipient');
      if (result.recipient.recipient_name)
        lines.push(`**Name:** ${escapeMarkdownInline(result.recipient.recipient_name)}`);
      if (result.recipient.uei)
        lines.push(`**UEI:** ${escapeMarkdownInline(result.recipient.uei)}`);
      if (result.recipient.recipient_id)
        lines.push(
          `**Recipient ID (for get_recipient):** ${escapeMarkdownInline(result.recipient.recipient_id)}`,
        );
      if (result.recipient.parent_recipient_name)
        lines.push(`**Parent:** ${escapeMarkdownInline(result.recipient.parent_recipient_name)}`);
      if (result.recipient.parent_uei)
        lines.push(`**Parent UEI:** ${escapeMarkdownInline(result.recipient.parent_uei)}`);
      if (result.recipient.parent_recipient_id)
        lines.push(
          `**Parent Recipient ID (for get_recipient):** ${escapeMarkdownInline(result.recipient.parent_recipient_id)}`,
        );
      if (result.recipient.business_categories?.length)
        lines.push(
          `**Business Categories:** ${escapeMarkdownInline(result.recipient.business_categories.join(', '))}`,
        );
      if (result.recipient.location) {
        const loc = result.recipient.location;
        const address = [loc.city_name, loc.state_code, loc.zip5, loc.country_code]
          .filter(Boolean)
          .join(', ');
        if (address) lines.push(`**Location:** ${escapeMarkdownInline(address)}`);
        if (loc.congressional_code)
          lines.push(
            `**Recipient Congressional District:** ${escapeMarkdownInline(loc.congressional_code)}`,
          );
        if (loc.county_name)
          lines.push(`**Recipient County:** ${escapeMarkdownInline(loc.county_name)}`);
      }
    }

    if (result.awarding_agency) {
      const a = result.awarding_agency;
      lines.push(
        `\n**Awarding Agency:** ${escapeMarkdownInline(a.toptier_name ?? 'N/A')}${a.subtier_name ? ` / ${escapeMarkdownInline(a.subtier_name)}` : ''}${a.toptier_code ? ` (code: ${escapeMarkdownInline(a.toptier_code)})` : ''}${a.toptier_slug ? ` (slug: ${escapeMarkdownInline(a.toptier_slug)})` : ''}`,
      );
    }
    if (result.funding_agency) {
      const f = result.funding_agency;
      lines.push(
        `**Funding Agency:** ${escapeMarkdownInline(f.toptier_name ?? 'N/A')}${f.subtier_name ? ` / ${escapeMarkdownInline(f.subtier_name)}` : ''}${f.toptier_code ? ` (code: ${escapeMarkdownInline(f.toptier_code)})` : ''}`,
      );
    }

    if (result.naics)
      lines.push(
        `**NAICS:** ${escapeMarkdownInline(String(result.naics.code))}${result.naics.description ? ` — ${escapeMarkdownInline(result.naics.description)}` : ''}`,
      );
    if (result.product_or_service_code)
      lines.push(
        `**PSC:** ${escapeMarkdownInline(String(result.product_or_service_code.code))}${result.product_or_service_code.description ? ` — ${escapeMarkdownInline(result.product_or_service_code.description)}` : ''}`,
      );

    if (typeof result.subaward_count === 'number')
      lines.push(`**Subaward Count:** ${escapeMarkdownInline(String(result.subaward_count))}`);

    if (result.assistance_listings?.length) {
      lines.push('\n### Assistance Listings');
      for (const l of result.assistance_listings) {
        lines.push(
          `- **${escapeMarkdownInline(l.number ?? 'N/A')}**${l.title ? ` — ${escapeMarkdownInline(l.title)}` : ''}${typeof l.obligation === 'number' ? `: ${formatCurrency(l.obligation)}` : ''}`,
        );
      }
    }

    if (result.parent_award) {
      lines.push('\n### Parent Award (IDV)');
      if (result.parent_award.award_id)
        lines.push(`**PIID:** ${escapeMarkdownInline(result.parent_award.award_id)}`);
      if (result.parent_award.generated_unique_award_id)
        lines.push(
          `**Chain ID (for get_award):** ${escapeMarkdownInline(result.parent_award.generated_unique_award_id)}`,
        );
      if (result.parent_award.agency_name)
        lines.push(`**Agency:** ${escapeMarkdownInline(result.parent_award.agency_name)}`);
      if (result.parent_award.type_description)
        lines.push(`**Type:** ${escapeMarkdownInline(result.parent_award.type_description)}`);
    }

    if (result.account_obligations_by_defc?.length) {
      lines.push('\n### Disaster/Emergency Funding (DEF Codes)');
      for (const d of result.account_obligations_by_defc) {
        lines.push(
          `- **${escapeMarkdownInline(d.code ?? 'N/A')}:** ${typeof d.amount === 'number' ? formatCurrency(d.amount) : 'N/A'}`,
        );
      }
    }

    if (result.account_outlays_by_defc?.length) {
      lines.push('\n### Account Outlays by DEF Code');
      for (const row of result.account_outlays_by_defc)
        lines.push(
          `- **${escapeMarkdownInline(row.code ?? 'N/A')}:** ${typeof row.amount === 'number' ? formatCurrency(row.amount) : 'N/A'}`,
        );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
