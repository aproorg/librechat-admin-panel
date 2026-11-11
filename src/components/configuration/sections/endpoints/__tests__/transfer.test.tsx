import '@/locales/i18n';
import { PrincipalType, configSchema } from 'librechat-data-provider';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import type * as t from '@/types';
import {
  valuesDataFixture,
  baseConfigFixture,
  baseLayersFixture,
  scopeConfigFixture,
  scopeLayersFixture,
} from '@/test/layers';
import { ConfigValuesProvider } from '@/contexts/ConfigValuesContext';
import { CustomEndpointsRenderer } from '../CustomEndpointsRenderer';
import { ScopeActionsContext } from '@/contexts/ScopeContext';
import { extractSchemaTree } from '@/server/config';
import { EndpointList } from '../List';

vi.mock('@/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server')>()),
  applyConfigChangesFn: vi.fn(),
  baseConfigOptions: {
    queryKey: ['baseConfig'],
    queryFn: () => Promise.resolve({ dbRevision: 'r', config: {}, dbOverrides: {} }),
  },
  getResolvedConfigFn: async () => ({
    revision: 'r',
    resolvedConfig: {},
    changedPaths: [],
    tombstones: [],
    overrides: {},
  }),
  availableScopesOptions: {
    queryKey: ['availableScopes'],
    queryFn: () =>
      Promise.resolve([
        {
          principalType: PrincipalType.GROUP,
          principalId: 'g1',
          name: 'Team g1',
          priority: 10,
          isActive: true,
        },
      ]),
  },
}));
vi.mock('@/hooks/useCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useCapabilities')>()),
  useCapabilities: () => ({ hasCapability: () => true }),
}));
vi.mock('@tanstack/react-router', async (importOriginal) =>
  (await import('@/test/router')).routerless(importOriginal),
);

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
});

const tree = extractSchemaTree(configSchema as t.ZodSchemaLike);
const fields = tree.find((field) => field.key === 'endpoints')?.children ?? [];

const MINE: t.ConfigRecord = {
  name: 'Mine',
  apiKeyPreview: 'sk-...1234',
  baseURL: 'https://mine.example.com/v1',
  models: { default: ['m-1'] },
};
const PLAIN: t.ConfigRecord = {
  name: 'Plain',
  apiKey: 'user_provided',
  baseURL: 'https://plain.example.com/v1',
  models: { default: ['m-1'] },
};
const OWN: t.ConfigRecord = { name: 'Own', apiKey: 'user_provided', baseURL: 'https://own.x/v1' };

function baseLayers(): t.ValueLayers {
  return baseLayersFixture(
    baseConfigFixture({ dbOverrides: { endpoints: { custom: [MINE, PLAIN] } } }),
  );
}

function scopeLayers(): t.ValueLayers {
  return scopeLayersFixture(
    scopeConfigFixture({
      overrides: { endpoints: { custom: [OWN] } },
      resolvedConfig: {},
      changedPaths: [],
      tombstones: [],
    }),
  );
}

function listOf(layers: t.ValueLayers): t.ConfigValue[] {
  const endpoints = layers.effective?.endpoints;
  const list =
    endpoints && typeof endpoints === 'object' && !Array.isArray(endpoints)
      ? endpoints.custom
      : undefined;
  return Array.isArray(list) ? list : [];
}

const PROFILE: t.ConfigScope = {
  principalType: PrincipalType.ROLE,
  principalId: 'USER',
  name: 'USER',
  priority: 1,
  isActive: true,
};

function Harness({
  layers,
  isDirty,
  disabled,
  profiles = [],
}: {
  layers: t.ValueLayers;
  isDirty?: boolean;
  disabled?: boolean;
  profiles?: t.ConfigScope[];
}) {
  const items = listOf(layers);
  const editingScope = layers.scope ? PROFILE : undefined;
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <ScopeActionsContext.Provider
        value={{
          selectScope: vi.fn(),
          editingScope,
          index: { scopes: profiles, byPath: new Map() },
        }}
      >
        <ConfigValuesProvider value={{ ...valuesDataFixture(layers), isDirty }}>
          <CustomEndpointsRenderer
            fields={fields}
            parentPath="endpoints"
            parentValue={{ custom: items }}
            getValue={(path, fallback) => (path === 'endpoints.custom' ? items : fallback)}
            onChange={vi.fn()}
            disabled={disabled}
          />
        </ConfigValuesProvider>
      </ScopeActionsContext.Provider>
    </QueryClientProvider>
  );
}

