import { describe, it, expect } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import type * as t from '@/types';
import { MASKED_SECRET } from './secrets';
import { planConfigChanges } from './changes';
import {
  transferTargets,
  transferEligibility,
  planCopy,
  planRemoval,
  MAX_TRANSFER_TARGETS,
} from './transfer';

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
    const text = JSON.stringify(planCopy(entry, input(sales), { apiKey: 'typed' }));
    expect(text).not.toContain(MASKED_SECRET);
    expect(text).not.toContain('apiKeyPreview');
    expect(text).not.toContain('sk-…1234');
  });

  it('replaces a masked nested MCP secret by the typed one in the leaf writes', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', oauth: { client_id: 'id', client_secret: MASKED_SECRET } },
      secrets: ['oauth.client_secret'],
    };
    const ops = planCopy(entry, input(sales), { 'oauth.client_secret': 'typed' })?.ops;
    expect(JSON.stringify(ops)).not.toContain(MASKED_SECRET);
    expect(ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
      { op: 'set', path: 'mcpServers.BC.oauth.client_id', value: 'id' },
      { op: 'set', path: 'mcpServers.BC.oauth.client_secret', value: 'typed' },
    ]);
  });

  it('drops a masked leaf of a keyed entry even when secrets does not list it', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKey: MASKED_SECRET, baseURL: 'u' },
      secrets: [],
    };
    const step = planCopy(entry, input(sales), {});
    expect(JSON.stringify(step)).not.toContain(MASKED_SECRET);
    expect(step?.ops).toEqual([
      {
        op: 'upsertEntry',
        path: 'endpoints.custom',
        key: 'K',
        identity: null,
        value: { name: 'K', baseURL: 'u' },
      },
    ]);
  });

  it('drops a nested masked leaf of an MCP server even when secrets does not list it', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'K',
      value: { url: 'u', headers: { A: MASKED_SECRET, B: 'b' } },
      secrets: [],
    };
    const step = planCopy(entry, input(sales), {});
    expect(JSON.stringify(step)).not.toContain(MASKED_SECRET);
    expect(step?.ops).toEqual([
      { op: 'set', path: 'mcpServers.K.url', value: 'u' },
      { op: 'set', path: 'mcpServers.K.headers.B', value: 'b' },
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

describe('transferEligibility block order', () => {
  const all = { fromFile: true, own: false, writable: false };

  it('names readOnly first when every block applies (not file or inherited)', () => {
    expect(transferEligibility('mcpServers', all).moveBlocked).toBe('readOnly');
  });

  it('names file before inherited when both apply (not inherited)', () => {
    const got = transferEligibility('mcpServers', { ...all, writable: true });
    expect(got.moveBlocked).toBe('file');
  });
});

describe('planRemoval', () => {
  it('resets the record entry in its own place', () => {
    const entry: t.TransferEntry = { path: 'mcpServers', key: 'BC', value: {}, secrets: [] };
    expect(planRemoval(entry)).toEqual([{ op: 'reset', path: 'mcpServers.BC' }]);
  });

  it('removes a keyed-list entry by its name, spaces, dots and Icelandic letters whole', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'Kimi 2.5 þðæ',
      value: { name: 'Kimi 2.5 þðæ' },
      secrets: [],
    };
    expect(planRemoval(entry)).toEqual([
      {
        op: 'removeEntry',
        path: 'endpoints.custom',
        key: 'Kimi 2.5 þðæ',
        identity: 'Kimi 2.5 þðæ',
      },
    ]);
  });

  it('refuses a record name with a dot (a reset of the wrong path)', () => {
    const entry: t.TransferEntry = { path: 'mcpServers', key: 'a.b', value: {}, secrets: [] };
    expect(() => planRemoval(entry)).toThrow(/a\.b/);
  });

  it('keeps spaces and Icelandic letters whole for a record', () => {
    const entry: t.TransferEntry = { path: 'mcpServers', key: 'Þór æði', value: {}, secrets: [] };
    expect(planRemoval(entry)).toEqual([{ op: 'reset', path: 'mcpServers.Þór æði' }]);
  });
});

