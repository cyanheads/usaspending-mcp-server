/**
 * @fileoverview The shared count-input mechanism (#99), tabled once at its seam: the
 * capped schema in both USASPENDING_CLAMP_LIMITS states, the JSON Schema `tools/list`
 * advertises, string repair and rejection through the framework's argument parse, the
 * clamp with its log record, counter, `limitClamp` enrichment, and notice sentence,
 * and the uncapped `countInput()`. Each case loads the modules fresh so the config is
 * parsed the way `setup()` parses it, after import. Per-tool suites prove only wiring.
 * @module tests/tools/count-limit.test
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { advertisedProperty } from '../helpers/clamp-mode.js';

interface CounterAdd {
  attributes: unknown;
  name: string;
  value: number;
}

/**
 * Fresh `server-config` and `count-limit` modules, with `createCounter` recording what
 * it creates and adds. `USASPENDING_CLAMP_LIMITS` is stubbed before the import; `setup`
 * parses the config after it, as `createApp()` runs `setup()` after the tool modules
 * load. Left false, the config stays unparsed.
 */
async function load({ env, setup = true }: { env?: string; setup?: boolean } = {}) {
  vi.resetModules();
  if (env !== undefined) vi.stubEnv('USASPENDING_CLAMP_LIMITS', env);
  const created: string[] = [];
  const added: CounterAdd[] = [];
  vi.doMock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>()),
    createCounter: (name: string) => {
      created.push(name);
      return {
        add: (value: number, attributes: unknown) => added.push({ name, value, attributes }),
      };
    },
  }));
  const config = await import('@/config/server-config.js');
  const module = await import('@/mcp-server/tools/definitions/count-limit.js');
  const limit = module.countLimit({ tool: 'probe_tool', default: 10, cap: 100 });
  const runSetup = () => config.getServerConfig();
  if (setup) runSetup();
  return { ...module, added, created, limit, runSetup };
}

const advertised = (schema: z.ZodType) => advertisedProperty(z.object({ limit: schema }), 'limit');

afterEach(() => {
  vi.doUnmock('@cyanheads/mcp-ts-core/utils');
  vi.unstubAllEnvs();
});

const modes = [
  ['clamp (USASPENDING_CLAMP_LIMITS unset)', undefined],
  ['strict (USASPENDING_CLAMP_LIMITS=false)', 'false'],
] as const;

