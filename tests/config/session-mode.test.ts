/**
 * @fileoverview Pins the deployment's session mode to `stateless` across every
 * surface that sets it. `MCP_SESSION_MODE` defaults to `auto`, which resolves to
 * `stateful`, so a surface that omits the variable silently disagrees with one
 * that sets it — the container and a source run then serve different modes with
 * nothing failing. This server holds no per-session state and requests no client
 * input mid-handler, so `stateless` is correct everywhere; a future edit that
 * reintroduces the split fails here rather than in production.
 * @module tests/config/session-mode.test
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(resolve(file), 'utf-8');

describe('MCP_SESSION_MODE is stateless on every surface', () => {
  it('createApp declares it in src/, the durable form', () => {
    expect(read('src/index.ts')).toMatch(/sessionMode:\s*'stateless'/);
  });

  it('the Dockerfile sets it explicitly', () => {
    expect(read('Dockerfile')).toContain('ENV MCP_SESSION_MODE="stateless"');
  });

  it('.env.example sets it uncommented, so a copied .env resolves the same way', () => {
    const line = read('.env.example')
      .split('\n')
      .find((l) => /^\s*MCP_SESSION_MODE\s*=/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/^MCP_SESSION_MODE=stateless\b/);
  });

  it('.env.example documents all three accepted values and the real default', () => {
    const session = read('.env.example');
    expect(session).toContain('auto | stateful | stateless');
    expect(session).toMatch(/default: auto, which resolves to stateful/);
  });

  it('the README configuration table carries a row for it', () => {
    expect(read('README.md')).toMatch(/^\| `MCP_SESSION_MODE` \|/m);
  });
});
