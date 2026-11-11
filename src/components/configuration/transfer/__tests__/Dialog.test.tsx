import '@/locales/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as t from '@/types';
import { applyConfigChangesFn } from '@/server';
import { TransferDialog } from '../Dialog';

const scopes = vi.hoisted(() => ({
  list: [] as unknown[],
  pending: false,
  fail: false,
  canManage: true,
  base: { config: {}, dbOverrides: {} } as { config: object; dbOverrides: object },
  docs: {} as Record<string, { overrides?: object; tombstones?: string[] }>,
  hold: null as Promise<void> | null,
  failDocs: false,
  failBase: false,
}));

vi.mock('@/server', () => ({
  applyConfigChangesFn: vi.fn(),
  baseConfigOptions: {
    queryKey: ['baseConfig'],
    queryFn: () =>
      scopes.failBase
        ? Promise.reject(new Error('base down'))
        : Promise.resolve({ dbRevision: 'base-rev', ...scopes.base }),
  },
  getResolvedConfigFn: async ({ data }: { data: { principalId: string } }) => {
    await scopes.hold;
    if (scopes.failDocs) throw new Error('profile down');
    return {
      revision: 'scope-rev',
      resolvedConfig: {},
      changedPaths: [],
      tombstones: [],
      overrides: {},
      ...scopes.docs[data.principalId],
    };
  },
  availableScopesOptions: {
    queryKey: ['availableScopes'],
    queryFn: () => {
      if (scopes.fail) return Promise.reject(new Error('down'));
      return scopes.pending ? new Promise(() => undefined) : Promise.resolve(scopes.list);
    },
  },
}));
vi.mock('@/hooks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks')>()),
  useCapabilities: () => ({ hasCapability: () => scopes.canManage }),
}));
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('@/test/router')).routerless(importOriginal),
);

const applyMock = vi.mocked(applyConfigChangesFn);
const entry: t.TransferEntry = {
  path: 'mcpServers',
  key: 'Notes',
  value: { type: 'sse', url: 'https://notes.example.com/sse' },
  secrets: [],
};
const profile = (id: string, isActive = true): t.ConfigScope => ({
  principalType: PrincipalType.GROUP,
  principalId: id,
  name: `Team ${id}`,
  priority: 10,
  isActive,
});
const ok = (): t.ApplyConfigChangesResult => ({
  applied: 1,
  failed: [],
  warnings: [],
  issues: [],
  skipped: [],
  reported: [],
});

function renderDialog(
  source: t.WriteTarget = { type: 'base' },
  onClose = vi.fn(),
  props: Partial<t.TransferDialogProps> = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransferDialog open mode="copy" entry={entry} source={source} onClose={onClose} {...props} />
    </QueryClientProvider>,
  );
  return { onClose, client };
}

const confirm = () => screen.getByRole('button', { name: 'Copy' });
const clickConfirm = async () => {
  await waitFor(() => expect(confirm()).toBeEnabled());
  fireEvent.click(confirm());
};

beforeEach(() => {
  vi.clearAllMocks();
  scopes.pending = false;
  scopes.fail = false;
  scopes.canManage = true;
  scopes.base = { config: {}, dbOverrides: {} };
  scopes.docs = {};
  scopes.hold = null;
  scopes.failDocs = false;
  scopes.failBase = false;
  scopes.list = [profile('a'), profile('b', false)];
  applyMock.mockResolvedValue(ok());
});

