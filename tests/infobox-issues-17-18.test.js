// Regression tests for #17 (editing the infobox erased the note / Properties
// "[object Object]" conversion / card covering note text) and #18 (images
// from note properties).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

class El {
    constructor(tag = 'div', options = {}) {
        this.tag = tag;
        this.children = [];
        this.parentElement = null;
        this.events = {};
        this.attrs = {};
        this.style = { setProperty() {} };
        this.text = options.text || '';
        const classes = new Set(String(options.cls || '').split(/\s+/).filter(Boolean));
        this.classList = {
            add: (...n) => n.forEach(c => classes.add(c)),
            remove: (...n) => n.forEach(c => classes.delete(c)),
            contains: n => classes.has(n),
            toggle: (n, force) => { const on = force === undefined ? !classes.has(n) : force; on ? classes.add(n) : classes.delete(n); return on; }
        };
        for (const [k, v] of Object.entries(options.attr || {})) this.attrs[k] = v;
    }
    get isConnected() { return true; }
    get nextSibling() { const s = this.parentElement?.children; return s ? s[s.indexOf(this) + 1] || null : null; }
    appendChild(child) { child.parentElement?.removeChild?.(child); child.parentElement = this; this.children.push(child); return child; }
    insertBefore(child, ref) {
        child.parentElement?.removeChild?.(child);
        child.parentElement = this;
        const i = this.children.indexOf(ref);
        this.children.splice(i < 0 ? this.children.length : i, 0, child);
        return child;
    }
    removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentElement = null; }
    remove() { this.parentElement?.removeChild(this); }
    createEl(tag, options = {}) { return this.appendChild(new El(tag, options)); }
    createDiv(options = {}) { return this.createEl('div', options); }
    createSpan(options = {}) { return this.createEl('span', options); }
    addClass(c) { this.classList.add(c); }
    setAttr(k, v) { this.attrs[k] = v; }
    setAttribute(k, v) { this.attrs[k] = v; }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(name, fn) { this.events[name] = fn; }
    empty() { this.children = []; }
    all() { return [this, ...this.children.flatMap(c => (c instanceof El ? c.all() : []))]; }
    querySelectorAll(sel) {
        const cls = sel.replace(/^\./, '');
        return this.all().slice(1).filter(e => e.classList.contains(cls) || e.tag === sel);
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

const notices = [];
const sandbox = {
    module: { exports: {} }, console: { error() {} },
    createDiv: options => new El('div', options),
    document: { body: new El('body'), createTextNode: text => ({ text: String(text) }), querySelectorAll: () => [] },
    require: () => ({
        Plugin: class {}, Modal: class { setTitle() {} }, FuzzySuggestModal: class {},
        parseYaml: yaml.load, stringifyYaml: yaml.dump,
        Notice: class { constructor(message) { notices.push(message); } }
    })
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') +
    '\nmodule.exports.Editor = InfoboxEditModal;' +
    '\nmodule.exports.writeInfobox = typeof writeInfobox === "function" ? writeInfobox : undefined;', sandbox);
const Plugin = sandbox.module.exports;

// A vault with one note whose frontmatter is rewritten the way Obsidian does it:
// parse, mutate, re-serialize, keep everything after the closing --- verbatim.
function vault(initial) {
    const file = { path: 'Notes/Hero.md', basename: 'Hero', extension: 'md' };
    let disk = initial;
    let editor = initial; // what is typed in the open editor, not yet saved
    const log = [];
    const split = text => {
        const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
        return m ? { fm: yaml.load(m[1]) || {}, body: text.slice(m[0].length) } : { fm: {}, body: text };
    };
    const app = {
        workspace: {
            iterateAllLeaves: fn => fn({ view: {
                file, getViewType: () => 'markdown',
                save: async () => { log.push('save'); disk = editor; }
            } })
        },
        fileManager: {
            processFrontMatter: async (target, callback) => {
                assert.equal(target, file);
                log.push('processFrontMatter');
                const { fm, body } = split(disk);
                callback(fm);
                disk = '---\n' + yaml.dump(fm) + '---\n' + body;
                editor = disk;
            }
        },
        metadataCache: {
            getFileCache: () => ({ frontmatter: split(disk).fm }),
            getFirstLinkpathDest: link => ({ path: 'attachments/' + link }),
            on() {}
        },
        vault: { getResourcePath: f => 'app://local/' + f.path, getMarkdownFiles: () => [] }
    };
    return {
        file, app, log,
        type: text => { editor += text; },
        disk: () => disk,
        fm: () => split(disk).fm,
        body: () => split(disk).body,
        setDisk: text => { disk = editor = text; }
    };
}

test('#17 frontmatter writes save unsaved editor text first and never touch the body', async () => {
    const v = vault('---\ninfobox:\n  title: Hero\n---\nLine one\nLine two\n');
    v.type('Typed but not yet saved\n');
    await Plugin.writeInfobox(v.app, v.file, infobox => { infobox.subtitle = 'Knight'; });
    assert.deepEqual(v.log, ['save', 'processFrontMatter'], 'editor is flushed before the frontmatter write');
    assert.equal(v.body(), 'Line one\nLine two\nTyped but not yet saved\n');
    assert.equal(v.fm().infobox.subtitle, 'Knight');
});

test('#17 the editor can save over an infobox that Properties turned into "[object Object]"', async () => {
    const v = vault('---\ninfobox: "[object Object]"\nstatus: draft\n---\nBody text\n');
    const editor = new Plugin.Editor(v.app, v.file, { title: 'Hero', subtitle: 'Knight' });
    editor.app = v.app;
    await editor.saveDetails();
    assert.equal(v.fm().infobox.title, 'Hero');
    assert.equal(v.fm().infobox.subtitle, 'Knight');
    assert.equal(v.fm().status, 'draft', 'other properties are preserved');
    assert.equal(v.body(), 'Body text\n');
});

test('#17 "Add infobox" writes the starter infobox before the editor can save', async () => {
    const v = vault('---\nstatus: draft\n---\nBody text\n');
    const plugin = new Plugin();
    plugin.app = v.app;
    let command;
    plugin.addCommand = c => { if (c.id === 'add-infobox') command = c; };
    plugin.registerEvent = () => {};
    plugin.addSettingTab = () => {};
    plugin.loadData = async () => ({});
    v.app.workspace.on = () => {};
    v.app.workspace.onLayoutReady = () => {};
    v.app.workspace.getActiveFile = () => v.file;
    const opened = [];
    const Original = Plugin.Editor.prototype.open;
    Plugin.Editor.prototype.open = function open() { opened.push(v.log.slice()); };
    try {
        await plugin.onload();
        command.checkCallback(false);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(opened.length, 1, 'editor opens');
        assert.deepEqual(opened[0], ['save', 'processFrontMatter'], 'editor opens only after the write finished');
        assert.equal(v.fm().infobox.title, 'Hero');
        assert.equal(v.body(), 'Body text\n');
    } finally {
        Plugin.Editor.prototype.open = Original;
    }
});

function leaf(v, width = 1000) {
    const containerEl = new El('div', { cls: 'workspace-leaf-content' });
    containerEl.clientWidth = width;
    containerEl.createDiv({ cls: 'view-header' });
    const contentEl = containerEl.createDiv({ cls: 'view-content' });
    contentEl.createDiv({ cls: 'cm-sizer' });
    return { view: { containerEl, contentEl, file: v.file, getViewType: () => 'markdown', getMode: () => 'source' } };
}

function rendered(plugin, v, width) {
    const l = leaf(v, width);
    plugin.processLeaf(l);
    const panels = l.view.containerEl.querySelectorAll('.infobox-panel');
    return { leaf: l, panels, panel: panels[0] };
}

test('#17 a converted "[object Object]" infobox can be restored from the last version shown', async () => {
    const v = vault('---\ninfobox:\n  title: Hero\n  fields:\n    - Class: Knight\n---\nBody text\n');
    const plugin = new Plugin();
    plugin.app = v.app;
    plugin.scheduleRefresh = () => {};
    assert.equal(rendered(plugin, v).panels.length, 1);

    // Obsidian's Properties panel "fixes" the nested object into text.
    v.setDisk('---\ninfobox: "[object Object]"\n---\nBody text\n');
    const { panel, panels, leaf: l } = rendered(plugin, v);
    assert.equal(panels.length, 1, 'a recovery card is shown instead of nothing');
    assert(panel.classList.contains('infobox-repair'));
    assert.equal(panel.parentElement, l.view.containerEl, 'recovery card is outside the editor');
    const button = panel.querySelectorAll('button')[0];
    assert.equal(button.text, 'Restore infobox');
    await button.events.click();
    assert.deepEqual(v.fm().infobox, { title: 'Hero', fields: [{ Class: 'Knight' }] });
    assert.equal(v.body(), 'Body text\n');
});

test('#17 the card is mounted outside the editor at every width', () => {
    const v = vault('---\ninfobox:\n  title: Hero\n---\nBody\n');
    const plugin = new Plugin();
    plugin.app = v.app;
    for (const width of [1400, 900, 699, 400]) {
        const { leaf: l, panels, panel } = rendered(plugin, v, width);
        assert.equal(panels.length, 1);
        assert.equal(panel.parentElement, l.view.containerEl, `width ${width}: card is a child of the leaf`);
        assert.equal(l.view.contentEl.querySelectorAll('.infobox-panel').length, 0, `width ${width}: nothing inside the editor`);
        const stacked = width < 700;
        assert.equal(l.view.containerEl.classList.contains('infobox-stacked'), stacked);
        assert.equal(l.view.containerEl.classList.contains('infobox-docked'), !stacked);
        if (stacked) assert.equal(panel.nextSibling, l.view.contentEl, 'narrow card sits above the note');
    }
});

function imagesFor(fmYaml, settings = {}) {
    const v = vault('---\n' + fmYaml + '---\nBody\n');
    const plugin = new Plugin();
    plugin.app = v.app;
    Object.assign(plugin.settings, settings);
    const { panel } = rendered(plugin, v);
    const img = panel.querySelectorAll('img')[0];
    const tabs = panel.querySelectorAll('.infobox-image-tab').map(t => t.text);
    return { src: img?.src, tabs };
}

test('#18 the default image property from settings fills an infobox with no image', () => {
    assert.equal(imagesFor('cover: hero.png\ninfobox:\n  title: Hero\n', { imageProperty: 'cover' }).src,
        'app://local/attachments/hero.png');
    assert.equal(imagesFor('cover: hero.png\ninfobox:\n  title: Hero\n').src, undefined, 'off unless configured');
});

test('#18 each infobox can pick its own property, case-insensitively', () => {
    const fm = 'Portrait: "[[portrait.jpg]]"\ncover: cover.png\ninfobox:\n  title: Hero\n  imageProperty: portrait\n';
    assert.equal(imagesFor(fm, { imageProperty: 'cover' }).src, 'app://local/attachments/portrait.jpg');
});

test('#18 property values: embeds, unquoted links, markdown images, URLs and lists', () => {
    const cases = [
        ['img: "![[a b.png|300]]"', 'app://local/attachments/a b.png'],
        ['img: [[unquoted.png]]', 'app://local/attachments/unquoted.png'],
        ['img: "![alt](folder/pic%20one.png)"', 'app://local/attachments/folder/pic one.png'],
        ['img: https://example.com/x.png', 'https://example.com/x.png']
    ];
    for (const [line, expected] of cases) {
        assert.equal(imagesFor(line + '\ninfobox:\n  title: Hero\n', { imageProperty: 'img' }).src, expected, line);
    }
    const gallery = imagesFor('img:\n  - "[[one.png]]"\n  - two.png\ninfobox:\n  title: Hero\n', { imageProperty: 'img' });
    assert.equal(gallery.src, 'app://local/attachments/one.png');
    assert.deepEqual(gallery.tabs, ['Image 1', 'Image 2'], 'a list becomes a gallery');
});

test('#18 an image set in the infobox itself still wins over the property', () => {
    const fm = 'cover: cover.png\ninfobox:\n  title: Hero\n  image: own.png\n';
    assert.equal(imagesFor(fm, { imageProperty: 'cover' }).src, 'app://local/attachments/own.png');
    assert.equal(imagesFor('cover: ""\ninfobox:\n  title: Hero\n', { imageProperty: 'cover' }).src, undefined);
    assert.equal(imagesFor('infobox:\n  title: Hero\n', { imageProperty: 'infobox' }).src, undefined);
});

test('#18 the editor saves and clears the per-note image property', async () => {
    const v = vault('---\ninfobox:\n  title: Hero\n---\nBody\n');
    const editor = new Plugin.Editor(v.app, v.file, { title: 'Hero', imageProperty: 'portrait' });
    editor.app = v.app;
    await editor.saveDetails();
    assert.equal(v.fm().infobox.imageProperty, 'portrait');
    editor.currentData.imageProperty = '';
    await editor.saveDetails();
    assert.equal('imageProperty' in v.fm().infobox, false);
});
