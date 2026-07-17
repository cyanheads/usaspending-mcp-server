/**
 * @fileoverview Tool to fetch a recipient's full profile by recipient ID.
 * @module mcp-server/tools/definitions/get-recipient.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getRecipientTool = tool('usaspending_get_recipient', {
  title: 'Get Recipient Profile',
  description:
    "Fetch a recipient's full profile including address, business type codes, parent organization, alternate names, and total transaction and loan amounts. Recipient IDs are UUID hashes with a level suffix (-P parent, -C child, -R standalone) from usaspending_search_recipients or usaspending_get_award. Optionally scope the totals to a specific fiscal year and award type. UEI and DUNS values can be used to cross-reference with SAM.gov and SEC EDGAR.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    recipient_id: z
      .string()
      .min(1)
      .describe(
        'Recipient hash ID (UUID with level suffix, e.g., b97d19b0-833c-8d8f-3a2c-157d04ea55ef-P) — from usaspending_search_recipients or usaspending_get_award',
      ),
    fiscal_year: z
      .number()
      .int()
      .min(2001)
      .max(2030)
      .optional()
      .describe('Fiscal year to scope award totals (e.g., 2024)'),
    award_type: z
      .enum(['contracts', 'grants', 'direct_payments', 'loans', 'other_financial_assistance'])
      .optional()
      .describe('Award type category to scope award totals'),
  }),

  output: z.object({
    name: z.string().optional().describe('Recipient legal business name'),
    uei: z.string().optional().describe('Unique Entity Identifier (SAM.gov)'),
    duns: z.string().optional().describe('DUNS number (legacy)'),
    recipient_id: z.string().optional().describe('Recipient hash ID'),
    recipient_level: z
      .string()
      .optional()
      .describe('Hierarchy level: P = parent, C = child, R = standalone'),
    parent_name: z.string().optional().describe('Parent organization name'),
    parent_uei: z.string().optional().describe('Parent organization UEI'),
    business_types: z.array(z.string()).optional().describe('Business type codes'),
    location: z
      .object({
        address_line1: z.string().optional().describe('Street address line 1'),
        address_line2: z.string().optional().describe('Street address line 2'),
        city_name: z.string().optional().describe('City'),
        state_code: z.string().optional().describe('State code'),
        zip: z.string().optional().describe('ZIP code'),
        zip4: z.string().optional().describe('ZIP+4 extension'),
        country_code: z.string().optional().describe('Country code'),
      })
      .optional()
      .describe('Recipient address'),
    total_transaction_amount: z
      .number()
      .optional()
      .describe(
        'Total transaction (award) amount in USD; scoped by fiscal_year/award_type when provided',
      ),
    total_transactions: z.number().optional().describe('Total number of award transactions'),
    total_face_value_loan_amount: z
      .number()
      .optional()
      .describe('Total face value of loans in USD'),
    total_face_value_loan_transactions: z
      .number()
      .optional()
      .describe('Number of face-value loan transactions'),
    alternate_names: z.array(z.string()).optional().describe('Alternate business names'),
  }),

  errors: [
    {
      reason: 'recipient_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No recipient found for the given recipient ID.',
      recovery:
        'Use usaspending_search_recipients to find the correct recipient ID from a name search.',
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
    ctx.log.info('usaspending_get_recipient', { recipient_id: input.recipient_id });
    const svc = getUSASpendingService();
    const r = await svc.getRecipient(
      input.recipient_id,
      {
        ...(input.fiscal_year !== undefined ? { fiscal_year: input.fiscal_year } : {}),
        ...(input.award_type !== undefined ? { award_type: input.award_type } : {}),
      },
      ctx,
    );

    if (!r?.name) {
      throw ctx.fail('recipient_not_found', `Recipient not found: ${input.recipient_id}`, {
        recovery: {
          hint: 'Search for the recipient name with usaspending_search_recipients to find the correct ID.',
        },
      });
    }

    return {
      name: r.name,
      ...(r.uei ? { uei: r.uei } : {}),
      ...(r.duns ? { duns: r.duns } : {}),
      ...(r.recipient_id ? { recipient_id: r.recipient_id } : {}),
      ...(r.recipient_level ? { recipient_level: r.recipient_level } : {}),
      ...(r.parent_name ? { parent_name: r.parent_name } : {}),
      ...(r.parent_uei ? { parent_uei: r.parent_uei } : {}),
      ...(r.business_types?.length ? { business_types: r.business_types } : {}),
      ...(r.location
        ? {
            location: {
              ...(r.location.address_line1 ? { address_line1: r.location.address_line1 } : {}),
              ...(r.location.address_line2 ? { address_line2: r.location.address_line2 } : {}),
              ...(r.location.city_name ? { city_name: r.location.city_name } : {}),
              ...(r.location.state_code ? { state_code: r.location.state_code } : {}),
              ...(r.location.zip ? { zip: r.location.zip } : {}),
              ...(r.location.zip4 ? { zip4: r.location.zip4 } : {}),
              ...(r.location.country_code ? { country_code: r.location.country_code } : {}),
            },
          }
        : {}),
      ...(typeof r.total_transaction_amount === 'number'
        ? { total_transaction_amount: r.total_transaction_amount }
        : {}),
      ...(typeof r.total_transactions === 'number'
        ? { total_transactions: r.total_transactions }
        : {}),
      ...(typeof r.total_face_value_loan_amount === 'number'
        ? { total_face_value_loan_amount: r.total_face_value_loan_amount }
        : {}),
      ...(typeof r.total_face_value_loan_transactions === 'number'
        ? { total_face_value_loan_transactions: r.total_face_value_loan_transactions }
        : {}),
      ...(r.alternate_names?.length ? { alternate_names: r.alternate_names } : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [`## Recipient: ${result.name ?? 'Unknown'}`];
    if (result.recipient_id) lines.push(`**Recipient ID:** ${result.recipient_id}`);
    if (result.uei) lines.push(`**UEI:** ${result.uei}`);
    if (result.duns) lines.push(`**DUNS:** ${result.duns}`);
    if (result.recipient_level) lines.push(`**Level:** ${result.recipient_level}`);
    if (result.parent_name) lines.push(`**Parent Org:** ${result.parent_name}`);
    if (result.parent_uei) lines.push(`**Parent UEI:** ${result.parent_uei}`);
    if (result.location) {
      const loc = result.location;
      const zip = [loc.zip, loc.zip4].filter(Boolean).join('-');
      const addr = [
        loc.address_line1,
        loc.address_line2,
        loc.city_name,
        loc.state_code,
        zip || undefined,
        loc.country_code,
      ]
        .filter(Boolean)
        .join(', ');
      if (addr) lines.push(`**Address:** ${addr}`);
    }
    if (result.business_types?.length)
      lines.push(`**Business Type Codes:** ${result.business_types.join(', ')}`);
    if (result.alternate_names?.length) {
      lines.push(`**Alternate Names:** ${result.alternate_names.join(', ')}`);
    }

    const hasTotals =
      typeof result.total_transaction_amount === 'number' ||
      typeof result.total_transactions === 'number' ||
      typeof result.total_face_value_loan_amount === 'number' ||
      typeof result.total_face_value_loan_transactions === 'number';
    if (hasTotals) {
      lines.push('\n### Award Totals');
      if (typeof result.total_transaction_amount === 'number')
        lines.push(
          `- **Total Transaction Amount:** $${result.total_transaction_amount.toLocaleString()}`,
        );
      if (typeof result.total_transactions === 'number')
        lines.push(`- **Total Transactions:** ${result.total_transactions.toLocaleString()}`);
      if (typeof result.total_face_value_loan_amount === 'number')
        lines.push(
          `- **Face Value of Loans:** $${result.total_face_value_loan_amount.toLocaleString()}`,
        );
      if (typeof result.total_face_value_loan_transactions === 'number')
        lines.push(
          `- **Face Value Loan Transactions:** ${result.total_face_value_loan_transactions.toLocaleString()}`,
        );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
