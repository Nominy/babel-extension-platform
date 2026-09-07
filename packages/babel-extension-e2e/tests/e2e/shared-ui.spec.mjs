import { test, expect } from '../../src/test.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { repositoryDir } from '../../src/build.mjs';

test.use({ extensions: [] });
const screenshots = path.join(repositoryDir, 'frontend-preview');

test('shared components isolate themes and keep dialogs keyboard accessible', async ({ page }) => {
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../../../babel-extension-frontend/src/index.mjs', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'SharedUI' });
  await page.goto('about:blank');
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.evaluate(() => {
    const { createComponent: c, confirmDialog } = window.SharedUI;
    document.body.style.cssText = 'margin:0;padding:24px;background:#eee;display:flex;gap:16px';
    const outside = document.createElement('button'); outside.textContent = 'Host button'; outside.id = 'host'; outside.style.cssText = 'position:fixed;bottom:24px;left:24px'; document.body.append(outside);
    for (const [name, accent] of [['Helper', 'white'], ['Gold Drafting', 'purple'], ['Review Helper', 'orange']]) {
      const panel = c('panel', { accent }); panel.style.cssText = 'width:340px;align-self:flex-start';
      const primary = c('button', { text: 'Apply changes', variant: 'primary' });
      primary.addEventListener('click', async () => { window.confirmed = await confirmDialog({ accent, title: 'Apply changes?', message: 'Save the reviewed transcript?', confirmLabel: 'Apply' }); });
      const input = c('input', { attrs: { 'aria-label': name + ' input', placeholder: 'Transcript text' } });
      const menu = c('menu', { children: [c('menu-item', { text: 'Selected suggestion', attrs: { 'aria-selected': 'true' } }), c('menu-item', { text: 'Another suggestion' })] });
      panel.append(c('header', { children: [c('title', { text: name }), c('badge', { text: 'Ready' })] }), c('body', { children: [input, c('diff', { children: [c('diff-text', { text: 'Original transcript' }), c('diff-text', { text: 'Reviewed transcript' })] }), menu, c('notice', { text: 'Changes are ready to review.', tone: 'success' })] }), c('footer', { children: [c('button', { text: 'Cancel' }), primary] }));
      document.body.append(panel);
    }
  });
  for (const panel of await page.locator('.bui-panel').all()) await expect(panel).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  const primary = page.getByRole('button', { name: 'Apply changes', exact: true });
  await expect(primary.nth(0)).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(primary.nth(1)).toHaveCSS('background-color', 'rgb(124, 58, 237)');
  await expect(primary.nth(2)).toHaveCSS('background-color', 'rgb(232, 97, 45)');
  await expect(page.locator('#host')).not.toHaveCSS('font-family', /Segoe UI/);
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, 'shared-components.png'), fullPage: true });
  await primary.nth(1).click();
  const dialog = page.getByRole('dialog', { name: 'Apply changes?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(primary.nth(1)).toBeFocused();
  expect(await page.evaluate(() => window.confirmed)).toBe(false);
  await primary.nth(1).click();
  await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
  expect(await page.evaluate(() => window.confirmed)).toBe(true);
  const shadow = await page.evaluate(() => {
    const host = document.createElement('div'); document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const panel = window.SharedUI.createComponent('panel', { accent: '#ffffff' }); root.append(panel);
    window.SharedUI.themeRoot(panel, '#ffffff'); window.SharedUI.ensureUiStyles(root);
    const button = window.SharedUI.createComponent('button', { text: 'Shadow button', variant: 'primary' }); panel.append(button);
    return { background: getComputedStyle(button).backgroundColor, color: getComputedStyle(button).color, sheets: root.querySelectorAll('style').length };
  });
  expect(shadow).toEqual({ background: 'rgb(255, 255, 255)', color: 'rgb(26, 26, 26)', sheets: 1 });
});