describe('countLimit schema', () => {
  it.each([
    [undefined, 1, true],
    [undefined, 100, true],
    [undefined, 101, true],
    [undefined, 5000, true],
    ['true', 101, true],
    ['false', 1, true],
    ['false', 100, true],
    ['false', 101, false],
    ['false', 5000, false],
  ] as const)(
    'USASPENDING_CLAMP_LIMITS=%s: limit %i accepted = %s, value unchanged',
    async (env, value, ok) => {
      const { limit } = await load(env === undefined ? {} : { env });

      const result = limit.schema.safeParse(value);

      expect(result.success).toBe(ok);
      if (result.success) expect(result.data).toBe(value);
      else
        expect(result.error.issues).toEqual([
          expect.objectContaining({ code: 'too_big', maximum: 100, inclusive: true }),
        ]);
    },
  );

  it.each(modes)('%s: rejects 0, -1, 1.5, 2^53, "abc", and true', async (_label, env) => {
    const { limit } = await load(env === undefined ? {} : { env });

    for (const value of [0, -1, 1.5, 2 ** 53, 'abc', true]) {
      expect(limit.schema.safeParse(value).success, `limit ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it.each(modes)('%s: defaults an absent limit to 10', async (_label, env) => {
    const { limit } = await load(env === undefined ? {} : { env });
    expect(limit.schema.parse(undefined)).toBe(10);
  });

  it('clamp mode advertises an integer with minimum 1 and the default, and no maximum key', async () => {
    const { limit } = await load();
    const described = limit.schema.describe('Rows per page. Default 10, at most 100 per call.');

    // Exact: `.int()` alone would emit `maximum: 9007199254740991`.
    expect(advertised(described)).toEqual({
      type: 'integer',
      minimum: 1,
      default: 10,
      description: 'Rows per page. Default 10, at most 100 per call.',
    });
    expect(advertised(described)).not.toHaveProperty('maximum');
  });

  it('strict mode advertises the cap as maximum, keeping the integer type and description', async () => {
    const { limit } = await load({ env: 'false' });
    const described = limit.schema.describe('Rows per page. Default 10, at most 100 per call.');

    expect(advertised(described)).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 100,
      default: 10,
      description: 'Rows per page. Default 10, at most 100 per call.',
    });
  });

  it('reads the config on each parse and emission: the same schema turns strict once setup() parses false', async () => {
    const { limit, runSetup } = await load({ env: 'false', setup: false });

    // Before setup(): the default, whatever the environment holds.
    expect(advertised(limit.schema)).not.toHaveProperty('maximum');
    expect(limit.schema.safeParse(101).success).toBe(true);

    runSetup();

    expect(advertised(limit.schema)).toHaveProperty('maximum', 100);
    expect(limit.schema.safeParse(101).success).toBe(false);
  });

  it('never parses the environment at import or emission: an invalid value reads as the default until setup()', async () => {
    const { limit, runSetup } = await load({ env: 'maybe', setup: false });

    expect(advertised(limit.schema)).not.toHaveProperty('maximum');
    expect(limit.schema.safeParse(5000).success).toBe(true);
    expect(runSetup).toThrow(/USASPENDING_CLAMP_LIMITS/);
  });

  it('throws at definition time when the default exceeds the cap', async () => {
    const { countLimit } = await load();
    expect(() => countLimit({ tool: 'probe_tool', default: 101, cap: 100 })).toThrow(
      /default 101 exceeds cap 100/,
    );
  });
});

describe('countLimit.apply', () => {
  it('returns a value at or under the cap unchanged, with no notice, log record, counter, or enrichment', async () => {
    const { limit, created, added } = await load();
    const ctx = createMockContext();

    expect(limit.apply(ctx, 'limit', 1)).toEqual({ applied: 1 });
    expect(limit.apply(ctx, 'limit', 100)).toEqual({ applied: 100 });

    expect((ctx.log as MockContextLogger).calls).toEqual([]);
    expect(added).toEqual([]);
    expect(getEnrichment(ctx)).not.toHaveProperty('limitClamp');
    // Created once at module scope (safe since mcp-ts-core 0.13.19), not per call.
    expect(created).toEqual(['usaspending.limit.clamped']);
  });

  it('reduces a value above the cap to the cap: one log record, one counter add, limitClamp, and the notice sentence', async () => {
    const { limit, added } = await load();
    const ctx = createMockContext();

    const result = limit.apply(ctx, 'limit', 101);

    expect(result).toEqual({
      applied: 100,
      notice: 'limit 101 exceeds the per-call maximum of 100; this call used limit 100.',
    });
    expect(getEnrichment(ctx)).toMatchObject({
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
    });
    expect((ctx.log as MockContextLogger).calls).toEqual([
      {
        level: 'info',
        msg: 'Clamped a count input to its per-call cap',
        data: { tool: 'probe_tool', field: 'limit', requested: 101, applied: 100 },
      },
    ]);
    expect(added).toEqual([
      {
        name: 'usaspending.limit.clamped',
        value: 1,
        attributes: { 'mcp.tool.name': 'probe_tool', 'usaspending.count_input': 'limit' },
      },
    ]);
  });
});

describe('countInput (no per-call cap)', () => {
  it.each(modes)(
    '%s: advertises no maximum and accepts any safe positive integer',
    async (_label, env) => {
      const { countInput } = await load(env === undefined ? {} : { env });
      const schema = countInput().optional().describe('Agencies per page');

      expect(advertised(schema)).toEqual({
        type: 'integer',
        minimum: 1,
        description: 'Agencies per page',
      });
      expect(schema.safeParse(100_000).success).toBe(true);
      for (const value of [0, -1, 1.5, 2 ** 53])
        expect(schema.safeParse(value).success, `value ${value}`).toBe(false);
    },
  );
});

describe('through the framework argument parse and enrichment merge', () => {
  /** A probe tool wired the way each clamping tool is. */
  async function probe(env?: string) {
    const { countLimit, LimitClampSchema, limitClampTrailer } = await load(
      env === undefined ? {} : { env },
    );
    const LIMIT = countLimit({ tool: 'probe_limit', default: 10, cap: 100 });
    return tool('probe_limit', {
      description: 'Probe tool for the count-limit seam.',
      annotations: { readOnlyHint: true },
      input: z.object({
        limit: LIMIT.schema.describe('Rows per page. Default 10, at most 100 per call.'),
      }),
      output: z.object({ rows: z.number().describe('Rows returned') }),
      enrichment: {
        limitClamp: LimitClampSchema,
        notice: z.string().optional().describe('Clamp and empty-page notices'),
      },
      enrichmentTrailer: { limitClamp: limitClampTrailer },
      handler(input, ctx) {
        const limit = LIMIT.apply(ctx, 'limit', input.limit);
        const notices = [limit.notice, 'Second notice.'].filter((n) => n !== undefined);
        ctx.enrich.notice(notices.join(' '));
        return { rows: limit.applied };
      },
      format: (r) => [{ type: 'text', text: `rows ${r.rows}` }],
    });
  }

  const text = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    result.content.map((b) => ('text' in b ? b.text : '')).join('\n');

  it('clamp mode: a value above the cap answers with limitClamp and the joined notice on both surfaces', async () => {
    const def = await probe();

    const result = await runToolContract(def, { limit: 101 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      rows: 100,
      limitClamp: { field: 'limit', requested: 101, applied: 100 },
      notice:
        'limit 101 exceeds the per-call maximum of 100; this call used limit 100. Second notice.',
    });
    const rendered = text(result);
    expect(rendered).toContain('rows 100');
    expect(rendered).toContain('**Limit clamp:** `limit` requested 101, applied 100');
    expect(rendered).toContain(
      'limit 101 exceeds the per-call maximum of 100; this call used limit 100. Second notice.',
    );
  });

  it('a value at the cap passes the enrichment parse with no limitClamp on either surface', async () => {
    const def = await probe();

    const result = await runToolContract(def, { limit: 100 });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ rows: 100, notice: 'Second notice.' });
    expect(text(result)).not.toContain('Limit clamp');
  });

  it.each(modes)('%s: repairs a stringified limit to a number', async (_label, env) => {
    const def = await probe(env);

    const result = await runToolContract(def, { limit: '100' as unknown as number });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ rows: 100 });
  });

  it('strict mode rejects above the cap with the standard too-big message, before the handler', async () => {
    const def = await probe('false');

    const result = await runToolContract(def, { limit: 101 });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain('Too big: expected number to be <=100');
  });

  it.each(modes)('%s: rejects 0 and 1.5 before the handler', async (_label, env) => {
    const def = await probe(env);

    for (const limit of [0, 1.5]) {
      const result = await runToolContract(def, { limit });
      expect(result.isError, `limit ${limit}`).toBe(true);
    }
  });
});
