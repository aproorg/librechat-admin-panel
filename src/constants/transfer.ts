import type * as t from '@/types';

export const MOVE_BLOCKED_REASONS: Readonly<Record<t.MoveBlock, string>> = {
  readOnly: 'com_config_transfer_blocked_read_only',
  file: 'com_config_transfer_blocked_file',
  inherited: 'com_config_transfer_blocked_inherited',
};
