import { describe, it, expect } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import type * as t from '@/types';
import { MASKED_SECRET } from './secrets';
import { transferTargets, transferEligibility, planCopy, MAX_TRANSFER_TARGETS } from './transfer';

const scope = (principalId: string, over: Partial<t.ConfigScope> = {}): t.ConfigScope => ({
  principalType: PrincipalType.GROUP,
  principalId,
  name: principalId,
  priority: 10,
  isActive: true,
  ...over,
});

const base: t.WriteTarget = { type: 'base' };
const at = (s: t.ConfigScope): t.WriteTarget => ({ type: 'scope', scope: s });
const input = (target: t.WriteTarget): t.TransferTargetInput => ({
  target,
  ownKeys: new Set(),
  shownKeys: new Set(),
});
const origin = { fromFile: false, own: true, writable: true };

describe('MAX_TRANSFER_TARGETS', () => {
  it('is 10', () => expect(MAX_TRANSFER_TARGETS).toBe(10));
});

describe('transferTargets', () => {
  const sales = scope('sales');
  const support = scope('support');

  it('lists Base first, then every profile, when the source is another profile', () => {
    const got = transferTargets([sales, support], at(scope('ops')), true);
    expect(got).toEqual([base, at(sales), at(support)]);
  });

  it('leaves Base out when the source is Base', () => {
    expect(transferTargets([sales], base, true)).toEqual([at(sales)]);
  });

  it('leaves Base out when the admin cannot write it', () => {
    expect(transferTargets([sales], at(support), false)).toEqual([at(sales)]);
  });

  it('leaves the open profile out when the scope object is a different copy of it', () => {
    const got = transferTargets([sales, support], at({ ...sales }), true);
    expect(got).toEqual([base, at(support)]);
  });

  it('keeps a profile of another kind that shares the open profile id', () => {
    const role = scope('sales', { principalType: PrincipalType.ROLE });
    expect(transferTargets([role], at(sales), false)).toEqual([at(role)]);
  });

  it('lists an inactive profile', () => {
    const idle = scope('idle', { isActive: false });
    expect(transferTargets([idle], base, true)).toEqual([at(idle)]);
  });

  it('is empty when nothing else is writable', () => {
    expect(transferTargets([sales], at(sales), false)).toEqual([]);
  });
});

describe('transferEligibility', () => {
  it('offers copy and move for an own entry of a record', () => {
    expect(transferEligibility('mcpServers', origin)).toEqual({ copy: true, move: true });
  });

  it('offers copy and move for a list merged by key', () => {
    expect(transferEligibility('endpoints.custom', origin)).toEqual({ copy: true, move: true });
  });

  it('offers nothing for a list a profile replaces whole (model specs)', () => {
    expect(transferEligibility('modelSpecs.list', origin)).toEqual({ copy: false, move: false });
  });

  it('offers nothing for a positional list', () => {
    expect(transferEligibility('endpoints.agents.capabilities', origin)).toEqual({
      copy: false,
      move: false,
    });
  });

  it('blocks move for a file entry but keeps copy', () => {
    expect(transferEligibility('mcpServers', { ...origin, fromFile: true })).toEqual({
      copy: true,
      move: false,
      moveBlocked: 'file',
    });
  });

  it('blocks move for an inherited entry but keeps copy', () => {
    expect(transferEligibility('mcpServers', { ...origin, own: false })).toEqual({
      copy: true,
      move: false,
      moveBlocked: 'inherited',
    });
  });

  it('blocks move in a place the admin can read but not write, keeping copy', () => {
    expect(transferEligibility('mcpServers', { ...origin, writable: false })).toEqual({
      copy: true,
      move: false,
      moveBlocked: 'readOnly',
    });
  });
});

describe('planCopy', () => {
  const sales = at(scope('sales'));

  it('writes an MCP server leaf by leaf under its name', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { type: 'sse', url: 'https://bc.example/', headers: { 'X-A': '1' } },
      secrets: [],
    };
    expect(planCopy(entry, input(sales), {})).toEqual({
      target: sales,
      key: 'BC',
      ops: [
        { op: 'set', path: 'mcpServers.BC.type', value: 'sse' },
        { op: 'set', path: 'mcpServers.BC.url', value: 'https://bc.example/' },
        { op: 'set', path: 'mcpServers.BC.headers.X-A', value: '1' },
      ],
    });
  });

  it('keeps a name with spaces and Icelandic letters whole in the path', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'Þórður æði',
      value: { url: 'https://x.example/' },
      secrets: [],
    };
    expect(planCopy(entry, input(sales), {})?.ops).toEqual([
      { op: 'set', path: 'mcpServers.Þórður æði.url', value: 'https://x.example/' },
    ]);
  });

  it('refuses a record name with a dot, which no path can address', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'a.b',
      value: { url: 'https://x.example/' },
      secrets: [],
    };
    expect(() => planCopy(entry, input(sales), {})).toThrow(/a\.b/);
  });

  it('upserts a keyed-list entry as a new entry, name with dots and spaces intact', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'Kimi 2.5 þ',
      value: { name: 'Kimi 2.5 þ', baseURL: 'https://api.example/v1' },
      secrets: [],
    };
    expect(planCopy(entry, input(sales), {})).toEqual({
      target: sales,
      key: 'Kimi 2.5 þ',
      ops: [
        {
          op: 'upsertEntry',
          path: 'endpoints.custom',
          key: 'Kimi 2.5 þ',
          identity: null,
          value: { name: 'Kimi 2.5 þ', baseURL: 'https://api.example/v1' },
        },
      ],
    });
  });

  it('never writes the masked secret or its preview', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'Kimi',
      value: { name: 'Kimi', apiKey: MASKED_SECRET, apiKeyPreview: 'sk-…1234', baseURL: 'u' },
      secrets: ['apiKey'],
    };
    const text = JSON.stringify(planCopy(entry, input(sales), {}));
    expect(text).not.toContain(MASKED_SECRET);
    expect(text).not.toContain('apiKey');
  });

  it('drops a masked nested MCP secret from the leaf writes', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', oauth: { client_id: 'id', client_secret: MASKED_SECRET } },
      secrets: ['oauth.client_secret'],
    };
    const ops = planCopy(entry, input(sales), {})?.ops;
    expect(ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
      { op: 'set', path: 'mcpServers.BC.oauth.client_id', value: 'id' },
    ]);
  });

  it('does not write empty objects or nulls', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', headers: {}, title: null },
      secrets: [],
    };
    expect(planCopy(entry, input(sales), {})?.ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
    ]);
  });
});
