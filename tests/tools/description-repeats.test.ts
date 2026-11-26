/**
 * @fileoverview Each description is stated once per tool (#131). A field that
 * repeats another field of the same tool — a nested twin of a flat input, a
 * second copy of the location object — carries a pointer at the first, under 80
 * characters, plus only what differs; a rule spanning several fields sits once
 * on their parent (for root fields, the tool description). Repeats across tools
 * stay: a client can load one tool's schema alone.
 * @module tests/tools/description-repeats.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchAwardsTool } from '@/mcp-server/tools/definitions/search-awards.tool.js';

/** A description this long must not occur twice in one tool; a pointer stays shorter. */
const MIN_REPEAT_CHARS = 80;

interface ToolLike {
  description: string;
  enrichment?: z.ZodRawShape | undefined;
  input: z.ZodObject;
  output: z.ZodObject;
}

interface Described {
  path: string;
  text: string;
}

/** Every `description` under `node`, keyed by its path: property names, `items`, `anyOf.N`. */
function collect(node: unknown, path: string[], out: Described[]): void {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) collect(child, [...path, String(i)], out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') {
      out.push({ path: path.join('.'), text: value });
    } else collect(value, key === 'properties' ? path : [...path, key], out);
  }
}

/** A JSON Schema as `~standard` emits it, the input schema's root included. */
const jsonSchema = (schema: z.ZodObject, io: 'input' | 'output') =>
  schema['~standard'].jsonSchema[io]({ target: 'draft-2020-12' });

/**
 * The tool description and every description in its `inputSchema` and
 * `outputSchema` as `tools/list` advertises them: the SDK reads both through
 * `~standard`, and the advertised output is `output` with `enrichment` merged
 * in. The framework's `error` member, generated from `errors[]`, states each
 * reason's `when` once and is left out.
 */
function descriptionsOf(def: ToolLike): Described[] {
  const out: Described[] = [{ path: 'description', text: def.description }];
  collect(jsonSchema(def.input, 'input'), ['inputSchema'], out);
  const output = z.object({ ...def.output.shape, ...def.enrichment });
  collect(jsonSchema(output, 'output'), ['outputSchema'], out);
  return out;
}

/** Descriptions of at least {@link MIN_REPEAT_CHARS} characters that occur more than once, with every path. */
function repeatsIn(def: ToolLike): { paths: string[]; text: string }[] {
  const byText = new Map<string, string[]>();
  for (const { path, text } of descriptionsOf(def)) {
    if (text.length >= MIN_REPEAT_CHARS) byText.set(text, [...(byText.get(text) ?? []), path]);
  }
  return [...byText]
    .filter(([, paths]) => paths.length > 1)
    .map(([text, paths]) => ({ paths, text: `${text.slice(0, 60)}…` }));
}

describe('each description of 80 or more characters is stated once per tool (#131)', () => {
  it('flags an 80-character repeat across the tool description, input (a union member included), output, and enrichment, naming every path, and nothing of 79', () => {
    // Literal lengths: the boundary is the guard's contract, not whatever the constant reads.
    const long = 'A'.repeat(80);
    const short = 'B'.repeat(79);
    const fake: ToolLike = {
      description: long,
      input: z.object({
        flat: z.string().describe(long),
        nested: z
          .object({
            flat: z.array(z.string().describe(short)).describe(long),
            other: z.string().describe(short),
          })
          .describe('Nested twin'),
        either: z.union([z.string().describe(long), z.number().describe(short)]),
      }),
      output: z.object({ echo: z.string().describe(short) }),
      enrichment: { notice: z.string().optional().describe(long) },
    };

    expect(repeatsIn(fake)).toEqual([
      {
        paths: [
          'description',
          'inputSchema.flat',
          'inputSchema.nested.flat',
          'inputSchema.either.anyOf.0',
          'outputSchema.notice',
        ],
        text: `${long.slice(0, 60)}…`,
      },
    ]);
  });

  it.each(allToolDefinitions.map((def) => ({ name: def.name, def })))('$name', ({ def }) => {
    expect(descriptionsOf(def as ToolLike).length).toBeGreaterThan(1);
    expect(repeatsIn(def as ToolLike)).toEqual([]);
  });
});

