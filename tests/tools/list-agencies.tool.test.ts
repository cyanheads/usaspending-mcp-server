/**
 * @fileoverview Tests for list-agencies tool.
 * @module tests/tools/list-agencies.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { listAgenciesTool } from '@/mcp-server/tools/definitions/list-agencies.tool.js';

const mockListAgencies = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({ listAgencies: mockListAgencies }),
}));

describe('listAgenciesTool', () => {
  it('returns a list of federal agencies', async () => {
    mockListAgencies.mockResolvedValueOnce({
      results: [
        {
          agency_name: 'Department of Agriculture',
          abbreviation: 'USDA',
          toptier_code: '012',
          agency_slug: 'department-of-agriculture',
          budget_authority_amount: 150_000_000_000,
          obligated_amount: 130_000_000_000,
          outlay_amount: 120_000_000_000,
        },
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 800_000_000_000,
          obligated_amount: 750_000_000_000,
          outlay_amount: 700_000_000_000,
        },
      ],
    });

    const ctx = createMockContext();
    const input = listAgenciesTool.input.parse({});
    const result = await listAgenciesTool.handler(input, ctx);

    expect(result.results).toHaveLength(2);
    expect(result.results[0].agency_name).toBe('Department of Agriculture');
    expect(result.results[0].toptier_code).toBe('012');
    expect(result.results[0].agency_slug).toBe('department-of-agriculture');
    expect(result.results[0].budget_authority_amount).toBe(150_000_000_000);
    expect(result.total).toBe(2);
  });

  it('returns empty results when no agencies are found', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext();
    const input = listAgenciesTool.input.parse({});
    const result = await listAgenciesTool.handler(input, ctx);

    expect(result.results).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('throws when service call fails', async () => {
    mockListAgencies.mockRejectedValueOnce(new Error('Service unavailable'));

    const ctx = createMockContext({ errors: listAgenciesTool.errors });
    const input = listAgenciesTool.input.parse({});
    await expect(listAgenciesTool.handler(input, ctx)).rejects.toThrow();
  });

  it('passes sort and order params through', async () => {
    mockListAgencies.mockResolvedValueOnce({ results: [] });

    const ctx = createMockContext();
    const input = listAgenciesTool.input.parse({
      sort: 'budget_authority_amount',
      order: 'desc',
    });
    await listAgenciesTool.handler(input, ctx);

    expect(mockListAgencies).toHaveBeenCalledWith(
      expect.objectContaining({ sort: 'budget_authority_amount', order: 'desc' }),
      ctx,
    );
  });

  it('formats output as a table with codes and amounts', () => {
    const output = {
      results: [
        {
          agency_name: 'Department of Defense',
          abbreviation: 'DOD',
          toptier_code: '097',
          agency_slug: 'department-of-defense',
          budget_authority_amount: 800_000_000_000,
          obligated_amount: 750_000_000_000,
          outlay_amount: 700_000_000_000,
        },
      ],
      total: 1,
    };

    const blocks = listAgenciesTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Department of Defense');
    expect(text).toContain('097');
    expect(text).toContain('department-of-defense');
    expect(text).toContain('800,000,000,000');
  });
});
