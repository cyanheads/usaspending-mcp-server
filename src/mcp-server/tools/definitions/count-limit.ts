/**
 * @fileoverview Result-count inputs (`limit`) and their per-call caps. With
 * USASPENDING_CLAMP_LIMITS on (the default), a capped count input advertises no
 * `maximum`, and a larger value is reduced to the cap: disclosed as the `limitClamp`
 * enrichment plus a notice sentence, with one log record and one counter increment.
 * Off, the cap is the advertised `maximum` and a larger value is rejected. The shape
 * follows the framework helper planned in cyanheads/mcp-ts-core#796
 * (`countLimit({ default, cap })` → `.schema` + `.apply(ctx, field, value)`), so
 * adopting it later renames nothing on the wire.
 * @module mcp-server/tools/definitions/count-limit
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { ATTR_MCP_TOOL_NAME, createCounter } from '@cyanheads/mcp-ts-core/utils';
import { clampLimitsEnabled } from '@/config/server-config.js';

/** Every count input reduced to its cap, attributed by tool and input name. */
const limitClamps = createCounter(
  'usaspending.limit.clamped',
  'Result-count inputs above their per-call cap, reduced to the cap',
  '{clamp}',
);

/**
 * A positive integer count with no advertised `maximum`, for a count input that has
 * no per-call cap. `.int()` alone emits Zod's safe-integer bound
 * (`maximum: 9007199254740991`); the `maximum: undefined` metadata drops it from the
 * emitted JSON Schema while the safe-integer check still runs.
 */
export function countInput() {
  return z.number().int().min(1).meta({ maximum: undefined });
}

/** The `limitClamp` enrichment field. Declare it in each clamping tool's `enrichment` block. */
export const LimitClampSchema = z
  .object({
    field: z.string().describe('Input that was reduced (e.g., limit)'),
    requested: z.number().describe('Value the caller sent'),
    applied: z.number().describe('Value the call used: the per-call cap'),
  })
  .optional()
  .describe('Present when a count input above its per-call cap was reduced to the cap.');

export type LimitClamp = NonNullable<z.infer<typeof LimitClampSchema>>;

/** The `limitClamp` entry for a clamping tool's `enrichmentTrailer`. */
export const limitClampTrailer = {
  render: (clamp: LimitClamp | undefined) =>
    clamp
      ? `**Limit clamp:** \`${clamp.field}\` requested ${clamp.requested}, applied ${clamp.applied}`
      : '',
};

/** What {@link CountLimit.apply} decided for one call. */
export interface AppliedCount {
  /** The value the call uses: the caller's, or the cap a larger one was reduced to. */
  applied: number;
  /**
   * The clamp sentence, present only when the value was reduced. `ctx.enrich.notice()`
   * is last-wins, so the tool joins it with its other notices into one call.
   */
  notice?: string;
}

/** A capped count input: its schema, its cap, and the per-call clamp. */
export interface CountLimit {
  /**
   * The value a call uses. Over the cap (reachable only while clamping), returns the
   * cap and the clamp sentence, writes `limitClamp` through `ctx.enrich`, logs one
   * record, and adds 1 to `usaspending.limit.clamped`.
   */
  apply(ctx: Context, field: string, value: number): AppliedCount;
  /** The per-call cap. */
  readonly cap: number;
  /**
   * Integer, minimum 1, defaulted. Its `maximum` and the strict `too_big` check follow
   * the switch, read on every parse and every `tools/list` emission, so nothing is read
   * at import. Add the tool's `.describe()`, worded true in both switch states.
   */
  readonly schema: ReturnType<typeof capped>;
}

function capped(defaultValue: number, cap: number) {
  return countInput()
    .check((payload) => {
      if (payload.value > cap && !clampLimitsEnabled()) {
        payload.issues.push({
          code: 'too_big',
          origin: 'number',
          maximum: cap,
          inclusive: true,
          input: payload.value,
        });
      }
    })
    .default(defaultValue)
    .meta({
      get maximum() {
        return clampLimitsEnabled() ? undefined : cap;
      },
    });
}

/**
 * Builds a capped count input for one tool.
 * @throws {Error} At definition time when `default` exceeds `cap`.
 */
export function countLimit(options: { cap: number; default: number; tool: string }): CountLimit {
  const { cap, tool } = options;
  if (options.default > cap) {
    throw new Error(`countLimit for ${tool}: default ${options.default} exceeds cap ${cap}`);
  }
  return {
    cap,
    schema: capped(options.default, cap),
    apply(ctx, field, value) {
      if (value <= cap) return { applied: value };
      const limitClamp: LimitClamp = { field, requested: value, applied: cap };
      ctx.log.info('Clamped a count input to its per-call cap', { tool, ...limitClamp });
      limitClamps.add(1, { [ATTR_MCP_TOOL_NAME]: tool, 'usaspending.count_input': field });
      ctx.enrich({ limitClamp });
      return {
        applied: cap,
        notice: `${field} ${value} exceeds the per-call maximum of ${cap}; this call used ${field} ${cap}.`,
      };
    },
  };
}
