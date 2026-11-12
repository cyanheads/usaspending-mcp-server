/**
 * @fileoverview Tests for get-recipient tool.
 * @module tests/tools/get-recipient.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRecipientTool } from '@/mcp-server/tools/definitions/get-recipient.tool.js';
import { advertisedProperty, loadWithClampLimits } from '../helpers/clamp-mode.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockGetRecipient = vi.fn();
const mockGetRecipientChildren = vi.fn();
const CALL_DEADLINE = 1_900_000_000_000;

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getRecipient: mockGetRecipient,
    getRecipientChildren: mockGetRecipientChildren,
    requestDeadline: () => CALL_DEADLINE,
  }),
}));

mockGetRecipientChildren.mockResolvedValue([]);

describe('getRecipientTool', () => {
  it('returns full recipient profile for a valid ID', async () => {
    mockGetRecipient.mockResolvedValueOnce({
      name: 'Acme Corporation',
      uei: 'ACMEAAAAAAAA',
      duns: '123456789',
      recipient_id: 'abc123-P',
      recipient_level: 'P',
      parent_name: 'Acme Holdings',
      parent_uei: 'HOLDINGSAAAA',
      business_types: ['category_business', 'manufacturer_of_goods'],
      location: {
        address_line1: '123 Main St',
        city_name: 'Seattle',
        state_code: 'WA',
        zip: '98101',
        zip4: '1234',
        country_code: 'USA',
      },
      total_transaction_amount: 10_600_000,
      total_transactions: 42,
      total_face_value_loan_amount: 0,
      total_face_value_loan_transactions: 0,
      alternate_names: ['ACME CORP', 'Acme Inc'],
    });

    const ctx = createMockContext({ errors: getRecipientTool.errors });
    const input = getRecipientTool.input.parse({ recipient_id: 'abc123-P' });
    const result = await getRecipientTool.handler(input, ctx);

    expect(result.name).toBe('Acme Corporation');
    expect(result.uei).toBe('ACMEAAAAAAAA');
    expect(result.recipient_level).toBe('P');
    expect(result.parent_name).toBe('Acme Holdings');
    expect(result.business_types).toEqual(['category_business', 'manufacturer_of_goods']);
    // #26: flat aggregate fields + location.zip flow through; nested `total` and zip5 are gone.
    expect(result.total_transaction_amount).toBe(10_600_000);
    expect(result.total_transactions).toBe(42);
    // Zero-valued loan totals must be preserved, not dropped as falsy.
    expect(result.total_face_value_loan_amount).toBe(0);
    expect(result.total_face_value_loan_transactions).toBe(0);
    expect(result.location?.zip).toBe('98101');
    expect(result.location?.zip4).toBe('1234');
    expect(result).not.toHaveProperty('total');
    expect(result).not.toHaveProperty('business_types_description');
    expect(result.alternate_names).toContain('ACME CORP');
  });

  it('throws recipient_not_found when no name returned', async () => {
    mockGetRecipient.mockResolvedValueOnce({});

    const ctx = createMockContext({ errors: getRecipientTool.errors });
    const input = getRecipientTool.input.parse({ recipient_id: 'nonexistent-id' });
    await expect(getRecipientTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'recipient_not_found' },
    });
  });

  it('throws when service call fails', async () => {
    mockGetRecipient.mockRejectedValueOnce(new Error('Network error'));

    const ctx = createMockContext({ errors: getRecipientTool.errors });
    const input = getRecipientTool.input.parse({ recipient_id: 'abc123-P' });
    await expect(getRecipientTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes fiscal_year through to the service and nothing else', async () => {
    mockGetRecipient.mockResolvedValueOnce({ name: 'Acme', total_transaction_amount: 100 });

    const ctx = createMockContext({ errors: getRecipientTool.errors });
    const input = getRecipientTool.input.parse({ recipient_id: 'abc123-P', fiscal_year: 2023 });
    await getRecipientTool.handler(input, ctx);

    // #67: award_type was removed — no recipient-profile endpoint scopes by award type.
    expect(mockGetRecipient).toHaveBeenCalledWith('abc123-P', { fiscal_year: 2023 }, ctx);
  });

  describe('fiscal-year window and location (#67)', () => {
    const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
      result.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
    const allNullLocation = {
      address_line1: null,
      address_line2: null,
      address_line3: null,
      foreign_province: null,
      city_name: null,
      county_name: null,
      state_code: null,
      zip: null,
      zip4: null,
      foreign_postal_code: null,
      country_name: null,
      country_code: null,
      congressional_code: null,
    };

    it('keeps a location that carries only some fields', async () => {
      mockGetRecipient.mockResolvedValueOnce({
        name: 'Acme',
        location: { ...allNullLocation, country_code: 'USA' },
      });

      const result = await runToolContract(getRecipientTool, { recipient_id: 'abc123-P' });

      expect(result.structuredContent).toMatchObject({ location: { country_code: 'USA' } });
    });

    it('emits no location key when every upstream location field is null', async () => {
      mockGetRecipient.mockResolvedValueOnce({ name: 'Acme', location: allNullLocation });

      const result = await runToolContract(getRecipientTool, { recipient_id: 'abc123-P' });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('location');
      expect(textOf(result)).not.toContain('Address');
    });

    it('labels fiscal-year totals with the year on both surfaces', async () => {
      mockGetRecipient.mockResolvedValueOnce({
        name: 'Acme',
        total_transaction_amount: 1_965_443.74,
        total_transactions: 3,
      });

      const result = await runToolContract(getRecipientTool, {
        recipient_id: 'abc123-P',
        fiscal_year: 2020,
      });

      expect(result.structuredContent).toMatchObject({
        period: 'FY2020',
        total_transaction_amount: 1_965_443.74,
      });
      expect(textOf(result)).toContain('**Period:** FY2020');
    });

    it('states the trailing-12-month window when fiscal_year is omitted', async () => {
      mockGetRecipient.mockResolvedValueOnce({ name: 'Acme', total_transaction_amount: 100 });

      const result = await runToolContract(getRecipientTool, { recipient_id: 'abc123-P' });

      expect(result.structuredContent).toMatchObject({ period: 'trailing 12 months' });
      expect(textOf(result)).toContain('**Period:** trailing 12 months');
    });

    it('states the period even when the upstream returns no totals', async () => {
      mockGetRecipient.mockResolvedValueOnce({ name: 'Minimal Corp' });

      const result = await runToolContract(getRecipientTool, {
        recipient_id: 'abc123-P',
        fiscal_year: 2024,
      });

      expect(result.structuredContent).toMatchObject({ period: 'FY2024' });
      expect(textOf(result)).toContain('FY2024');
    });

    // Each pattern names the failing issue, not just the field: the recovery of any
    // unrecognized-key rejection lists every accepted key, fiscal_year included.
    it.each([
      ['award_type', { award_type: 'loans' }, /Unrecognized key: "award_type"/],
      ['a fractional fiscal_year', { fiscal_year: 2020.5 }, /fiscal_year: Invalid input/],
      ['a non-numeric fiscal_year', { fiscal_year: 'abc' }, /fiscal_year: Invalid input/],
      ['a fiscal_year past the range', { fiscal_year: 2031 }, /fiscal_year: Too big/],
    ])('rejects %s before any upstream request', async (_label, extra, field) => {
      mockGetRecipient.mockClear();

      const result = await runToolContract(getRecipientTool, {
        recipient_id: 'abc123-P',
        ...(extra as Record<string, unknown>),
      } as never);

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
      expect(textOf(result)).toMatch(field);
      expect(mockGetRecipient).not.toHaveBeenCalled();
    });

    it('points award-type questions to usaspending_spending_over_time', () => {
      expect(getRecipientTool.description).toContain('usaspending_spending_over_time');
      expect(getRecipientTool.description).not.toContain('fiscal year and award type');
    });

    it('no longer tells a timed-out caller to narrow with fiscal_year', () => {
      const timeout = getRecipientTool.errors?.find((e) => e.reason === 'api_timeout');
      expect(timeout).toBeDefined();
      expect(timeout?.recovery).not.toContain('fiscal_year');
    });
  });

  it('handles sparse recipient — no total or alternate names', async () => {
    mockGetRecipient.mockResolvedValueOnce({
      name: 'Minimal Corp',
      uei: 'MINIMALAAAAA',
    });

    const ctx = createMockContext({ errors: getRecipientTool.errors });
    const input = getRecipientTool.input.parse({ recipient_id: 'minimal-id' });
    const result = await getRecipientTool.handler(input, ctx);

    expect(result.name).toBe('Minimal Corp');
    expect(result.total_transaction_amount).toBeUndefined();
    expect(result.alternate_names).toBeUndefined();
  });

  it('formats output with name, ID, and totals', () => {
    const output = {
      name: 'Acme Corporation',
      uei: 'ACMEAAAAAAAA',
      duns: '123456789',
      recipient_id: 'abc123-P',
      recipient_level: 'P',
      parent_name: 'Acme Holdings',
      parent_uei: 'HOLDINGSAAAA',
      business_types: ['category_business'],
      location: {
        address_line1: '123 Main St',
        address_line2: 'Suite 400',
        city_name: 'Seattle',
        state_code: 'WA',
        zip: '98101',
        zip4: '1234',
        country_code: 'USA',
      },
      total_transaction_amount: 10_000_000,
      total_transactions: 42,
      total_face_value_loan_amount: 0,
      total_face_value_loan_transactions: 0,
      alternate_names: ['ACME CORP'],
      period: 'trailing 12 months',
    };

    const blocks = getRecipientTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('abc123-P');
    expect(text).toContain('10,000,000');
    expect(text).toContain('98101-1234');
    expect(text).toContain('ACME CORP');
  });
});

describe('parents and children (#110)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const textOf = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
  const structured = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.structuredContent as Record<string, unknown>;

  const ORACLE_P = 'c406663e-71aa-fbe3-4678-97f901f9fee6-P';
  const ORACLE_HEALTH_P = '9232b26d-789d-bdd2-5a6d-28714f1dfa2c-P';
  const CERNER_P = '7243a027-4829-4617-9d1b-bdf597c46c55-P';
  /** Profiles as `recipient/{id}/` answered them on 2026-11-12. */
  const oracleHealthChild = {
    name: 'ORACLE HEALTH GOVERNMENT SERVICES, INC.',
    recipient_id: '9232b26d-789d-bdd2-5a6d-28714f1dfa2c-C',
    recipient_level: 'C',
    uei: 'DT2KS3HH5FP5',
    duns: '080898173',
    parent_id: ORACLE_HEALTH_P,
    parent_name: 'ORACLE HEALTH GOVERNMENT SERVICES, INC.',
    parent_uei: 'DT2KS3HH5FP5',
    parent_duns: '080898173',
    parents: [
      {
        parent_duns: '080898173',
        parent_name: 'ORACLE HEALTH GOVERNMENT SERVICES, INC.',
        parent_id: ORACLE_HEALTH_P,
        parent_uei: 'DT2KS3HH5FP5',
      },
      {
        parent_duns: null,
        parent_name: 'ORACLE CORP',
        parent_id: ORACLE_P,
        parent_uei: 'ZFKQZW16QPU3',
      },
      {
        parent_duns: '042410688',
        parent_name: 'CERNER CORPORATION',
        parent_id: CERNER_P,
        parent_uei: 'DMHXTXRARC74',
      },
    ],
  };
  const oracleParent = {
    name: 'ORACLE CORP',
    recipient_id: ORACLE_P,
    recipient_level: 'P',
    uei: 'ZFKQZW16QPU3',
    duns: null,
    parent_id: ORACLE_P,
    parent_name: 'ORACLE CORP',
    parent_uei: 'ZFKQZW16QPU3',
    parent_duns: null,
    parents: [
      {
        parent_id: ORACLE_P,
        parent_duns: null,
        parent_uei: 'ZFKQZW16QPU3',
        parent_name: 'ORACLE CORP',
      },
    ],
  };
  const child = (n: number, amount: number | null) => ({
    recipient_id: `0000000${n}-0000-0000-0000-000000000000-C`,
    name: `CHILD ${String(n).padStart(3, '0')}`,
    uei: null,
    duns: null,
    amount,
    state_province: 'VA',
  });
  /** A 217-child family shaped like the largest one measured: 58 with an amount, 159 at $0, in upstream order. */
  const largeFamily = (size = 217, withAmount = 58) =>
    Array.from({ length: size }, (_, i) => child(i, i < withAmount ? (i + 1) * 1_000 : 0));

  const run = async (profile: unknown, input: Record<string, unknown> = {}) => {
    mockGetRecipient.mockResolvedValueOnce(profile);
    mockGetRecipientChildren.mockClear();
    const result = await runToolContract(getRecipientTool, {
      recipient_id: (profile as { recipient_id: string }).recipient_id,
      ...input,
    } as never);
    expect(result.isError).toBeFalsy();
    return result;
  };

  it('lists every parent of a -C recipient in upstream order, takes parent_id from the first, and requests no children', async () => {
    const result = await run(oracleHealthChild);

    const sc = structured(result);
    expect(sc.parents).toEqual([
      {
        parent_id: ORACLE_HEALTH_P,
        parent_name: 'ORACLE HEALTH GOVERNMENT SERVICES, INC.',
        parent_uei: 'DT2KS3HH5FP5',
        parent_duns: '080898173',
      },
      { parent_id: ORACLE_P, parent_name: 'ORACLE CORP', parent_uei: 'ZFKQZW16QPU3' },
      {
        parent_id: CERNER_P,
        parent_name: 'CERNER CORPORATION',
        parent_uei: 'DMHXTXRARC74',
        parent_duns: '042410688',
      },
    ]);
    expect(sc.parent_id).toBe((sc.parents as { parent_id: string }[])[0]?.parent_id);
    expect(sc).not.toHaveProperty('children');
    expect(sc).not.toHaveProperty('children_total');
    expect(mockGetRecipientChildren).not.toHaveBeenCalled();
    const text = textOf(result);
    expect(text).toContain(`**Parent ID (for get_recipient):** ${ORACLE_HEALTH_P}`);
    expect(text).toContain('### Parents');
    for (const value of [ORACLE_P, CERNER_P, 'CERNER CORPORATION', 'DMHXTXRARC74', '042410688'])
      expect(text).toContain(value);
  });

  it('drops a parents entry with no populated member and omits null members', async () => {
    const result = await run({
      ...oracleHealthChild,
      parents: [
        { parent_id: null, parent_name: null, parent_uei: null, parent_duns: null },
        { parent_id: null, parent_name: 'NAME ONLY', parent_uei: null, parent_duns: '' },
      ],
    });

    expect(structured(result).parents).toEqual([{ parent_name: 'NAME ONLY' }]);
  });

  it('lists a -P recipient as its own parent and ranks its children by amount, ties by name, a missing amount last', async () => {
    mockGetRecipientChildren.mockResolvedValueOnce([
      { ...child(1, 5), name: 'ZETA' },
      { ...child(2, null), name: 'NO AMOUNT' },
      { ...child(3, 5), name: 'BETA', uei: 'BETAUEI00001', duns: '000000003' },
      { ...child(4, -385_389.16), name: 'NEGATIVE' },
      { ...child(5, 9), name: 'TOP', state_province: null },
    ]);

    const result = await run(oracleParent);

    const sc = structured(result);
    expect(sc.parents).toEqual([
      { parent_id: ORACLE_P, parent_name: 'ORACLE CORP', parent_uei: 'ZFKQZW16QPU3' },
    ]);
    expect(sc.children).toEqual([
      { recipient_id: child(5, 9).recipient_id, name: 'TOP', amount: 9 },
      {
        recipient_id: child(3, 5).recipient_id,
        name: 'BETA',
        uei: 'BETAUEI00001',
        duns: '000000003',
        amount: 5,
        state_province: 'VA',
      },
      { recipient_id: child(1, 5).recipient_id, name: 'ZETA', amount: 5, state_province: 'VA' },
      {
        recipient_id: child(4, 0).recipient_id,
        name: 'NEGATIVE',
        amount: -385_389.16,
        state_province: 'VA',
      },
      { recipient_id: child(2, 0).recipient_id, name: 'NO AMOUNT', state_province: 'VA' },
    ]);
    expect(sc.children_total).toBe(5);
    expect(sc).not.toHaveProperty('truncated');
    expect(mockGetRecipientChildren).toHaveBeenCalledWith(
      'ZFKQZW16QPU3',
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      CALL_DEADLINE,
    );
    const text = textOf(result);
    expect(text).toContain('### Child Recipients');
    expect(text).toContain('| Recipient | Recipient ID | UEI | DUNS | State | Amount |');
    expect(text).toContain(
      `| BETA | ${child(3, 5).recipient_id} | BETAUEI00001 | 000000003 | VA | $5 |`,
    );
    expect(text).toContain(
      `| NEGATIVE | ${child(4, 0).recipient_id} | N/A | N/A | VA | -$385,389.16 |`,
    );
    expect(text).toContain(`| NO AMOUNT | ${child(2, 0).recipient_id} | N/A | N/A | VA | N/A |`);
    expect(text).toContain('**Children:** 5 of 5');
  });

  it('returns children [] and children_total 0 for a parent with none', async () => {
    mockGetRecipientChildren.mockResolvedValueOnce([]);

    const result = await run(oracleParent);

    expect(structured(result)).toMatchObject({ children: [], children_total: 0 });
    expect(textOf(result)).toContain('**Children:** 0 of 0');
  });

  it('returns no parent_id, parents, or children for a -R recipient and requests no children', async () => {
    const result = await run({
      name: 'UNIVERSITY OF CALIFORNIA, SAN DIEGO',
      recipient_id: 'ce42d274-7283-659b-de1c-e11666794c48-R',
      recipient_level: 'R',
      uei: 'UYTTZT6G9DT1',
      duns: '804355790',
      parent_id: null,
      parent_name: null,
      parent_uei: null,
      parent_duns: null,
      parents: [],
    });

    for (const key of [
      'parent_id',
      'parents',
      'children',
      'children_total',
      'unavailable_sections',
    ])
      expect(structured(result)).not.toHaveProperty(key);
    expect(mockGetRecipientChildren).not.toHaveBeenCalled();
  });

  it('looks children up by DUNS when the parent has no UEI, scoped to the fiscal year', async () => {
    mockGetRecipientChildren.mockResolvedValueOnce([]);

    await run({ ...oracleParent, uei: null, duns: '123456789' }, { fiscal_year: 2025 });

    expect(mockGetRecipientChildren.mock.calls[0]?.slice(0, 2)).toEqual([
      '123456789',
      { fiscal_year: 2025 },
    ]);
  });

  it('discloses children as unavailable for a -P profile with neither UEI nor DUNS', async () => {
    const result = await run({ ...oracleParent, uei: null, duns: null });

    const sc = structured(result);
    expect(mockGetRecipientChildren).not.toHaveBeenCalled();
    expect(sc).not.toHaveProperty('children');
    expect(sc.unavailable_sections).toEqual([
      {
        section: 'children',
        reason: 'upstream_error',
        retryable: false,
        message:
          'USAspending lists children by the parent UEI or DUNS, and this parent profile carries neither.',
      },
    ]);
    expect(sc.notice).toContain('Partial result: children (upstream_error)');
    expect(markdownText(textOf(result))).toContain(String(sc.notice));
  });

  it.each([
    [
      'unavailable',
      new McpError(JsonRpcErrorCode.ServiceUnavailable, 'Fetch failed. Status: 503', {
        reason: 'api_unavailable',
        retryable: true,
      }),
      { reason: 'api_unavailable', retryable: true },
    ],
    [
      'timed out',
      new McpError(JsonRpcErrorCode.Timeout, 'USAspending did not answer within 5000ms', {
        reason: 'api_timeout',
        retryable: true,
      }),
      { reason: 'api_timeout', retryable: true },
    ],
    [
      'rejected',
      new McpError(JsonRpcErrorCode.InvalidParams, 'USAspending rejected it (HTTP 400): no', {
        status: 400,
      }),
      { reason: 'upstream_error', retryable: false },
    ],
  ])(
    'returns the profile with children unavailable when the children read is %s',
    async (_label, err, entry) => {
      mockGetRecipientChildren.mockRejectedValueOnce(err);

      const result = await run(oracleParent);

      const sc = structured(result);
      expect(sc.name).toBe('ORACLE CORP');
      expect(sc.parents).toHaveLength(1);
      expect(sc).not.toHaveProperty('children');
      expect(sc).not.toHaveProperty('children_total');
      expect(sc.unavailable_sections).toEqual([
        { section: 'children', ...entry, message: err.message },
      ]);
      const text = textOf(result);
      expect(text).not.toContain('Child Recipients');
      expect(text).toContain(
        `- children: ${entry.reason}${entry.retryable ? ' (retryable)' : ''} — ${err.message}`,
      );
      expect(markdownText(text)).toContain(String(sc.notice));
    },
  );

  it('rethrows a children failure that is not a classified upstream error', async () => {
    mockGetRecipientChildren.mockRejectedValueOnce(new TypeError('boom'));
    mockGetRecipient.mockResolvedValueOnce(oracleParent);

    const result = await runToolContract(getRecipientTool, { recipient_id: ORACLE_P });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InternalError, message: expect.stringContaining('boom') },
    });
  });

  it.each([
    ['an AbortError', () => new DOMException('The operation was aborted.', 'AbortError')],
    [
      'the classified fetch abort',
      () =>
        new McpError(JsonRpcErrorCode.RequestCancelled, 'Fetch aborted', {
          errorSource: 'FetchAborted',
        }),
    ],
  ])(
    'rejects the handler with %s when the caller cancels during the children read',
    async (_label, abortError) => {
      mockGetRecipient.mockResolvedValueOnce(oracleParent);
      const raised = abortError();
      mockGetRecipientChildren.mockImplementationOnce(
        (_key: string, _params: unknown, ctx: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            ctx.signal.addEventListener('abort', () => reject(raised));
          }),
      );
      const caller = new AbortController();

      const pending = getRecipientTool.handler(
        getRecipientTool.input.parse({ recipient_id: ORACLE_P }),
        createMockContext({ errors: getRecipientTool.errors, signal: caller.signal }),
      );
      await vi.waitFor(() => expect(mockGetRecipientChildren).toHaveBeenCalled());
      caller.abort();

      await expect(pending).rejects.toBe(raised);
    },
  );

  describe('children_limit', () => {
    it('returns the 50 highest-amount children of 217 by default, with the full count and the truncation', async () => {
      mockGetRecipientChildren.mockResolvedValueOnce(largeFamily());

      const result = await run(oracleParent);

      const sc = structured(result);
      const children = sc.children as { name: string; amount: number }[];
      expect(children).toHaveLength(50);
      expect(children[0]).toMatchObject({ name: 'CHILD 057', amount: 58_000 });
      expect(children.at(-1)).toMatchObject({ name: 'CHILD 008', amount: 9_000 });
      expect(sc).toMatchObject({ children_total: 217, truncated: true, shown: 50, cap: 50 });
      expect(sc).not.toHaveProperty('limitClamp');
      expect(sc.notice).toBe(
        'Showing the 50 highest-amount of 217 child recipients. Raise children_limit (at most 500) to see more.',
      );
      const text = textOf(result);
      expect(text).toContain('**Children:** 50 of 217');
      expect(markdownText(text)).toContain(String(sc.notice));
    });

    it('clamps children_limit 600 to 500 and returns all 217 with the clamp on both surfaces', async () => {
      mockGetRecipientChildren.mockResolvedValueOnce(largeFamily());

      const result = await run(oracleParent, { children_limit: 600 });

      const sc = structured(result);
      expect(sc.children).toHaveLength(217);
      expect(sc).toMatchObject({
        children_total: 217,
        limitClamp: { field: 'children_limit', requested: 600, applied: 500 },
        notice:
          'children_limit 600 exceeds the per-call maximum of 500; this call used children_limit 500.',
      });
      expect(sc).not.toHaveProperty('truncated');
      const text = textOf(result);
      expect(text).toContain('**Limit clamp:** `children_limit` requested 600, applied 500');
      expect(markdownText(text)).toContain(String(sc.notice));
    });

    it('keeps the clamp and truncation sentences together when 501 children meet children_limit 600', async () => {
      mockGetRecipientChildren.mockResolvedValueOnce(largeFamily(501, 501));

      const result = await run(oracleParent, { children_limit: 600 });

      const sc = structured(result);
      expect(sc.children).toHaveLength(500);
      expect(sc).toMatchObject({ children_total: 501, truncated: true, shown: 500, cap: 500 });
      expect(sc.notice).toBe(
        'children_limit 600 exceeds the per-call maximum of 500; this call used children_limit 500. Showing the 500 highest-amount of 501 child recipients. 500 is the most one call returns.',
      );
    });

    it('reports no truncation when the children exactly fill children_limit', async () => {
      mockGetRecipientChildren.mockResolvedValueOnce(largeFamily(3, 3));

      const result = await run(oracleParent, { children_limit: 3 });

      const sc = structured(result);
      expect(sc).toMatchObject({ children_total: 3 });
      expect(sc.children).toHaveLength(3);
      for (const key of ['truncated', 'shown', 'cap', 'notice', 'limitClamp'])
        expect(sc).not.toHaveProperty(key);
    });

    it('applies no clamp to a -C profile, which never reads children_limit', async () => {
      const result = await run(oracleHealthChild, { children_limit: 600 });

      expect(structured(result)).not.toHaveProperty('limitClamp');
      expect(structured(result)).not.toHaveProperty('notice');
    });

    // A numeric string such as '5' is not here: the framework repairs it to 5 before validation.
    it.each([0, -1, 1.5, 'five'])(
      'rejects children_limit %j before any upstream request',
      async (value) => {
        mockGetRecipient.mockClear();

        const result = await runToolContract(getRecipientTool, {
          recipient_id: ORACLE_P,
          children_limit: value,
        } as never);

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: { code: JsonRpcErrorCode.InvalidParams },
        });
        expect(mockGetRecipient).not.toHaveBeenCalled();
      },
    );

    it('advertises no maximum by default, and maximum 500 with rejection under USASPENDING_CLAMP_LIMITS=false', async () => {
      expect(advertisedProperty(getRecipientTool.input, 'children_limit')).toEqual({
        type: 'integer',
        minimum: 1,
        default: 50,
        description:
          'Child recipients to return for a parent (-P) profile, highest amount first. Default 50, at most 500 per call. Ignored for -C and -R profiles.',
      });

      const strict = await loadWithClampLimits(
        'false',
        async () =>
          (await import('@/mcp-server/tools/definitions/get-recipient.tool.js')).getRecipientTool,
      );

      expect(advertisedProperty(strict.input, 'children_limit')).toMatchObject({ maximum: 500 });
      mockGetRecipient.mockClear();
      const rejected = await runToolContract(strict, {
        recipient_id: ORACLE_P,
        children_limit: 501,
      });
      expect(rejected.isError).toBe(true);
      expect(textOf(rejected)).toContain('Too big: expected number to be <=500');
      expect(mockGetRecipient).not.toHaveBeenCalled();
    });
  });
});
