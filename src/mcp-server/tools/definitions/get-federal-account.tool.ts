/**
 * @fileoverview Tool to fetch a federal account's budget data, obligations, and outlays.
 * @module mcp-server/tools/definitions/get-federal-account.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getUSASpendingService } from '@/services/usaspending/usaspending-service.js';

export const getFederalAccountTool = tool('usaspending_get_federal_account', {
  title: 'Get Federal Account',
  description:
    "Fetch a federal account's budget data: total obligations, outlays, program activities, and object class breakdown for the current fiscal year. Federal accounts connect appropriations law to actual agency spending. Account codes appear in usaspending_get_award account_obligations_by_defc field and are formatted as AGENCY-MAIN (e.g., 097-0100 for DoD Air Force Operation and Maintenance). Returns both account metadata and fiscal year financial snapshot.",
  annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },

  input: z.object({
    account_code: z
      .string()
      .min(1)
      .describe(
        'Federal account code in AGENCY-MAIN format (e.g., 097-0100). Appears in award funding details from usaspending_get_award.',
      ),
  }),

  output: z.object({
    account_title: z.string().optional().describe('Full account title'),
    federal_account_code: z.string().optional().describe('Federal account code'),
    agency_identifier: z.string().optional().describe('Agency identifier code'),
    main_account_code: z.string().optional().describe('Main account code'),
    managing_agency: z.string().optional().describe('Managing agency name'),
    managing_agency_acronym: z.string().optional().describe('Managing agency acronym'),
    budget_function: z.string().optional().describe('Budget function classification'),
    budget_subfunction: z.string().optional().describe('Budget sub-function classification'),
    description: z.string().optional().describe('Account description'),
    fiscal_year_snapshot: z
      .object({
        total_obligations: z
          .number()
          .optional()
          .describe('Total obligations in USD for the current fiscal year'),
        total_outlays: z
          .number()
          .optional()
          .describe('Total outlays in USD for the current fiscal year'),
        total_budgetary_resources: z
          .number()
          .optional()
          .describe('Total budgetary resources in USD'),
        unobligated_balance: z.number().optional().describe('Unobligated balance in USD'),
        budget_authority_amount: z.number().optional().describe('Budget authority amount in USD'),
      })
      .optional()
      .describe('Current fiscal year financial snapshot'),
  }),

  errors: [
    {
      reason: 'account_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No federal account found for the given account code.',
      recovery:
        'Account codes come from usaspending_get_award account_obligations_by_defc field. Verify the AGENCY-MAIN format (e.g., 097-0100).',
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
    ctx.log.info('usaspending_get_federal_account', { account_code: input.account_code });
    const svc = getUSASpendingService();

    const [account, snapshot] = await Promise.all([
      svc.getFederalAccount(input.account_code, ctx),
      svc.getFederalAccountSnapshot(input.account_code, ctx).catch(() => null),
    ]);

    if (!account?.account_title) {
      throw ctx.fail('account_not_found', `Federal account not found: ${input.account_code}`, {
        recovery: {
          hint: 'Use account codes from usaspending_get_award account_obligations_by_defc. Format: AGENCY-MAIN (e.g., 097-0100).',
        },
      });
    }

    return {
      ...(account.account_title ? { account_title: account.account_title } : {}),
      ...(account.federal_account_code
        ? { federal_account_code: account.federal_account_code }
        : {}),
      ...(account.agency_identifier ? { agency_identifier: account.agency_identifier } : {}),
      ...(account.main_account_code ? { main_account_code: account.main_account_code } : {}),
      ...(account.managing_agency ? { managing_agency: account.managing_agency } : {}),
      ...(account.managing_agency_acronym
        ? { managing_agency_acronym: account.managing_agency_acronym }
        : {}),
      ...(account.budget_function ? { budget_function: account.budget_function } : {}),
      ...(account.budget_subfunction ? { budget_subfunction: account.budget_subfunction } : {}),
      ...(account.description ? { description: account.description } : {}),
      ...(snapshot &&
      (typeof snapshot.total_obligations === 'number' ||
        typeof snapshot.total_outlays === 'number' ||
        typeof snapshot.budget_authority_amount === 'number')
        ? {
            fiscal_year_snapshot: {
              ...(typeof snapshot.total_obligations === 'number'
                ? { total_obligations: snapshot.total_obligations }
                : {}),
              ...(typeof snapshot.total_outlays === 'number'
                ? { total_outlays: snapshot.total_outlays }
                : {}),
              ...(typeof snapshot.total_budgetary_resources === 'number'
                ? { total_budgetary_resources: snapshot.total_budgetary_resources }
                : {}),
              ...(typeof snapshot.unobligated_balance === 'number'
                ? { unobligated_balance: snapshot.unobligated_balance }
                : {}),
              ...(typeof snapshot.budget_authority_amount === 'number'
                ? { budget_authority_amount: snapshot.budget_authority_amount }
                : {}),
            },
          }
        : {}),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## Federal Account: ${result.account_title ?? result.federal_account_code ?? 'Unknown'}`,
    ];
    if (result.federal_account_code) lines.push(`**Code:** ${result.federal_account_code}`);
    if (result.agency_identifier) lines.push(`**Agency Identifier:** ${result.agency_identifier}`);
    if (result.main_account_code) lines.push(`**Main Account Code:** ${result.main_account_code}`);
    if (result.managing_agency)
      lines.push(
        `**Managing Agency:** ${result.managing_agency}${result.managing_agency_acronym ? ` (${result.managing_agency_acronym})` : ''}`,
      );
    if (result.budget_function) lines.push(`**Budget Function:** ${result.budget_function}`);
    if (result.budget_subfunction)
      lines.push(`**Budget Sub-Function:** ${result.budget_subfunction}`);
    if (result.description) lines.push(`**Description:** ${result.description}`);

    if (result.fiscal_year_snapshot) {
      lines.push('\n### Current Fiscal Year Snapshot');
      const s = result.fiscal_year_snapshot;
      if (typeof s.budget_authority_amount === 'number')
        lines.push(`- **Budget Authority:** $${s.budget_authority_amount.toLocaleString()}`);
      if (typeof s.total_budgetary_resources === 'number')
        lines.push(`- **Budgetary Resources:** $${s.total_budgetary_resources.toLocaleString()}`);
      if (typeof s.total_obligations === 'number')
        lines.push(`- **Total Obligations:** $${s.total_obligations.toLocaleString()}`);
      if (typeof s.total_outlays === 'number')
        lines.push(`- **Total Outlays:** $${s.total_outlays.toLocaleString()}`);
      if (typeof s.unobligated_balance === 'number')
        lines.push(`- **Unobligated Balance:** $${s.unobligated_balance.toLocaleString()}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
