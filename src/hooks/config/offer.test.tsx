import '@/locales/i18n';
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { PrincipalType } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import type * as t from '@/types';
import { baseLayersFixture, scopeLayersFixture, valuesDataFixture } from '@/test/layers';
import { ScopeActionsContext } from '@/contexts/ScopeContext';
import { ConfigValuesProvider } from '@/contexts/ConfigValuesContext';
import { useTransferOffer } from './offer';
import { getScopeIndex } from '@/utils';

const UNSAVED = 'Save your changes first';
const FILE = "Defined in librechat.yaml, so it can't be moved";
const INHERITED = 'This place only inherits it, so there is nothing here to move';
const READ_ONLY = "You can't change this place";
const EXTRA = 'stdio servers cannot be copied';
const team: t.ConfigScope = {
  principalType: PrincipalType.ROLE,
  principalId: 'USER',
  name: 'USER',
  priority: 1,
  isActive: true,
};
const own: t.TransferFacts = {
  key: 'docs',
  value: { url: 'https://docs.example.com', apiKey: '••••1234' },
  secrets: ['apiKey'],
  fromFile: false,
  own: true,
  writable: true,
};

interface Options {
  path?: string;
  dirty?: boolean;
  inProfile?: boolean;
}

function setup({ path = 'mcpServers', dirty = false, inProfile = false }: Options = {}) {
  const layers = inProfile ? scopeLayersFixture() : baseLayersFixture();
  const data = { ...valuesDataFixture(layers), isDirty: dirty };
  const scope = {
    selectScope: vi.fn(),
    index: getScopeIndex([]),
    ...(inProfile && { editingScope: team }),
  };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ScopeActionsContext.Provider value={scope}>
      <ConfigValuesProvider value={data}>{children}</ConfigValuesProvider>
    </ScopeActionsContext.Provider>
  );
  return renderHook(() => useTransferOffer(path), { wrapper });
}

const itemsOf = (facts: Partial<t.TransferFacts> = {}, options: Options = {}) =>
  setup(options).result.current.itemsFor({ ...own, ...facts });
const itemFor = (items: t.TransferAction[], mode: t.TransferMode) =>
  items.find((item) => item.mode === mode);

