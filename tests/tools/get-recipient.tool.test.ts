/**
 * @fileoverview Tests for get-recipient tool.
 * @module tests/tools/get-recipient.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { getRecipientTool } from '@/mcp-server/tools/definitions/get-recipient.tool.js';

const mockGetRecipient = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ getRecipient: mockGetRecipient }),
}));

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
