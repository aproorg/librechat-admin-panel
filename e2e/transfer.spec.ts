import { test, expect } from '@playwright/test';
import { LIVE, MOCK_FIXTURES_SKIP_REASON } from './live';

/**
 * Copy an MCP server to other places. The mock backend serves Base with one
 * server (`docs`) and an Engineering group profile; a live LibreChat has neither.
 */
const SERVER = 'docs';

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
    await result.getByRole('link', { name: /Engineering/ }).click();

    await expect(page.locator(`[data-mcp-server="${SERVER}"]`)).toHaveCount(1);
  });

  test('keeps Copy to… disabled while the page has unsaved edits', async ({ page }) => {
    await page.goto('/configuration?tab=mcp');
    const entry = page.locator(`[data-mcp-server="${SERVER}"]`);
    await entry.locator('button[aria-expanded]').first().click();
    await entry.getByRole('textbox').first().fill('https://mcp.example.com/changed');
    await entry.getByRole('textbox').first().press('Tab');

    await page.getByRole('button', { name: `Actions for ${SERVER}` }).click();
    await expect(page.getByRole('menuitem', { name: 'Copy to…' })).toBeDisabled();
  });
});