test.describe('real extension shared settings surfaces', () => {
  test.use({ extensions: ['helper', 'gold', 'review'], visibleScrollbars: true });
  test('settings share white panels and keep their extension accent', async ({ babel }) => {
    await mkdir(screenshots, { recursive: true });
    let referencePosition;
    for (const [name, accent] of [['helper', 'white'], ['gold', 'purple'], ['review', 'orange']]) {
      const options = await babel.options(name);
      await expect(options.locator(`[data-bui-accent="${accent}"]`).first()).toBeVisible();
      await expect(options.locator('.bui-panel, .bui-card').first()).toHaveCSS('background-color', 'rgb(255, 255, 255)');
      const shell = options.locator('.bui-settings-shell');
      await expect(shell).toHaveCSS('max-width', '640px');
      const position = await shell.evaluate(element => {
        const shell = element.getBoundingClientRect();
        const header = element.querySelector('.bui-header').getBoundingClientRect();
        const title = element.querySelector('.bui-title').getBoundingClientRect();
        return { x: shell.x, y: shell.y, width: shell.width, headerY: header.y, headerHeight: header.height, titleX: title.x, titleY: title.y };
      });
      referencePosition ??= position;
      expect(position).toEqual(referencePosition);
      await options.evaluate(() => { document.documentElement.style.overflowY = 'scroll'; });
      const scrollingPosition = await shell.boundingBox();
      await options.evaluate(() => { document.documentElement.style.overflowY = 'hidden'; });
      const nonScrollingPosition = await shell.boundingBox();
      expect(nonScrollingPosition.x).toBe(scrollingPosition.x);
      expect(nonScrollingPosition.width).toBe(scrollingPosition.width);
      await options.evaluate(() => { document.documentElement.style.overflowY = ''; });
      await expect(shell.locator('.bui-header').first()).toHaveCSS('padding', '12px 16px');
      await expect(shell.locator('.bui-title').first()).toHaveCSS('font-size', '14px');
      await expect(shell.locator('.bui-body').first()).toHaveCSS('padding', '14px 16px');
      await expect(shell.locator('.bui-card').first()).toHaveCSS('padding', '12px');
      await expect(shell.locator('.bui-label').first()).toHaveCSS('font-size', '11px');
      await expect(shell.locator('.bui-button').first()).toHaveCSS('padding', '7px 11px');
      await options.screenshot({ path: path.join(screenshots, `${name}-settings.png`), fullPage: true });
      await options.screenshot({ path: path.join(screenshots, `${name}-settings-viewport.png`) });
      await options.setViewportSize({ width: 390, height: 844 });
      const bounds = await shell.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(12);
      expect(bounds.x + bounds.width / 2).toBe(195);
      expect(bounds.width).toBe(390 - 2 * bounds.x);
      expect(await options.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      await options.setViewportSize({ width: 1600, height: 1000 });
      await options.close();
    }
  });
});

test.describe('real extension review surfaces', () => {
  test.use({ extensions: ['helper', 'gold', 'review'] });
  test('Helper appearance and Gold preview render with shared surfaces', async ({ page, babel }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await babel.setExtensionSettings('gold', { backendBaseUrl: babel.apiURL, openRouterApiKey: 'e2e-non-secret-admission-key', audioInputEnabled: false, l0ReplacementPreviewEnabled: false, localModelsEnabled: false });
    await babel.reset('baseline');
    await page.locator('[data-babel-helper-appearance-button]').click();
    const appearance = page.getByRole('dialog', { name: 'Website Appearance' });
    await expect(appearance).toBeVisible();
    await expect(appearance).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await page.screenshot({ path: path.join(screenshots, 'helper-appearance.png') });
    await appearance.getByRole('button', { name: 'Close Website Appearance editor' }).click();
    const goldLauncher = page.locator('#babel-gold-drafting-magic-button');
    await expect(goldLauncher).toHaveCSS('background-color', 'rgb(245, 240, 255)');
    await expect(goldLauncher).toHaveCSS('color', 'rgb(109, 40, 217)');
    await goldLauncher.hover();
    const timingPanel = page.locator('.bgd-timing-hover-panel');
    await expect(timingPanel).toHaveAttribute('data-open', 'true');
    await expect(timingPanel).toHaveCSS('background-color', 'rgb(243, 232, 255)');
    await expect(goldLauncher).toHaveCSS('background-color', 'rgb(243, 232, 255)');
    await expect(timingPanel).toHaveCSS('box-shadow', 'none');
    await expect(timingPanel).toHaveCSS('font-weight', '600');
    await expect(timingPanel).toHaveCSS('transform', 'none');
    await expect(goldLauncher).toHaveCSS('border-radius', '6px 0px 0px 6px');
    await expect(timingPanel).toHaveCSS('border-radius', '0px 6px 6px 0px');
    const wandBounds = await goldLauncher.boundingBox();
    const panelBounds = await timingPanel.boundingBox();
    expect(panelBounds.y).toBe(wandBounds.y);
    expect(panelBounds.height).toBe(wandBounds.height);
    expect(panelBounds.x).toBe(wandBounds.x + wandBounds.width - 1);
    const loadingFill = timingPanel.locator('.bui-progress-fill');
    if (await loadingFill.isVisible()) {
    await expect(loadingFill).toHaveCSS('animation-name', 'bui-progress-slide');
    const motion = await loadingFill.evaluate(element => {
      const animation = element.getAnimations()[0];
      animation.pause();
      animation.currentTime = 200;
      const start = element.getBoundingClientRect().x;
      animation.currentTime = 900;
      const end = element.getBoundingClientRect().x;
      animation.play();
      return { start, end };
    });
    expect(motion.end).toBeGreaterThan(motion.start);
    } else {
      await expect(timingPanel).toHaveAttribute('data-status', 'available');
    }
    await page.screenshot({ path: path.join(screenshots, 'gold-timing-panel.png') });
    await page.mouse.move(10, 10);
    await expect(goldLauncher).toHaveAttribute('data-attached-open', 'false');
    await expect(goldLauncher).toHaveCSS('background-color', 'rgb(245, 240, 255)');
    await expect(goldLauncher).toHaveCSS('border-radius', '6px');
    await goldLauncher.click();
    await expect(page.locator('#babel-gold-drafting-overlay .bgd-status')).toContainText('Draft ready.');
    await expect(page.locator('#babel-gold-drafting-overlay .bgd-activity')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Apply Draft', exact: true })).toHaveCSS('background-color', 'rgb(124, 58, 237)');
    await expect(page.locator('#babel-gold-drafting-overlay .bgd-header')).toHaveCSS('background-color', 'rgb(250, 245, 255)');
    await expect(page.locator('#babel-gold-drafting-overlay .bgd-dialog')).toHaveCSS('border-color', 'rgb(234, 223, 247)');
    await page.screenshot({ path: path.join(screenshots, 'gold-preview.png') });
  });
  test('Review workspace renders with shared orange controls', async ({ page, babel }) => {
    await babel.setExtensionSettings('review', { workflowMode: 'interactive', backendBaseUrl: babel.apiURL, backendBaseUrlFallbacks: [], refreshTimeoutMs: 4000 });
    await babel.reset('review');
    const url = new URL(page.url()); url.searchParams.set('displayFeedback', 'true'); await page.goto(url.href);
    await page.locator('#babel-review-magic-button').click();
    const workspace = page.locator('.br-overlay-dialog');
    await expect(workspace).toBeVisible();
    await expect(workspace).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(workspace.locator('[data-variant="primary"]').first()).toHaveCSS('background-color', 'rgb(232, 97, 45)');
    await page.screenshot({ path: path.join(screenshots, 'review-workspace.png') });
  });
});
