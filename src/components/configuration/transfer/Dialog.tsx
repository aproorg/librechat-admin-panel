import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Dialog, RadioGroup } from '@clickhouse/click-ui';
import type * as t from '@/types';
import { SKIP_REASON_KEYS } from '@/constants';
import { PasswordInput } from '@/components/PasswordInput';
import { availableScopesOptions, baseConfigOptions } from '@/server';
import {
  useLocalize,
  useReturnFocus,
  useCapabilities,
  useEntryTransfer,
  importTargetLabel,
  scopeConfigOptions,
  useConfigFeatures,
  useConfigWriteRules,
} from '@/hooks';
import {
  cn,
  planCopy,
  entriesByKey,
  isConfigRecord,
  mergeScopeLayer,
  getValueAtPath,
  getKeyedCollection,
  formatScopeParam,
  transferTargets,
  hasConfigCapability,
  MAX_TRANSFER_TARGETS,
} from '@/utils';

const EMPTY_SCOPES: t.ConfigScope[] = [];
const BAR = 'rounded bg-(--cui-color-background-secondary)';
const STATUS_KEYS: Readonly<Record<t.TransferStatus, string>> = {
  pending: 'com_config_transfer_saving',
  saved: 'com_config_transfer_saved',
  failed: 'com_config_transfer_failed',
  stale: 'com_config_transfer_stale',
  skipped: 'com_config_transfer_skipped',
};

const keyOf = (target: t.WriteTarget): string =>
  target.type === 'base' ? 'base' : formatScopeParam(target.scope);

function labelOf(target: t.WriteTarget, localize: t.LocalizeFn): string {
  const label = importTargetLabel(
    target.type === 'base' ? target : { ...target, exists: true },
    localize,
  );
  return target.type === 'scope' && !target.scope.isActive
    ? `${label} (${localize('com_config_transfer_inactive')})`
    : label;
}

function PlacesSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2 motion-safe:animate-pulse">
      {[0, 1, 2].map((row) => (
        <div key={row} className={cn(BAR, 'h-8 w-full')} />
      ))}
    </div>
  );
}

const CLASH_CHOICES: readonly t.ClashChoice[] = ['replace', 'keepBoth', 'skip'];
const CLASH_KEYS: Readonly<Record<t.ClashChoice, string>> = {
  replace: 'com_config_transfer_clash_replace',
  keepBoth: 'com_config_transfer_clash_keep_both',
  skip: 'com_config_transfer_clash_skip',
};

function namesAt(layer: t.ConfigValue, entry: t.TransferEntry): Set<string> {
  const list = getValueAtPath(layer, entry.path);
  const collection = getKeyedCollection(entry.path);
  if (collection) return new Set(entriesByKey(list, collection.key).keys());
  return new Set(isConfigRecord(list) ? Object.keys(list) : []);
}

function namesOf(
  entry: t.TransferEntry,
  base: t.BaseConfigData,
  scope: t.ResolvedConfigData | undefined,
  merge: (base: t.ConfigRecord, scope: t.ResolvedConfigData) => t.ConfigRecord,
): t.TransferNames {
  if (!scope) {
    return {
      ownKeys: namesAt(base.dbOverrides ?? {}, entry),
      shownKeys: namesAt(base.config, entry),
    };
  }
  const shown = merge(base.config, scope);
  return { ownKeys: namesAt(scope.overrides, entry), shownKeys: namesAt(shown, entry) };
}

