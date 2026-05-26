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
      business_types: ['23', '2X'],
      business_types_description: ['For Profit Organization', 'Large Business'],
      location: {
        address_line1: '123 Main St',
        city_name: 'Seattle',
        state_code: 'WA',
        zip5: '98101',
        country_code: 'USA',
      },
      total: {
        contracts: 10_000_000,
        grants: 500_000,
        direct_payments: 0,
        loans: 0,
        other: 100_000,
      },
      alternate_names: ['ACME CORP', 'Acme Inc'],
    });

    const ctx = createMockContext();
    const input = getRecipientTool.input.parse({ recipient_id: 'abc123-P' });
    const result = await getRecipientTool.handler(input, ctx);

    expect(result.name).toBe('Acme Corporation');
    expect(result.uei).toBe('ACMEAAAAAAAA');
    expect(result.recipient_level).toBe('P');
    expect(result.parent_name).toBe('Acme Holdings');
    expect(result.business_types).toEqual(['23', '2X']);
    expect(result.total?.contracts).toBe(10_000_000);
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
    mockGetRecipient.mockResolvedValueOnce({ name: 'Acme', total: { contracts: 100 } });

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
    expect(result.total).toBeUndefined();
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
      business_types: ['23'],
      business_types_description: ['For Profit Organization'],
      location: {
        address_line1: '123 Main St',
        address_line2: 'Suite 400',
        city_name: 'Seattle',
        state_code: 'WA',
        zip5: '98101',
        country_code: 'USA',
      },
      total: {
        contracts: 10_000_000,
        grants: 500_000,
        direct_payments: 0,
        loans: 0,
        other: 100_000,
      },
      alternate_names: ['ACME CORP'],
    };

    const blocks = getRecipientTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Acme Corporation');
    expect(text).toContain('abc123-P');
    expect(text).toContain('10,000,000');
    expect(text).toContain('ACME CORP');
  });
});