interface JsonNode {
  description?: string;
  properties?: Record<string, JsonNode>;
  [key: string]: unknown;
}

/** A schema node with every description removed, at any depth: the part validation reads. */
const stripDescriptions = (node: unknown): unknown =>
  JSON.parse(JSON.stringify(node, (key, value) => (key === 'description' ? undefined : value)));

describe('usaspending_search_awards points each nested twin at its top-level field (#131)', () => {
  const root = (jsonSchema(searchAwardsTool.input, 'input') as JsonNode).properties!;
  const nested = root.filters!.properties!;

  /** Each nested field and the top-level field it repeats, as a dotted path. */
  const TWIN_OF: Record<string, string> = {
    keywords: 'keyword',
    award_type_codes: 'award_type_codes',
    agency_name: 'agency_name',
    funding_agency_name: 'funding_agency_name',
    recipient_name: 'recipient_name',
    naics_codes: 'naics_codes',
    assistance_listings: 'assistance_listings',
    psc_codes: 'psc_codes',
    def_codes: 'def_codes',
    extent_competed_type_codes: 'extent_competed_type_codes',
    set_aside_type_codes: 'set_aside_type_codes',
    contract_pricing_type_codes: 'contract_pricing_type_codes',
    place_of_performance_location: 'location_filter',
    time_period_start: 'time_period.start_date',
    time_period_end: 'time_period.end_date',
  };
  /** Twins that validate unlike their top-level field: a list of keywords, and no default award types. */
  const RESHAPED = new Set(['keywords', 'award_type_codes']);

  it('covers every nested field but recipient_location, which has no top-level twin', () => {
    expect(Object.keys(nested).sort()).toEqual(
      [...Object.keys(TWIN_OF), 'recipient_location'].sort(),
    );
  });

  it.each(Object.entries(TWIN_OF))('filters.%s points at %s', (key, path) => {
    const top = path
      .split('.')
      .reduce((node, name) => node.properties![name]!, { properties: root } as JsonNode);
    const twin = nested[key]!;
    const pointer =
      key === 'keywords'
        ? 'Same as the top-level keyword, as a list of terms.'
        : `Same as the top-level ${path}.`;

    expect(twin.description).toBe(pointer);
    expect(pointer.length).toBeLessThan(MIN_REPEAT_CHARS);
    expect(top.description).toEqual(expect.any(String));
    if (!RESHAPED.has(key)) expect(stripDescriptions(twin)).toEqual(stripDescriptions(top));
  });

  it('states the nested-wins rule once, on filters', () => {
    expect(root.filters!.description).toContain('falls back to the top-level value');
    for (const [key, node] of Object.entries(nested)) {
      expect({ key, description: node.description }).not.toEqual({
        key,
        description: expect.stringMatching(/override|falls? back|wins/i),
      });
    }
  });
});

describe('usaspending_search_awards states each paging rule once per side (#131)', () => {
  const pageMetadata = searchAwardsTool.output.shape.page_metadata;
  const enrichment = searchAwardsTool.enrichment!;
  const FIELDS = {
    page: searchAwardsTool.input.shape.page,
    last_record_sort_value: searchAwardsTool.input.shape.last_record_sort_value,
    'page_metadata.has_next': pageMetadata.shape.has_next,
    'page_metadata.last_record_sort_value': pageMetadata.shape.last_record_sort_value,
    truncated: enrichment.truncated!,
    has_next: enrichment.has_next!,
  };

  it('states the call-side windows in the tool description and the result-side rule on page_metadata', () => {
    expect(searchAwardsTool.description).toContain('50,000-result');
    expect(searchAwardsTool.description).toContain('10,000');
    expect(pageMetadata.description).toContain('10,000-result offset');
    for (const [field, schema] of Object.entries(FIELDS)) {
      expect({ field, description: schema.description }).not.toEqual({
        field,
        description: expect.stringMatching(/50,000|10,000/),
      });
    }
  });
});