describe('planCopy clash', () => {
  const sales = at(scope('sales'));
  const server: t.TransferEntry = {
    path: 'mcpServers',
    key: 'BC',
    value: { url: 'u' },
    secrets: [],
  };
  const keyed: t.TransferEntry = {
    path: 'endpoints.custom',
    key: 'K',
    value: { name: 'K' },
    secrets: [],
  };
  const withClash = (
    clash: t.ClashChoice | undefined,
    shown: string[] = [],
    own: string[] = ['BC'],
  ): t.TransferTargetInput => ({
    target: sales,
    ownKeys: new Set(own),
    shownKeys: new Set(shown),
    clash,
  });

  it('skip returns null (not an empty step)', () => {
    expect(planCopy(server, withClash('skip'), {})).toBeNull();
  });

  it('skip returns null for a keyed entry too', () => {
    expect(planCopy(keyed, withClash('skip'), {})).toBeNull();
  });

  it('replace of a record entry clears the target entry first, then writes the leaves', () => {
    expect(planCopy(server, withClash('replace'), {})?.ops).toEqual([
      { op: 'reset', path: 'mcpServers.BC' },
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
    ]);
  });

  it('replace of a keyed entry removes the target entry, then upserts it', () => {
    expect(planCopy(keyed, withClash('replace'), {})?.ops).toEqual([
      { op: 'removeEntry', path: 'endpoints.custom', key: 'K', identity: 'K' },
      {
        op: 'upsertEntry',
        path: 'endpoints.custom',
        key: 'K',
        identity: null,
        value: { name: 'K' },
      },
    ]);
  });

  it('no choice writes plainly under the same name, even if the target holds it', () => {
    const step = planCopy(server, withClash(undefined), {});
    expect(step?.key).toBe('BC');
    expect(step?.ops).toEqual([{ op: 'set', path: 'mcpServers.BC.url', value: 'u' }]);
  });

  it('keepBoth writes a record entry under BC-copy', () => {
    const step = planCopy(server, withClash('keepBoth'), {});
    expect(step?.key).toBe('BC-copy');
    expect(step?.ops).toEqual([{ op: 'set', path: 'mcpServers.BC-copy.url', value: 'u' }]);
  });

  it('keepBoth moves past a taken BC-copy to BC-copy-2', () => {
    expect(planCopy(server, withClash('keepBoth', ['BC', 'BC-copy']), {})?.key).toBe('BC-copy-2');
  });

  it('keepBoth moves past BC-copy and BC-copy-2 to BC-copy-3', () => {
    const shown = ['BC', 'BC-copy', 'BC-copy-2'];
    expect(planCopy(server, withClash('keepBoth', shown), {})?.key).toBe('BC-copy-3');
  });

  it('keepBoth avoids a name only an inherited layer shows (shownKeys, not ownKeys)', () => {
    expect(planCopy(server, withClash('keepBoth', ['BC-copy'], ['BC']), {})?.key).toBe('BC-copy-2');
  });

  it('keepBoth treats a name differing only in letter case as taken', () => {
    expect(planCopy(server, withClash('keepBoth', ['bc-COPY']), {})?.key).toBe('BC-copy-2');
  });

  it('keepBoth keeps spaces, dots and Icelandic letters of a keyed entry name', () => {
    const named: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'Kimi 2.5 þðæ',
      value: { name: 'Kimi 2.5 þðæ', baseURL: 'u' },
      secrets: [],
    };
    expect(planCopy(named, withClash('keepBoth', [], ['Kimi 2.5 þðæ']), {})).toEqual({
      target: sales,
      key: 'Kimi 2.5 þðæ-copy',
      ops: [
        {
          op: 'upsertEntry',
          path: 'endpoints.custom',
          key: 'Kimi 2.5 þðæ-copy',
          identity: null,
          value: { name: 'Kimi 2.5 þðæ-copy', baseURL: 'u' },
        },
      ],
    });
  });

  it('keepBoth keeps Icelandic letters in a record name whole', () => {
    const entry = { ...server, key: 'Þórður-æði' };
    expect(planCopy(entry, withClash('keepBoth', [], ['Þórður-æði']), {})?.key).toBe(
      'Þórður-æði-copy',
    );
  });

  it('keepBoth of a dotted record name still throws (the new name has the dot)', () => {
    const entry = { ...server, key: 'a.b' };
    expect(() => planCopy(entry, withClash('keepBoth'), {})).toThrow(/a\.b/);
  });

  it('skip wins over a dotted name that would throw', () => {
    const entry = { ...server, key: 'a.b' };
    expect(planCopy(entry, withClash('skip'), {})).toBeNull();
  });
});

