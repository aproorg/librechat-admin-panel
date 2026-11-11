import type { ConfigValue } from './config';
import type { WriteTarget } from './config-ui';
import type { ConfigChange } from './changes';

export type TransferMode = 'copy' | 'move';
/** One named entry as the open place shows it. `path` is the collection path (`mcpServers`, `endpoints.custom`); `secrets` are leaf paths inside the entry whose stored value is masked. */
export interface TransferEntry {
  path: string;
  key: string;
  value: ConfigValue;
  secrets: string[];
}
export type ClashChoice = 'replace' | 'keepBoth' | 'skip';
/** `ownKeys`: names the target's own layer holds (a clash). `shownKeys`: every name the target shows, own or inherited (a keep-both name must miss all of them). */
export interface TransferTargetInput {
  target: WriteTarget;
  ownKeys: ReadonlySet<string>;
  shownKeys: ReadonlySet<string>;
  clash?: ClashChoice;
  /** The entry the target shows under the entry's name; a keyed-list replace sends it as the upsert baseline. */
  current?: ConfigValue;
}
export type TransferNames = Pick<TransferTargetInput, 'ownKeys' | 'shownKeys' | 'current'>;
export interface TransferStep {
  target: WriteTarget;
  key: string;
  ops: ConfigChange[];
}
export type MoveBlock = 'file' | 'inherited' | 'readOnly';
export interface TransferEligibility {
  copy: boolean;
  move: boolean;
  moveBlocked?: MoveBlock;
}
export type TransferStatus = 'pending' | 'saved' | 'failed' | 'stale' | 'skipped';
export interface TransferResult {
  target: WriteTarget;
  key: string;
  status: TransferStatus;
  message?: string;
}
/** One Copy to… / Move to… item of an entry; `reason` says why it is disabled. */
export interface TransferAction {
  mode: TransferMode;
  label: string;
  onSelect: () => void;
  disabled: boolean;
  reason?: string;
}
/** The entry an admin picked an action for. */
export interface ChosenEntry {
  key: string;
  mode: TransferMode;
  value: ConfigValue;
  secrets: string[];
}
/** What a surface alone knows about one entry; `extraReason` disables both actions ahead of every other reason. */
export interface TransferFacts {
  key: string;
  value: ConfigValue;
  secrets: string[];
  fromFile: boolean;
  own: boolean;
  writable: boolean;
  extraReason?: string;
}
export interface TransferDialogProps {
  open: boolean;
  mode: TransferMode;
  entry: TransferEntry;
  source: WriteTarget;
  onClose: () => void;
}
export interface TransferOffer {
  itemsFor: (facts: TransferFacts) => TransferAction[];
  dialog: TransferDialogProps;
}
