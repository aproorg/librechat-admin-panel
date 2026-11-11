import { configSchema } from 'librechat-data-provider';
import type * as t from '@/types';
import { schemaType, unwrapSchema, resolveSubSchema } from './schema';
import { flattenObject, isConfigRecord, removeValueAtPath } from './format';
import { getKeyedCollection } from './collections';
import { isSameScope } from './scopes';
import { MASKED_SECRET } from './secrets';

export const MAX_TRANSFER_TARGETS = 10;

/** The places a transfer can go: Base when the admin may write it, then every profile, minus the open place. `scopes` holds only profiles the admin may write. */
export function transferTargets(
  scopes: t.ConfigScope[],
  source: t.WriteTarget,
  canWriteBase: boolean,
): t.WriteTarget[] {
  const baseTargets: t.WriteTarget[] =
    canWriteBase && source.type !== 'base' ? [{ type: 'base' }] : [];
  const profiles = scopes
    .filter((scope) => source.type === 'base' || !isSameScope(scope, source.scope))
    .map((scope): t.WriteTarget => ({ type: 'scope', scope }));
  return [...baseTargets, ...profiles];
}

function isPositionalList(path: string): boolean {
  const schema = resolveSubSchema(configSchema as t.ZodSchemaLike, path.split('.'));
  return schema !== null && schemaType(unwrapSchema(schema)) === 'array';
}

function moveBlockOf(origin: {
  fromFile: boolean;
  own: boolean;
  writable: boolean;
}): t.MoveBlock | undefined {
  if (!origin.writable) return 'readOnly';
  if (origin.fromFile) return 'file';
  if (!origin.own) return 'inherited';
  return undefined;
}

/** What an entry's actions offer. Lists a profile replaces whole, and positional lists, offer nothing. */
export function transferEligibility(
  path: string,
  origin: { fromFile: boolean; own: boolean; writable: boolean },
): t.TransferEligibility {
  const collection = getKeyedCollection(path);
  const replaced = collection ? collection.merge === 'replace' : isPositionalList(path);
  if (replaced) return { copy: false, move: false };
  const moveBlocked = moveBlockOf(origin);
  return moveBlocked ? { copy: true, move: false, moveBlocked } : { copy: true, move: true };
}

function isWritableLeaf(leaf: t.ConfigValue): boolean {
  if (leaf === null || leaf === undefined) return false;
  return !(isConfigRecord(leaf) && Object.keys(leaf).length === 0);
}

function withoutMask(record: t.ConfigRecord): t.ConfigRecord {
  return Object.fromEntries(
    Object.entries(record)
      .filter(([, leaf]) => leaf !== MASKED_SECRET)
      .map(([key, leaf]): [string, t.ConfigValue] => [
        key,
        isConfigRecord(leaf) ? withoutMask(leaf) : leaf,
      ]),
  );
}

/** The writes that put `entry` in one target, as today's create flow emits them. */
export function planCopy(
  entry: t.TransferEntry,
  input: t.TransferTargetInput,
  _secrets: Record<string, string>,
): t.TransferStep | null {
  const collection = getKeyedCollection(entry.path);
  const hidden = collection?.secret ? [...entry.secrets, collection.secret.preview] : entry.secrets;
  const clean = withoutMask(
    hidden.reduce(removeValueAtPath, isConfigRecord(entry.value) ? entry.value : {}),
  );
  const step = (ops: t.ConfigChange[]): t.TransferStep => ({
    target: input.target,
    key: entry.key,
    ops,
  });
  if (collection) {
    const value = { ...clean, [collection.key]: entry.key };
    return step([
      { op: 'upsertEntry', path: collection.path, key: entry.key, identity: null, value },
    ]);
  }
  if (entry.key.includes('.')) {
    throw new Error(`${entry.path}: "${entry.key}" has a dot, no path can address it`);
  }
  return step(
    Object.entries(flattenObject(clean))
      .filter(([, leaf]) => isWritableLeaf(leaf))
      .map(([leaf, value]): t.ConfigChange => {
        return { op: 'set', path: `${entry.path}.${entry.key}.${leaf}`, value };
      }),
  );
}