/** The names each ticked target holds and shows, by key; a target whose layers are loading or failed has none. */
function useTargetNames(chosen: t.WriteTarget[], entry: t.TransferEntry) {
  const rules = useConfigWriteRules();
  const { keyedTombstones } = useConfigFeatures();
  const base = useQuery({ ...baseConfigOptions, enabled: chosen.length > 0 });
  const scoped = useQueries({
    queries: chosen.map((target) =>
      scopeConfigOptions(target.type === 'scope' ? target.scope : null),
    ),
  });
  const merge = (lower: t.ConfigRecord, scope: t.ResolvedConfigData) =>
    mergeScopeLayer(lower, scope.overrides, scope.tombstones, rules, keyedTombstones);
  const names = new Map<string, t.TransferNames>();
  chosen.forEach((target, i) => {
    if (!base.data) return;
    const scope = scoped[i]?.data;
    if (target.type === 'scope' && !scope) return;
    names.set(keyOf(target), namesOf(entry, base.data, scope, merge));
  });
  const failedQueries = [base, ...scoped].filter((query) => query.isError);
  return {
    names,
    failed: chosen.length > 0 && failedQueries.length > 0,
    loading: chosen.some((target) => !names.has(keyOf(target))),
    retry: () => failedQueries.forEach((query) => void query.refetch()),
  };
}

function describe(message: string, localize: t.LocalizeFn): string {
  return Object.hasOwn(SKIP_REASON_KEYS, message)
    ? localize(SKIP_REASON_KEYS[message as t.SkipReason])
    : message;
}

function ResultRow({ result, label: heading }: { result: t.TransferResult; label?: string }) {
  const localize = useLocalize();
  const { target, status, message } = result;
  const label = heading ?? labelOf(target, localize);
  const scope = target.type === 'base' ? undefined : formatScopeParam(target.scope);
  return (
    <li data-testid="transfer-result" className="flex flex-col gap-0.5 py-1 text-sm">
      {status === 'saved' ? (
        <Link to="/configuration" search={{ scope }}>
          {label}
        </Link>
      ) : (
        <span className="font-medium">{label}</span>
      )}
      <span className="text-xs wrap-anywhere text-(--cui-color-text-muted)">
        {localize(STATUS_KEYS[status])}
        {message ? `: ${describe(message, localize)}` : ''}
      </span>
    </li>
  );
}

interface PickerProps {
  mode: t.TransferMode;
  entry: t.TransferEntry;
  loading: boolean;
  failed: boolean;
  targets: t.WriteTarget[];
  ticked: ReadonlySet<string>;
  chosen: t.WriteTarget[];
  onReload: () => void;
  onToggle: (key: string, checked: boolean) => void;
}

function Picker(props: PickerProps) {
  const { mode, entry, loading, failed, targets, ticked, chosen, onReload, onToggle } = props;
  const localize = useLocalize();
  if (loading) return <PlacesSkeleton />;
  if (failed) {
    return (
      <div role="alert" className="flex items-center gap-3">
        <span className="text-sm text-(--cui-color-text-danger)">
          {localize('com_config_transfer_load_error')}
        </span>
        <Button
          htmlType="button"
          type="secondary"
          label={localize('com_ui_retry')}
          onClick={onReload}
        />
      </div>
    );
  }
  if (targets.length === 0) {
    return (
      <p className="m-0 text-sm text-(--cui-color-text-muted)">
        {localize('com_config_transfer_empty')}
      </p>
    );
  }
  return (
    <>
      <div
        role="group"
        aria-label={localize('com_config_transfer_places')}
        className="flex flex-col gap-2"
      >
        {targets.map((target) => (
          <Checkbox
            key={keyOf(target)}
            id={`transfer-${keyOf(target)}`}
            label={labelOf(target, localize)}
            checked={ticked.has(keyOf(target))}
            onCheckedChange={(checked) => onToggle(keyOf(target), checked === true)}
          />
        ))}
      </div>
      {chosen.length >= MAX_TRANSFER_TARGETS && (
        <p className="m-0 text-xs text-(--cui-color-text-muted)">
          {localize('com_config_transfer_limit', { max: MAX_TRANSFER_TARGETS })}
        </p>
      )}
      {chosen.length > 0 && (
        <p data-testid="transfer-summary" className="m-0 text-sm wrap-anywhere">
          {localize(`com_config_transfer_summary_${mode}`, {
            name: entry.key,
            count: chosen.length,
            targets: chosen.map((target) => labelOf(target, localize)).join(', '),
          })}
        </p>
      )}
    </>
  );
}

