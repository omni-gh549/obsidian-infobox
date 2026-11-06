// Run against an isolated Obsidian vault named test-vault, with this plugin
// installed and remote debugging enabled. Never runs against a personal vault.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
    const browser = await chromium.connectOverCDP(process.env.OBSIDIAN_CDP || 'http://127.0.0.1:9237');
    const page = browser.contexts()[0].pages().find(p => p.url().startsWith('app://obsidian.md'));
    assert(page, 'Obsidian page not found');
    page.setDefaultTimeout(10000);
    assert.equal(await page.evaluate(() => app.vault.getName()), 'test-vault', 'Use an isolated test vault');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const output = process.env.OBSIDIAN_TEST_OUTPUT || path.join(__dirname, '../output/playwright');
    await fs.mkdir(output, { recursive: true });
    let checks = 0;
    const check = (condition, message) => { assert(condition, message); checks++; };
    const settle = () => page.waitForTimeout(200);
    const open = async (file, mode = 'preview') => {
        await page.evaluate(async ({ file, mode }) => {
            await app.workspace.getLeaf().setViewState({ type: 'markdown', state: { file, mode } });
        }, { file, mode });
        await settle();
    };
    const geometry = () => page.evaluate(() => {
        const view = app.workspace.activeLeaf.view;
        const panels = view.containerEl.querySelectorAll('.infobox-panel');
        const panel = panels[0];
        const rect = panel?.getBoundingClientRect();
        const leaf = view.containerEl.getBoundingClientRect();
        return { count: panels.length, inline: panel?.classList.contains('infobox-panel-inline'),
            connected: panel?.isConnected, x: rect?.x, right: rect?.right, y: rect?.y, width: rect?.width,
            leafLeft: leaf.left, leafRight: leaf.right, title: panel?.querySelector('.infobox-title')?.textContent };
    });
    await page.evaluate(async () => {
        app.workspace.leftSplit.collapse();
        app.workspace.rightSplit.collapse();
        const notes = {
            'Smoke Long.md': '---\ninfobox:\n  title: Lifecycle test\n  fields:\n    - section: Identity\n    - Status: Visible\n---\n' +
                Array.from({ length: 180 }, (_, i) => `\n## Section ${i}\n\nParagraph ${i}. Long note content.\n\n`).join(''),
            'Smoke Empty.md': '---\nkeep: original\n---\nBody must survive.\n',
            'Smoke Other.md': '---\ninfobox:\n  title: Other note\n---\nOther body.\n'
        };
        for (const [name, text] of Object.entries(notes)) {
            const file = app.vault.getAbstractFileByPath(name);
            if (file) await app.vault.modify(file, text); else await app.vault.create(name, text);
        }
    });
    await settle();
    for (const width of [1280, 900, 480]) {
        await page.setViewportSize({ width, height: 900 });
        for (const mode of ['preview', 'source']) {
            await open('Smoke Long.md', mode);
            let g = await geometry();
            check(g.count === 1 && g.connected, `one panel at ${width}/${mode}`);
            check(g.x >= g.leafLeft && g.right <= g.leafRight + 1, `panel fits at ${width}/${mode}: ${JSON.stringify(g)}`);
            for (const fraction of [1, 0.5, 0, 1, 0]) {
                await page.evaluate(fraction => {
                    const v = app.workspace.activeLeaf.view;
                    const scroller = v.getMode() === 'preview' ? v.containerEl.querySelector('.markdown-preview-view') : v.containerEl.querySelector('.cm-scroller');
                    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * fraction;
                }, fraction);
                await settle();
                g = await geometry();
                check(g.count === 1 && g.connected, `panel survives scrolling ${width}/${mode}/${fraction}`);
                if (fraction === 0) check(g.y >= 0 && g.y < 900, 'panel visible on return to top');
            }
            if (mode === 'source') {
                await page.evaluate(() => { const e = app.workspace.activeLeaf.view.editor; e.setCursor({ line: e.lineCount() - 1, ch: 0 }); e.replaceSelection('\nEdited in source.'); });
                await settle();
                check((await geometry()).count === 1, 'source edit retains infobox');
            }
        }
        await open('Smoke Long.md');
        await page.evaluate(() => { app.workspace.activeLeaf.view.containerEl.querySelector('.markdown-preview-view').scrollTop = 0; });
        await settle();
        await page.screenshot({ path: path.join(output, `layout-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await open('Smoke Long.md');
    await page.evaluate(async () => {
        const original = app.workspace.activeLeaf;
        const second = app.workspace.getLeaf('split');
        await second.openFile(app.vault.getAbstractFileByPath('Smoke Other.md'));
        window.smokeLeaves = { original, second };
    });
    await settle();
    const splits = await page.evaluate(() => Object.values(window.smokeLeaves).map(leaf => {
        const panel = leaf.view.containerEl.querySelector('.infobox-panel');
        const p = panel?.getBoundingClientRect();
        const c = leaf.view.containerEl.getBoundingClientRect();
        return { count: leaf.view.containerEl.querySelectorAll('.infobox-panel').length,
            fits: p && p.left >= c.left && p.right <= c.right + 1 };
    }));
    check(splits.every(s => s.count === 1 && s.fits), 'both split panes have one visible card inside their bounds');
    await page.screenshot({ path: path.join(output, 'split-panes.png') });
    await page.evaluate(() => { const { original, second } = window.smokeLeaves; second.detach(); app.workspace.setActiveLeaf(original); delete window.smokeLeaves; });
    await settle();
    check(await page.evaluate(() => app.plugins.plugins['omni-infobox']._panelObservers.size) === 1, 'closed split observers are released');
    await page.evaluate(async () => app.workspace.activeLeaf.setViewState({ type: 'markdown', state: { file: 'Smoke Long.md', mode: 'source', source: true } }));
    await settle();
    check((await geometry()).count === 1, 'raw Source mode retains panel');
    for (let i = 0; i < 8; i++) {
        await open('Smoke Other.md', i % 2 ? 'source' : 'preview');
        check((await geometry()).title === 'Other note', 'note switch updates panel');
        await open('Smoke Empty.md');
        check((await geometry()).count === 0, 'note without infobox has no stale panel');
        await open('Smoke Long.md', i % 2 ? 'preview' : 'source');
        check((await geometry()).title === 'Lifecycle test', 'return restores correct panel');
    }
    await open('Smoke Long.md');
    await page.getByRole('button', { name: 'Edit infobox', exact: true }).click();
    await page.getByText('Colors', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Card background', exact: true }).fill('#e6f0e9');
    await page.getByRole('textbox', { name: 'Section background', exact: true }).fill('#315b43');
    await page.getByRole('textbox', { name: 'Section text', exact: true }).fill('#ffffff');
    await page.getByRole('textbox', { name: 'Text', exact: true }).fill('#203329');
    await page.getByRole('textbox', { name: 'Borders', exact: true }).fill('#a3baa9');
    await page.getByRole('button', { name: 'Save infobox', exact: true }).click();
    await settle();
    const colors = await page.evaluate(() => {
        const panel = document.querySelector('.infobox-panel');
        return { background: getComputedStyle(panel.querySelector('.infobox')).backgroundColor,
            text: getComputedStyle(panel.querySelector('.infobox-label')).color,
            section: getComputedStyle(panel.querySelector('.infobox-section')).backgroundColor };
    });
    check(colors.background === 'rgb(230, 240, 233)', 'note background applied');
    check(colors.text === 'rgb(32, 51, 41)', 'note text applied to labels');
    check(colors.section === 'rgb(49, 91, 67)', 'section background applied');
    await page.screenshot({ path: path.join(output, 'colors.png') });
    await page.getByRole('button', { name: 'Edit infobox', exact: true }).click();
    await page.getByRole('button', { name: 'Save as template', exact: true }).click();
    const templateModal = page.locator('.modal').filter({ has: page.getByText('Save infobox template', { exact: true }) });
    const templateName = 'Smoke template ' + Date.now();
    await templateModal.getByRole('textbox', { name: 'Template name' }).fill(templateName);
    await templateModal.getByRole('button', { name: 'Save template', exact: true }).click();
    await page.getByRole('button', { name: 'Save infobox', exact: true }).click();
    await settle();
    await open('Smoke Empty.md');
    await page.evaluate(() => app.commands.executeCommandById('omni-infobox:insert-infobox-template'));
    await page.getByPlaceholder('Choose an infobox template').fill(templateName);
    await page.keyboard.press('Enter');
    await settle();
    check((await geometry()).title === 'Smoke Empty', 'template uses destination title');
    const contents = await page.evaluate(() => app.vault.read(app.vault.getAbstractFileByPath('Smoke Empty.md')));
    check(contents.includes('keep: original') && contents.endsWith('Body must survive.\n'), 'import preserves body and other properties');
    check(contents.includes('#e6f0e9') && contents.includes('Status: Visible'), 'import retains structure and colors');
    // A second insertion must wait for an explicit replacement choice.
    await page.evaluate(() => app.commands.executeCommandById('omni-infobox:insert-infobox-template'));
    await page.getByPlaceholder('Choose an infobox template').fill(templateName);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    check(contents === await page.evaluate(() => app.vault.read(app.vault.getAbstractFileByPath('Smoke Empty.md'))), 'cancel replacement leaves note unchanged');
    await page.evaluate(() => { app.setting.open(); app.setting.openTabById('omni-infobox'); });
    await settle();
    let settingsPage;
    for (const candidate of browser.contexts()[0].pages()) {
        if (await candidate.getByText('Template folder', { exact: true }).isVisible()) settingsPage = candidate;
    }
    check(Boolean(settingsPage), 'native settings tab appears, including separate Settings windows');
    await settingsPage.screenshot({ path: path.join(output, 'settings.png') });
    await page.evaluate(() => app.setting.close());
    const hasStyleSettings = await page.evaluate(() => Boolean(app.plugins.plugins['obsidian-style-settings']));
    if (hasStyleSettings) {
        const style = await page.evaluate(async () => {
            const plugin = app.plugins.plugins['obsidian-style-settings'];
            const manager = plugin.settingsManager;
            manager.settings['omni-infobox@@infobox-primary@@light'] = '#fbefe2';
            manager.settings['omni-infobox@@infobox-primary@@dark'] = '#293c32';
            await manager.save();
            return { count: Object.keys(manager.config['omni-infobox'] || {}).length, errors: plugin.errorList };
        });
        check(style.count === 5 && style.errors.length === 0, 'Style Settings discovers all five color controls');
        await open('Smoke Other.md');
        check(await page.locator('.infobox').evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(251, 239, 226)', 'global light color inherits');
        await page.evaluate(() => { document.body.classList.remove('theme-light'); document.body.classList.add('theme-dark'); });
        await settle();
        check(await page.locator('.infobox').evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(41, 60, 50)', 'global dark color inherits');
        await page.screenshot({ path: path.join(output, 'dark.png') });
        await open('Smoke Empty.md');
        check(await page.locator('.infobox').evaluate(el => getComputedStyle(el).backgroundColor) === 'rgb(230, 240, 233)', 'per-note color overrides global settings');
        await page.evaluate(() => { document.body.classList.remove('theme-dark'); document.body.classList.add('theme-light'); });
        await page.evaluate(() => { app.setting.open(); app.setting.openTabById('obsidian-style-settings'); });
        await settle();
        let stylePage;
        for (const candidate of browser.contexts()[0].pages()) {
            if (await candidate.getByText('Omni Infobox', { exact: true }).count() > 1) stylePage = candidate;
        }
        // The configuration parser and rendered Settings UI are independent checks.
        check(Boolean(stylePage), 'Omni Infobox is listed in Style Settings');
        await stylePage.getByText('Omni Infobox', { exact: true }).last().click();
        check(await stylePage.getByText('Card background', { exact: true }).isVisible(), 'Style Settings color controls expand');
        await stylePage.screenshot({ path: path.join(output, 'style-settings.png') });
        await page.evaluate(() => app.setting.close());
    }
    await page.evaluate(async () => { await app.plugins.disablePlugin('omni-infobox'); });
    check(await page.locator('.infobox-panel, .infobox-docked').count() === 0, 'unload removes panels and reserved space');
    await page.evaluate(async () => { await app.plugins.enablePlugin('omni-infobox'); });
    await settle();
    check((await geometry()).count === 1, 'reload restores panel');
    check(errors.length === 0, `no renderer errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
    await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
