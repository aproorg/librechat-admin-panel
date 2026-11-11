import '@/locales/i18n';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type * as t from '@/types';
import {
  baseConfigFixture,
  baseLayersFixture,
  scopeLayersFixture,
  valuesDataFixture,
} from '@/test/layers';
import { ScopeActionsContext } from '@/contexts/ScopeContext';
import { ConfigValuesProvider } from '@/contexts/ConfigValuesContext';
import { ConfigContractContext } from '@/contexts/ContractContext';
import { AZURE_GROUPS_PATH } from '@/constants';
import { createServerContract } from '@/test/fixtures';
import { RecordObjectField } from '../RecordObjectField';
import { ArrayObjectField } from '../ArrayObjectField';
import { getScopeIndex, getValueAtPath } from '@/utils';

vi.mock('@/server', () => ({
  applyConfigChangesFn: vi.fn(),
  baseConfigOptions: {
    queryKey: ['baseConfig'],
    queryFn: () => Promise.resolve({ dbRevision: 'base-rev', config: {}, dbOverrides: {} }),
  },
  getResolvedConfigFn: async () => ({
    revision: 'scope-rev',
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
          principalId: 'a',
          name: 'Team a',
          priority: 10,
          isActive: true,
        },
        {
          principalType: PrincipalType.ROLE,
          principalId: 'USER',
          name: 'USER',
          priority: 1,
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

const RECORD_PATH = 'fileConfig.endpoints';
const CUSTOM_PATH = 'endpoints.custom';
const SPECS_PATH = 'modelSpecs.list';
const UNSAVED = 'Save your changes first';
const FILE = "Defined in librechat.yaml, so it can't be moved";
const INHERITED = 'This place only inherits it, so there is nothing here to move';
const READ_ONLY = "You can't change this place";

const noFields: t.SchemaField[] = [];
const renderNothing: t.CollectionRenderFields = () => null;
const team: t.ConfigScope = {
  principalType: PrincipalType.ROLE,
  principalId: 'USER',
  name: 'USER',
  priority: 1,
  isActive: true,
};

const YAML: t.ConfigRecord = {
  fileConfig: { endpoints: { fromfile: { fileLimit: 5 } } },
  endpoints: { custom: [{ name: 'FromFile', baseURL: 'https://file.example.com' }] },
};
const NESTED = { a: { customUserVars: { TOKEN: { title: 'Token' } } } };
const DOTTED = { 'gpt-4.1': { fileLimit: 3 } };
const OVERRIDES: t.ConfigRecord = {
  mcpServers: NESTED,
  fileConfig: { endpoints: { mine: { fileLimit: 2 }, ...DOTTED } },
  endpoints: {
    custom: [{ name: 'Mine', baseURL: 'https://mine.example.com', apiKeyPreview: '••••1234' }],
  },
  modelSpecs: { list: [{ name: 'spec-a', label: 'Spec A' }] },
};
const MERGED: t.ConfigRecord = {
  mcpServers: NESTED,
  fileConfig: { endpoints: { fromfile: { fileLimit: 5 }, mine: { fileLimit: 2 }, ...DOTTED } },
  endpoints: {
    custom: [
      { name: 'FromFile', baseURL: 'https://file.example.com' },
      { name: 'Mine', baseURL: 'https://mine.example.com', apiKeyPreview: '••••1234' },
    ],
  },
  modelSpecs: { list: [{ name: 'spec-a', label: 'Spec A' }] },
};

const baseData = baseConfigFixture({
  config: MERGED,
  yamlConfig: YAML,
  yamlPaths: ['fileConfig.endpoints.fromfile.fileLimit', 'endpoints.custom'],
  dbOverrides: OVERRIDES,
  schemaDefaults: {},
});

const profileData: t.ResolvedConfigData = {
  resolvedConfig: {},
  changedPaths: [],
  overrides: { fileConfig: { endpoints: { theirs: { fileLimit: 1 } } } },
  tombstones: [],
};

const overridingData: t.ResolvedConfigData = {
  ...profileData,
  overrides: {
    fileConfig: { endpoints: { mine: { fileLimit: 9 } } },
    endpoints: { custom: [{ name: 'Mine', baseURL: 'https://profile.example.com' }] },
  },
};

interface PageProps {
  children: ReactNode;
  inProfile?: boolean;
  overriding?: boolean;
  dirty?: boolean;
}

function layersOf(inProfile: boolean, overriding = false): t.ValueLayers {
  if (!inProfile) return baseLayersFixture(baseData);
  return scopeLayersFixture(overriding ? overridingData : profileData, baseData);
}

function Page({ children, inProfile = false, overriding = false, dirty = false }: PageProps) {
  const layers = layersOf(inProfile, overriding);
  const data = { ...valuesDataFixture(layers), isDirty: dirty };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const scope = {
    selectScope: vi.fn(),
    index: getScopeIndex([]),
    ...(inProfile && { editingScope: team }),
  };
  return (
    <QueryClientProvider client={client}>
      <ScopeActionsContext.Provider value={scope}>
        <ConfigValuesProvider value={data}>{children}</ConfigValuesProvider>
      </ScopeActionsContext.Provider>
    </QueryClientProvider>
  );
}

function RecordList(props: Omit<PageProps, 'children'> & { disabled?: boolean; path?: string }) {
  const { disabled, path = RECORD_PATH, ...page } = props;
  const value = getValueAtPath(layersOf(page.inProfile ?? false, page.overriding).effective, path);
  return (
    <Page {...page}>
      <RecordObjectField
        id="record"
        path={path}
        value={value}
        fields={noFields}
        onChange={vi.fn()}
        disabled={disabled}
        renderFields={renderNothing}
      />
    </Page>
  );
}

function ListOf({
  path,
  ...page
}: Omit<PageProps, 'children'> & { path: string; disabled?: boolean }) {
  const { disabled, ...rest } = page;
  const value = getValueAtPath(layersOf(rest.inProfile ?? false, rest.overriding).effective, path);
  return (
    <Page {...rest}>
      <ArrayObjectField
        id="list"
        path={path}
        value={value}
        fields={noFields}
        onChange={vi.fn()}
        disabled={disabled}
        renderFields={renderNothing}
      />
    </Page>
  );
}

const cardOf = (name: string): HTMLElement => {
  const card = screen.getByText(name).closest<HTMLElement>('[data-entry-card]');
  if (!card) throw new Error(`no card for ${name}`);
  return card;
};
const copyOf = (name: string) =>
  within(cardOf(name)).queryByRole('button', { name: `Copy to… ${name}` });
const moveOf = (name: string) =>
  within(cardOf(name)).queryByRole('button', { name: `Move to… ${name}` });
const reasonOf = (button: HTMLElement | null) =>
  document.getElementById(button?.getAttribute('aria-describedby') ?? '')?.textContent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Copy to and Move to on a record entry', () => {
  it('shows both, enabled, on an entry the open place holds itself', () => {
    render(<RecordList />);
    expect(copyOf('mine')).toBeEnabled();
    expect(moveOf('mine')).toBeEnabled();
  });

  it('opens the dialog in copy mode with the entry named', async () => {
    render(<RecordList />);
    fireEvent.click(copyOf('mine')!);
    expect(await screen.findByRole('dialog', { name: 'Copy to…' })).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    expect(screen.getByTestId('transfer-summary')).toHaveTextContent('Copy "mine" to 1 place');
  });

  it('opens the dialog in move mode with the entry named', async () => {
    render(<RecordList />);
    fireEvent.click(moveOf('mine')!);
    expect(await screen.findByRole('dialog', { name: 'Move to…' })).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    expect(screen.getByTestId('transfer-summary')).toHaveTextContent('Move "mine" to 1 place');
  });

  it('disables Move for an entry from librechat.yaml with its reason, and keeps Copy enabled', () => {
    render(<RecordList />);
    expect(moveOf('fromfile')).toBeDisabled();
    expect(reasonOf(moveOf('fromfile'))).toBe(FILE);
    expect(copyOf('fromfile')).toBeEnabled();
  });

  it('disables Move for an entry the open profile only inherits, and keeps Copy enabled', () => {
    render(<RecordList inProfile />);
    expect(moveOf('mine')).toBeDisabled();
    expect(reasonOf(moveOf('mine'))).toBe(INHERITED);
    expect(copyOf('mine')).toBeEnabled();
  });

  it('enables Move for an entry the open profile holds itself', () => {
    render(<RecordList inProfile />);
    expect(moveOf('theirs')).toBeEnabled();
    expect(copyOf('theirs')).toBeEnabled();
  });

  it('disables Move, not Copy, where the admin may not write the place', () => {
    render(<RecordList disabled />);
    expect(moveOf('mine')).toBeDisabled();
    expect(reasonOf(moveOf('mine'))).toBe(READ_ONLY);
    expect(copyOf('mine')).toBeEnabled();
  });

  it('disables both with the unsaved hint while the page has edits', () => {
    render(<RecordList dirty />);
    expect(copyOf('mine')).toBeDisabled();
    expect(reasonOf(copyOf('mine'))).toBe(UNSAVED);
    expect(moveOf('mine')).toBeDisabled();
    expect(reasonOf(moveOf('mine'))).toBe(UNSAVED);
  });

  it('names the file reason, not the unsaved one, on a yaml entry while dirty', () => {
    render(<RecordList dirty />);
    expect(reasonOf(moveOf('fromfile'))).toBe(FILE);
    expect(reasonOf(copyOf('fromfile'))).toBe(UNSAVED);
  });

  it('enables both again once the page is clean', () => {
    render(<RecordList dirty={false} />);
    expect(copyOf('mine')).toBeEnabled();
    expect(moveOf('mine')).toBeEnabled();
  });
});

describe('Copy to and Move to on a by-name list entry', () => {
  it('shows both on a custom-endpoint-shaped list entry the place holds itself', () => {
    render(<ListOf path={CUSTOM_PATH} />);
    expect(copyOf('Mine')).toBeEnabled();
    expect(moveOf('Mine')).toBeEnabled();
  });

  it('disables Move for a list entry from librechat.yaml, keeping Copy', () => {
    render(<ListOf path={CUSTOM_PATH} />);
    expect(reasonOf(moveOf('FromFile'))).toBe(FILE);
    expect(copyOf('FromFile')).toBeEnabled();
  });

  it('disables Move for a list entry the profile only inherits', () => {
    render(<ListOf path={CUSTOM_PATH} inProfile />);
    expect(reasonOf(moveOf('Mine'))).toBe(INHERITED);
    expect(copyOf('Mine')).toBeEnabled();
  });

  it('opens the dialog with the entry by its name, in the chosen mode', async () => {
    render(<ListOf path={CUSTOM_PATH} />);
    fireEvent.click(moveOf('Mine')!);
    expect(await screen.findByRole('dialog', { name: 'Move to…' })).toBeVisible();
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    expect(screen.getByTestId('transfer-summary')).toHaveTextContent('Move "Mine" to 1 place');
  });

  it('asks for the stored secret of the entry again', async () => {
    render(<ListOf path={CUSTOM_PATH} />);
    fireEvent.click(copyOf('Mine')!);
    fireEvent.click(await screen.findByRole('checkbox', { name: /Team a/ }));
    expect(await screen.findByText('Type apiKey again')).toBeVisible();
  });

  it('disables both while the page has unsaved edits', () => {
    render(<ListOf path={CUSTOM_PATH} dirty />);
    expect(reasonOf(copyOf('Mine'))).toBe(UNSAVED);
    expect(moveOf('Mine')).toBeDisabled();
  });

  it('disables Move where the place is read-only, keeping Copy', () => {
    render(<ListOf path={CUSTOM_PATH} disabled />);
    expect(reasonOf(moveOf('Mine'))).toBe(READ_ONLY);
    expect(copyOf('Mine')).toBeEnabled();
  });
});

describe('a profile that overrides an entry Base also has', () => {
  it('enables Move on a record entry', () => {
    render(<RecordList inProfile overriding />);
    expect(moveOf('mine')).toBeEnabled();
    expect(copyOf('mine')).toBeEnabled();
  });

  it('enables Move on a by-name list entry', () => {
    render(<ListOf path={CUSTOM_PATH} inProfile overriding />);
    expect(moveOf('Mine')).toBeEnabled();
    expect(copyOf('Mine')).toBeEnabled();
  });

  it('opens the dialog from the profile: Base is offered, the open profile is not', async () => {
    render(<RecordList inProfile overriding />);
    fireEvent.click(moveOf('mine')!);
    expect(await screen.findByRole('checkbox', { name: /Base configuration/ })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: /Team a/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /USER/ })).not.toBeInTheDocument();
  });

  it('opens the dialog from Base: the profile is offered, Base is not', async () => {
    render(<RecordList />);
    fireEvent.click(moveOf('mine')!);
    expect(await screen.findByRole('checkbox', { name: /USER/ })).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: /Base configuration/ })).not.toBeInTheDocument();
  });
});

