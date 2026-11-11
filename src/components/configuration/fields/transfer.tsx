import { useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type * as t from '@/types';
import {
  entriesByKey,
  getValueAtPath,
  isConfigRecord,
  findStoredSecrets,
  getKeyedCollection,
  transferEligibility,
} from '@/utils';
import {
  useLocalize,
  useScopeActions,
  useEntryMarkers,
  useConfigFeatures,
  useRecordEntryOverrides,
} from '@/hooks';
import { TransferDialog } from '@/components/configuration/transfer';
import { ConfigValuesContext } from '@/contexts/ConfigValuesContext';

const MOVE_BLOCKED_REASONS: Readonly<Record<t.MoveBlock, string>> = {
  readOnly: 'com_config_transfer_blocked_read_only',
  file: 'com_config_transfer_blocked_file',
  inherited: 'com_config_transfer_blocked_inherited',
};
const EMPTY_RECORD: t.ConfigRecord = Object.freeze({}) as t.ConfigRecord;

/** Copy to… / Move to… of one entry; `reason` says why it is disabled. */
export interface EntryTransferAction {
  id: t.TransferMode;
  label: string;
  onSelect: () => void;
  disabled: boolean;
  reason?: string;
}

/** The entry `key` of the record or by-name list at `path` in `root`, if that layer holds it. */
function entryOf(root: t.ConfigValue, path: string, key: string): t.ConfigValue {
  const at = getValueAtPath(root, path);
  const collection = getKeyedCollection(path);
  if (collection) return entriesByKey(at, collection.key).get(key);
  return isConfigRecord(at) && Object.hasOwn(at, key) ? at[key] : undefined;
}

/**
 * Copy to… and Move to… for the entries of the record or by-name list at
 * `path`: `actionsFor` gives one entry's actions (none where the list is not
 * merged entry by entry), `dialog` is the one dialog to render beside the list.
 */
export function useEntryTransfer(path: string | undefined): {
  actionsFor: (key: string, value: t.ConfigValue, disabled?: boolean) => EntryTransferAction[];
  dialog: ReactNode;
} {
  const localize = useLocalize();
  const features = useConfigFeatures();
  const valuesData = useContext(ConfigValuesContext);
  const editingScope = useScopeActions()?.editingScope;
  const markersOf = useEntryMarkers(path);
  const overridesOf = useRecordEntryOverrides(path ?? '');
  const [chosen, setChosen] = useState<{
    key: string;
    mode: t.TransferMode;
    value: t.ConfigValue;
  } | null>(null);
  const layers = valuesData?.layers ?? null;
  const inScope = layers?.scope != null;
  const collection = path ? getKeyedCollection(path) : undefined;

  const actionsFor = (key: string, value: t.ConfigValue, disabled = false) => {
    if (!path || !layers || collection?.gate?.(features) === false) return [];
    if (!collection && key.includes('.')) return [];
    const saved = entryOf(layers.effective, path, key);
    if (saved === undefined) return [];
    const isLower = entryOf(inScope ? layers.base : layers.yamlEffective, path, key) !== undefined;
    const overridden = collection ? markersOf?.(value)?.overridden : overridesOf?.(key).overridden;
    const eligibility = transferEligibility(path, {
      fromFile: entryOf(layers.yamlEffective, path, key) !== undefined,
      own: !isLower || overridden === true,
      writable: !disabled,
    });
    if (!eligibility.copy) return [];
    const unsaved =
      valuesData?.isDirty === true ? localize('com_config_transfer_unsaved') : undefined;
    const blocked = eligibility.moveBlocked;
    const action = (mode: t.TransferMode, reason?: string): EntryTransferAction => ({
      id: mode,
      label: localize(`com_config_transfer_title_${mode}`),
      onSelect: () => setChosen({ key, mode, value: saved }),
      disabled: reason !== undefined,
      reason,
    });
    return [
      action('copy', unsaved),
      action('move', blocked ? localize(MOVE_BLOCKED_REASONS[blocked]) : unsaved),
    ];
  };

  const dialog = (
    <TransferDialog
      open={chosen !== null}
      mode={chosen?.mode ?? 'copy'}
      entry={{
        path: path ?? '',
        key: chosen?.key ?? '',
        value: chosen?.value ?? EMPTY_RECORD,
        secrets: isConfigRecord(chosen?.value)
          ? findStoredSecrets(chosen.value).map((secret) => secret.path)
          : [],
      }}
      source={editingScope && inScope ? { type: 'scope', scope: editingScope } : { type: 'base' }}
      onClose={() => setChosen(null)}
    />
  );
  return { actionsFor, dialog };
}
