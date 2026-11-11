import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { LIVE, MOCK_FIXTURES_SKIP_REASON } from './live';

/**
 * Copy and move an MCP server between places. The mock backend serves Base with
 * one admin server (`docs`) and one librechat.yaml server (`filed`), and an
 * Engineering group profile; a live LibreChat has neither. Each test that
 * writes works on a server of its own and removes it again, so the spec runs
 * in any order, in parallel, and again against the same backend.
 */
const SERVER = 'docs';
const FILE_SERVER = 'filed';
const MOCK_API = 'http://localhost:3081';
const HINT = 'Save your changes first';
const FILE_HINT = "Defined in librechat.yaml, so it can't be moved";
const INHERITED_HINT = 'This place only inherits it, so there is nothing here to move';
const READ_ONLY_HINT = "You can't change this place";
const COPIED_URL = 'https://mcp.example.com/mcp';
const asAdmin = { headers: { Authorization: 'Bearer test-admin-token' } };

interface Place {
  type: 'role' | 'group';
  id: string;
}
const BASE: Place = { type: 'role', id: '__base__' };

const fieldsUrl = ({ type, id }: Place) => `${MOCK_API}/api/admin/config/${type}/${id}/fields`;

async function engineering(request: APIRequestContext): Promise<Place> {
  const listed = await request.get(`${MOCK_API}/api/admin/groups?search=Engineering`, asAdmin);
  const { groups } = await listed.json();
  return { type: 'group', id: groups[0]._id };
}

async function overridesOf(request: APIRequestContext, place: Place) {
  const stored = await request.get(
    `${MOCK_API}/api/admin/config/${place.type}/${place.id}`,
    asAdmin,
  );
  const { config } = await stored.json();
  return config.overrides;
}

async function seed(request: APIRequestContext, place: Place, name: string): Promise<void> {
  const value = { type: 'streamable-http', url: COPIED_URL };
  const saved = await request.patch(fieldsUrl(place), {
    ...asAdmin,
    data: { entries: [{ fieldPath: `mcpServers.${name}`, value }] },
  });
  expect(saved.ok(), `seeding ${name}`).toBe(true);
}

async function clean(request: APIRequestContext, name: string): Promise<void> {
  const path = encodeURIComponent(`mcpServers.${name}`);
  for (const place of [BASE, await engineering(request)]) {
    await request.delete(`${fieldsUrl(place)}?fieldPath=${path}`, asAdmin);
  }
}

async function openMenu(page: Page, name: string) {
  await page.getByRole('button', { name: `Actions for ${name}` }).click();
}

async function transferToGroup(page: Page, name: string, item: string, action: string) {
  await openMenu(page, name);
  await page.getByRole('menuitem', { name: item }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: /Engineering/ }).click();
  await dialog.getByRole('button', { name: action, exact: true }).click();
  const result = dialog.getByTestId('transfer-result').filter({ hasText: /Engineering/ });
  await expect(result).toContainText('Saved');
  return { dialog, result };
}

async function edit(page: Page, value: string) {
  const entry = page.locator(`[data-mcp-server="${SERVER}"]`);
  const url = entry.getByRole('textbox').first();
  if (!(await url.isVisible())) await entry.locator('button[aria-expanded]').first().click();
  await url.fill(value);
  await url.press('Tab');
}

