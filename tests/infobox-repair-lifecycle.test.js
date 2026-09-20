const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');

class Element {
    constructor() { this.children = []; this.events = {}; this.classList = { add() {} }; }
    createEl(tag, options = {}) {
        const child = new Element();
        Object.assign(child, { tag, options });
        this.children.push(child);
        return child;
    }
    createDiv(options) { return this.createEl('div', options); }
    addEventListener(name, fn) { this.events[name] = fn; }
}
const notices = [];
const sandbox = {
    module: { exports: {} }, console: { error() {} },
    require: () => ({ Plugin: class {}, parseYaml: yaml.load, Notice: class { constructor(text) { notices.push(text); } } })
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8'), sandbox);
const invalid = '---\ninfobox:\n  title: [[Note]] description\n---\nOriginal body';
function fixture() {
    const plugin = new sandbox.module.exports();
    const file = { path: 'Test.md' };
    const view = { file, containerEl: new Element() };
    const request = {};
    plugin._repairRequests.set(view.containerEl, request);
    let source = invalid;
    plugin.app = { vault: { cachedRead: async () => source, process: async (_, fn) => { source = fn(source); } } };
    plugin.scheduleRefresh = () => {};
    return { plugin, file, view, request, read: () => source, write: value => { source = value; } };
}
test('repair reads latest contents and preserves concurrent body edits', async () => {
    const f = fixture();
    await f.plugin.showFrontmatterRepair(f.view, f.file, f.request);
    f.write(invalid + '\nConcurrent edit');
    await f.view.containerEl.children[0].children[1].events.click();
    assert(f.read().endsWith('Original body\nConcurrent edit'));
    assert.equal(yaml.load(f.read().split('---')[1]).infobox.title, '[[Note]] description');
});
test('stale reads do not add a repair panel after switching notes or refreshing', async () => {
    for (const stale of ['file', 'request']) {
        const f = fixture();
        let resolve;
        f.plugin.app.vault.cachedRead = () => new Promise(r => { resolve = r; });
        const pending = f.plugin.showFrontmatterRepair(f.view, f.file, f.request);
        if (stale === 'file') f.view.file = { path: 'Other.md' };
        else f.plugin._repairRequests.set(f.view.containerEl, {});
        resolve(invalid);
        await pending;
        assert.equal(f.view.containerEl.children.length, 0);
    }
});
test('failed repairs enable retry and notify the user', async () => {
    const f = fixture();
    f.plugin.app.vault.process = async () => { throw new Error('write failed'); };
    await f.plugin.showFrontmatterRepair(f.view, f.file, f.request);
    const button = f.view.containerEl.children[0].children[1];
    await button.events.click();
    assert.equal(button.disabled, false);
    assert(notices.at(-1).includes('Could not repair'));
    assert.equal(f.read(), invalid);
});
