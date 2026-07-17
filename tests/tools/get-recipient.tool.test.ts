/**
 * @fileoverview Tests for get-recipient tool.
 * @module tests/tools/get-recipient.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

    const ctx = createMockContext();
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

  it('passes fiscal_year and award_type through to service', async () => {
    mockGetRecipient.mockResolvedValueOnce({ name: 'Acme', total_transaction_amount: 100 });

    const ctx = createMockContext();
    const input = getRecipientTool.input.parse({
      recipient_id: 'abc123-P',
      fiscal_year: 2023,
      award_type: 'contracts',
    });
    await getRecipientTool.handler(input, ctx);

    expect(mockGetRecipient).toHaveBeenCalledWith(
      'abc123-P',
      expect.objectContaining({ fiscal_year: 2023, award_type: 'contracts' }),
      ctx,
    );
  });

  it('handles sparse recipient — no total or alternate names', async () => {
    mockGetRecipient.mockResolvedValueOnce({
      name: 'Minimal Corp',
      uei: 'MINIMALAAAAA',
    });

    const ctx = createMockContext();
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