function row(name: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`li[data-endpoint-row="${name}"]`);
  if (!element) throw new Error(`no row for ${name}`);
  return element;
}

function openMenu(name: string) {
  const trigger = within(row(name)).getByRole('button', { name: `Actions for ${name}` });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}

const item = (label: string): HTMLElement | null =>
  screen.queryByRole('menuitem', { name: new RegExp(`^${label}`) });

const UNSAVED = 'Save your changes first';
const BLOCKED = {
  readOnly: "You can't change this place",
  file: "Defined in librechat.yaml, so it can't be moved",
  inherited: 'This place only inherits it, so there is nothing here to move',
};

describe('Copy to… and Move to… on a custom endpoint row', () => {
  it('offers both on an endpoint of Base that nothing blocks', () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Plain');
    expect(item('Copy to…')).toBeVisible();
    expect(item('Copy to…')).not.toHaveAttribute('aria-disabled');
    expect(item('Move to…')).toBeVisible();
    expect(item('Move to…')).not.toHaveAttribute('aria-disabled');
  });

  it('opens the dialog in copy mode with the endpoint name', async () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Plain');
    fireEvent.click(item('Copy to…') as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Copy to…' })).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team g1/ }));
    expect(screen.getByTestId('transfer-summary')).toHaveTextContent('Copy "Plain" to 1 place');
  });

  it('opens the dialog in move mode with the endpoint name', async () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Plain');
    fireEvent.click(item('Move to…') as HTMLElement);
    expect(await screen.findByRole('dialog', { name: 'Move to…' })).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team g1/ }));
    expect(screen.getByTestId('transfer-summary')).toHaveTextContent('Move "Plain" to 1 place');
  });

  it('disables both with the unsaved hint while the page has unsaved edits', () => {
    render(<Harness layers={baseLayers()} isDirty />);
    openMenu('Plain');
    expect(item('Copy to…')).toHaveAttribute('aria-disabled', 'true');
    expect(item('Move to…')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText(UNSAVED)).toHaveLength(2);
  });

  it('shows no unsaved hint when the page is clean', () => {
    render(<Harness layers={baseLayers()} isDirty={false} />);
    openMenu('Plain');
    expect(screen.queryByText(UNSAVED)).toBeNull();
  });

  it('does not open the dialog from a disabled item', () => {
    render(<Harness layers={baseLayers()} isDirty />);
    openMenu('Plain');
    fireEvent.click(item('Copy to…') as HTMLElement);
    expect(screen.queryByRole('dialog', { name: 'Copy to…' })).toBeNull();
  });

  it('disables Move for a librechat.yaml endpoint with its reason, Copy stays enabled', () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Claude');
    expect(item('Move to…')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(BLOCKED.file)).toBeInTheDocument();
    expect(item('Copy to…')).not.toHaveAttribute('aria-disabled');
  });

  it('names the file, not the inheritance, for a librechat.yaml endpoint the profile inherits', () => {
    render(<Harness layers={scopeLayers()} />);
    openMenu('Claude');
    expect(item('Move to…')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(BLOCKED.file)).toBeInTheDocument();
    expect(item('Copy to…')).not.toHaveAttribute('aria-disabled');
  });

  it('disables Move for an Base endpoint the profile only inherits, Copy stays enabled', () => {
    const layers = scopeLayersFixture(
      scopeConfigFixture({ overrides: {}, resolvedConfig: {}, changedPaths: [], tombstones: [] }),
      baseConfigFixture({ dbOverrides: { endpoints: { custom: [PLAIN] } } }),
    );
    render(<Harness layers={layers} />);
    openMenu('Plain');
    expect(item('Move to…')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(BLOCKED.inherited)).toBeInTheDocument();
    expect(item('Copy to…')).not.toHaveAttribute('aria-disabled');
  });

  it('offers Move for a Base endpoint the profile overrides, since the profile holds its own', () => {
    const layers = scopeLayersFixture(
      scopeConfigFixture({
        overrides: { endpoints: { custom: [{ name: 'Plain', baseURL: 'https://other.x/v1' }] } },
        resolvedConfig: {},
        changedPaths: [],
        tombstones: [],
      }),
      baseConfigFixture({ dbOverrides: { endpoints: { custom: [PLAIN] } } }),
    );
    render(<Harness layers={layers} />);
    openMenu('Plain');
    expect(item('Move to…')).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(BLOCKED.inherited)).toBeNull();
  });

  it('shows what a profile overriding the endpoint by name loses when Move is chosen, and not for Copy', async () => {
    const overrider: t.ConfigScope = {
      ...PROFILE,
      principalId: 'g1',
      name: 'Team g1',
      overridePaths: ['endpoints.custom'],
      overrideEntries: { 'endpoints.custom': ['Plain'] },
    };
    const { unmount } = render(<Harness layers={baseLayers()} profiles={[overrider]} />);
    openMenu('Plain');
    fireEvent.click(item('Move to…') as HTMLElement);
    const dialog = await screen.findByRole('dialog', { name: 'Move to…' });
    expect(within(dialog).getByTestId('transfer-notes')).toHaveTextContent(/Team g1/);
    unmount();
    render(<Harness layers={baseLayers()} profiles={[overrider]} />);
    openMenu('Plain');
    fireEvent.click(item('Copy to…') as HTMLElement);
    await screen.findByRole('dialog', { name: 'Copy to…' });
    expect(screen.queryByTestId('transfer-notes')).toBeNull();
  });

  it('gives the block reason, not the unsaved hint, for Move on a file endpoint of a dirty page', () => {
    render(<Harness layers={baseLayers()} isDirty />);
    openMenu('Claude');
    expect(item('Move to…')).toHaveAttribute('aria-describedby');
    expect(screen.getByText(BLOCKED.file)).toBeInTheDocument();
    expect(screen.getAllByText(UNSAVED)).toHaveLength(1);
    expect(item('Copy to…')).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers Move for an endpoint the profile holds itself, with the profile as source', async () => {
    render(<Harness layers={scopeLayers()} />);
    openMenu('Own');
    expect(item('Move to…')).not.toHaveAttribute('aria-disabled');
    fireEvent.click(item('Move to…') as HTMLElement);
    await screen.findByRole('dialog', { name: 'Move to…' });
    expect(await screen.findByRole('checkbox', { name: /Base configuration/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /USER/ })).toBeNull();
  });

  it('offers Copy and disables Move with the read-only reason when the place is not writable', () => {
    render(<Harness layers={baseLayers()} disabled />);
    openMenu('Plain');
    expect(item('Copy to…')).not.toHaveAttribute('aria-disabled');
    expect(item('Move to…')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText(BLOCKED.readOnly)).toBeInTheDocument();
  });

  it('asks for the stored secret of an endpoint that has one', async () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Mine');
    fireEvent.click(item('Copy to…') as HTMLElement);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team g1/ }));
    expect(await screen.findByLabelText(/apiKey/)).toHaveAttribute('type', 'password');
  });

  it('asks for no secret when the endpoint stores none', async () => {
    render(<Harness layers={baseLayers()} />);
    openMenu('Plain');
    fireEvent.click(item('Copy to…') as HTMLElement);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team g1/ }));
    await waitFor(() => expect(screen.getByTestId('transfer-summary')).toBeVisible());
    expect(screen.queryByLabelText(/apiKey/)).toBeNull();
  });
});