describe('planCopy secrets', () => {
  const sales = at(scope('sales'));

  it('writes a typed nested MCP secret at exactly oauth.client_secret', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', oauth: { client_id: 'id', client_secret: MASKED_SECRET } },
      secrets: ['oauth.client_secret'],
    };
    const ops = planCopy(entry, input(sales), { 'oauth.client_secret': 'typed' })?.ops;
    expect(ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
      { op: 'set', path: 'mcpServers.BC.oauth.client_id', value: 'id' },
      { op: 'set', path: 'mcpServers.BC.oauth.client_secret', value: 'typed' },
    ]);
  });

  it('writes a typed apiKey.key at exactly apiKey.key and drops its preview', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', apiKey: { source: 'admin', key: MASKED_SECRET, keyPreview: 'sk-…12' } },
      secrets: ['apiKey.key'],
    };
    const ops = planCopy(entry, input(sales), { 'apiKey.key': 'typed' })?.ops;
    expect(ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.url', value: 'u' },
      { op: 'set', path: 'mcpServers.BC.apiKey.source', value: 'admin' },
      { op: 'set', path: 'mcpServers.BC.apiKey.key', value: 'typed' },
    ]);
  });

  it('writes a typed secret into a keyed entry value at its leaf', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKey: MASKED_SECRET, apiKeyPreview: 'sk-…1', baseURL: 'u' },
      secrets: ['apiKey'],
    };
    expect(planCopy(entry, input(sales), { apiKey: 'typed' })?.ops).toEqual([
      {
        op: 'upsertEntry',
        path: 'endpoints.custom',
        key: 'K',
        identity: null,
        value: { name: 'K', baseURL: 'u', apiKey: 'typed' },
      },
    ]);
  });

  it('writes a typed keyed-entry secret two levels deep at its leaf', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKey: { key: MASKED_SECRET } },
      secrets: ['apiKey.key'],
    };
    const op = planCopy(entry, input(sales), { 'apiKey.key': 'typed' })?.ops[0];
    expect(op).toMatchObject({ value: { name: 'K', apiKey: { key: 'typed' } } });
  });

  it('writes each of two typed secrets at its own path', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { oauth: { client_secret: MASKED_SECRET }, apiKey: { key: MASKED_SECRET } },
      secrets: ['oauth.client_secret', 'apiKey.key'],
    };
    const ops = planCopy(entry, input(sales), {
      'oauth.client_secret': 'one',
      'apiKey.key': 'two',
    })?.ops;
    expect(ops).toEqual([
      { op: 'set', path: 'mcpServers.BC.oauth.client_secret', value: 'one' },
      { op: 'set', path: 'mcpServers.BC.apiKey.key', value: 'two' },
    ]);
  });

  it('throws when a listed secret has no typed value', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { oauth: { client_secret: MASKED_SECRET } },
      secrets: ['oauth.client_secret'],
    };
    expect(() => planCopy(entry, input(sales), {})).toThrow(/oauth\.client_secret/);
  });

  it('throws when only one of two listed secrets is typed', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { oauth: { client_secret: MASKED_SECRET }, apiKey: { key: MASKED_SECRET } },
      secrets: ['oauth.client_secret', 'apiKey.key'],
    };
    expect(() => planCopy(entry, input(sales), { 'oauth.client_secret': 'x' })).toThrow(
      /apiKey\.key/,
    );
  });

  it('throws when a typed secret is empty', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKey: MASKED_SECRET },
      secrets: ['apiKey'],
    };
    expect(() => planCopy(entry, input(sales), { apiKey: '' })).toThrow(/apiKey/);
  });

  it('throws when a typed secret is the mask itself', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKey: MASKED_SECRET },
      secrets: ['apiKey'],
    };
    expect(() => planCopy(entry, input(sales), { apiKey: MASKED_SECRET })).toThrow(/apiKey/);
  });

  it('skip wins over a missing secret', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { oauth: { client_secret: MASKED_SECRET } },
      secrets: ['oauth.client_secret'],
    };
    expect(planCopy(entry, { ...input(sales), clash: 'skip' }, {})).toBeNull();
  });

  it('never writes the mask at depth three, with an incomplete secrets list', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { url: 'u', a: { b: { c: MASKED_SECRET, d: 'd' } } },
      secrets: [],
    };
    const step = planCopy(entry, input(sales), {});
    expect(JSON.stringify(step)).not.toContain(MASKED_SECRET);
    expect(step?.ops).toContainEqual({ op: 'set', path: 'mcpServers.BC.a.b.d', value: 'd' });
  });

  it('never writes the mask inside a list of a keyed entry', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', models: { default: ['a', MASKED_SECRET, 'b'] } },
      secrets: [],
    };
    const step = planCopy(entry, input(sales), {});
    expect(JSON.stringify(step)).not.toContain(MASKED_SECRET);
    expect(step?.ops[0]).toMatchObject({ value: { models: { default: ['a', 'b'] } } });
  });

  it('never writes the mask inside a record held in a list', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', items: [{ token: MASKED_SECRET, id: 1 }] },
      secrets: [],
    };
    expect(JSON.stringify(planCopy(entry, input(sales), {}))).not.toContain(MASKED_SECRET);
  });

  it('writes no preview leaf beside a listed nested record secret', () => {
    const entry: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: {
        url: 'u',
        oauth: { client_secret: MASKED_SECRET, client_secretPreview: 'abc…12' },
      },
      secrets: ['oauth.client_secret'],
    };
    const ops = planCopy(entry, input(sales), { 'oauth.client_secret': 'typed' })?.ops;
    expect(JSON.stringify(ops)).not.toContain('client_secretPreview');
  });

  it('writes no preview leaf of a keyed entry whose secrets list is empty', () => {
    const entry: t.TransferEntry = {
      path: 'endpoints.custom',
      key: 'K',
      value: { name: 'K', apiKeyPreview: 'sk-…1', baseURL: 'u' },
      secrets: [],
    };
    expect(JSON.stringify(planCopy(entry, input(sales), {})?.ops)).not.toContain('apiKeyPreview');
  });
});

