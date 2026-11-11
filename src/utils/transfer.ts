import { configSchema } from 'librechat-data-provider';
import type * as t from '@/types';
import { schemaType, unwrapSchema, resolveSubSchema } from './schema';
import { flattenObject, isConfigRecord, removeValueAtPath, setValueAtPath } from './format';
import { getKeyedCollection } from './collections';
import { isSameScope } from './scopes';
import { MASKED_SECRET, secretPreviewPath } from './secrets';

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

/** Whether a proper prefix of `path` is a record or a list, so `path` lies inside one of its entries. */
function isInsideEntry(path: string): boolean {
  const segments = path.split('.');
  return segments.slice(1).some((_, i) => {
    const prefix = segments.slice(0, i + 1);
    if (getKeyedCollection(prefix.join('.'))) return true;
    const schema = resolveSubSchema(configSchema as t.ZodSchemaLike, prefix);
    const type = schema ? schemaType(unwrapSchema(schema)) : undefined;
    return type === 'record' || type === 'array';
  });
}

/** What an entry's actions offer. Lists a profile replaces whole, positional lists, and collections nested inside another collection's entry, offer nothing. */
export function transferEligibility(
  path: string,
  origin: { fromFile: boolean; own: boolean; writable: boolean },
): t.TransferEligibility {
  if (isInsideEntry(path)) return { copy: false, move: false };
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
    Object.entries(record).flatMap(([key, leaf]): [string, t.ConfigValue][] =>
      leaf === MASKED_SECRET ? [] : [[key, unmasked(leaf)]],
    ),
  );
}

function unmasked(value: t.ConfigValue): t.ConfigValue {
  if (Array.isArray(value)) {
    return value.filter((item) => item !== MASKED_SECRET).map(unmasked);
  }
  return isConfigRecord(value) ? withoutMask(value) : value;
}

function typedSecret(secret: string, secrets: Record<string, string>): string {
  const typed = secrets[secret];
  if (!typed || typed === MASKED_SECRET) {
    throw new Error(`${secret}: the secret needs a typed value`);
  }
  return typed;
}

/** `name-copy`, then `name-copy-2`, ...: the first no shown entry has, in any letter case. The name itself stays as it is (spaces, dots, Icelandic letters). */
function keepBothName(name: string, shown: ReadonlySet<string>): string {
  const taken = new Set([...shown].map((key) => key.toLowerCase()));
  const base = `${name}-copy`;
  const free = (candidate: string) => !taken.has(candidate.toLowerCase());
  if (free(base)) return base;
  let n = 2;
  while (!free(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function assertAddressable(path: string, key: string): void {
  if (key.includes('.')) throw new Error(`${path}: "${key}" has a dot, no path can address it`);
}

/** The writes that take `entry` out of the place it is in, as deleting it there emits them. */
export function planRemoval(entry: t.TransferEntry): t.ConfigChange[] {
  const collection = getKeyedCollection(entry.path);
  if (collection) {
    return [{ op: 'removeEntry', path: collection.path, key: entry.key, identity: entry.key }];
  }
  assertAddressable(entry.path, entry.key);
  return [{ op: 'reset', path: `${entry.path}.${entry.key}` }];
}

/** The writes that put `entry` in one target, as today's create flow emits them. `secrets` holds the typed value of each of `entry.secrets`, by leaf path. */
export function planCopy(
  entry: t.TransferEntry,
  input: t.TransferTargetInput,
  secrets: Record<string, string>,
): t.TransferStep | null {
  if (input.clash === 'skip') return null;
  const collection = getKeyedCollection(entry.path);
  const key = input.clash === 'keepBoth' ? keepBothName(entry.key, input.shownKeys) : entry.key;
  const typed = entry.secrets.map((secret): [string, string] => [
    secret,
    typedSecret(secret, secrets),
  ]);
  const hidden = [
    ...entry.secrets,
    ...entry.secrets.map(secretPreviewPath),
    ...(collection?.secret ? [collection.secret.preview] : []),
  ];
  const clean = typed.reduce(
    (record, [secret, value]) => setValueAtPath(record, secret, value),
    withoutMask(hidden.reduce(removeValueAtPath, isConfigRecord(entry.value) ? entry.value : {})),
  );
  const step = (ops: t.ConfigChange[]): t.TransferStep => ({ target: input.target, key, ops });
  const cleared = input.clash === 'replace' ? planRemoval(entry) : [];
  const inherited =
    input.clash !== 'replace' && !input.ownKeys.has(key) && input.shownKeys.has(key);
  const identity = inherited ? key : null;
  if (collection) {
    const value = { ...clean, [collection.key]: key };
    const { current: baseline } = input;
    if (input.clash === 'replace' && baseline !== undefined) {
      return step([
        { op: 'upsertEntry', path: collection.path, key, identity: key, baseline, value },
      ]);
    }
    return step([...cleared, { op: 'upsertEntry', path: collection.path, key, identity, value }]);
  }
  assertAddressable(entry.path, key);
  return step([
    ...cleared,
    ...Object.entries(flattenObject(clean))
      .filter(([, leaf]) => isWritableLeaf(leaf))
      .map(([leaf, value]): t.ConfigChange => {
        return { op: 'set', path: `${entry.path}.${key}.${leaf}`, value };
      }),
  ]);
}
