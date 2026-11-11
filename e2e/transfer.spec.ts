import { test, expect } from '@playwright/test';
import { LIVE, MOCK_FIXTURES_SKIP_REASON } from './live';

/**
 * Copy an MCP server to other places. The mock backend serves Base with one
 * server (`docs`) and an Engineering group profile; a live LibreChat has neither.
 */
const SERVER = 'docs';
const MOCK_API = 'http://localhost:3081';
const HINT = 'Save your changes first';
const COPIED_URL = 'https://mcp.example.com/mcp';
const asAdmin = { headers: { Authorization: 'Bearer test-admin-token' } };

test.describe('Configuration: copy an MCP server to other places', () => {
  test.skip(LIVE, MOCK_FIXTURES_SKIP_REASON);

  test('copies a server from Base to the group profile', async ({ page }) => {
    await page.goto('/configuration?tab=mcp');
    await page.getByRole('button', { name: `Actions for ${SERVER}` }).click();
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: /Engineering/ }).click();
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();

    const result = dialog.getByTestId('transfer-result');
    await expect(result).toContainText('Saved');
    const href = await result.getByRole('link', { name: /Engineering/ }).getAttribute('href');
    const groupId = new URL(href ?? '', 'http://x').searchParams.get('scope')?.split(':')[1];
    expect(groupId, 'the Saved link names the group').toBeTruthy();

    const stored = await page.request.get(`${MOCK_API}/api/admin/config/group/${groupId}`, asAdmin);
    const { config: group } = await stored.json();
    expect(group.overrides.mcpServers?.[SERVER]?.url).toBe(COPIED_URL);
    const base = await page.request.get(`${MOCK_API}/api/admin/config/role/__base__`, asAdmin);
    const { config: baseDoc } = await base.json();
    expect(baseDoc.overrides.mcpServers[SERVER].url).toBe(COPIED_URL);
  });

  test('keeps Copy to… disabled while the page has unsaved edits', async ({ page }) => {
    await page.goto('/configuration?tab=mcp');
    await page.getByRole('button', { name: `Actions for ${SERVER}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toBeEnabled();
    await page.keyboard.press('Escape');

    const entry = page.locator(`[data-mcp-server="${SERVER}"]`);
    await entry.locator('button[aria-expanded]').first().click();
    await entry.getByRole('textbox').first().fill('https://mcp.example.com/changed');
    await entry.getByRole('textbox').first().press('Tab');

    await page.getByRole('button', { name: `Actions for ${SERVER}` }).click();
    const item = page.getByRole('menuitem', { name: /Copy to…/ });
    await expect(item).toBeDisabled();
    await expect(item).toHaveAccessibleDescription(HINT);
  });
});