interface OptionsProps {
  entry: t.TransferEntry;
  clashing: t.WriteTarget[];
  choices: Readonly<Record<string, t.ClashChoice>>;
  secrets: Readonly<Record<string, string>>;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  onChoose: (key: string, choice: t.ClashChoice) => void;
  onSecret: (path: string, value: string) => void;
}

function Options(props: OptionsProps) {
  const { entry, clashing, choices, secrets, loading, failed, onRetry, onChoose, onSecret } = props;
  const localize = useLocalize();
  return (
    <>
      {failed && (
        <div role="alert" className="flex items-center gap-3">
          <span className="text-sm text-(--cui-color-text-danger)">
            {localize('com_config_transfer_names_error')}
          </span>
          <Button
            htmlType="button"
            type="secondary"
            label={localize('com_ui_retry')}
            onClick={onRetry}
          />
        </div>
      )}
      {loading && !failed && (
        <p className="m-0 text-xs text-(--cui-color-text-muted)">
          {localize('com_config_transfer_names_loading')}
        </p>
      )}
      {clashing.map((target) => {
        const label = localize('com_config_transfer_clash', {
          name: entry.key,
          place: labelOf(target, localize),
        });
        return (
          <RadioGroup
            key={keyOf(target)}
            label={label}
            aria-label={label}
            value={choices[keyOf(target)] ?? ''}
            onValueChange={(choice) => onChoose(keyOf(target), choice as t.ClashChoice)}
          >
            {CLASH_CHOICES.map((choice) => (
              <RadioGroup.Item
                key={choice}
                value={choice}
                id={`transfer-clash-${keyOf(target)}-${choice}`}
                label={localize(CLASH_KEYS[choice])}
              />
            ))}
          </RadioGroup>
        );
      })}
      {entry.secrets.map((path) => (
        <PasswordInput
          key={path}
          label={localize('com_config_transfer_secret', { path })}
          value={secrets[path] ?? ''}
          onChange={(value) => onSecret(path, value)}
        />
      ))}
    </>
  );
}

function useTicks(targets: t.WriteTarget[]) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const chosen = targets.filter((target) => ticked.has(keyOf(target)));
  const toggle = (key: string, checked: boolean) => {
    const next = new Set(chosen.map(keyOf));
    if (!checked) next.delete(key);
    else if (next.size < MAX_TRANSFER_TARGETS) next.add(key);
    setTicked(next);
  };
  return { ticked, chosen, toggle };
}

interface FooterProps {
  error?: string;
  started: boolean;
  canRetry: boolean;
  running: boolean;
  canConfirm: boolean;
  mode: t.TransferMode;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}