describe('accessible names and reasons of the actions', () => {
  it('names each action after its entry and describes why it is disabled', () => {
    render(<RecordList dirty />);
    expect(copyOf('mine')).toHaveAccessibleName('Copy to… mine');
    expect(moveOf('fromfile')).toHaveAccessibleDescription(FILE);
    expect(moveOf('mine')).toHaveAccessibleDescription(UNSAVED);
  });
});

describe('records the actions do not belong on', () => {
  it('shows none on a record nested inside an entry, while the top-level record shows them', () => {
    render(
      <>
        <RecordList path="mcpServers.a.customUserVars" />
        <RecordList />
      </>,
    );
    expect(screen.getByText('TOKEN')).toBeVisible();
    expect(copyOf('TOKEN')).toBeNull();
    expect(moveOf('TOKEN')).toBeNull();
    expect(copyOf('mine')).toBeEnabled();
  });

  it('shows none on an entry whose name has a dot, while its siblings show them', () => {
    render(<RecordList />);
    expect(screen.getByText('gpt-4.1')).toBeVisible();
    expect(copyOf('gpt-4.1')).toBeNull();
    expect(moveOf('gpt-4.1')).toBeNull();
    expect(copyOf('mine')).toBeEnabled();
  });
});

describe('where Copy to and Move to are absent', () => {
  it('shows neither on a list a profile replaces whole', () => {
    render(<ListOf path={SPECS_PATH} />);
    expect(screen.getByText('spec-a')).toBeVisible();
    expect(copyOf('spec-a')).toBeNull();
    expect(moveOf('spec-a')).toBeNull();
  });

  it('shows neither on a list a profile replaces whole, in a profile', () => {
    render(<ListOf path={SPECS_PATH} inProfile />);
    expect(copyOf('spec-a')).toBeNull();
    expect(moveOf('spec-a')).toBeNull();
  });

  const azure = (features: Partial<t.ConfigFeatures>) => createServerContract(features);
  const groups = (contract: t.ConfigContract) => <GroupsList contract={contract} />;

  it('shows both on Azure groups where the server lets the panel edit them entry by entry', () => {
    render(
      groups(azure({ endpointRederive: true, azureGroupMergeKey: true, azureGroupSecrets: true })),
    );
    expect(copyOf('east')).toBeEnabled();
    expect(moveOf('east')).toBeEnabled();
  });

  it.each([
    [
      'endpointRederive',
      { endpointRederive: false, azureGroupMergeKey: true, azureGroupSecrets: true },
    ],
    [
      'azureGroupMergeKey',
      { endpointRederive: true, azureGroupMergeKey: false, azureGroupSecrets: true },
    ],
    [
      'azureGroupSecrets',
      { endpointRederive: true, azureGroupMergeKey: true, azureGroupSecrets: false },
    ],
  ])('shows neither on Azure groups where the server lacks %s', (_name, features) => {
    render(groups(azure(features)));
    expect(screen.getByText('east')).toBeVisible();
    expect(copyOf('east')).toBeNull();
    expect(moveOf('east')).toBeNull();
  });
});

function GroupsList({ contract }: { contract: t.ConfigContract }) {
  const groupsBase = baseConfigFixture({
    config: { endpoints: { azureOpenAI: { groups: [{ group: 'east', apiKeyPreview: '••••' }] } } },
    yamlConfig: {},
    yamlPaths: [],
    dbOverrides: { endpoints: { azureOpenAI: { groups: [{ group: 'east' }] } } },
    schemaDefaults: {},
  });
  const layers = baseLayersFixture(groupsBase);
  const client = new QueryClient();
  return (
    <QueryClientProvider client={client}>
      <ConfigContractContext.Provider value={contract}>
        <ConfigValuesProvider value={valuesDataFixture(layers)}>
          <ArrayObjectField
            id="groups"
            path={AZURE_GROUPS_PATH}
            value={getValueAtPath(layers.effective, AZURE_GROUPS_PATH)}
            fields={noFields}
            onChange={vi.fn()}
            renderFields={renderNothing}
          />
        </ConfigValuesProvider>
      </ConfigContractContext.Provider>
    </QueryClientProvider>
  );
}
