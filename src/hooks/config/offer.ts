import { useContext, useState } from 'react';
import type * as t from '@/types';
import { ConfigValuesContext } from '@/contexts/ConfigValuesContext';
import { MOVE_BLOCKED_REASONS } from '@/constants';
import { transferEligibility } from '@/utils';
import { useScopeActions } from './scope';
import { useLocalize } from '../useLocalize';

const EMPTY_RECORD: t.ConfigRecord = Object.freeze({}) as t.ConfigRecord;

/**
 * Copy to… and Move to… for the entries of the collection at `path`: `itemsFor`
 * gives one entry's items (none where the list is not merged entry by entry)
 * from the facts only its surface knows, `dialog` is what to give
 * `<TransferDialog>`. Move shows the surface's extra reason, else why it is
 * blocked, else the unsaved hint; Copy the extra reason, else the hint.
 */
export function useTransferOffer(path: string): t.TransferOffer {
  const localize = useLocalize();
  const valuesData = useContext(ConfigValuesContext);
  const editingScope = useScopeActions()?.editingScope;
  const [chosen, setChosen] = useState<t.ChosenEntry | null>(null);
  const unsaved =
    valuesData?.isDirty === true ? localize('com_config_transfer_unsaved') : undefined;

  const itemsFor = (facts: t.TransferFacts): t.TransferAction[] => {
    const { key, value, secrets, extraReason } = facts;
    const eligibility = transferEligibility(path, facts);
    if (!eligibility.copy) return [];
    const blocked =
      eligibility.moveBlocked && localize(MOVE_BLOCKED_REASONS[eligibility.moveBlocked]);
    const item = (mode: t.TransferMode, reason: string | undefined): t.TransferAction => ({
      mode,
      label: localize(`com_config_transfer_title_${mode}`),
      onSelect: () => setChosen({ key, mode, value, secrets }),
      disabled: reason !== undefined,
      reason,
    });
    return [item('copy', extraReason ?? unsaved), item('move', extraReason ?? blocked ?? unsaved)];
  };

  const dialog: t.TransferDialogProps = {
    open: chosen !== null,
    mode: chosen?.mode ?? 'copy',
    entry: {
      path,
      key: chosen?.key ?? '',
      value: chosen?.value ?? EMPTY_RECORD,
      secrets: chosen?.secrets ?? [],
    },
    source:
      editingScope && valuesData?.layers?.scope != null
        ? { type: 'scope', scope: editingScope }
        : { type: 'base' },
    onClose: () => setChosen(null),
  };
  return { itemsFor, dialog };
}
