import { useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useRef } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import type * as t from '@/types';
import { applyConfigChangesFn, baseConfigOptions } from '@/server';
import { planRemoval, toRevisionPrecondition } from '@/utils';
import { RESOLVED_READ_QUERY_KEYS } from '@/constants';
import { scopeConfigOptions } from './layers';

function toTargetRef(target: t.WriteTarget): t.WriteTargetRef {
  if (target.type === 'base') return { type: 'base' };
  const { principalType, principalId } = target.scope;
  return { type: 'scope', scope: { principalType, principalId } };
}

/** Whether a save may be run again: it failed or went stale. */
export function isRetryable(result: t.TransferResult | null | undefined): boolean {
  return result?.status === 'failed' || result?.status === 'stale';
}

function readKeys(target: t.WriteTarget): ReadonlyArray<readonly string[]> {
  return target.type === 'base'
    ? [['baseConfig'], ...RESOLVED_READ_QUERY_KEYS]
    : [['resolvedConfig'], ['availableScopes'], ...RESOLVED_READ_QUERY_KEYS];
}

/** A target's stored revision: the one already loaded, or with `fresh` one read now. */
async function readRevision(
  client: QueryClient,
  target: t.WriteTarget,
  fresh: boolean,
): Promise<string | undefined> {
  const staleTime = fresh ? 0 : Infinity;
  if (target.type === 'base') {
    const base = await client.fetchQuery({ ...baseConfigOptions, staleTime });
    return toRevisionPrecondition(base.dbRevision);
  }
  const doc = await client.fetchQuery({ ...scopeConfigOptions(target.scope), staleTime });
  return toRevisionPrecondition(doc.revision);
}

/** The status of one save: a conflict is stale, any issue or failed write is failed with its message. */
function toResult(
  target: t.WriteTarget,
  key: string,
  outcome: t.ApplyConfigChangesResult,
): t.TransferResult {
  if (outcome.conflict) return { target, key, status: 'stale' };
  const [problem] = [...outcome.issues, ...outcome.failed];
  if (problem) return { target, key, status: 'failed', message: problem.message };
  const [dropped] = [...outcome.skipped, ...outcome.reported];
  if (outcome.applied === 0 || dropped) {
    return { target, key, status: 'failed', message: dropped?.reason };
  }
  return { target, key, status: 'saved' };
}

function toPending({ target, key }: t.TransferStep): t.TransferResult {
  return { target, key, status: 'pending' };
}

function toThrownResult(target: t.WriteTarget, key: string, err: unknown): t.TransferResult {
  const message = err instanceof Error ? err.message : String(err);
  return { target, key, status: 'failed', message };
}

async function save(
  client: QueryClient,
  target: t.WriteTarget,
  key: string,
  ops: t.ConfigChange[],
  fresh: boolean,
): Promise<t.TransferResult> {
  if (ops.length === 0) return { target, key, status: 'skipped' };
  try {
    const expectedRevision = await readRevision(client, target, fresh);
    const outcome = await applyConfigChangesFn({
      data: { target: toTargetRef(target), ops, expectedRevision },
    });
    return toResult(target, key, outcome);
  } catch (err) {
    return toThrownResult(target, key, err);
  }
}

function uniqueReadKeys(targets: t.WriteTarget[]): Array<readonly string[]> {
  const keys = new Map<string, readonly string[]>();
  targets.flatMap(readKeys).forEach((key) => keys.set(key.join('/'), key));
  return [...keys.values()];
}

/** Every non-skipped copy is saved, and at least one was written: only then may the original go. */
function copiesComplete(results: t.TransferResult[]): boolean {
  const attempted = results.filter(({ status }) => status !== 'skipped');
  return attempted.length > 0 && attempted.every(({ status }) => status === 'saved');
}

/** Saves `steps`, then for a move the removal once every copy is saved; `fresh` reads each target's revision anew. Returns the targets written to. */
async function writeTransfer(
  client: QueryClient,
  source: t.WriteTarget,
  transfer: t.Transfer,
  steps: t.TransferStep[],
  fresh: boolean,
  publish: t.Publish,
): Promise<t.WriteTarget[]> {
  for (const step of steps) {
    const { target, key, ops } = step;
    const next = [...transfer.results];
    next[transfer.steps.indexOf(step)] = await save(client, target, key, ops, fresh);
    transfer.results = next;
    publish.results(next);
  }
  const { mode, entry, removal } = transfer;
  const written = steps.map(({ target }) => target);
  const removable = mode === 'move' && copiesComplete(transfer.results);
  if (!removable || removal?.status === 'saved') return written;
  transfer.removal = await save(client, source, entry.key, planRemoval(entry), fresh);
  publish.removal(transfer.removal);
  return [...written, source];
}

/**
 * Writes an entry to each target, one save per step, and reports one result
 * per step. Nothing is saved until `run`; a step that fails does not stop the
 * others, and `retry` re-runs only the failed and stale ones against the
 * target as it is now. A move removes the original from `source` once every
 * copy is saved, and never before.
 */
export function useEntryTransfer(options: { source: t.WriteTarget }): t.EntryTransferState {
  const { source } = options;
  const queryClient = useQueryClient();
  const [results, setResults] = useState<t.TransferResult[]>([]);
  const [removal, setRemoval] = useState<t.TransferResult | null>(null);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<t.TransferMode>('copy');
  const transferRef = useRef<t.Transfer | null>(null);
  const busyRef = useRef(false);

  const execute = useCallback(
    async (transfer: t.Transfer, steps: t.TransferStep[], fresh: boolean) => {
      busyRef.current = true;
      setRunning(true);
      const publish: t.Publish = { results: setResults, removal: setRemoval };
      let touched: t.WriteTarget[] = steps.map(({ target }) => target);
      try {
        touched = await writeTransfer(queryClient, source, transfer, steps, fresh, publish);
      } finally {
        await Promise.all(
          uniqueReadKeys(touched).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        );
        busyRef.current = false;
        setRunning(false);
      }
    },
    [queryClient, source],
  );

  const run = useCallback<t.EntryTransferState['run']>(
    async (nextMode, entry, steps) => {
      if (busyRef.current) return;
      busyRef.current = true;
      const pending = steps.map(toPending);
      const transfer: t.Transfer = {
        mode: nextMode,
        entry,
        steps,
        results: pending,
        removal: null,
      };
      transferRef.current = transfer;
      setMode(nextMode);
      setRemoval(null);
      setResults(pending);
      await execute(transfer, steps, false);
    },
    [execute],
  );

  const retry = useCallback(async () => {
    const transfer = transferRef.current;
    if (busyRef.current || !transfer) return;
    const failed = transfer.steps.filter((_, i) => isRetryable(transfer.results[i]));
    const removalFailed = transfer.removal !== null && transfer.removal.status !== 'saved';
    if (failed.length === 0 && !removalFailed) return;
    await execute(transfer, failed, true);
  }, [execute]);

  const originalKept =
    mode === 'move' && results.length > 0 && !running && removal?.status !== 'saved';
  return { run, retry, results, removal, running, originalKept };
}