describe('TransferDialog', () => {
  it('shows a loading skeleton while the places load', () => {
    scopes.pending = true;
    renderDialog();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('says no other place can be changed, and disables confirm, when the list is empty', async () => {
    scopes.list = [];
    renderDialog();
    expect(await screen.findByText('No other place you can change')).toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it('lists Base for a profile source but not the open profile itself', async () => {
    renderDialog({ type: 'scope', scope: profile('a') });
    expect(await screen.findByRole('checkbox', { name: /Base configuration/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /Team a/ })).not.toBeInTheDocument();
  });

  it('marks inactive profiles and still lists them', async () => {
    renderDialog();
    const box = await screen.findByRole('checkbox', { name: /Team b/ });
    expect(box).toHaveAccessibleName(/Inactive/);
    expect(screen.getByRole('checkbox', { name: /Team a/ })).not.toHaveAccessibleName(/Inactive/);
  });

  it('keeps confirm disabled with zero ticks and enables it with one', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await waitFor(() => expect(confirm()).toBeEnabled());
    fireEvent.click(screen.getByRole('checkbox', { name: /Team a/ }));
    expect(confirm()).toBeDisabled();
  });

  it('names the entry, the action and every ticked target before anything is written', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Team b/ }));
    const summary = screen.getByTestId('transfer-summary');
    expect(summary).toHaveTextContent('Copy "Notes" to 2 places');
    expect(summary).toHaveTextContent('Group: Team a');
    expect(summary).toHaveTextContent('Group: Team b');
    expect(applyMock).not.toHaveBeenCalled();
  });

  it('closing without confirming makes no save call', async () => {
    const { onClose } = renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(applyMock).not.toHaveBeenCalled();
  });

  describe('at most 10 places', () => {
    beforeEach(() => {
      scopes.list = Array.from({ length: 11 }, (_, i) => profile(`p${i}`));
    });

    it('applies the 10th tick and shows no warning at 9', async () => {
      renderDialog();
      const boxes = await screen.findAllByRole('checkbox');
      boxes.slice(0, 9).forEach((box) => fireEvent.click(box));
      expect(screen.queryByText('At most 10 places')).not.toBeInTheDocument();
      fireEvent.click(boxes[9]);
      expect(boxes[9]).toBeChecked();
    });

    it('ignores the 11th tick and shows the limit text', async () => {
      renderDialog();
      const boxes = await screen.findAllByRole('checkbox');
      boxes.slice(0, 10).forEach((box) => fireEvent.click(box));
      fireEvent.click(boxes[10]);
      expect(boxes[10]).not.toBeChecked();
      expect(screen.getAllByRole('checkbox', { checked: true })).toHaveLength(10);
      expect(screen.getByText('At most 10 places')).toBeInTheDocument();
    });

    it('frees a slot when a tick is removed', async () => {
      renderDialog();
      const boxes = await screen.findAllByRole('checkbox');
      boxes.slice(0, 10).forEach((box) => fireEvent.click(box));
      fireEvent.click(boxes[0]);
      fireEvent.click(boxes[10]);
      expect(boxes[10]).toBeChecked();
    });
  });

  it('saves once per ticked place and shows a result with a link for each', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Team b/ }));
    await clickConfirm();
    const link = await screen.findByRole('link', { name: /Group: Team a/ });
    expect(link).toHaveAttribute('href', '/configuration?scope=group%3Aa');
    expect(await screen.findByRole('link', { name: /Group: Team b/ })).toBeVisible();
    expect(applyMock).toHaveBeenCalledTimes(2);
  });

  it('shows a failed result with its message and Retry, and no link for it', async () => {
    applyMock.mockResolvedValueOnce({
      ...ok(),
      applied: 0,
      failed: [{ path: 'mcpServers.Notes', message: 'boom' }],
    });
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await clickConfirm();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Team a/ })).not.toBeInTheDocument();
    applyMock.mockResolvedValue(ok());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('link', { name: /Team a/ })).toBeVisible());
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows "changed by someone else" for a stale result', async () => {
    applyMock.mockResolvedValueOnce({ ...ok(), applied: 0, conflict: true });
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await clickConfirm();
    const row = await screen.findByTestId('transfer-result');
    expect(within(row).getByText(/changed by someone else/)).toBeInTheDocument();
  });

  it('shows no Retry when every place saved', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await clickConfirm();
    await screen.findByRole('link', { name: /Team a/ });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('drops a ticked place that leaves the list: confirm is disabled again', async () => {
    const { client } = renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    scopes.list = [profile('b', false)];
    await act(() => client.invalidateQueries({ queryKey: ['availableScopes'] }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Team a/ })).toBeNull());
    expect(confirm()).toBeDisabled();
  });

  it('does not count a ticked place that left the list toward the limit', async () => {
    scopes.list = Array.from({ length: 11 }, (_, i) => profile(`p${i}`));
    const { client } = renderDialog();
    const boxes = await screen.findAllByRole('checkbox');
    boxes.slice(0, 10).forEach((box) => fireEvent.click(box));
    scopes.list = (scopes.list as t.ConfigScope[]).slice(1);
    await act(() => client.invalidateQueries({ queryKey: ['availableScopes'] }));
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Team p0$/ })).toBeNull());
    expect(screen.queryByText('At most 10 places')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Team p10/ }));
    expect(screen.getByRole('checkbox', { name: /Team p10/ })).toBeChecked();
  });

  it('shows a load error, not the empty state, when the places fail to load, and Retry reloads', async () => {
    scopes.fail = true;
    renderDialog();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load places');
    expect(screen.queryByText('No other place you can change')).not.toBeInTheDocument();
    expect(confirm()).toBeDisabled();
    scopes.fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox', { name: /Team a/ })).toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('offers Retry for a stale result', async () => {
    applyMock.mockResolvedValueOnce({ ...ok(), applied: 0, conflict: true });
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await clickConfirm();
    await screen.findByTestId('transfer-result');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('offers no place and keeps confirm disabled without the manage capability', async () => {
    scopes.canManage = false;
    renderDialog();
    expect(await screen.findByText('No other place you can change')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(confirm()).toBeDisabled();
  });

  it('keeps the loaded places and the tick when a later refetch fails', async () => {
    const { client } = renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    scopes.fail = true;
    await act(() => client.refetchQueries({ queryKey: ['availableScopes'] }));
    await waitFor(() => expect(client.getQueryState(['availableScopes'])?.status).toBe('error'));
    expect(screen.getByRole('checkbox', { name: /Team a/ })).toBeChecked();
    await waitFor(() => expect(confirm()).toBeEnabled());
  });

  describe('names, clashes and secrets', () => {
    const holdsNotes = { overrides: { mcpServers: { Notes: { url: 'x' } } }, tombstones: [] };
    const group = (id: string) => screen.getByRole('checkbox', { name: new RegExp(`Team ${id}`) });
    const choose = async (place: string, label: string) => {
      const radios = within(await screen.findByRole('radiogroup', { name: new RegExp(place) }));
      fireEvent.click(radios.getByRole('radio', { name: label }));
    };
    const sentOps = (call = 0) => applyMock.mock.calls[call][0].data.ops;

    it('keeps confirm disabled while a ticked place is still loading its names, and enables it after', async () => {
      let release = () => {};
      scopes.hold = new Promise<void>((resolve) => (release = resolve));
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      expect(await screen.findByText(/Checking the names/)).toBeVisible();
      expect(confirm()).toBeDisabled();
      release();
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByText(/Checking the names/)).not.toBeInTheDocument();
    });

    it('asks only for a place whose own layer holds the name, and confirm waits for the choice', async () => {
      scopes.docs = { a: holdsNotes };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      fireEvent.click(group('b'));
      expect(await screen.findAllByRole('radiogroup')).toHaveLength(1);
      expect(screen.getByRole('radiogroup', { name: /Team a/ })).toBeVisible();
      expect(screen.queryByRole('radiogroup', { name: /Team b/ })).not.toBeInTheDocument();
      expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0);
      expect(confirm()).toBeDisabled();
      await choose('Team a', 'Skip this place');
      expect(confirm()).toBeEnabled();
    });

    it('asks nothing for a name the place only inherits', async () => {
      scopes.base = { config: { mcpServers: { Notes: { url: 'x' } } }, dbOverrides: {} };
      renderDialog({ type: 'scope', scope: profile('b') });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    });

    it('asks for Base when Base holds the name in its own overrides', async () => {
      scopes.base = { config: {}, dbOverrides: { mcpServers: { Notes: { url: 'x' } } } };
      renderDialog({ type: 'scope', scope: profile('a') });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Base configuration/ }));
      expect(await screen.findByRole('radiogroup', { name: /Base configuration/ })).toBeVisible();
      expect(confirm()).toBeDisabled();
    });

    it('replace clears the own entry first, then writes it', async () => {
      scopes.docs = { a: holdsNotes };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await choose('Team a', 'Replace it');
      await clickConfirm();
      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      expect(sentOps()[0]).toEqual({ op: 'reset', path: 'mcpServers.Notes' });
      expect(sentOps()).toContainEqual({ op: 'set', path: 'mcpServers.Notes.type', value: 'sse' });
    });

    it('keep both writes under a name no shown entry has, using every name the place shows', async () => {
      scopes.base = { config: { mcpServers: { 'Notes-copy': { url: 'y' } } }, dbOverrides: {} };
      scopes.docs = { a: holdsNotes };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await choose('Team a', 'Keep both');
      await clickConfirm();
      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      expect(sentOps()).toContainEqual({
        op: 'set',
        path: 'mcpServers.Notes-copy-2.type',
        value: 'sse',
      });
    });

    it('skip writes nothing for that place and still writes the others', async () => {
      scopes.docs = { a: holdsNotes };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      fireEvent.click(group('b'));
      await choose('Team a', 'Skip this place');
      await waitFor(() => expect(confirm()).toBeEnabled());
      await clickConfirm();
      expect(await screen.findByRole('link', { name: /Team b/ })).toBeVisible();
      expect(applyMock).toHaveBeenCalledTimes(1);
      expect(screen.getAllByTestId('transfer-result')).toHaveLength(1);
    });

    it('closes without a save when every place is skipped', async () => {
      scopes.docs = { a: holdsNotes };
      const { onClose } = renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await choose('Team a', 'Skip this place');
      await clickConfirm();
      expect(onClose).toHaveBeenCalled();
      expect(applyMock).not.toHaveBeenCalled();
    });

    it('forgets a choice when the place is unticked, so ticking it again asks again', async () => {
      scopes.docs = { a: holdsNotes };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await choose('Team a', 'Replace it');
      expect(confirm()).toBeEnabled();
      fireEvent.click(group('a'));
      fireEvent.click(group('a'));
      await screen.findByRole('radiogroup', { name: /Team a/ });
      expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0);
      expect(confirm()).toBeDisabled();
    });

    it('a ticked place that leaves the list keeps no choice and does not count as chosen', async () => {
      scopes.docs = { a: holdsNotes };
      const { client } = renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      fireEvent.click(group('b'));
      await choose('Team a', 'Replace it');
      scopes.list = [profile('b', false)];
      await act(() => client.invalidateQueries({ queryKey: ['availableScopes'] }));
      await waitFor(() => expect(screen.queryByRole('checkbox', { name: /Team a/ })).toBeNull());
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      expect(confirm()).toBeEnabled();
      await clickConfirm();
      expect(await screen.findByRole('link', { name: /Team b/ })).toBeVisible();
      expect(sentOps()[0]).not.toEqual({ op: 'reset', path: 'mcpServers.Notes' });
    });

    it('shows an error and Retry, not "checking", when a ticked profile fails to load, and recovers', async () => {
      scopes.failDocs = true;
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the names');
      expect(screen.queryByText(/Checking the names/)).not.toBeInTheDocument();
      expect(confirm()).toBeDisabled();
      scopes.failDocs = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('shows an error and Retry when Base fails to load, and recovers', async () => {
      scopes.failBase = true;
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the names');
      expect(screen.queryByText(/Checking the names/)).not.toBeInTheDocument();
      expect(confirm()).toBeDisabled();
      scopes.failBase = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('frees a name the profile hides with a tombstone, so keep both takes it', async () => {
      scopes.base = {
        config: { mcpServers: { 'Notes-copy': { url: 'y' } } },
        dbOverrides: {},
      };
      scopes.docs = {
        a: { overrides: holdsNotes.overrides, tombstones: ['mcpServers.Notes-copy'] },
      };
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await choose('Team a', 'Keep both');
      await clickConfirm();
      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      expect(sentOps()).toContainEqual({
        op: 'set',
        path: 'mcpServers.Notes-copy.type',
        value: 'sse',
      });
    });

    it('keep both for Base avoids a name only librechat.yaml holds', async () => {
      scopes.base = {
        config: { mcpServers: { Notes: { url: 'x' }, 'Notes-copy': { url: 'y' } } },
        dbOverrides: { mcpServers: { Notes: { url: 'x' } } },
      };
      renderDialog({ type: 'scope', scope: profile('a') });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Base configuration/ }));
      await choose('Base configuration', 'Keep both');
      await clickConfirm();
      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      expect(sentOps()).toContainEqual({
        op: 'set',
        path: 'mcpServers.Notes-copy-2.type',
        value: 'sse',
      });
    });

    it('does not ask about a name Base holds only through librechat.yaml, and writes once', async () => {
      scopes.base = { config: { mcpServers: { Notes: { url: 'x' } } }, dbOverrides: {} };
      renderDialog({ type: 'scope', scope: profile('a') });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Base configuration/ }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
      fireEvent.click(confirm());
      await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
      expect(sentOps()).toContainEqual({ op: 'set', path: 'mcpServers.Notes.type', value: 'sse' });
    });

    describe('typed secrets', () => {
      const secretEntry: t.TransferEntry = {
        path: 'mcpServers',
        key: 'Notes',
        value: {
          type: 'sse',
          url: 'https://notes.example.com/sse',
          oauth: { client_id: 'id', client_secret: '********' },
          apiKey: { source: 'admin', key: '********' },
        },
        secrets: ['oauth.client_secret', 'apiKey.key'],
      };
      const field = (name: RegExp) => screen.getByLabelText(name, { selector: 'input' });

      it('asks for each secret by its path, as a password input, and confirm waits for every one', async () => {
        renderDialog(undefined, undefined, { entry: secretEntry });
        fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
        await waitFor(() =>
          expect(field(/oauth\.client_secret/)).toHaveAttribute('type', 'password'),
        );
        expect(field(/apiKey\.key/)).toHaveAttribute('type', 'password');
        expect(confirm()).toBeDisabled();
        fireEvent.change(field(/oauth\.client_secret/), { target: { value: 'sec1' } });
        expect(confirm()).toBeDisabled();
        fireEvent.change(field(/apiKey\.key/), { target: { value: 'sec2' } });
        expect(confirm()).toBeEnabled();
        fireEvent.change(field(/oauth\.client_secret/), { target: { value: '' } });
        expect(confirm()).toBeDisabled();
      });

      it('writes the typed values, never the mask', async () => {
        renderDialog(undefined, undefined, { entry: secretEntry });
        fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
        fireEvent.change(await screen.findByLabelText(/oauth\.client_secret/), {
          target: { value: 'sec1' },
        });
        fireEvent.change(field(/apiKey\.key/), { target: { value: 'sec2' } });
        await waitFor(() => expect(confirm()).toBeEnabled());
        await clickConfirm();
        await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
        const ops = sentOps();
        expect(ops).toContainEqual({
          op: 'set',
          path: 'mcpServers.Notes.oauth.client_secret',
          value: 'sec1',
        });
        expect(ops).toContainEqual({
          op: 'set',
          path: 'mcpServers.Notes.apiKey.key',
          value: 'sec2',
        });
        expect(JSON.stringify(ops)).not.toContain('********');
      });

      it('shows no secret input for an entry without secrets', async () => {
        renderDialog();
        fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
        await waitFor(() => expect(confirm()).toBeEnabled());
        expect(document.querySelector('input[type="password"]')).toBeNull();
      });
    });

    it('shows a planner throw in the alert and writes nothing', async () => {
      const dotted = { ...entry, key: 'No.tes' };
      renderDialog(undefined, undefined, { entry: dotted });
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      await clickConfirm();
      expect(await screen.findByRole('alert')).toHaveTextContent(/has a dot/);
      expect(applyMock).not.toHaveBeenCalled();
    });
  });

  describe('results of a move', () => {
    const move = (source: t.WriteTarget = { type: 'base' }) =>
      renderDialog(source, undefined, { mode: 'move' });
    const fail = { ...ok(), applied: 0, failed: [{ path: 'mcpServers.Notes', message: 'boom' }] };

    it('shows the removal and no kept line once the original is removed', async () => {
      move();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      const row = await screen.findByRole('link', { name: /Original in Base configuration/ });
      expect(row).toBeVisible();
      expect(applyMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByTestId('transfer-kept')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('says the original was kept, and shows no removal, when a copy failed', async () => {
      applyMock.mockResolvedValueOnce(fail);
      move();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      expect(await screen.findByTestId('transfer-kept')).toHaveTextContent('The original was kept');
      expect(screen.queryByText(/Original in/)).not.toBeInTheDocument();
      expect(applyMock).toHaveBeenCalledTimes(1);
    });

    it('offers Retry for a failed removal, and a retry that saves clears the kept line', async () => {
      applyMock.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail);
      move();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      expect(await screen.findByTestId('transfer-kept')).toBeVisible();
      expect(screen.getByText(/Original in Base configuration/)).toBeVisible();
      applyMock.mockResolvedValue(ok());
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(screen.queryByTestId('transfer-kept')).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    });

    it('offers Retry for a stale removal', async () => {
      applyMock
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce({ ...ok(), applied: 0, conflict: true });
      move();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Move' }));
      expect(await screen.findByText(/Original in Base configuration/)).toBeVisible();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
    });

    it('shows no kept line for a copy', async () => {
      applyMock.mockResolvedValueOnce(fail);
      renderDialog();
      fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
      await waitFor(() => expect(confirm()).toBeEnabled());
      await clickConfirm();
      await screen.findByText(/boom/);
      expect(screen.queryByTestId('transfer-kept')).not.toBeInTheDocument();
    });
  });

  it('shows a skip reason as words, not as its code', async () => {
    applyMock.mockResolvedValueOnce({
      ...ok(),
      applied: 0,
      skipped: [{ fieldPath: 'mcpServers.Notes', reason: 'notStored' }],
    });
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await waitFor(() => expect(confirm()).toBeEnabled());
    await clickConfirm();
    const row = await screen.findByTestId('transfer-result');
    expect(row).toHaveTextContent('LibreChat did not store it; configure it in librechat.yaml');
    expect(row).not.toHaveTextContent('notStored');
  });

  it('still shows a message that is not a skip reason as it is', async () => {
    applyMock.mockResolvedValueOnce({
      ...ok(),
      applied: 0,
      failed: [{ path: 'mcpServers.constructor', message: 'constructor' }],
    });
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    await waitFor(() => expect(confirm()).toBeEnabled());
    await clickConfirm();
    expect(await screen.findByTestId('transfer-result')).toHaveTextContent(
      'Not saved: constructor',
    );
  });
});
