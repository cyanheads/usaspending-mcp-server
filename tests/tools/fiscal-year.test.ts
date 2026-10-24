/**
 * @fileoverview Federal-account fiscal-year grammar and reporting dates.
 * @module tests/tools/fiscal-year.test
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountFiscalYearRange,
  accountFiscalYearSchema,
  normalizeAccountFiscalYear,
} from '@/mcp-server/tools/definitions/fiscal-year.js';
import { getFederalAccountTool } from '@/mcp-server/tools/definitions/get-federal-account.tool.js';
import { getFederalAccountBreakdownTool } from '@/mcp-server/tools/definitions/get-federal-account-breakdown.tool.js';
import { searchFederalAccountsTool } from '@/mcp-server/tools/definitions/search-federal-accounts.tool.js';

describe('account fiscal years', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([2001, 2024, 2025, 2027, undefined, '', '  '])(
    'accepts supported years and blanks: %s',
    (year) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
      expect(accountFiscalYearSchema.safeParse(year).success).toBe(true);
    },
  );

  it.each([
    2000,
    2028,
    2025.5,
    '2025',
    'FY2025',
    '2025.0',
    null,
    true,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects malformed or unsupported years: %s', (year) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
    expect(accountFiscalYearSchema.safeParse(year).success).toBe(false);
  });

  it('changes the maximum at October 1 without reloading the schema', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T23:59:59Z'));
    expect(accountFiscalYearSchema.safeParse(2026).success).toBe(true);
    expect(accountFiscalYearSchema.safeParse(2027).success).toBe(false);
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    expect(accountFiscalYearSchema.safeParse(2027).success).toBe(true);
  });

  it.each([
    [2024, '2023-10-01', '2024-09-30'],
    [2025, '2024-10-01', '2025-09-30'],
  ] as const)('maps FY%i to full reporting dates', (year, start, end) => {
    expect(accountFiscalYearRange(year)).toEqual({ start_date: start, end_date: end });
  });

  it.each([
    [2025, 2025],
    ['2025', 2025],
    [null, undefined],
    [undefined, undefined],
  ] as const)('normalizes upstream year %s to %s', (raw, expected) => {
    expect(normalizeAccountFiscalYear(raw)).toBe(expected);
  });

  it.each([
    [searchFederalAccountsTool.input, {}],
    [getFederalAccountTool.input, { account_code: '014-0680' }],
    [
      getFederalAccountBreakdownTool.input,
      { account_code: '014-0680', dimension: 'program_activity' },
    ],
  ] as const)('uses the same grammar in every account tool', (schema, required) => {
    expect(schema.safeParse({ ...required, fiscal_year: 'FY2025' }).success).toBe(false);
    expect(schema.safeParse({ ...required, fiscal_year: 2025 }).success).toBe(true);
    expect(schema.safeParse({ ...required, fiscal_year: '' }).success).toBe(true);
  });
});
