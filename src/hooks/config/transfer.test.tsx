import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type * as t from '@/types';
import { applyConfigChangesFn } from '@/server';
import { useEntryTransfer } from './transfer';

vi.mock('@/server', () => ({ applyConfigChangesFn: vi.fn() }));

const applyMock = vi.mocked(applyConfigChangesFn);
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

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const view = renderHook(() => useEntryTransfer({ source }), { wrapper });
  return { ...view, invalidate };
}

const invalidatedKeys = (invalidate: ReturnType<typeof setup>['invalidate']) =>
  invalidate.mock.calls.map(([filters]) => filters?.queryKey?.[0]);

beforeEach(() => applyMock.mockReset());

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
      expectedRevision: undefined,
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
});
