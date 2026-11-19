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
        return { count: panels.length, stacked: panel?.classList.contains('infobox-panel-stacked'),
            insideEditor: Boolean(view.contentEl.querySelector('.infobox-panel')),
            connected: panel?.isConnected, x: rect?.x, right: rect?.right, y: rect?.y, width: rect?.width,
            leafLeft: leaf.left, leafRight: leaf.right, title: panel?.querySelector('.infobox-title')?.textContent };
    });
    // Visible note text (editor lines or rendered blocks) that overlaps the card.
    const coveredText = () => page.evaluate(() => {
        const view = app.workspace.activeLeaf.view;
        const panel = view.containerEl.querySelector('.infobox-panel');
        if (!panel) return [];
        const p = panel.getBoundingClientRect();
        const scroller = view.containerEl.querySelector(view.getMode() === 'preview' ? '.markdown-preview-view' : '.cm-scroller');
        const s = scroller.getBoundingClientRect();
        const nodes = view.containerEl.querySelectorAll(view.getMode() === 'preview'
            ? '.markdown-preview-sizer > div > :is(p, h1, h2, h3, h4, li)' : '.cm-content .cm-line');
        const hits = [];
        for (const node of nodes) {
            // Rects of the glyphs themselves, limited to the visible scroll area.
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const t of range.getClientRects()) {
                if (t.width && t.right > p.left && t.left < p.right && t.bottom > p.top && t.top < p.bottom &&
                    t.bottom > s.top && t.top < s.bottom) hits.push(node.textContent.slice(0, 30));
            }
        }
        return [...new Set(hits)].slice(0, 5);
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
            check(!g.insideEditor, `panel is never inside the editor or reading view at ${width}/${mode} (#17)`);
            check(g.stacked === (width < 700), `stacked only in narrow panes at ${width}/${mode}`);
            const covered = await coveredText();
            check(covered.length === 0, `panel covers no note text at ${width}/${mode} (#17): ${JSON.stringify(covered)}`);
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
    check(await settingsPage.getByText('Image property', { exact: true }).isVisible(), 'image property setting is shown (#18)');
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
    const read = name => page.evaluate(name => app.vault.read(app.vault.getAbstractFileByPath(name)), name);
    const editorValue = () => page.evaluate(() => app.workspace.activeLeaf.view.editor.getValue());

    // #17: clicking around the card and pressing Enter in the note must only ever
    // insert that one newline. Reproduces the reported flow at desktop and narrow widths.
    for (const width of [1280, 480]) {
        await page.setViewportSize({ width, height: 900 });
        await open('Smoke Long.md', 'preview');
        await open('Smoke Long.md', 'source');
        const before = await editorValue();
        const card = page.locator('.workspace-leaf.mod-active .infobox-panel');
        for (const target of ['.infobox-title', '.infobox-section', '.infobox-label', '.infobox-value']) {
            await card.locator(target).first().click();
        }
        await card.locator('.infobox-title').dblclick();
        await card.locator('.infobox-title').click({ clickCount: 3 });
        await page.keyboard.press('Enter');
        await page.keyboard.type('zz');
        await page.keyboard.press('Backspace');
        await settle();
        check(await editorValue() === before, `clicking and typing on the card never edits the note at ${width} (#17)`);
        const line = page.locator('.workspace-leaf.mod-active .cm-content .cm-line', { hasText: 'Paragraph 3.' }).first();
        await line.click();
        await page.keyboard.press('End');
        await page.keyboard.press('Enter');
        await settle();
        const after = await editorValue();
        check(after.length === before.length + 1, `Enter in the note inserts exactly one character at ${width} (#17)`);
        check(Array.from({ length: 180 }, (_, i) => `## Section ${i}`).every(h => after.includes(h)), `every section survives at ${width} (#17)`);
        // Selections must never run from the note into the card (or back): the
        // editor read them as reaching the note's start or end, and Enter deleted it.
        // Measured right before each use (the card can still be settling after a
        // resize), and checked to really be the card, not the note behind it.
        const cardPoint = async () => {
            await settle();
            const box = await card.locator('.infobox-label').first().boundingBox();
            const point = { x: box.x + 8, y: box.y + box.height / 2 };
            const onCard = await page.evaluate(p => Boolean(document.elementFromPoint(p.x, p.y)?.closest('.infobox-panel')), point);
            check(onCard, `gesture targets the card at ${width}`);
            return point;
        };
        // Each gesture starts from a caret placed by the editor API on a visible
        // line, and targets that caret's exact screen position.
        const caret = () => page.evaluate(() => {
            const e = app.workspace.activeLeaf.view.editor;
            // End of the line, so each Enter adds a line without splitting the marker.
            const line = e.getValue().split('\n').findIndex(l => l.startsWith('Paragraph 4.'));
            if (line < 0) throw new Error('marker line missing');
            const ch = e.getLine(line).length;
            e.setCursor({ line, ch });
            e.focus();
            const c = e.cm.coordsAtPos(e.posToOffset({ line, ch }));
            return { x: c.left - 1, y: (c.top + c.bottom) / 2 };
        });
        const gestures = {
            'shift+click on the card': async () => {
                const at = await cardPoint();
                await caret();
                await page.keyboard.down('Shift'); await page.mouse.click(at.x, at.y); await page.keyboard.up('Shift');
            },
            'drag from the card into the note': async () => {
                const at = await cardPoint();
                const c = await caret();
                await page.mouse.move(at.x, at.y); await page.mouse.down();
                await page.mouse.move(c.x, c.y, { steps: 8 }); await page.mouse.up();
            },
            'click card, shift+click note': async () => {
                const at = await cardPoint();
                const c = await caret();
                await page.mouse.click(at.x, at.y);
                await page.keyboard.down('Shift'); await page.mouse.click(c.x, c.y); await page.keyboard.up('Shift');
            }
        };
        for (const [name, gesture] of Object.entries(gestures)) {
            const start = await editorValue();
            await gesture();
            await settle();
            const crossing = await page.evaluate(() => {
                const sel = window.getSelection();
                const inCard = n => Boolean((n?.nodeType === 1 ? n : n?.parentElement)?.closest?.('.infobox-panel'));
                return !sel.isCollapsed && inCard(sel.anchorNode) !== inCard(sel.focusNode);
            });
            const selected = await page.evaluate(() => {
                const e = app.workspace.activeLeaf.view.editor;
                return e.listSelections().map(s => e.getRange(s.anchor, s.head)).join('');
            });
            await page.keyboard.press('Enter');
            await settle();
            const end = await editorValue();
            check(!crossing, `${name}: no selection crosses the card edge at ${width} (#17)`);
            check(selected === '', `${name}: the editor selects no text at ${width} (#17): ${JSON.stringify(selected.slice(0, 60))}`);
            check(end.length >= start.length && end.length <= start.length + 1, `${name}: Enter loses no text at ${width} (#17): ${start.length} -> ${end.length} ${JSON.stringify((() => { let i = 0; while (i < start.length && start[i] === end[i]) i++; return [start.slice(i, i + 40), end.slice(i, i + 40)]; })())}`);
        }
        await page.evaluate(() => app.workspace.activeLeaf.view.save());
        const saved = await read('Smoke Long.md');
        check(saved.startsWith('---\ninfobox:') && saved.includes('## Section 179') && saved.includes('Edited in source.'),
            `saved note keeps properties and body at ${width} (#17)`);
        await page.screenshot({ path: path.join(output, `editing-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // #17: the Properties panel's "convert" turns the infobox into "[object Object]".
    await open('Smoke Other.md');
    await page.evaluate(() => app.fileManager.processFrontMatter(app.vault.getAbstractFileByPath('Smoke Other.md'), fm => { fm.infobox = '[object Object]'; }));
    await page.waitForTimeout(800);
    const restore = page.locator('.workspace-leaf.mod-active').getByRole('button', { name: 'Restore infobox', exact: true });
    check(await restore.isVisible(), 'converted infobox offers a restore button (#17)');
    await page.screenshot({ path: path.join(output, 'object-object-recovery.png') });
    await restore.click();
    await page.waitForTimeout(800);
    check((await geometry()).title === 'Other note', 'restore brings the infobox back (#17)');
    check((await read('Smoke Other.md')).endsWith('Other body.\n'), 'restore keeps the note body (#17)');

    // #17 through Obsidian's real Properties UI: with the infobox property typed
    // as Text, its warning offers "Display as text?" -> Update, and touching the
    // value then writes "[object Object]". The card must offer a full restore.
    await page.evaluate(async () => {
        app.metadataTypeManager.setType('infobox', 'text');
        const text = '---\ninfobox:\n  title: Props test\n  fields:\n    - Class: Knight\n---\nProps body.\n';
        const file = app.vault.getAbstractFileByPath('Smoke Props.md');
        if (file) await app.vault.modify(file, text); else await app.vault.create('Smoke Props.md', text);
        await app.workspace.activeLeaf.setViewState({ type: 'markdown', state: { file: 'Smoke Props.md', mode: 'source', source: false } });
    });
    await page.waitForTimeout(800);
    const active = page.locator('.workspace-leaf.mod-active');
    const property = active.locator('.metadata-property[data-property-key="infobox"]');
    await property.hover();
    await property.locator('.metadata-property-warning-icon').click();
    await page.getByRole('button', { name: 'Update', exact: true }).click();
    await page.waitForTimeout(500);
    await property.locator('.metadata-property-value').click();
    await page.keyboard.type(' ');
    await page.keyboard.press('Backspace');
    await active.locator('.cm-content .cm-line', { hasText: 'Props body.' }).click();
    await page.waitForTimeout(1200);
    check((await read('Smoke Props.md')).includes('infobox: "[object Object]"'), 'Properties UI conversion reproduced');
    const restoreUi = active.getByRole('button', { name: 'Restore infobox', exact: true });
    check(await restoreUi.isVisible(), 'restore is offered after a real Properties conversion (#17)');
    await restoreUi.click();
    await page.waitForTimeout(1000);
    const restored = await read('Smoke Props.md');
    check(restored.includes('title: Props test') && restored.includes('Class: Knight') && restored.endsWith('Props body.\n'),
        `real conversion is fully restored (#17): ${JSON.stringify(restored)}`);
    await page.evaluate(() => app.metadataTypeManager.unsetType('infobox'));

    // #18: image from a note property, globally and per note.
    await page.evaluate(async () => {
        for (const [name, color] of [['smoke-cover.png', '#2f6f4f'], ['smoke-portrait.png', '#8a3b2e']]) {
            const canvas = new OffscreenCanvas(64, 64);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = color; ctx.fillRect(0, 0, 64, 64);
            const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
            const existing = app.vault.getAbstractFileByPath(name);
            if (existing) await app.vault.modifyBinary(existing, png); else await app.vault.createBinary(name, png);
        }
        const text = '---\ncover: "[[smoke-cover.png]]"\nportrait: "![[smoke-portrait.png]]"\ninfobox:\n  title: Property image\n---\nImage body.\n';
        const file = app.vault.getAbstractFileByPath('Smoke Image.md');
        if (file) await app.vault.modify(file, text); else await app.vault.create('Smoke Image.md', text);
        const plugin = app.plugins.plugins['omni-infobox'];
        plugin.settings.imageProperty = 'cover';
        await plugin.saveData(plugin.settings);
    });
    await open('Smoke Image.md');
    await page.waitForTimeout(400);
    const image = () => page.evaluate(async () => {
        const img = app.workspace.activeLeaf.view.containerEl.querySelector('.infobox-panel img');
        if (!img) return null;
        await img.decode().catch(() => {});
        return { src: img.getAttribute('src'), width: img.naturalWidth };
    });
    let shown = await image();
    check(shown?.src?.includes('smoke-cover.png') && shown.width === 64, `default image property shows a loaded image (#18): ${JSON.stringify(shown)}`);
    await page.getByRole('button', { name: 'Edit infobox', exact: true }).click();
    await page.getByRole('textbox', { name: 'Image property', exact: true }).fill('portrait');
    await page.getByRole('button', { name: 'Save infobox', exact: true }).click();
    await page.waitForTimeout(800);
    shown = await image();
    check(shown?.src?.includes('smoke-portrait.png') && shown.width === 64, `per-note image property overrides the default (#18): ${JSON.stringify(shown)}`);
    const imageNote = await read('Smoke Image.md');
    check(imageNote.includes('imageProperty: portrait') && imageNote.endsWith('Image body.\n'), 'per-note property is saved without touching the body (#18)');
    await page.screenshot({ path: path.join(output, 'property-image.png') });
    await open('Smoke Long.md');

    await page.evaluate(async () => { await app.plugins.disablePlugin('omni-infobox'); });
    check(await page.locator('.infobox-panel, .infobox-docked, .infobox-stacked').count() === 0, 'unload removes panels and reserved space');
    await page.evaluate(async () => { await app.plugins.enablePlugin('omni-infobox'); });
    await settle();
    check((await geometry()).count === 1, 'reload restores panel');
    check(errors.length === 0, `no renderer errors: ${errors.join('\n')}`);
    console.log(JSON.stringify({ checks, errors, output }, null, 2));
    await browser.close();
})().catch(error => { console.error(error); process.exit(1); });