describe('EndpointList actions prop', () => {
  const rows: t.EndpointRow[] = [
    {
      key: 'k',
      index: 0,
      value: { name: 'A' },
      title: 'A',
      identity: 'A',
      loadedName: 'A',
      origin: 'admin',
      overridden: false,
      isNew: false,
      edited: false,
      host: null,
      modelCount: 0,
      fetchesModels: false,
      storedSecret: false,
      issues: [],
    },
  ];
  const props = {
    rows,
    removals: [],
    idPrefix: 'p',
    onOpen: vi.fn(),
    onReveal: vi.fn(),
    onDelete: vi.fn(),
    onRevert: vi.fn(),
    onUndoRemoval: vi.fn(),
  };
  const labels = () => screen.getAllByRole('menuitem').map((el) => el.textContent);
  const openA = () =>
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions for A' }), { key: 'ArrowDown' });

  it('puts the extra items before Delete', () => {
    render(<EndpointList {...props} actions={() => [{ label: 'Extra', onClick: vi.fn() }]} />);
    openA();
    expect(labels().indexOf('Extra')).toBeGreaterThan(-1);
    expect(labels().indexOf('Extra')).toBe(labels().indexOf('Delete') - 1);
  });

  it('adds nothing without the prop', () => {
    render(<EndpointList {...props} />);
    openA();
    expect(labels()).toEqual(['Edit', 'Delete']);
  });
});
