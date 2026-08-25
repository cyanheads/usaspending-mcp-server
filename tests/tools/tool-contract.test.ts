/**
 * @fileoverview Production-envelope conformance for the tool surface. The suites
 * in this directory call `handler()` and `format()` directly; this one drives two
 * representative definitions through the full path a client sees — input parse,
 * handler, output parse, `format()`, enrichment merge, and the error envelope.
 *
 * That envelope is what the advertised `outputSchema` now declares: success
 * fields are optional, `error` is a declared member, and a failed call answers
 * with `structuredContent.error` alongside `content[]` rather than a rejected
 * result. Nothing else in this suite exercises it.
 * @module tests/tools/tool-contract.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { toolContractSuite } from '@cyanheads/mcp-ts-core/testing/vitest';
import { vi } from 'vitest';
import { getAwardTool } from '@/mcp-server/tools/definitions/get-award.tool.js';
import { listAgenciesTool } from '@/mcp-server/tools/definitions/list-agencies.tool.js';

const KNOWN_AWARD_ID = 'CONT_AWD_FA862118F6251_9700';

const awardFixture = {
  generated_unique_award_id: KNOWN_AWARD_ID,
  piid: 'FA862118F6251',
  type: 'D',
  type_description: 'Definitive Contract',
  category: 'contract',
  description: 'IT services contract for cloud infrastructure',
  total_obligation: 5_000_000,
  total_outlay: 4_200_000,
  date_signed: '2018-06-01',
  period_of_performance: { start_date: '2018-07-01', end_date: '2023-06-30' },
  recipient: { recipient_name: 'Acme Corp', uei: 'AAAAAAAAAAAA' },
  awarding_agency: {
    toptier_agency: { name: 'Department of Defense', code: '097', slug: 'department-of-defense' },
  },
};

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    listAgencies: vi.fn().mockResolvedValue({
      results: [
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 1_000_000_000,
          obligated_amount: 900_000_000,
          outlay_amount: 800_000_000,
        },
      ],
    }),
    /**
     * The upstream answers a nonexistent award with a miss status, which the
     * service maps to `undefined` so the declared not-found contract can fire.
     */
    getAward: vi.fn(async (awardId: string) =>
      awardId === KNOWN_AWARD_ID ? awardFixture : undefined,
    ),
  }),
}));

toolContractSuite(listAgenciesTool, {
  success: [
    {
      name: 'returns the agency roster with its enrichment trailer',
      input: { sort: 'agency_name', order: 'asc' },
      expected: { total: 1 },
    },
  ],
});

toolContractSuite(getAwardTool, {
  success: [
    {
      name: 'returns award detail on both consumption paths',
      input: { award_id: KNOWN_AWARD_ID },
      expected: { generated_unique_award_id: KNOWN_AWARD_ID, category: 'contract' },
    },
  ],
  errors: [
    {
      name: 'reports an award that does not exist',
      input: { award_id: 'CONT_AWD_NOT_A_REAL_ID' },
      code: JsonRpcErrorCode.NotFound,
      reason: 'award_not_found',
    },
  ],
});
