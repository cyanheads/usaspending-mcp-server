/**
 * @fileoverview Tests for get-agency tool.
 * @module tests/tools/get-agency.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgencyTool } from '@/mcp-server/tools/definitions/get-agency.tool.js';

const mockGetAgency = vi.fn();
const mockGetAgencySubAgencies = vi.fn();
const mockGetAgencyBudgetaryResources = vi.fn();
const mockListAgencies = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getAgency: mockGetAgency,
    getAgencySubAgencies: mockGetAgencySubAgencies,
    getAgencyBudgetaryResources: mockGetAgencyBudgetaryResources,
    listAgencies: mockListAgencies,
  }),
}));

// The agency overview endpoint carries no budget/obligation/transaction totals.
const agencyFixture = {
  name: 'Department of Defense',
  abbreviation: 'DOD',
  agency_id: 517,
  mission: 'Provide the military forces needed to deter war and ensure national security.',
  sub_agency_count: 12,
  website: 'https://www.defense.gov',
  def_codes: [{ code: 'M', public_law: '116-136', title: 'CARES Act' }],
};

const subAgenciesFixture = {
  results: [
    {
      name: 'Department of the Army',
      abbreviation: 'ARMY',
      total_obligations: 200_000_000_000,
      transaction_count: 1_500_000,
      new_award_count: 50_000,
    },
    {
      name: 'Department of the Navy',
      abbreviation: 'NAVY',
      total_obligations: 150_000_000_000,
      transaction_count: 1_000_000,
      new_award_count: 35_000,
    },
  ],
  page_metadata: { page: 1, total: 25, limit: 10, hasNext: true, hasPrevious: false },
};

// Budget/obligation/outlay totals come from the budgetary-resources endpoint. Years are
// deliberately out of order so the tool must select the most recent (FY 2026).
const budgetFixture = {
  agency_data_by_year: [
    {
      fiscal_year: 2025,
      agency_budgetary_resources: 1_900_000_000_000,
      agency_total_obligated: 1_800_000_000_000,
      agency_total_outlayed: 1_700_000_000_000,
    },
    {
      fiscal_year: 2026,
      agency_budgetary_resources: 2_098_732_693_771,
      agency_total_obligated: 1_481_933_755_483,
      agency_total_outlayed: 1_328_539_963_417,
    },
  ],
};

mockGetAgencyBudgetaryResources.mockResolvedValue(budgetFixture);

describe('getAgencyTool', () => {
  it('returns agency details by toptier_code', async () => {
    mockGetAgency.mockResolvedValueOnce(agencyFixture);
    mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ toptier_code: '097' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.abbreviation).toBe('DOD');
    expect(result.toptier_code).toBe('097');
    // #29a/#29c: budget totals come from the budgetary-resources endpoint (most recent FY 2026),
    // with agency_total_outlayed mapped to outlay_amount. The overview-sourced fields are gone.
    expect(result.fiscal_year).toBe(2026);
    expect(result.budgetary_resources_amount).toBe(2_098_732_693_771);
    expect(result.obligated_amount).toBe(1_481_933_755_483);
    expect(result.outlay_amount).toBe(1_328_539_963_417);
    expect(result).not.toHaveProperty('budget_authority_amount');
    expect(result).not.toHaveProperty('transactions_count');
    expect(result.sub_agencies).toHaveLength(2);
    expect(result.sub_agencies![0]!.name).toBe('Department of the Army');
    expect(result.sub_agencies![0]!.total_obligations).toBe(200_000_000_000);
    // #29b: sub-agency pagination metadata is surfaced (was discarded), and the page input
    // is threaded through to the service.
    expect(result.sub_agency_page_metadata).toEqual({
      total: 25,
      page: 1,
      has_next: true,
      limit: 10,
    });
    expect(mockGetAgencySubAgencies).toHaveBeenCalledWith(
      '097',
      expect.objectContaining({ page: 1, limit: 10 }),
      ctx,
    );
    expect(result.def_codes).toHaveLength(1);
  });

  it('resolves agency_slug to toptier_code', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        {
          agency_slug: 'department-of-defense',
          agency_name: 'Department of Defense',
          toptier_code: '097',
        },
      ],
    });
    mockGetAgency.mockResolvedValueOnce(agencyFixture);
    mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ agency_slug: 'department-of-defense' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.toptier_code).toBe('097');
  });

  it('throws missing_input when neither toptier_code nor agency_slug provided', async () => {
    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({});
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_input' },
    });
  });

  it('throws agency_not_found for unknown slug', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ agency_slug: 'nonexistent-agency' });
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
  });

  it('throws agency_not_found when API returns no name', async () => {
    mockGetAgency.mockResolvedValueOnce({});
    mockGetAgencySubAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ toptier_code: '999' });
    await expect(getAgencyTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'agency_not_found' },
    });
  });

  it('returns agency without sub-agencies when results are empty', async () => {
    mockGetAgency.mockResolvedValueOnce({
      ...agencyFixture,
      def_codes: undefined,
    });
    mockGetAgencySubAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext({ errors: getAgencyTool.errors });
    const input = getAgencyTool.input.parse({ toptier_code: '097' });
    const result = await getAgencyTool.handler(input, ctx);

    expect(result.name).toBe('Department of Defense');
    expect(result.sub_agencies).toBeUndefined();
    expect(result.def_codes).toBeUndefined();
  });

  describe('identifier exclusivity (#75)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const clearServiceCalls = () => {
      for (const m of [
        mockGetAgency,
        mockGetAgencySubAgencies,
        mockGetAgencyBudgetaryResources,
        mockListAgencies,
      ]) {
        m.mockClear();
      }
    };

    it('treats a whitespace-only slug beside a code as absent', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

      const result = await runToolContract(getAgencyTool, {
        toptier_code: '014',
        agency_slug: '  ',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ toptier_code: '014' });
    });

    it('treats a whitespace-only code beside a slug as absent', async () => {
      mockListAgencies.mockResolvedValueOnce({
        results: [
          { agency_slug: 'department-of-defense', agency_name: 'DoD', toptier_code: '097' },
        ],
      });
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

      const result = await runToolContract(getAgencyTool, {
        toptier_code: ' ',
        agency_slug: 'department-of-defense',
      });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ toptier_code: '097' });
    });

    it.each([
      ['conflicting', { toptier_code: '014', agency_slug: 'department-of-defense' }],
      ['consistent', { toptier_code: '014', agency_slug: 'department-of-the-interior' }],
      ['padded', { toptier_code: ' 014 ', agency_slug: ' department-of-defense ' }],
    ])('rejects a %s identifier pair before any upstream request', async (_label, input) => {
      clearServiceCalls();

      const result = await runToolContract(getAgencyTool, input);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: {
            reason: 'conflicting_input',
            recovery: {
              hint: expect.stringContaining('toptier_code (e.g., 097) or agency_slug'),
            },
          },
        },
      });
      const text = textOf(result);
      expect(text).toContain('conflicting_input');
      expect(text).toContain('toptier_code (e.g., 097) or agency_slug');
      expect(mockGetAgency).not.toHaveBeenCalled();
      expect(mockGetAgencySubAgencies).not.toHaveBeenCalled();
      expect(mockGetAgencyBudgetaryResources).not.toHaveBeenCalled();
      expect(mockListAgencies).not.toHaveBeenCalled();
    });
  });

  describe('failed budget and sub-agency requests (#69)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const structured = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.structuredContent as Record<string, unknown>;

    it('keeps an exhausted sub-agency page a plain success with nothing unavailable', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce({
        results: [],
        page_metadata: { page: 50, total: 3, limit: 10, hasNext: false, hasPrevious: false },
      });

      const result = await runToolContract(getAgencyTool, { toptier_code: '014', page: 50 });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      expect(sc.sub_agency_page).toBe(50);
      expect(sc.has_more_sub_agencies).toBe(false);
      expect(sc.sub_agency_total).toBe(3);
      expect(sc).not.toHaveProperty('unavailable_sections');
      expect(sc).not.toHaveProperty('notice');
      expect(sc.budgetary_resources_amount).toBe(2_098_732_693_771);
    });

    it('still fails the call when the agency overview request fails', async () => {
      mockGetAgency.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Status: 503', {
          reason: 'api_unavailable',
          retryable: true,
        }),
      );
      mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);

      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'api_unavailable' } },
      });
    });

    const unavailable = () =>
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
        reason: 'api_unavailable',
        retryable: true,
      });
    const timedOut = () =>
      new McpError(JsonRpcErrorCode.Timeout, 'USAspending did not answer within the budget', {
        reason: 'api_timeout',
        retryable: true,
      });

    it('returns the identity and lists a failed budget leg as unavailable', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce({
        ...subAgenciesFixture,
        page_metadata: { page: 1, total: 2, limit: 10, hasNext: false },
      });
      mockGetAgencyBudgetaryResources.mockRejectedValueOnce(unavailable());

      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      expect(sc.name).toBe('Department of Defense');
      expect(sc.toptier_code).toBe('014');
      for (const key of [
        'fiscal_year',
        'budgetary_resources_amount',
        'obligated_amount',
        'outlay_amount',
      ]) {
        expect(sc).not.toHaveProperty(key);
      }
      expect(sc.sub_agencies).toHaveLength(2);
      expect(sc.has_more_sub_agencies).toBe(false);
      expect(sc.unavailable_sections).toEqual([
        {
          section: 'budgetary_resources',
          reason: 'api_unavailable',
          retryable: true,
          message: 'Fetch failed. Status: 503',
        },
      ]);
      expect(sc.notice).toContain('budgetary_resources');
      expect(sc.notice).toContain('Retry');
      const text = textOf(result);
      // The section line itself, not just its name — the notice already names both.
      expect(text).toContain(
        '- budgetary_resources: api_unavailable (retryable) — Fetch failed. Status: 503',
      );
      expect(text).toContain(String(sc.notice));
    });

    it('omits every sub-agency field and lists the section when the sub-agency leg fails', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockRejectedValueOnce(timedOut());

      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });

      expect(result.isError).toBeFalsy();
      const sc = structured(result);
      for (const key of [
        'sub_agencies',
        'sub_agency_page_metadata',
        'sub_agency_page',
        'has_more_sub_agencies',
        'sub_agency_total',
      ]) {
        expect(sc).not.toHaveProperty(key);
      }
      expect(sc.budgetary_resources_amount).toBe(2_098_732_693_771);
      expect(sc.unavailable_sections).toEqual([
        expect.objectContaining({ section: 'sub_agencies', reason: 'api_timeout' }),
      ]);
      const text = textOf(result);
      expect(text).not.toContain('Sub-Agency Breakdown');
      // The section line itself, not just its name — the notice already names both.
      expect(text).toContain(
        '- sub_agencies: api_timeout (retryable) — USAspending did not answer within the budget',
      );
    });

    it('names both failed legs in one composed notice', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockRejectedValueOnce(timedOut());
      mockGetAgencyBudgetaryResources.mockRejectedValueOnce(unavailable());

      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });

      const sc = structured(result);
      expect(
        (sc.unavailable_sections as { section: string }[]).map((s) => s.section).sort(),
      ).toEqual(['budgetary_resources', 'sub_agencies']);
      expect(sc.notice).toContain('budgetary_resources');
      expect(sc.notice).toContain('sub_agencies');
      expect(textOf(result)).toContain(String(sc.notice));
    });

    it('keeps the pagination guidance beside the failed-leg notice', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);
      mockGetAgencyBudgetaryResources.mockRejectedValueOnce(unavailable());

      const result = await runToolContract(getAgencyTool, { toptier_code: '097' });

      const sc = structured(result);
      expect(sc.has_more_sub_agencies).toBe(true);
      expect(sc.notice).toContain('page=2');
      expect(sc.notice).toContain('budgetary_resources');
    });

    it('lists a non-transient leg rejection as upstream_error, not retryable', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subAgenciesFixture);
      mockGetAgencyBudgetaryResources.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.InvalidParams, 'Fetch failed. Status: 400', {
          status: 400,
        }),
      );

      const result = await runToolContract(getAgencyTool, { toptier_code: '097' });

      const sc = structured(result);
      expect(sc.unavailable_sections).toEqual([
        {
          section: 'budgetary_resources',
          reason: 'upstream_error',
          retryable: false,
          message: 'Fetch failed. Status: 400',
        },
      ]);
      expect(sc.notice).not.toContain('Retry the call');
    });

    /**
     * Settles only when the request's signal aborts, rejecting with the classified
     * McpError the service's fetch raises for a caller abort — the shape a leg
     * handler could otherwise mistake for a degradable upstream failure.
     */
    const abortable = (...args: unknown[]) => {
      const { signal } = args.at(-1) as { signal: AbortSignal };
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(
            new McpError(JsonRpcErrorCode.RequestCancelled, 'Fetch aborted', {
              errorSource: 'FetchAborted',
            }),
          ),
        );
      });
    };
    /** Aborts the call once `leg` has been issued, so the abort lands mid-request. */
    const runCancelled = async (leg: ReturnType<typeof vi.fn>) => {
      const issuedBefore = leg.mock.calls.length;
      const caller = new AbortController();
      const pending = runToolContract(
        getAgencyTool,
        { toptier_code: '014' },
        { context: { signal: caller.signal } },
      );
      await vi.waitFor(() => expect(leg.mock.calls.length).toBeGreaterThan(issuedBefore));
      caller.abort();
      return await pending;
    };

    it('propagates caller cancellation during the budget request without requesting sub-agencies', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockImplementationOnce(abortable);
      mockGetAgencySubAgencies.mockClear();

      const result = await runCancelled(mockGetAgencyBudgetaryResources);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      // #86: the sub-agency request waits on the budget year, so a cancelled budget leg never issues it.
      expect(mockGetAgencySubAgencies).not.toHaveBeenCalled();
    });

    it('propagates caller cancellation during the sub-agency request', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockImplementationOnce(abortable);

      const result = await runCancelled(mockGetAgencySubAgencies);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
    });

    it('rethrows a leg failure that is not a classified upstream error', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockRejectedValueOnce(new TypeError('boom'));

      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InternalError, message: expect.stringContaining('boom') },
      });
      expect(structured(result)).not.toHaveProperty('unavailable_sections');
      expect(textOf(result)).toContain('boom');
    });
  });

  describe('budget year selection (#81)', () => {
    const run = async (rows: Record<string, unknown>[]) => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce({ results: [] });
      mockGetAgencyBudgetaryResources.mockResolvedValueOnce({ agency_data_by_year: rows });
      const result = await runToolContract(getAgencyTool, { toptier_code: '014' });
      expect(result.isError).toBeFalsy();
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { sc: result.structuredContent as Record<string, unknown>, text };
    };
    const emptyYear = (fiscal_year: number) => ({
      fiscal_year,
      agency_budgetary_resources: null,
      agency_total_obligated: null,
      agency_total_outlayed: null,
      total_budgetary_resources: null,
      agency_obligation_by_period: [],
    });
    const fy2026 = {
      fiscal_year: 2026,
      agency_budgetary_resources: 96_773_322_454.92,
      agency_total_obligated: 37_802_479_770.8,
      agency_total_outlayed: 36_821_485_523.31,
      total_budgetary_resources: 16_181_198_695_809.91,
    };

    it('reports a newest year whose only amount is 0', async () => {
      const { sc } = await run([{ ...emptyYear(2027), agency_total_obligated: 0 }, fy2026]);
      expect(sc.fiscal_year).toBe(2027);
      expect(sc.obligated_amount).toBe(0);
      expect(sc).not.toHaveProperty('budgetary_resources_amount');
      expect(sc).not.toHaveProperty('outlay_amount');
    });

    it('omits every budget amount when no row carries data', async () => {
      const { sc } = await run([emptyYear(2027), emptyYear(2026)]);
      expect(sc).not.toHaveProperty('budgetary_resources_amount');
      expect(sc).not.toHaveProperty('obligated_amount');
      expect(sc).not.toHaveProperty('outlay_amount');
    });

    it('omits fiscal_year too when no row carries data', async () => {
      const { sc, text } = await run([emptyYear(2027), emptyYear(2026)]);
      expect(sc).not.toHaveProperty('fiscal_year');
      expect(text).not.toContain('Fiscal Year');
    });

    it('skips an all-null newest year and reports the latest year with data', async () => {
      const { sc, text } = await run([emptyYear(2027), fy2026]);
      expect(sc.fiscal_year).toBe(2026);
      expect(sc.budgetary_resources_amount).toBe(96_773_322_454.92);
      expect(sc.obligated_amount).toBe(37_802_479_770.8);
      expect(sc.outlay_amount).toBe(36_821_485_523.31);
      expect(text).toContain('**Fiscal Year:** 2026');
      expect(text).toContain('96,773,322,454');
    });

    it('skips several all-null years, in any upstream order', async () => {
      const { sc } = await run([
        emptyYear(2026),
        { ...fy2026, fiscal_year: 2024, agency_budgetary_resources: 1 },
        emptyYear(2027),
        { ...fy2026, fiscal_year: 2025, agency_budgetary_resources: 2 },
      ]);
      expect(sc.fiscal_year).toBe(2025);
      expect(sc.budgetary_resources_amount).toBe(2);
    });
  });

  describe('sub-agency breakdown fiscal year (#86)', () => {
    const run = async (input: { toptier_code: string; page?: number }) => {
      const result = await runToolContract(getAgencyTool, input);
      expect(result.isError).toBeFalsy();
      const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
      return { sc: result.structuredContent as Record<string, unknown>, text };
    };
    const subPage = (fiscal_year: number | undefined) => ({
      ...subAgenciesFixture,
      ...(fiscal_year !== undefined ? { fiscal_year } : {}),
    });
    const sentParams = () => mockGetAgencySubAgencies.mock.calls.at(-1)?.[1];

    it('requests the sub-agency page without a fiscal year when the budget has none', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockResolvedValueOnce({ agency_data_by_year: [] });
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2027));

      await run({ toptier_code: '014' });

      expect(sentParams()).toEqual({ page: 1, limit: 10 });
    });

    it('requests the breakdown for the budget totals year and names it on both surfaces', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2026));

      const { sc, text } = await run({ toptier_code: '014' });

      expect(sentParams()).toEqual({ page: 1, limit: 10, fiscal_year: 2026 });
      expect(sc.fiscal_year).toBe(2026);
      expect(sc.sub_agency_fiscal_year).toBe(2026);
      expect(text).toContain('**Sub-Agency Fiscal Year:** 2026');
    });

    it('follows the #81 year past an all-null newest row', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockResolvedValueOnce({
        agency_data_by_year: [
          { fiscal_year: 2027, agency_budgetary_resources: null },
          { fiscal_year: 2026, agency_total_obligated: 5 },
        ],
      });
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2026));

      await run({ toptier_code: '014' });

      expect(sentParams()).toMatchObject({ fiscal_year: 2026 });
    });

    it('keeps the same fiscal year on every page', async () => {
      for (const page of [1, 2, 3]) {
        mockGetAgency.mockResolvedValueOnce(agencyFixture);
        mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2026));
        const { sc } = await run({ toptier_code: '014', page });
        expect(sentParams()).toEqual({ page, limit: 10, fiscal_year: 2026 });
        expect(sc.sub_agency_fiscal_year).toBe(2026);
      }
    });

    it('falls back to the upstream default year and names it when the budget request fails', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockRejectedValueOnce(
        new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Status: 503', {
          reason: 'api_unavailable',
          retryable: true,
        }),
      );
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2027));

      const { sc, text } = await run({ toptier_code: '014' });

      expect(sentParams()).toEqual({ page: 1, limit: 10 });
      expect(sc.sub_agency_fiscal_year).toBe(2027);
      expect(text).toContain('**Sub-Agency Fiscal Year:** 2027');
      expect(sc.unavailable_sections).toEqual([
        expect.objectContaining({ section: 'budgetary_resources' }),
      ]);
    });

    it('falls back to the upstream default year when no budget year carries data', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockResolvedValueOnce({
        agency_data_by_year: [{ fiscal_year: 2027, agency_budgetary_resources: null }],
      });
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2027));

      const { sc } = await run({ toptier_code: '014' });

      expect(sentParams()).toEqual({ page: 1, limit: 10 });
      expect(sc).not.toHaveProperty('fiscal_year');
      expect(sc.sub_agency_fiscal_year).toBe(2027);
    });

    it('names the requested year when upstream omits it, and nothing when neither is known', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(undefined));
      expect((await run({ toptier_code: '014' })).sc.sub_agency_fiscal_year).toBe(2026);

      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencyBudgetaryResources.mockResolvedValueOnce({ agency_data_by_year: [] });
      mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(undefined));
      expect((await run({ toptier_code: '014' })).sc).not.toHaveProperty('sub_agency_fiscal_year');
    });

    it('names the year of an empty page past the end', async () => {
      mockGetAgency.mockResolvedValueOnce(agencyFixture);
      mockGetAgencySubAgencies.mockResolvedValueOnce({
        fiscal_year: 2026,
        results: [],
        page_metadata: { page: 50, total: 12, limit: 10, hasNext: false },
      });

      const { sc, text } = await run({ toptier_code: '014', page: 50 });

      expect(sc).not.toHaveProperty('sub_agencies');
      expect(sc.sub_agency_fiscal_year).toBe(2026);
      expect(text).toContain('**Sub-Agency Fiscal Year:** 2026');
    });

    describe('bounded wait for the budget year', () => {
      /** A budget answer that lands after `delayMs` of (fake) time. */
      const budgetAfter = (delayMs: number) =>
        new Promise((resolve) => setTimeout(() => resolve(budgetFixture), delayMs));

      afterEach(() => {
        vi.useRealTimers();
      });

      it('passes the budget year when the budget answers inside the cap', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        mockGetAgency.mockResolvedValueOnce(agencyFixture);
        mockGetAgencyBudgetaryResources.mockImplementationOnce(() => budgetAfter(4_900));
        mockGetAgencySubAgencies.mockClear();
        mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2026));

        const pending = runToolContract(getAgencyTool, { toptier_code: '014' });
        await vi.advanceTimersByTimeAsync(4_899);
        expect(mockGetAgencySubAgencies).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const result = await pending;

        expect(sentParams()).toEqual({ page: 1, limit: 10, fiscal_year: 2026 });
        expect(result.structuredContent).toMatchObject({
          fiscal_year: 2026,
          sub_agency_fiscal_year: 2026,
        });
      });

      it('requests the default year once the cap passes, and still reports the late totals', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        mockGetAgency.mockResolvedValueOnce(agencyFixture);
        mockGetAgencyBudgetaryResources.mockImplementationOnce(() => budgetAfter(30_000));
        mockGetAgencySubAgencies.mockClear();
        mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(2027));

        const pending = runToolContract(getAgencyTool, { toptier_code: '014' });
        await vi.advanceTimersByTimeAsync(4_999);
        expect(mockGetAgencySubAgencies).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(mockGetAgencySubAgencies).toHaveBeenCalledTimes(1);
        expect(sentParams()).toEqual({ page: 1, limit: 10 });

        await vi.advanceTimersByTimeAsync(25_000);
        const result = await pending;

        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc.fiscal_year).toBe(2026);
        expect(sc.budgetary_resources_amount).toBe(2_098_732_693_771);
        expect(sc.sub_agency_fiscal_year).toBe(2027);
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text).toContain('**Fiscal Year:** 2026');
        expect(text).toContain('**Sub-Agency Fiscal Year:** 2027');
      });

      it('names no breakdown year when the page omits it and the budget year came after the cap', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        mockGetAgency.mockResolvedValueOnce(agencyFixture);
        mockGetAgencyBudgetaryResources.mockImplementationOnce(() => budgetAfter(8_000));
        mockGetAgencySubAgencies.mockClear();
        mockGetAgencySubAgencies.mockResolvedValueOnce(subPage(undefined));

        const pending = runToolContract(getAgencyTool, { toptier_code: '014' });
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await pending;

        expect(sentParams()).toEqual({ page: 1, limit: 10 });
        const sc = result.structuredContent as Record<string, unknown>;
        expect(sc.fiscal_year).toBe(2026);
        expect(sc).not.toHaveProperty('sub_agency_fiscal_year');
        const text = result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        expect(text).toContain('**Fiscal Year:** 2026');
        expect(text).not.toContain('Sub-Agency Fiscal Year');
      });
    });
  });

  it('formats output with agency details and sub-agency breakdown', () => {
    const output = {
      name: 'Department of Defense',
      abbreviation: 'DOD',
      toptier_code: '097',
      agency_id: 517,
      mission: 'Deter war and ensure national security.',
      fiscal_year: 2026,
      budgetary_resources_amount: 2_098_732_693_771,
      obligated_amount: 1_481_933_755_483,
      outlay_amount: 1_328_539_963_417,
      subtier_agency_count: 12,
      website: 'https://www.defense.gov',
      sub_agencies: [
        {
          name: 'Department of the Army',
          abbreviation: 'ARMY',
          total_obligations: 200_000_000_000,
          transaction_count: 1_500_000,
          new_award_count: 50_000,
        },
      ],
      sub_agency_page_metadata: { total: 25, page: 1, has_next: true, limit: 10 },
      def_codes: [{ code: 'M', public_law: '116-136', title: 'CARES Act' }],
    };

    const blocks = getAgencyTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Department of Defense');
    expect(text).toContain('097');
    expect(text).toContain('2,098,732,693,771');
    expect(text).toContain('200,000,000,000');
    expect(text).toContain('Army');
    expect(text).toContain('Has next:');
    expect(text).toContain('CARES Act');
  });
});