function Footer(props: FooterProps) {
  const localize = useLocalize();
  const { error, started, canRetry, running, canConfirm, mode, onClose, onConfirm, onRetry } =
    props;
  return (
    <div className="form-dialog-footer">
      {error && (
        <div className="rounded-lg bg-[rgba(220,38,38,0.1)] px-3 py-2" role="alert">
          <span className="text-sm font-medium wrap-anywhere text-(--cui-color-text-danger)">
            {error}
          </span>
        </div>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          htmlType="button"
          type="secondary"
          label={localize(started ? 'com_ui_done' : 'com_ui_cancel')}
          onClick={onClose}
          disabled={running}
        />
        {started && canRetry && (
          <Button
            htmlType="button"
            type="primary"
            label={localize('com_ui_retry')}
            onClick={onRetry}
            disabled={running}
          />
        )}
        {!started && (
          <Button
            htmlType="button"
            type="primary"
            label={localize(`com_config_transfer_action_${mode}`)}
            onClick={onConfirm}
            disabled={!canConfirm}
          />
        )}
      </div>
    </div>
  );
}

function TransferBody({ mode, entry, source, onClose }: Omit<t.TransferDialogProps, 'open'>) {
  const localize = useLocalize();
  const { hasCapability } = useCapabilities();
  const query = useQuery(availableScopesOptions);
  const { data: scopes = EMPTY_SCOPES, isPending, isError } = query;
  const transfer = useEntryTransfer({ source });
  const [error, setError] = useState<string>();
  const [choices, setChoices] = useState<Readonly<Record<string, t.ClashChoice>>>({});
  const [secrets, setSecrets] = useState<Readonly<Record<string, string>>>({});

  const canWrite = hasConfigCapability(hasCapability, null, 'manage');
  const targets = transferTargets(canWrite ? scopes : EMPTY_SCOPES, source, canWrite);
  const { ticked, chosen, toggle } = useTicks(targets);
  const { names, loading, failed, retry } = useTargetNames(chosen, entry);
  const clashing = chosen.filter((target) => names.get(keyOf(target))?.ownKeys.has(entry.key));
  const choiceOf = (target: t.WriteTarget) => choices[keyOf(target)];
  const secretsTyped = entry.secrets.every((path) => (secrets[path] ?? '') !== '');
  const started = transfer.results.length > 0;
  const { removal } = transfer;
  const retryable = (result: t.TransferResult | null) =>
    result?.status === 'failed' || result?.status === 'stale';
  const canRetry = transfer.results.some(retryable) || retryable(removal);
  const canConfirm =
    chosen.length > 0 && !loading && secretsTyped && clashing.every((target) => choiceOf(target));

  const onToggle = (key: string, checked: boolean) => {
    toggle(key, checked);
    if (!checked) setChoices(({ [key]: _dropped, ...rest }) => rest);
  };

  const confirm = async () => {
    setError(undefined);
    try {
      const steps = chosen
        .flatMap((target) => {
          const named = names.get(keyOf(target));
          return named ? [{ ...named, target, clash: choiceOf(target) }] : [];
        })
        .map((wanted) => planCopy(entry, wanted, secrets))
        .filter((step): step is t.TransferStep => step !== null);
      if (steps.length === 0) return onClose();
      await transfer.run(mode, entry, steps);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="form-dialog-form">
      <div className="form-dialog-body gap-4!">
        {started ? (
          <>
            <ul className="m-0 flex list-none flex-col p-0" aria-live="polite">
              {transfer.results.map((result) => (
                <ResultRow key={keyOf(result.target)} result={result} />
              ))}
              {removal && (
                <ResultRow
                  result={removal}
                  label={localize('com_config_transfer_original', {
                    place: labelOf(source, localize),
                  })}
                />
              )}
            </ul>
            {transfer.originalKept && (
              <p data-testid="transfer-kept" className="m-0 text-sm">
                {localize('com_config_transfer_kept')}
              </p>
            )}
          </>
        ) : (
          <>
            <Picker
              mode={mode}
              entry={entry}
              loading={isPending}
              failed={isError && query.data === undefined}
              targets={targets}
              ticked={ticked}
              chosen={chosen}
              onReload={() => void query.refetch()}
              onToggle={onToggle}
            />
            {chosen.length > 0 && (
              <Options
                entry={entry}
                clashing={clashing}
                choices={choices}
                secrets={secrets}
                loading={loading}
                failed={failed}
                onRetry={retry}
                onChoose={(key, choice) => setChoices((prev) => ({ ...prev, [key]: choice }))}
                onSecret={(path, value) => setSecrets((prev) => ({ ...prev, [path]: value }))}
              />
            )}
          </>
        )}
      </div>

      <Footer
        error={error}
        started={started}
        canRetry={canRetry}
        running={transfer.running}
        canConfirm={canConfirm}
        mode={mode}
        onClose={onClose}
        onConfirm={() => void confirm()}
        onRetry={() => void transfer.retry()}
      />
    </div>
  );
}

/** Copy (or move) one entry to the places the admin ticks; nothing is written until confirm. */
export function TransferDialog({ open, mode, entry, source, onClose }: t.TransferDialogProps) {
  const localize = useLocalize();
  const returnFocus = useReturnFocus(open);
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <Dialog.Content
        title={localize(`com_config_transfer_title_${mode}`)}
        showClose
        onClose={onClose}
        onCloseAutoFocus={returnFocus}
        className="modal-frost form-dialog-content"
      >
        <TransferBody mode={mode} entry={entry} source={source} onClose={onClose} />
      </Dialog.Content>
    </Dialog>
  );
}