describe('useTransferOffer', () => {
  it('offers Copy to… then Move to…, both enabled, with no reason', () => {
    const items = itemsOf();
    expect(items.map((item) => [item.mode, item.label, item.disabled, item.reason])).toEqual([
      ['copy', 'Copy to…', false, undefined],
      ['move', 'Move to…', false, undefined],
    ]);
  });

  it('disables both with the unsaved hint while the page has unsaved edits', () => {
    const items = itemsOf({}, { dirty: true });
    expect(items.map((item) => [item.disabled, item.reason])).toEqual([
      [true, UNSAVED],
      [true, UNSAVED],
    ]);
  });

  describe('move blocks keep Copy enabled', () => {
    it.each([
      ['a librechat.yaml entry', { fromFile: true }, FILE],
      ['an entry this place only inherits', { own: false }, INHERITED],
      ['a place the admin may not write', { writable: false }, READ_ONLY],
    ])('%s', (_name, facts, reason) => {
      const items = itemsOf(facts);
      expect(itemFor(items, 'copy')).toMatchObject({ disabled: false, reason: undefined });
      expect(itemFor(items, 'move')).toMatchObject({ disabled: true, reason });
    });
  });

  it('offers the same items in a place the admin may not write: Copy enabled, Move read-only', () => {
    const items = itemsOf({ writable: false, fromFile: false, own: true });
    expect(items).toHaveLength(2);
    expect(itemFor(items, 'copy')?.disabled).toBe(false);
    expect(itemFor(items, 'move')).toMatchObject({ disabled: true, reason: READ_ONLY });
  });

  it('puts a read-only Copy behind the unsaved hint on a dirty page', () => {
    const items = itemsOf({ writable: false }, { dirty: true });
    expect(itemFor(items, 'copy')).toMatchObject({ disabled: true, reason: UNSAVED });
  });

  describe('reason order', () => {
    it('extra reason beats the move block on Move; Copy shows the extra reason', () => {
      const items = itemsOf({ extraReason: EXTRA, fromFile: true });
      expect(itemFor(items, 'move')?.reason).toBe(EXTRA);
      expect(itemFor(items, 'copy')?.reason).toBe(EXTRA);
    });

    it('extra reason beats the unsaved hint', () => {
      const items = itemsOf({ extraReason: EXTRA }, { dirty: true });
      expect(itemFor(items, 'move')?.reason).toBe(EXTRA);
      expect(itemFor(items, 'copy')?.reason).toBe(EXTRA);
    });

    it('the move block beats the unsaved hint on Move; Copy shows the hint', () => {
      const items = itemsOf({ fromFile: true }, { dirty: true });
      expect(itemFor(items, 'move')?.reason).toBe(FILE);
      expect(itemFor(items, 'copy')?.reason).toBe(UNSAVED);
    });

    it('the unsaved hint shows alone when nothing else applies', () => {
      expect(itemFor(itemsOf({}, { dirty: true }), 'move')?.reason).toBe(UNSAVED);
    });
  });

  describe('offers nothing where eligibility says copy is false', () => {
    it('on a list the profile replaces whole', () => {
      expect(itemsOf({}, { path: 'modelSpecs.list' })).toEqual([]);
    });

    it('on a collection nested inside an entry', () => {
      expect(itemsOf({}, { path: 'mcpServers.docs.customUserVars' })).toEqual([]);
    });
  });

  describe('dialog', () => {
    it('starts closed on the path with an empty entry', () => {
      const { dialog } = setup().result.current;
      expect(dialog.open).toBe(false);
      expect(dialog.entry).toEqual({ path: 'mcpServers', key: '', value: {}, secrets: [] });
    });

    it('opens on the chosen entry in the chosen mode, from Base', () => {
      const view = setup();
      act(() => itemFor(view.result.current.itemsFor(own), 'move')?.onSelect());
      expect(view.result.current.dialog).toMatchObject({
        open: true,
        mode: 'move',
        entry: { path: 'mcpServers', key: 'docs', value: own.value, secrets: ['apiKey'] },
        source: { type: 'base' },
      });
    });

    it('takes the open profile as its source in a profile', () => {
      const view = setup({ inProfile: true });
      act(() => itemFor(view.result.current.itemsFor(own), 'copy')?.onSelect());
      expect(view.result.current.dialog).toMatchObject({
        open: true,
        mode: 'copy',
        source: { type: 'scope', scope: team },
      });
    });

    it('stays on Base while the editing profile has no layer loaded yet', () => {
      const data = valuesDataFixture(baseLayersFixture());
      const scope = { selectScope: vi.fn(), index: getScopeIndex([]), editingScope: team };
      const wrapper = ({ children }: { children: ReactNode }) => (
        <ScopeActionsContext.Provider value={scope}>
          <ConfigValuesProvider value={data}>{children}</ConfigValuesProvider>
        </ScopeActionsContext.Provider>
      );
      const view = renderHook(() => useTransferOffer('mcpServers'), { wrapper });
      act(() => itemFor(view.result.current.itemsFor(own), 'copy')?.onSelect());
      expect(view.result.current.dialog.source).toEqual({ type: 'base' });
    });

    it('hands the notes of the chosen entry to the dialog, and none before one is chosen', () => {
      const notes = ['Team a overrides docs by name'];
      const view = setup();
      expect(view.result.current.dialog.notes).toBeUndefined();
      act(() => itemFor(view.result.current.itemsFor({ ...own, notes }), 'move')?.onSelect());
      expect(view.result.current.dialog.notes).toEqual(notes);
    });

    it('closing clears the entry again', () => {
      const view = setup();
      act(() => itemFor(view.result.current.itemsFor(own), 'copy')?.onSelect());
      act(() => view.result.current.dialog.onClose());
      expect(view.result.current.dialog).toMatchObject({
        open: false,
        mode: 'copy',
        entry: { key: '', value: {}, secrets: [] },
      });
    });
  });
});
