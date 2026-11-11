import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as t from '@/types';
import { applyConfigChangesFn, baseConfigOptions, getResolvedConfigFn } from '@/server';
import { useEntryTransfer } from './transfer';

vi.mock('@/server', () => ({
  applyConfigChangesFn: vi.fn(),
  baseConfigOptions: { queryKey: ['baseConfig'], queryFn: vi.fn() },
  getResolvedConfigFn: vi.fn(),
}));

const applyMock = vi.mocked(applyConfigChangesFn);
const baseMock = vi.mocked(baseConfigOptions.queryFn as () => Promise<t.BaseConfigData>);
const resolvedMock = vi.mocked(getResolvedConfigFn);
const baseDoc = (dbRevision: string | null) => ({ dbRevision }) as t.BaseConfigData;
const scopeDoc = (revision: string | null | undefined): t.ResolvedConfigData => ({
  resolvedConfig: {},
  changedPaths: [],
  overrides: {},
  tombstones: [],
  revision,
});
const source: t.WriteTarget = { type: 'base' };
const group = {
  principalType: PrincipalType.GROUP,
  principalId: 'g1',
  priority: 10,
  isActive: true,
} as t.ConfigScope;
const role = {
  principalType: PrincipalType.ROLE,
  principalId: 'r1',
  priority: 20,
  isActive: true,
} as t.ConfigScope;
const entry: t.TransferEntry = {
  path: 'mcpServers',
  key: 'Notes',
  value: { type: 'sse', url: 'https://notes.example.com/sse' },
  secrets: [],
};
const stepFor = (target: t.WriteTarget): t.TransferStep => ({
  target,
  key: 'Notes',
  ops: [
    {
      op: 'upsertEntry',
      path: 'mcpServers',
      key: 'Notes',
      identity: null,
      value: { type: 'sse', url: 'https://notes.example.com/sse', serverName: 'Notes' },
    },
  ],
});
const toGroup: t.WriteTarget = { type: 'scope', scope: group };
const toRole: t.WriteTarget = { type: 'scope', scope: role };
const ok = (): t.ApplyConfigChangesResult => ({
  applied: 1,
  failed: [],
  warnings: [],
  issues: [],
  skipped: [],
  reported: [],
});

function setup(options: { source?: t.WriteTarget } = {}) {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useEntryTransfer({ source: options.source ?? source }), {
    wrapper,
  });
  return { ...view, invalidate, client };
}

const invalidatedKeys = (invalidate: ReturnType<typeof setup>['invalidate']) =>
  invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);

beforeEach(() => {
  applyMock.mockReset();
  baseMock.mockReset().mockResolvedValue(baseDoc('base-rev'));
  resolvedMock.mockReset().mockResolvedValue(scopeDoc('scope-rev'));
});

