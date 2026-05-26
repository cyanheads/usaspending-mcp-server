/**
 * @fileoverview Tool to fetch full details of a federal award by its generated ID.
 * @module mcp-server/tools/definitions/get-award.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getAwardTool = tool('usaspending_get_award', {
  title: 'Get Award Details',
  description:
    'Fetch full details of a federal award by its generated unique award ID. Returns contract or assistance award data including recipient info, agency hierarchy, period of performance, place of performance, funding account linkages (account_obligations_by_defc), parent IDV information, and subaward count. Use generated_internal_id values from usaspending_search_awards as input. Recipient hashes can be passed to usaspending_get_recipient; NAICS codes can be used in usaspending_search_awards filters.',
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
      .describe('Award category (contract, grant, direct_payment, loan, idv, other)'),
    description: z.string().optional().describe('Award description'),
    total_obligation: z.number().optional().describe('Total obligation amount in USD'),
    total_outlays: z.number().optional().describe('Total outlay amount in USD'),
    base_and_all_options_value: z
      .number()
      .optional()
      .describe('Base and all options value in USD (contracts)'),
    subaward_count: z
      .number()
      .optional()
      .describe('Number of subawards; use with usaspending_get_award_subawards'),
    date_signed: z.string().optional().describe('Date award was signed (YYYY-MM-DD)'),
    period_of_performance: z
      .object({
        start_date: z.string().optional().describe('Performance start date'),
        end_date: z.string().optional().describe('Performance end date'),
        potential_end_date: z.string().optional().describe('Potential end date including options'),
      })
      .optional()
      .describe('Period of performance dates'),
    place_of_performance: z
      .object({
        city_name: z.string().optional().describe('City of performance'),
        state_code: z.string().optional().describe('State code of performance'),
        country_code: z.string().optional().describe('Country code of performance'),
        zip5: z.string().optional().describe('ZIP code of performance'),
      })
      .optional()
      .describe('Place of performance'),
    recipient: z
      .object({
        recipient_name: z.string().optional().describe('Recipient legal business name'),
        uei: z.string().optional().describe('Unique Entity Identifier'),
        recipient_id: z
          .string()
          .optional()
          .describe('Recipient hash ID — pass to usaspending_get_recipient for full profile'),
        parent_recipient_name: z.string().optional().describe('Parent organization name'),
        business_types: z.array(z.string()).optional().describe('Recipient business type codes'),
        location: z
          .object({
            city_name: z.string().optional().describe('Recipient city'),
            state_code: z.string().optional().describe('Recipient state code'),
            country_code: z.string().optional().describe('Recipient country code'),
          })
          .optional()
          .describe('Recipient address'),
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
    cfda: z
      .object({
        number: z.string().optional().describe('CFDA/Assistance Listing number'),
        title: z.string().optional().describe('CFDA program title'),
      })
      .optional()
      .describe('CFDA program (grants/assistance)'),
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
    transactions_count: z
      .number()
      .optional()
      .describe('Number of transactions; use with usaspending_get_award_transactions'),
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
      recovery: 'The API may be temporarily down. Retry the request after a few seconds.',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('usaspending_get_award', { award_id: input.award_id });
    const svc = getUSASpendingService();
    const r = await svc.getAward(input.award_id, ctx);

    if (!r || (!r.generated_unique_award_id && !r.piid && !r.fain)) {
      throw ctx.fail('award_not_found', `Award not found: ${input.award_id}`, {
        recovery: {
          hint: 'Use generated_internal_id from usaspending_search_awards results — not display Award IDs.',
        },
      });
    }

    const contractData = r.latest_transaction_contract_data;
    const assistanceData = r.latest_transaction_assistance_data;

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
      ...(typeof r.total_outlays === 'number' ? { total_outlays: r.total_outlays } : {}),
      ...(typeof r.base_and_all_options_value === 'number'
        ? { base_and_all_options_value: r.base_and_all_options_value }
        : {}),
      ...(typeof r.subaward_count === 'number' ? { subaward_count: r.subaward_count } : {}),
      ...(r.date_signed ? { date_signed: r.date_signed } : {}),
      ...(r.period_of_performance
        ? {
            period_of_performance: {
              ...(r.period_of_performance.start_date
                ? { start_date: r.period_of_performance.start_date }
                : {}),
              ...(r.period_of_performance.end_date
                ? { end_date: r.period_of_performance.end_date }
                : {}),
              ...(r.period_of_performance.potential_end_date
                ? { potential_end_date: r.period_of_performance.potential_end_date }
                : {}),
            },
          }
        : {}),
      ...(r.place_of_performance
        ? {
            place_of_performance: {
              ...(r.place_of_performance.city_name
                ? { city_name: r.place_of_performance.city_name }
                : {}),
              ...(r.place_of_performance.state_code
                ? { state_code: r.place_of_performance.state_code }
                : {}),
              ...(r.place_of_performance.country_code
                ? { country_code: r.place_of_performance.country_code }
                : {}),
              ...(r.place_of_performance.zip5 ? { zip5: r.place_of_performance.zip5 } : {}),
            },
          }
        : {}),
      ...(r.recipient
        ? {
            recipient: {
              ...(r.recipient.recipient_name ? { recipient_name: r.recipient.recipient_name } : {}),
              ...(r.recipient.uei ? { uei: r.recipient.uei } : {}),
              ...(r.recipient.recipient_hash
                ? { recipient_id: r.recipient.recipient_hash }
                : r.recipient.recipient_id
                  ? { recipient_id: r.recipient.recipient_id }
                  : {}),
              ...(r.recipient.parent_recipient_name
                ? { parent_recipient_name: r.recipient.parent_recipient_name }
                : {}),
              ...(r.recipient.business_types?.length
                ? { business_types: r.recipient.business_types }
                : {}),
              ...(r.recipient.location
                ? {
                    location: {
                      ...(r.recipient.location.city_name
                        ? { city_name: r.recipient.location.city_name }
                        : {}),
                      ...(r.recipient.location.state_code
                        ? { state_code: r.recipient.location.state_code }
                        : {}),
                      ...(r.recipient.location.country_code
                        ? { country_code: r.recipient.location.country_code }
                        : {}),
                    },
                  }
                : {}),
            },
          }
        : {}),
      ...(r.awarding_agency
        ? {
            awarding_agency: {
              ...(r.awarding_agency.toptier_agency?.name
                ? { toptier_name: r.awarding_agency.toptier_agency.name }
                : {}),
              ...(r.awarding_agency.toptier_agency?.code
                ? { toptier_code: r.awarding_agency.toptier_agency.code }
                : {}),
              ...(r.awarding_agency.toptier_agency?.slug
                ? { toptier_slug: r.awarding_agency.toptier_agency.slug }
                : {}),
              ...(r.awarding_agency.subtier_agency?.name
                ? { subtier_name: r.awarding_agency.subtier_agency.name }
                : {}),
            },
          }
        : {}),
      ...(r.funding_agency
        ? {
            funding_agency: {
              ...(r.funding_agency.toptier_agency?.name
                ? { toptier_name: r.funding_agency.toptier_agency.name }
                : {}),
              ...(r.funding_agency.toptier_agency?.code
                ? { toptier_code: r.funding_agency.toptier_agency.code }
                : {}),
              ...(r.funding_agency.subtier_agency?.name
                ? { subtier_name: r.funding_agency.subtier_agency.name }
                : {}),
            },
          }
        : {}),
      ...(r.parent_award
        ? {
            parent_award: {
              ...(r.parent_award.piid ? { award_id: r.parent_award.piid } : {}),
              ...(r.parent_award.generated_unique_award_id
                ? { generated_unique_award_id: r.parent_award.generated_unique_award_id }
                : {}),
              ...(r.parent_award.agency_name ? { agency_name: r.parent_award.agency_name } : {}),
              ...(r.parent_award.idv_type_description
                ? { type_description: r.parent_award.idv_type_description }
                : {}),
            },
          }
        : {}),
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
              ...(contractData.product_or_service_code_description
                ? { description: contractData.product_or_service_code_description }
                : {}),
            },
          }
        : {}),
      ...(assistanceData?.cfda_number
        ? {
            cfda: {
              number: assistanceData.cfda_number,
              ...(assistanceData.cfda_title ? { title: assistanceData.cfda_title } : {}),
            },
          }
        : {}),
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
      ...(typeof r.transactions_count === 'number'
        ? { transactions_count: r.transactions_count }
        : {}),
    };
  },

  format: (result) => {
    const lines: string[] = ['## Award Details'];
    if (result.generated_unique_award_id)
      lines.push(`**Award ID:** ${result.generated_unique_award_id}`);
    if (result.piid) lines.push(`**PIID:** ${result.piid}`);
    if (result.fain) lines.push(`**FAIN:** ${result.fain}`);
    if (result.type) lines.push(`**Type Code:** ${result.type}`);
    if (result.type_description) lines.push(`**Type:** ${result.type_description}`);
    if (result.category) lines.push(`**Category:** ${result.category}`);
    if (result.description) lines.push(`**Description:** ${result.description}`);
    if (typeof result.total_obligation === 'number')
      lines.push(`**Total Obligation:** $${result.total_obligation.toLocaleString()}`);
    if (typeof result.total_outlays === 'number')
      lines.push(`**Total Outlays:** $${result.total_outlays.toLocaleString()}`);
    if (typeof result.base_and_all_options_value === 'number')
      lines.push(`**Base + All Options:** $${result.base_and_all_options_value.toLocaleString()}`);
    if (result.date_signed) lines.push(`**Date Signed:** ${result.date_signed}`);

    if (result.period_of_performance) {
      const p = result.period_of_performance;
      lines.push(
        `**Period:** ${p.start_date ?? 'N/A'} → ${p.end_date ?? 'N/A'}${p.potential_end_date ? ` (potential: ${p.potential_end_date})` : ''}`,
      );
    }

    if (result.place_of_performance) {
      const pop = result.place_of_performance;
      const loc = [pop.city_name, pop.state_code, pop.zip5, pop.country_code]
        .filter(Boolean)
        .join(', ');
      if (loc) lines.push(`**Place of Performance:** ${loc}`);
    }

    if (result.recipient) {
      lines.push('\n### Recipient');
      if (result.recipient.recipient_name)
        lines.push(`**Name:** ${result.recipient.recipient_name}`);
      if (result.recipient.uei) lines.push(`**UEI:** ${result.recipient.uei}`);
      if (result.recipient.recipient_id)
        lines.push(`**Recipient ID (for get_recipient):** ${result.recipient.recipient_id}`);
      if (result.recipient.parent_recipient_name)
        lines.push(`**Parent:** ${result.recipient.parent_recipient_name}`);
      if (result.recipient.business_types?.length)
        lines.push(`**Business Types:** ${result.recipient.business_types.join(', ')}`);
      if (result.recipient.location) {
        const loc = result.recipient.location;
        lines.push(
          `**Location:** ${[loc.city_name, loc.state_code, loc.country_code].filter(Boolean).join(', ')}`,
        );
      }
    }

    if (result.awarding_agency) {
      const a = result.awarding_agency;
      lines.push(
        `\n**Awarding Agency:** ${a.toptier_name ?? 'N/A'}${a.subtier_name ? ` / ${a.subtier_name}` : ''}${a.toptier_code ? ` (code: ${a.toptier_code})` : ''}${a.toptier_slug ? ` (slug: ${a.toptier_slug})` : ''}`,
      );
    }
    if (result.funding_agency) {
      const f = result.funding_agency;
      lines.push(
        `**Funding Agency:** ${f.toptier_name ?? 'N/A'}${f.subtier_name ? ` / ${f.subtier_name}` : ''}${f.toptier_code ? ` (code: ${f.toptier_code})` : ''}`,
      );
    }

    if (result.naics)
      lines.push(
        `**NAICS:** ${result.naics.code}${result.naics.description ? ` — ${result.naics.description}` : ''}`,
      );
    if (result.product_or_service_code)
      lines.push(
        `**PSC:** ${result.product_or_service_code.code}${result.product_or_service_code.description ? ` — ${result.product_or_service_code.description}` : ''}`,
      );
    if (result.cfda)
      lines.push(
        `**CFDA:** ${result.cfda.number}${result.cfda.title ? ` — ${result.cfda.title}` : ''}`,
      );

    if (typeof result.subaward_count === 'number')
      lines.push(`**Subaward Count:** ${result.subaward_count}`);
    if (typeof result.transactions_count === 'number')
      lines.push(`**Transaction Count:** ${result.transactions_count}`);

    if (result.parent_award) {
      lines.push('\n### Parent Award (IDV)');
      if (result.parent_award.award_id) lines.push(`**PIID:** ${result.parent_award.award_id}`);
      if (result.parent_award.generated_unique_award_id)
        lines.push(
          `**Chain ID (for get_award):** ${result.parent_award.generated_unique_award_id}`,
        );
      if (result.parent_award.agency_name)
        lines.push(`**Agency:** ${result.parent_award.agency_name}`);
      if (result.parent_award.type_description)
        lines.push(`**Type:** ${result.parent_award.type_description}`);
    }

    if (result.account_obligations_by_defc?.length) {
      lines.push('\n### Disaster/Emergency Funding (DEF Codes)');
      for (const d of result.account_obligations_by_defc) {
        lines.push(
          `- **${d.code ?? 'N/A'}:** ${typeof d.amount === 'number' ? `$${d.amount.toLocaleString()}` : 'N/A'}`,
        );
      }
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
