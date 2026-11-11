import '@/locales/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type * as t from '@/types';
import { applyConfigChangesFn } from '@/server';
import { TransferDialog } from '../Dialog';

const scopes = vi.hoisted(() => ({ list: [] as unknown[], pending: false, fail: false, canManage: true }));

vi.mock('@/server', () => ({
  applyConfigChangesFn: vi.fn(),
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

function renderDialog(source: t.WriteTarget = { type: 'base' }, onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TransferDialog open mode="copy" entry={entry} source={source} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, client };
}

const confirm = () => screen.getByRole('button', { name: 'Copy' });

beforeEach(() => {
  vi.clearAllMocks();
  scopes.pending = false;
  scopes.fail = false;
  scopes.canManage = true;
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
    expect(confirm()).toBeEnabled();
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
    fireEvent.click(confirm());
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
    fireEvent.click(confirm());
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
    fireEvent.click(confirm());
    const row = await screen.findByTestId('transfer-result');
    expect(within(row).getByText(/changed by someone else/)).toBeInTheDocument();
  });

  it('shows no Retry when every place saved', async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    fireEvent.click(confirm());
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
    fireEvent.click(confirm());
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
    expect(confirm()).toBeEnabled();
  });
});