describe('useEntryTransfer', () => {
  it('makes no save before run', () => {
    const { result } = setup();
    expect(applyMock).not.toHaveBeenCalled();
    expect(result.current.results).toEqual([]);
    expect(result.current.running).toBe(false);
  });

  it('reports one result per step with one save call each', async () => {
    applyMock.mockResolvedValue(ok());
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]));
    expect(applyMock).toHaveBeenCalledTimes(2);
    expect(applyMock.mock.calls[0][0].data).toEqual({
      target: { type: 'scope', scope: { principalType: PrincipalType.GROUP, principalId: 'g1' } },
      ops: stepFor(toGroup).ops,
      expectedRevision: 'scope-rev',
    });
    expect(applyMock.mock.calls[1][0].data.target).toEqual({
      type: 'scope',
      scope: { principalType: PrincipalType.ROLE, principalId: 'r1' },
    });
    expect(result.current.results).toEqual([
      { target: toGroup, key: 'Notes', status: 'saved' },
      { target: toRole, key: 'Notes', status: 'saved' },
    ]);
    expect(result.current.originalKept).toBe(false);
  });

  it('fails only the target whose save reports an issue, with its message', async () => {
    applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({
      ...ok(),
      applied: 0,
      issues: [{ path: 'mcpServers.Notes.url', message: 'url is not allowed' }],
    });
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]));
    expect(result.current.results.map((r) => r.status)).toEqual(['saved', 'failed']);
    expect(result.current.results[1].message).toBe('url is not allowed');
    expect(result.current.results[0].message).toBeUndefined();
  });

  it('fails a target whose write failed after the pre-flight', async () => {
    applyMock.mockResolvedValue({
      ...ok(),
      applied: 0,
      failed: [{ path: 'mcpServers', message: 'write refused' }],
    });
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0]).toMatchObject({ status: 'failed', message: 'write refused' });
  });

  it('keeps going and reports failed when a save call throws', async () => {
    applyMock.mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce(ok());
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]));
    expect(result.current.results[0]).toMatchObject({ status: 'failed', message: 'network down' });
    expect(result.current.results[1].status).toBe('saved');
  });

  it('marks a revision conflict stale, not failed', async () => {
    applyMock.mockResolvedValue({ ...ok(), applied: 0, conflict: true });
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0].status).toBe('stale');
  });

  it('refreshes a profile place after the save, not base', async () => {
    applyMock.mockResolvedValue(ok());
    const { result, invalidate } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(invalidatedKeys(invalidate)).toContain('resolvedConfig');
    expect(invalidatedKeys(invalidate)).not.toContain('baseConfig');
  });

  it('refreshes the base place when a step targets it', async () => {
    applyMock.mockResolvedValue(ok());
    const { result, invalidate } = setup();
    await act(() => result.current.run('copy', entry, [stepFor({ type: 'base' })]));
    expect(invalidatedKeys(invalidate)).toContain('baseConfig');
  });

  it('refreshes after a failed save too', async () => {
    applyMock.mockRejectedValueOnce(new Error('boom'));
    const { result, invalidate } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(invalidate).toHaveBeenCalled();
  });

  it('retries only failed and stale steps and keeps saved ones', async () => {
    applyMock
      .mockResolvedValueOnce(ok())
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(ok());
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]));
    await act(() => result.current.retry());
    expect(applyMock).toHaveBeenCalledTimes(3);
    expect(applyMock.mock.calls[2][0].data.target).toMatchObject({
      scope: { principalId: 'r1' },
    });
    expect(result.current.results.map((r) => r.status)).toEqual(['saved', 'saved']);
    expect(result.current.results[1].message).toBeUndefined();
  });

  it('flags originalKept on a move with an unsaved target', async () => {
    applyMock.mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();
    await act(() => result.current.run('move', entry, [stepFor(toGroup), stepFor(toRole)]));
    expect(result.current.originalKept).toBe(true);
  });

  it('is not running once the saves finish', async () => {
    applyMock.mockResolvedValue(ok());
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.running).toBe(false);
  });

  it('fails a save that wrote nothing, with the first skipped reason', async () => {
    applyMock.mockResolvedValue({
      ...ok(),
      applied: 0,
      skipped: [{ fieldPath: 'mcpServers.Notes', reason: 'permission' }],
    });
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0]).toMatchObject({ status: 'failed', message: 'permission' });
  });

  it('fails a save that wrote nothing and skipped nothing, without a message', async () => {
    applyMock.mockResolvedValue({ ...ok(), applied: 0 });
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0].status).toBe('failed');
    expect(result.current.results[0].message).toBeUndefined();
  });

  it('ignores run and retry while a run is in flight', async () => {
    let release: (value: t.ApplyConfigChangesResult) => void = () => undefined;
    applyMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
    applyMock.mockResolvedValue(ok());
    const { result } = setup();
    const steps = [stepFor(toGroup), stepFor(toRole)];
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.run('copy', entry, steps);
      await result.current.run('copy', entry, steps);
      await result.current.retry();
    });
    expect(applyMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(ok());
      await first;
    });
    expect(applyMock).toHaveBeenCalledTimes(2);
    expect(result.current.results.map((r) => r.status)).toEqual(['saved', 'saved']);
    expect(result.current.running).toBe(false);
  });

  it('keys each result by its own step', async () => {
    applyMock.mockResolvedValue(ok());
    const { result } = setup();
    const other: t.TransferStep = { ...stepFor(toRole), key: 'Wiki' };
    await act(() => result.current.run('copy', entry, [stepFor(toGroup), other]));
    expect(result.current.results.map((r) => r.key)).toEqual(['Notes', 'Wiki']);
  });

  it('does not flag originalKept for a copy with a failed target', async () => {
    applyMock.mockRejectedValueOnce(new Error('boom'));
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0].status).toBe('failed');
    expect(result.current.originalKept).toBe(false);
  });

  it('retries a stale step', async () => {
    applyMock
      .mockResolvedValueOnce({ ...ok(), applied: 0, conflict: true })
      .mockResolvedValueOnce(ok());
    const { result } = setup();
    await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
    expect(result.current.results[0].status).toBe('stale');
    await act(() => result.current.retry());
    expect(applyMock).toHaveBeenCalledTimes(2);
    expect(result.current.results[0].status).toBe('saved');
  });

  describe('revisions', () => {
    const conflict = (): t.ApplyConfigChangesResult => ({ ...ok(), applied: 0, conflict: true });
    const revisionOf = (call: number) => applyMock.mock.calls[call][0].data.expectedRevision;

    it('saves a profile against the revision it was loaded at', async () => {
      applyMock.mockResolvedValue(ok());
      const { result, client } = setup();
      client.setQueryData(['resolvedConfig', PrincipalType.GROUP, 'g1'], scopeDoc('loaded-rev'));
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(revisionOf(0)).toBe('loaded-rev');
      expect(resolvedMock).not.toHaveBeenCalled();
    });

    it('reads a profile that is not loaded yet before saving to it', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(resolvedMock).toHaveBeenCalledWith({
        data: { principalType: PrincipalType.GROUP, principalId: 'g1' },
      });
      expect(revisionOf(0)).toBe('scope-rev');
    });

    it('saves base against its own revision', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor({ type: 'base' })]));
      expect(revisionOf(0)).toBe('base-rev');
    });

    it('names a missing document as absent', async () => {
      applyMock.mockResolvedValue(ok());
      baseMock.mockResolvedValue(baseDoc(null));
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor({ type: 'base' })]));
      expect(revisionOf(0)).toBe('absent');
    });

    it('sends no revision when the server reports none', async () => {
      applyMock.mockResolvedValue(ok());
      resolvedMock.mockResolvedValue(scopeDoc(undefined));
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(revisionOf(0)).toBeUndefined();
    });

    it('fails a step whose target cannot be read, without saving to it', async () => {
      applyMock.mockResolvedValue(ok());
      resolvedMock.mockRejectedValueOnce(new Error('read failed'));
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]));
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(result.current.results[0]).toMatchObject({ status: 'failed', message: 'read failed' });
      expect(result.current.results[1].status).toBe('saved');
    });

    it('retries a stale step against the freshly read revision, not the one it failed with', async () => {
      applyMock.mockResolvedValueOnce(conflict()).mockResolvedValueOnce(ok());
      resolvedMock
        .mockResolvedValueOnce(scopeDoc('rev-1'))
        .mockResolvedValueOnce(scopeDoc('rev-2'));
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(revisionOf(0)).toBe('rev-1');
      await act(() => result.current.retry());
      expect(revisionOf(1)).toBe('rev-2');
      expect(result.current.results[0].status).toBe('saved');
    });

    it('retries a failed step against the freshly read revision too', async () => {
      applyMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(ok());
      resolvedMock
        .mockResolvedValueOnce(scopeDoc('rev-1'))
        .mockResolvedValueOnce(scopeDoc('rev-2'));
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      await act(() => result.current.retry());
      expect(revisionOf(1)).toBe('rev-2');
    });

    it('keeps a step that stays stale stale', async () => {
      applyMock.mockResolvedValue(conflict());
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      await act(() => result.current.retry());
      expect(result.current.results[0].status).toBe('stale');
    });
  });

  describe('move', () => {
    const conflict = (): t.ApplyConfigChangesResult => ({ ...ok(), applied: 0, conflict: true });
    const removalOps = [{ op: 'reset', path: 'mcpServers.Notes' }];
    const skippedStep: t.TransferStep = { target: toRole, key: 'Notes', ops: [] };
    const saveCalls = () => applyMock.mock.calls.map(([call]) => call.data);
    const removalCalls = () => saveCalls().filter(({ ops }) => ops[0].op === 'reset');
    const third: t.WriteTarget = {
      type: 'scope',
      scope: { ...role, principalId: 'r2' } as t.ConfigScope,
    };

    it('removes the original from the source after every copy is saved, copies first', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), stepFor(toRole)]));
      expect(applyMock).toHaveBeenCalledTimes(3);
      expect(saveCalls()[2]).toMatchObject({ target: { type: 'base' }, ops: removalOps });
      expect(saveCalls()[0].ops[0].op).toBe('upsertEntry');
      expect(saveCalls()[1].ops[0].op).toBe('upsertEntry');
      expect(result.current.originalKept).toBe(false);
      expect(result.current.removal).toMatchObject({ status: 'saved', key: 'Notes' });
    });

    it('removes from a profile source, not from base', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup({ source: toRole });
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(saveCalls()[1].target).toEqual({
        type: 'scope',
        scope: { principalType: PrincipalType.ROLE, principalId: 'r1' },
      });
    });

    it('removes the original on the source revision it was loaded at', async () => {
      applyMock.mockResolvedValue(ok());
      const { result, client } = setup();
      client.setQueryData(['baseConfig'], baseDoc('source-rev'));
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(saveCalls()[1].expectedRevision).toBe('source-rev');
    });

    it('never removes when a copy failed, and says the original was kept', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error('boom'));
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), stepFor(toRole)]));
      expect(removalCalls()).toHaveLength(0);
      expect(result.current.originalKept).toBe(true);
      expect(result.current.removal).toBeNull();
    });

    it('never removes when a copy is stale', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(conflict());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), stepFor(toRole)]));
      expect(removalCalls()).toHaveLength(0);
      expect(result.current.originalKept).toBe(true);
    });

    it('never removes when a copy saved nothing without a problem', async () => {
      applyMock.mockResolvedValue({ ...ok(), applied: 0 });
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(result.current.originalKept).toBe(true);
    });

    it('does not remove after a copy', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(result.current.removal).toBeNull();
    });

    it('removes after a retry that completes the copies', async () => {
      applyMock
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), stepFor(toRole)]));
      expect(removalCalls()).toHaveLength(0);
      await act(() => result.current.retry());
      expect(applyMock).toHaveBeenCalledTimes(4);
      expect(saveCalls()[2].target).toMatchObject({ scope: { principalId: 'r1' } });
      expect(saveCalls()[3]).toMatchObject({ target: { type: 'base' }, ops: removalOps });
      expect(result.current.originalKept).toBe(false);
    });

    it('does not remove after a retry that saves only some of the failed copies', async () => {
      applyMock
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(new Error('one'))
        .mockRejectedValueOnce(new Error('two'))
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(new Error('still two'))
        .mockResolvedValue(ok());
      const { result } = setup();
      const steps = [stepFor(toGroup), stepFor(toRole), stepFor(third)];
      await act(() => result.current.run('move', entry, steps));
      await act(() => result.current.retry());
      expect(result.current.results.map((r) => r.status)).toEqual(['saved', 'saved', 'failed']);
      expect(removalCalls()).toHaveLength(0);
      expect(result.current.originalKept).toBe(true);
      await act(() => result.current.retry());
      expect(removalCalls()).toHaveLength(1);
      expect(result.current.originalKept).toBe(false);
    });

    it('keeps the original and reports it when the removal throws', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockRejectedValueOnce(new Error('cannot remove'));
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(result.current.results[0].status).toBe('saved');
      expect(result.current.removal).toMatchObject({ status: 'failed', message: 'cannot remove' });
      expect(result.current.originalKept).toBe(true);
    });

    it('reports a removal that conflicts as stale and keeps the original', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(conflict());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(result.current.removal?.status).toBe('stale');
      expect(result.current.originalKept).toBe(true);
    });

    it('reports a removal that wrote nothing as failed and keeps the original', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({ ...ok(), applied: 0 });
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(result.current.removal?.status).toBe('failed');
      expect(result.current.originalKept).toBe(true);
    });

    it('reports a removal with an issue as failed with its message', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce({
        ...ok(),
        applied: 0,
        issues: [{ path: 'mcpServers', message: 'no' }],
      });
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(result.current.removal).toMatchObject({ status: 'failed', message: 'no' });
    });

    it('retries only the removal when the copies are saved, on the fresh source revision', async () => {
      applyMock
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(conflict())
        .mockResolvedValueOnce(ok());
      baseMock.mockResolvedValueOnce(baseDoc('src-1')).mockResolvedValueOnce(baseDoc('src-2'));
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(saveCalls()[1].expectedRevision).toBe('src-1');
      await act(() => result.current.retry());
      expect(applyMock).toHaveBeenCalledTimes(3);
      expect(saveCalls()[2]).toMatchObject({ ops: removalOps, expectedRevision: 'src-2' });
      expect(result.current.removal?.status).toBe('saved');
      expect(result.current.originalKept).toBe(false);
    });

    it('does not remove twice once the removal is saved', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      await act(() => result.current.retry());
      expect(removalCalls()).toHaveLength(1);
    });

    it('skips a step with nothing to write, without a save, and still removes', async () => {
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), skippedStep]));
      expect(applyMock).toHaveBeenCalledTimes(2);
      expect(result.current.results.map((r) => r.status)).toEqual(['saved', 'skipped']);
      expect(removalCalls()).toHaveLength(1);
    });

    it('does not remove when a skipped step sits beside a failed one', async () => {
      applyMock.mockRejectedValueOnce(new Error('boom'));
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup), skippedStep]));
      expect(result.current.results.map((r) => r.status)).toEqual(['failed', 'skipped']);
      expect(removalCalls()).toHaveLength(0);
      expect(result.current.originalKept).toBe(true);
    });

    it('does not remove when every step is skipped', async () => {
      const { result } = setup();
      await act(() => result.current.run('move', entry, [skippedStep]));
      expect(applyMock).not.toHaveBeenCalled();
      expect(result.current.originalKept).toBe(true);
    });

    it('does nothing for a move with no steps', async () => {
      const { result } = setup();
      await act(() => result.current.run('move', entry, []));
      expect(applyMock).not.toHaveBeenCalled();
      expect(result.current.results).toEqual([]);
      expect(result.current.removal).toBeNull();
    });

    it('ignores run and retry while the removal is in flight', async () => {
      let release: (value: t.ApplyConfigChangesResult) => void = () => undefined;
      applyMock.mockResolvedValueOnce(ok());
      applyMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      let first: Promise<void> = Promise.resolve();
      await act(async () => {
        first = result.current.run('move', entry, [stepFor(toGroup)]);
        await vi.waitFor(() => expect(applyMock).toHaveBeenCalledTimes(2));
        await result.current.run('move', entry, [stepFor(toGroup)]);
        await result.current.retry();
      });
      expect(applyMock).toHaveBeenCalledTimes(2);
      expect(result.current.running).toBe(true);
      await act(async () => {
        release(ok());
        await first;
      });
      expect(applyMock).toHaveBeenCalledTimes(2);
      expect(result.current.removal?.status).toBe('saved');
      expect(result.current.running).toBe(false);
    });

    it('refreshes the source place after the removal', async () => {
      applyMock.mockResolvedValue(ok());
      const { result, invalidate } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(invalidatedKeys(invalidate)).toContain('baseConfig');
    });

    it('treats a copy that wrote but dropped part of it as failed, with the reason', async () => {
      applyMock.mockResolvedValue({
        ...ok(),
        applied: 3,
        skipped: [{ fieldPath: 'mcpServers.Notes.apiKey', reason: 'notStored' }],
      });
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(result.current.results[0]).toMatchObject({
        status: 'failed',
        message: 'notStored',
      });
    });

    it('treats a copy with a reported part as failed, with the reason', async () => {
      applyMock.mockResolvedValue({
        ...ok(),
        applied: 3,
        reported: [{ fieldPath: 'mcpServers.Notes.apiKey', reason: 'notApplied' }],
      });
      const { result } = setup();
      await act(() => result.current.run('copy', entry, [stepFor(toGroup)]));
      expect(result.current.results[0]).toMatchObject({ status: 'failed', message: 'notApplied' });
    });

    it('does not remove the original after a copy that dropped part of it', async () => {
      applyMock.mockResolvedValue({
        ...ok(),
        applied: 3,
        skipped: [{ fieldPath: 'mcpServers.Notes.apiKey', reason: 'notStored' }],
      });
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(result.current.originalKept).toBe(true);
    });

    it('does not remove the original after a copy with a reported part', async () => {
      applyMock.mockResolvedValue({
        ...ok(),
        applied: 3,
        reported: [{ fieldPath: 'mcpServers.Notes.apiKey', reason: 'notApplied' }],
      });
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(result.current.originalKept).toBe(true);
    });

    it('ignores retry while a copy save is in flight', async () => {
      let release: (value: t.ApplyConfigChangesResult) => void = () => undefined;
      applyMock.mockRejectedValueOnce(new Error('boom'));
      applyMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      applyMock.mockResolvedValue(ok());
      const { result } = setup();
      let first: Promise<void> = Promise.resolve();
      await act(async () => {
        first = result.current.run('copy', entry, [stepFor(toGroup), stepFor(toRole)]);
        await vi.waitFor(() => expect(applyMock).toHaveBeenCalledTimes(2));
        await result.current.retry();
      });
      expect(applyMock).toHaveBeenCalledTimes(2);
      await act(async () => {
        release(ok());
        await first;
      });
      expect(applyMock).toHaveBeenCalledTimes(2);
    });

    it('does not say the original was kept while the removal is still saving', async () => {
      let release: (value: t.ApplyConfigChangesResult) => void = () => undefined;
      applyMock.mockResolvedValueOnce(ok());
      applyMock.mockReturnValueOnce(new Promise((resolve) => (release = resolve)));
      const { result } = setup();
      let first: Promise<void> = Promise.resolve();
      await act(async () => {
        first = result.current.run('move', entry, [stepFor(toGroup)]);
        await vi.waitFor(() => expect(applyMock).toHaveBeenCalledTimes(2));
      });
      expect(result.current.running).toBe(true);
      expect(result.current.originalKept).toBe(false);
      await act(async () => {
        release(ok());
        await first;
      });
    });

    it('clears the previous move when a new one starts', async () => {
      applyMock
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(new Error('boom'));
      const { result } = setup();
      await act(() => result.current.run('move', entry, [stepFor(toGroup)]));
      expect(result.current.removal?.status).toBe('saved');
      await act(() => result.current.run('move', entry, [stepFor(toRole)]));
      expect(result.current.removal).toBeNull();
      expect(result.current.originalKept).toBe(true);
    });
  });
});
