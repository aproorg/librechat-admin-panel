import { useContext } from 'react';
import type { ReactNode } from 'react';
import type * as t from '@/types';
import {
  entryOf,
  isConfigRecord,
  findStoredSecrets,
  getKeyedCollection,
  transferEligibility,
} from '@/utils';
import {
  useEntryMarkers,
  useConfigFeatures,
  useLocalize,
  useTransferOffer,
  useEntryOverrideNotes,
  useRecordEntryOverrides,
} from '@/hooks';
import { describeOverrideNotes } from '../values';
import { TransferDialog } from '@/components/configuration/transfer';
import { ConfigValuesContext } from '@/contexts/ConfigValuesContext';

/**
 * Copy to… and Move to… for the entries of the record or by-name list at
 * `path`: `actionsFor` gives one entry's actions (none for an entry this
 * layer does not hold, a dotted record key, or a feature-gated list),
 * `dialog` is the one dialog to render beside the list.
 */
export function useFieldTransfer(path: string | undefined): {
  actionsFor: (key: string, value: t.ConfigValue, disabled?: boolean) => t.TransferAction[];
  dialog: ReactNode;
} {
  const features = useConfigFeatures();
  const layers = useContext(ConfigValuesContext)?.layers ?? null;
  const markersOf = useEntryMarkers(path);
  const overridesOf = useRecordEntryOverrides(path ?? '');
  const offer = useTransferOffer(path ?? '');
  const localize = useLocalize();
  const overrideNotes = useEntryOverrideNotes(path ?? '');
  const collection = path ? getKeyedCollection(path) : undefined;

  const offersAny =
    path !== undefined &&
    collection?.gate?.(features) !== false &&
    transferEligibility(path, { fromFile: false, own: true, writable: true }).copy;

  const actionsFor = (key: string, value: t.ConfigValue, disabled = false) => {
    if (!path || !layers || !offersAny) return [];
    if (!collection && key.includes('.')) return [];
    const saved = entryOf(layers.effective, path, key);
    if (saved === undefined) return [];
    const lowerLayer = layers.scope != null ? layers.base : layers.yamlEffective;
    const overridden = collection ? markersOf?.(value)?.overridden : overridesOf?.(key).overridden;
    return offer.itemsFor({
      key,
      value: saved,
      secrets: isConfigRecord(saved) ? findStoredSecrets(saved).map((secret) => secret.path) : [],
      fromFile: entryOf(layers.yamlEffective, path, key) !== undefined,
      own: entryOf(lowerLayer, path, key) === undefined || overridden === true,
      writable: !disabled,
      notes: describeOverrideNotes(overrideNotes.left(key), localize),
    });
  };

  return { actionsFor, dialog: offersAny ? <TransferDialog {...offer.dialog} /> : null };
}
