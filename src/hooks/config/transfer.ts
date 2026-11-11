import { useQueryClient } from '@tanstack/react-query';
import { useState, useCallback, useRef } from 'react';
import type * as t from '@/types';
import { RESOLVED_READ_QUERY_KEYS } from '@/constants';
import { applyConfigChangesFn } from '@/server';

function toTargetRef(target: t.WriteTarget): t.WriteTargetRef {
  if (target.type === 'base') return { type: 'base' };
  const { principalType, principalId } = target.scope;
  return { type: 'scope', scope: { principalType, principalId } };
}

const RETRYABLE: ReadonlySet<t.TransferStatus> = new Set(['failed', 'stale']);

function readKeys(target: t.WriteTarget): ReadonlyArray<readonly string[]> {
  return target.type === 'base'
    ? [['baseConfig'], ...RESOLVED_READ_QUERY_KEYS]
    : [['resolvedConfig'], ['availableScopes'], ...RESOLVED_READ_QUERY_KEYS];
}

/** The status of one step's save: a conflict is stale, any issue or failed write is failed with its message. */
function toResult(step: t.TransferStep, outcome: t.ApplyConfigChangesResult): t.TransferResult {
  const { target, key } = step;
  if (outcome.conflict) return { target, key, status: 'stale' };
  const [problem] = [...outcome.issues, ...outcome.failed];
  if (problem) return { target, key, status: 'failed', message: problem.message };
  if (outcome.applied === 0) {
    return { target, key, status: 'failed', message: outcome.skipped[0]?.reason };
  }
  return { target, key, status: 'saved' };
}

function toPending({ target, key }: t.TransferStep): t.TransferResult {
  return { target, key, status: 'pending' };
}

function toThrownResult(step: t.TransferStep, err: unknown): t.TransferResult {
  const message = err instanceof Error ? err.message : String(err);
  return { target: step.target, key: step.key, status: 'failed', message };
}

async function saveStep(step: t.TransferStep): Promise<t.TransferResult> {
  try {
    const outcome = await applyConfigChangesFn({
      data: { target: toTargetRef(step.target), ops: step.ops },
    });
    return toResult(step, outcome);
  } catch (err) {
    return toThrownResult(step, err);
  }
}

function uniqueReadKeys(steps: t.TransferStep[]): Array<readonly string[]> {
  const keys = new Map<string, readonly string[]>();
  steps.flatMap(({ target }) => readKeys(target)).forEach((key) => keys.set(key.join('/'), key));
  return [...keys.values()];
}

function keepsOriginal(mode: t.TransferMode, results: t.TransferResult[]): boolean {
  return (
    mode === 'move' && results.some(({ status }) => status !== 'saved' && status !== 'skipped')
  );
}

interface EntryTransferState {
  run(mode: t.TransferMode, entry: t.TransferEntry, steps: t.TransferStep[]): Promise<void>;
  retry(): Promise<void>;
  results: t.TransferResult[];
  running: boolean;
  originalKept: boolean;
}

/**
 * Writes an entry to each target, one save per step, and reports one result
 * per step. Nothing is saved until `run`; a step that fails does not stop the
 * others, and `retry` re-runs only the failed and stale ones.
 */
export function useEntryTransfer(_options: { source: t.WriteTarget }): EntryTransferState {
  const queryClient = useQueryClient();
  const [results, setResults] = useState<t.TransferResult[]>([]);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useState<t.TransferMode>('copy');
  const stepsRef = useRef<t.TransferStep[]>([]);
  const resultsRef = useRef<t.TransferResult[]>([]);
  const busyRef = useRef(false);

  const refresh = useCallback(
    (steps: t.TransferStep[]) => {
      return Promise.all(
        uniqueReadKeys(steps).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
    },
    [queryClient],
  );

  const runSteps = useCallback(
    async (steps: t.TransferStep[], previous: t.TransferResult[]) => {
      busyRef.current = true;
      setRunning(true);
      try {
        const next = [...previous];
        for (const step of steps) {
          const index = stepsRef.current.indexOf(step);
          next[index] = await saveStep(step);
          resultsRef.current = [...next];
          setResults(resultsRef.current);
        }
        await refresh(steps);
      } finally {
        busyRef.current = false;
        setRunning(false);
      }
    },
    [refresh],
  );

  const run = useCallback<EntryTransferState['run']>(
    async (nextMode, _entry, steps) => {
      if (busyRef.current) return;
      busyRef.current = true;
      stepsRef.current = steps;
      setMode(nextMode);
      const pending = steps.map(toPending);
      resultsRef.current = pending;
      setResults(pending);
      await runSteps(steps, pending);
    },
    [runSteps],
  );

  const retry = useCallback(async () => {
    if (busyRef.current) return;
    const failed = stepsRef.current.filter((_, i) => RETRYABLE.has(resultsRef.current[i]?.status));
    if (failed.length === 0) return;
    await runSteps(failed, resultsRef.current);
  }, [runSteps]);

  return { run, retry, results, running, originalKept: keepsOriginal(mode, results) };
}
