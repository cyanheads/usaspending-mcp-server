/**
 * @fileoverview Tests for get-federal-account tool.
 * @module tests/tools/get-federal-account.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFederalAccountTool } from '@/mcp-server/tools/definitions/get-federal-account.tool.js';
import { markdownText } from '../helpers/markdown-text.js';

const mockGetFederalAccount = vi.fn();

vi.mock('@/services/usaspending/usaspending-service.js', () => ({
  getUSASpendingService: () => ({
    getFederalAccount: mockGetFederalAccount,
  }),
}));

describe('getFederalAccountTool', () => {
  beforeEach(() => {
    mockGetFederalAccount.mockReset();
  });
  // Selected fields from the captured FY2024/FY2025 detail responses for 014-0680.
  it.each([
    [2024, 4_007_029_840.24, 10_735_587_629.51],
    [2025, 4_117_711_187.29, 10_130_607_579.09],
  ])(
    'preserves captured FY%i totals independently of search totals',
    async (year, obligations, resources) => {
      mockGetFederalAccount.mockResolvedValueOnce({
        account_title: 'Water and Related Resources, Bureau of Reclamation, Interior',
        federal_account_code: '014-0680',
        fiscal_year: String(year),
        total_obligated_amount: obligations,
        total_budgetary_resources: resources,
      });
      const result = await runToolContract(getFederalAccountTool, {
        account_code: '014-0680',
        fiscal_year: year,
      });
      expect(result.structuredContent).toMatchObject({
        fiscal_year: year,
        total_obligated_amount: obligations,
        total_budgetary_resources: resources,
      });
      const rendered = markdownText(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      );
      expect(rendered).toContain(String(year));
      expect(rendered).toContain(year === 2024 ? '4,007,029,840.24' : '4,117,711,187.29');
      expect(rendered).toContain(year === 2024 ? '10,735,587,629.51' : '10,130,607,579.09');
    },
  );
  it('selects a historical year and normalizes its string year without losing real zeros', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Water and Related Resources',
      fiscal_year: '2025',
      total_obligated_amount: 0,
      children: [{ code: '014-0680', obligated_amount: 0 }],
    });
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '014-0680',
      fiscal_year: 2025,
    });
    expect(mockGetFederalAccount).toHaveBeenLastCalledWith('014-0680', expect.anything(), 2025);
    expect(result.structuredContent).toMatchObject({
      fiscal_year: 2025,
      total_obligated_amount: 0,
      children: [{ obligated_amount: 0 }],
    });
    expect(result.structuredContent).not.toHaveProperty('notice');
    expect(JSON.stringify(result.content)).toContain('**Fiscal Year:** 2025');
    const rendered = markdownText(
      result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n'),
    );
    expect(rendered).toContain('Fiscal Year:');
    expect(rendered).toContain('2025');
    expect(JSON.stringify(result.content)).toContain('$0');
  });

  it('rejects a malformed year before calling the service', async () => {
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '014-0680',
      fiscal_year: 'FY2025',
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.InvalidParams },
    });
    expect(mockGetFederalAccount).not.toHaveBeenCalled();
  });

  it('keeps an explicitly empty year with metadata and a notice on both surfaces', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Water and Related Resources',
      fiscal_year: '2027',
      total_obligated_amount: null,
      total_gross_outlay_amount: null,
      total_budgetary_resources: null,
      children: [],
    });
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '014-0680',
      fiscal_year: 2027,
    });
    expect(result.structuredContent).toMatchObject({
      account_title: 'Water and Related Resources',
      fiscal_year: 2027,
      notice: expect.stringContaining('2027'),
    });
    expect(result.structuredContent).not.toHaveProperty('total_obligated_amount');
    expect(result.structuredContent).not.toHaveProperty('children');
    expect(JSON.stringify(result.content)).toContain('2027');
    expect(JSON.stringify(result.content)).toContain('No financial');
    expect(mockGetFederalAccount).toHaveBeenLastCalledWith('014-0680', expect.anything(), 2027);
  });

  it('treats a blank detail year as omitted', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({ account_title: 'Water and Related Resources' });
    const result = await runToolContract(getFederalAccountTool, {
      account_code: '014-0680',
      fiscal_year: '',
    });
    expect(result.isError).not.toBe(true);
    expect(mockGetFederalAccount).toHaveBeenLastCalledWith('014-0680', expect.anything());
  });
  it('preserves the default detail request without a year', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({ account_title: 'Test Account' });
    const result = await runToolContract(getFederalAccountTool, { account_code: '014-0680' });
    expect(mockGetFederalAccount).toHaveBeenLastCalledWith('014-0680', expect.anything());
    expect(result.isError).not.toBe(true);
    expect(getFederalAccountTool.output.parse(result.structuredContent)).toEqual({
      account_title: 'Test Account',
    });
    expect(
      markdownText(
        result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n'),
      ),
    ).toContain('Test Account');
  });
  it('returns federal account details with financial totals', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Operation and Maintenance, Defense-Wide, Defense',
      federal_account_code: '097-0100',
      agency_identifier: '097',
      main_account_code: '0100',
      parent_agency_name: 'Department of Defense',
      bureau_name: 'Operation and Maintenance',
      total_obligated_amount: 28_107_078_661.46,
      total_gross_outlay_amount: 25_436_487_564.21,
      total_budgetary_resources: 77_226_422_906.39,
      fiscal_year: 2026,
    });

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0100' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.account_title).toBe('Operation and Maintenance, Defense-Wide, Defense');
    expect(result.federal_account_code).toBe('097-0100');
    expect(result.parent_agency_name).toBe('Department of Defense');
    expect(result.bureau_name).toBe('Operation and Maintenance');
    expect(result.total_obligated_amount).toBe(28_107_078_661.46);
    expect(result.total_gross_outlay_amount).toBe(25_436_487_564.21);
    expect(result.total_budgetary_resources).toBe(77_226_422_906.39);
    expect(result.fiscal_year).toBe(2026);
  });

  it('maps the children Treasury Account Symbol breakdown', async () => {
    // Verbatim shape of two of the seven children the live API returns for 080-0120.
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Science, National Aeronautics and Space Administration',
      federal_account_code: '080-0120',
      children: [
        {
          name: 'Science, National Aeronautics and Space Administration',
          code: '080-2020/2021-0120-000',
          obligated_amount: 80_867.4,
          gross_outlay_amount: 996_051.75,
          budgetary_resources_amount: 13_551_991.48,
        },
        {
          name: 'Science, National Aeronautics and Space Administration',
          code: '080-2026/2027-0120-000',
          obligated_amount: 3_436_332_447.12,
          gross_outlay_amount: 905_838_263.09,
          budgetary_resources_amount: 7_250_000_000,
        },
      ],
    });

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '080-0120' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.children).toHaveLength(2);
    expect(result.children?.[0]).toEqual({
      name: 'Science, National Aeronautics and Space Administration',
      code: '080-2020/2021-0120-000',
      obligated_amount: 80_867.4,
      gross_outlay_amount: 996_051.75,
      budgetary_resources_amount: 13_551_991.48,
    });
    expect(result.children?.[1]?.code).toBe('080-2026/2027-0120-000');
    expect(result.children?.[1]?.budgetary_resources_amount).toBe(7_250_000_000);
  });

  it('omits children when upstream returns none', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Test Account',
      federal_account_code: '097-0200',
      children: [],
    });

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0200' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.children).toBeUndefined();
  });

  it('handles a sparse child — amounts omitted by upstream', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Test Account',
      federal_account_code: '097-0200',
      children: [{ code: '097-2021/2025-0100-000' }],
    });

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0200' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.children).toHaveLength(1);
    expect(result.children?.[0]?.code).toBe('097-2021/2025-0100-000');
    expect(result.children?.[0]?.name).toBeUndefined();
    expect(result.children?.[0]?.obligated_amount).toBeUndefined();
    expect(result.children?.[0]?.gross_outlay_amount).toBeUndefined();
    expect(result.children?.[0]?.budgetary_resources_amount).toBeUndefined();
  });

  it('returns account without financial totals when absent', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({
      account_title: 'Test Account',
      federal_account_code: '097-0200',
      agency_identifier: '097',
    });

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0200' });
    const result = await getFederalAccountTool.handler(input, ctx);

    expect(result.account_title).toBe('Test Account');
    expect(result.total_obligated_amount).toBeUndefined();
    expect(result.total_budgetary_resources).toBeUndefined();
  });

  it('throws account_not_found when no account_title returned', async () => {
    mockGetFederalAccount.mockResolvedValueOnce({});

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '999-9999' });
    await expect(getFederalAccountTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'account_not_found' },
    });
  });

  it('throws when service call fails', async () => {
    mockGetFederalAccount.mockRejectedValueOnce(new Error('API error'));

    const ctx = createMockContext({ errors: getFederalAccountTool.errors });
    const input = getFederalAccountTool.input.parse({ account_code: '097-0100' });
    await expect(getFederalAccountTool.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with account details and financial totals', () => {
    const output = {
      account_title: 'Operation and Maintenance, Defense-Wide, Defense',
      federal_account_code: '097-0100',
      agency_identifier: '097',
      main_account_code: '0100',
      parent_agency_name: 'Department of Defense',
      bureau_name: 'Operation and Maintenance',
      fiscal_year: 2026,
      total_obligated_amount: 28_107_078_661.46,
      total_gross_outlay_amount: 25_436_487_564.21,
      total_budgetary_resources: 77_226_422_906.39,
    };

    const blocks = getFederalAccountTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('097-0100');
    expect(text).toContain('Department of Defense');
    expect(text).toContain('Operation and Maintenance');
    expect(text).toContain('2026');
  });

  it('renders the children breakdown in content[] at parity with structuredContent', () => {
    const output = {
      account_title: 'Science, National Aeronautics and Space Administration',
      federal_account_code: '080-0120',
      children: [
        {
          name: 'Science, National Aeronautics and Space Administration',
          code: '080-2020/2021-0120-000',
          obligated_amount: 80_867.4,
          gross_outlay_amount: 996_051.75,
          budgetary_resources_amount: 13_551_991.48,
        },
      ],
    };

    const blocks = getFederalAccountTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Treasury Account Symbols');
    expect(text).toContain('080-2020/2021-0120-000');
    expect(text).toContain('80,867.4');
    expect(text).toContain('996,051.75');
    expect(text).toContain('13,551,991.48');
  });

  it('renders a sparse child without inventing amounts', () => {
    const output = {
      account_title: 'Test Account',
      federal_account_code: '097-0200',
      children: [{ code: '097-2021/2025-0100-000' }],
    };

    const blocks = getFederalAccountTool.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('097-2021/2025-0100-000');
    // Missing amounts render as N/A — never as $0.
    expect(text).toContain('N/A');
    expect(text).not.toContain('$0');
  });
});