test.describe('Configuration: copy and move an MCP server between places', () => {
  test.skip(LIVE, MOCK_FIXTURES_SKIP_REASON);

  test('copies a server from Base to the group profile', async ({ page, request }) => {
    const name = 'copy-src';
    await clean(request, name);
    await seed(request, BASE, name);
    try {
      await page.goto('/configuration?tab=mcp');
      const { result } = await transferToGroup(page, name, 'Copy to…', 'Copy');
      const href = await result.getByRole('link', { name: /Engineering/ }).getAttribute('href');
      const groupId = new URL(href ?? '', 'http://x').searchParams.get('scope')?.split(':')[1];
      expect(groupId, 'the Saved link names the group').toBeTruthy();

      const group = await overridesOf(request, { type: 'group', id: groupId ?? '' });
      expect(group.mcpServers?.[name]?.url).toBe(COPIED_URL);
      const base = await overridesOf(request, BASE);
      expect(base.mcpServers[name].url).toBe(COPIED_URL);
    } finally {
      await clean(request, name);
    }
  });

  test('moves a server from Base to the group profile and takes it out of Base', async ({
    page,
    request,
  }) => {
    const name = 'move-src';
    await clean(request, name);
    await seed(request, BASE, name);
    try {
      await page.goto('/configuration?tab=mcp');
      const card = page.locator(`[data-mcp-server="${name}"]`);
      await expect(card, 'the server is listed in Base').toHaveCount(1, { timeout: 30_000 });
      const { dialog } = await transferToGroup(page, name, 'Move to…', 'Move');
      const original = dialog.getByTestId('transfer-result').filter({ hasText: /Original in/ });
      await expect(original, 'the original is removed').toContainText('Saved');

      const group = await overridesOf(request, await engineering(request));
      expect(group.mcpServers?.[name]?.url, 'the group holds it').toBe(COPIED_URL);
      const base = await overridesOf(request, BASE);
      expect(base.mcpServers?.[name], 'Base no longer holds it').toBeUndefined();
      await expect(card, 'the page drops it without a reload').toHaveCount(0);
    } finally {
      await clean(request, name);
    }
  });

  test('keeps Copy to… and Move to… disabled while the page has unsaved edits', async ({
    page,
  }) => {
    await page.goto('/configuration?tab=mcp');
    await openMenu(page, SERVER);
    await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeEnabled();
    await page.keyboard.press('Escape');

    await edit(page, 'https://mcp.example.com/changed');

    await openMenu(page, SERVER);
    for (const label of [/Copy to…/, /Move to…/]) {
      const item = page.getByRole('menuitem', { name: label });
      await expect(item).toBeDisabled();
      await expect(item).toHaveAccessibleDescription(HINT);
    }
  });

  test('enables Copy to… and Move to… again once an edit is put back to its saved value', async ({
    page,
  }) => {
    await page.goto('/configuration?tab=mcp');
    await edit(page, 'https://mcp.example.com/changed');
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toBeVisible();
    await edit(page, COPIED_URL);
    await expect(page.getByRole('region', { name: 'Unsaved changes' })).toHaveCount(0);

    await openMenu(page, SERVER);
    await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeEnabled();
  });

  test('disables Move to… for a server librechat.yaml defines, with the reason', async ({
    page,
  }) => {
    await page.goto('/configuration?tab=mcp');
    await openMenu(page, FILE_SERVER);
    const item = page.getByRole('menuitem', { name: /Move to…/ });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAccessibleDescription(FILE_HINT);
    await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toBeEnabled();
    await page.keyboard.press('Escape');

    await openMenu(page, SERVER);
    await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeEnabled();
  });

  test('disables Move to… for a server the open profile only inherits, with the reason', async ({
    page,
    request,
  }) => {
    const own = 'own-src';
    const group = await engineering(request);
    await clean(request, own);
    await seed(request, group, own);
    try {
      await page.goto(`/configuration?tab=mcp&scope=group:${group.id}`);
      await openMenu(page, SERVER);
      const item = page.getByRole('menuitem', { name: /Move to…/ });
      await expect(item).toBeDisabled();
      await expect(item).toHaveAccessibleDescription(INHERITED_HINT);
      await page.keyboard.press('Escape');

      await openMenu(page, own);
      await expect(page.getByRole('menuitem', { name: 'Move to…' })).toBeEnabled();
    } finally {
      await clean(request, own);
    }
  });

  test.describe('as an admin who can read but not change the configuration', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('disables Move to… with the reason', async ({ page }) => {
      await page.goto('/login');
      await page.locator('input:not([type="password"])').first().fill('reader@test.com');
      await page.locator('input[type="password"]').first().fill('mock-password');
      await page.getByRole('button', { name: /^sign in$/i }).click();
      await page.waitForURL('**/');

      await page.goto('/configuration?tab=mcp');
      await openMenu(page, SERVER);
      const item = page.getByRole('menuitem', { name: /Move to…/ });
      await expect(item).toBeDisabled();
      await expect(item).toHaveAccessibleDescription(READ_ONLY_HINT);
    });
  });
});