describe('planCopy ops through the real write planner', () => {
  const sales = at(scope('sales'));
  const copied: t.TransferEntry = {
    path: 'endpoints.custom',
    key: 'K',
    value: {
      name: 'K',
      apiKey: 'user_provided',
      baseURL: 'https://new',
      models: { default: ['m'] },
    },
    secrets: [],
  };
  const lowerK = {
    name: 'K',
    apiKey: 'user_provided',
    baseURL: 'https://low',
    models: { default: ['m'] },
  };
  const ownK = { name: 'K', baseURL: 'https://old', headers: { Stale: '1' } };
  const target = (ownKeys: string[], shownKeys: string[], clash?: t.ClashChoice) => ({
    target: sales,
    ownKeys: new Set(ownKeys),
    shownKeys: new Set(shownKeys),
    clash,
  });
  const plan = (
    entry: t.TransferEntry,
    wanted: t.TransferTargetInput,
    stored: t.ConfigRecord,
    lower: t.ConfigRecord,
  ) => {
    const ops = planCopy(entry, wanted, {})?.ops ?? [];
    return planConfigChanges(ops, { stored, tombstones: [], lower, lowerKind: 'inherited' });
  };
  const custom = (...list: t.ConfigRecord[]): t.ConfigRecord => ({ endpoints: { custom: list } });
  const ownList = (after: t.ConfigRecord): t.ConfigValue =>
    (after.endpoints as t.ConfigRecord | undefined)?.custom ?? null;

  it('copies into a place that has no entry of that name', () => {
    const got = plan(copied, target([], []), {}, {});
    expect(got.issues).toEqual([]);
    expect(ownList(got.storedAfter)).toEqual([copied.value]);
  });

  it('copies over a name the place only inherits, as an override of it', () => {
    const got = plan(copied, target([], ['K']), {}, custom(lowerK));
    expect(got.issues).toEqual([]);
    expect(ownList(got.storedAfter)).toEqual([{ name: 'K', baseURL: 'https://new' }]);
  });

  it('replaces an own entry the layer below lacks, leaving no stale field', () => {
    const got = plan(copied, target(['K'], ['K'], 'replace'), custom(ownK), {});
    expect(got.issues).toEqual([]);
    expect(ownList(got.storedAfter)).toEqual([copied.value]);
  });

  it('is refused, not half-applied, when replacing an own entry the layer below also has', () => {
    const got = plan(copied, target(['K'], ['K'], 'replace'), custom(ownK), custom(lowerK));
    expect(got.issues.length).toBeGreaterThan(0);
  });

  it('keeps both next to an own entry under a free name', () => {
    const got = plan(copied, target(['K'], ['K'], 'keepBoth'), custom(ownK), {});
    expect(got.issues).toEqual([]);
    expect(ownList(got.storedAfter)).toEqual([
      ownK,
      { ...(copied.value as t.ConfigRecord), name: 'K-copy' },
    ]);
  });

  it('replaces a record entry whole: no stale leaf, the entry present', () => {
    const server: t.TransferEntry = {
      path: 'mcpServers',
      key: 'BC',
      value: { type: 'sse', url: 'https://new/' },
      secrets: [],
    };
    const stored = { mcpServers: { BC: { type: 'sse', url: 'https://old/', title: 'Stale' } } };
    const got = plan(server, target(['BC'], ['BC'], 'replace'), stored, {});
    expect(got.issues).toEqual([]);
    expect(got.storedAfter).toEqual({
      mcpServers: { BC: { type: 'sse', url: 'https://new/' } },
    });
  });
});
