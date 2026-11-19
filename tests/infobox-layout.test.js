const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
        return { Plugin: class Plugin {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};

function createClassList(initial = '') {
    const classes = new Set(initial.split(/\s+/).filter(Boolean));
    return {
        add(...names) {
            names.forEach(name => classes.add(name));
        },
        remove(...names) {
            names.forEach(name => classes.delete(name));
        },
        contains(name) {
            return classes.has(name);
        },
        toggle(name, force) {
            if (force === undefined) {
                if (classes.has(name)) { classes.delete(name); return false; }
                else { classes.add(name); return true; }
            }
            if (force) { classes.add(name); return true; }
            else { classes.delete(name); return false; }
        }
    };
}

class TestElement {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.cls = options.cls || '';
        this.children = [];
        this.parent = null;
        this.classList = createClassList(this.cls);
    }

    appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
        if (child && typeof child === 'object') child.parent = this;
        this.children.push(child);
        return child;
    }

    createEl(tag, options = {}) {
        const child = new TestElement(tag, options);
        this.appendChild(child);
        return child;
    }

    createDiv(options = {}) {
        return this.createEl('div', options);
    }

    addClass(name) {
        this.classList.add(name);
    }

    addEventListener(eventName, callback) {
        this.listeners = this.listeners || {};
        this.listeners[eventName] = callback;
    }

    closest(selector) {
        const className = selector.startsWith('.') ? selector.slice(1) : selector;
        let current = this;
        while (current) {
            if (current.classList?.contains(className)) return current;
            current = current.parent;
        }
        return null;
    }

    querySelector(selector) {
        if (selector === '.markdown-preview-sizer') return this.previewSizer || null;
        if (selector === '.cm-sizer') return this.sourceSizer || null;
        if (selector === '.markdown-preview-sizer, .cm-sizer') {
            return this.contentSizer || null;
        }
        return null;
    }

    querySelectorAll() {
        return [];
    }
}

global.document = {
    body: { classList: createClassList() },
    createTextNode(text) {
        return { type: 'text', text: String(text) };
    }
};
global.createDiv = options => new TestElement('div', options);

const InfoboxPlugin = require('../main.js');

const container = new TestElement('div');
const readableView = new TestElement('div', {
    cls: 'is-readable-line-width'
});
const cmSizer = new TestElement('div', { cls: 'cm-sizer' });
readableView.appendChild(cmSizer);
container.contentSizer = cmSizer;

const plugin = new InfoboxPlugin();
plugin.app = {
    metadataCache: {
        getFileCache() {
            return { frontmatter: { infobox: { title: 'Terafab' } } };
        }
    }
};

plugin.processLeaf({
    view: {
        containerEl: container,
        contentEl: container,
        file: { path: 'Projects/Terafab.md' },
        getViewType() {
            return 'markdown';
        }
    }
});

assert(container.classList.contains('has-infobox'), 'container should have has-infobox class');
assert(container.children.some(child => child.cls === 'infobox-panel'), 'desktop panel must be outside the virtualized sizer');
assert(container.classList.contains('infobox-docked'));
for (const mode of ['preview', 'source']) {
    const modeContainer = new TestElement('div');
    const readable = new TestElement('div', { cls: 'is-readable-line-width' });
    const source = new TestElement('div', { cls: 'cm-sizer' });
    const preview = new TestElement('div', { cls: 'markdown-preview-sizer' });
    readable.appendChild(source);
    readable.appendChild(preview);
    modeContainer.contentSizer = source;
    modeContainer.sourceSizer = source;
    modeContainer.previewSizer = preview;
    plugin.processLeaf({ view: {
        containerEl: modeContainer, contentEl: modeContainer,
        file: { path: 'Test.md' }, getViewType: () => 'markdown', getMode: () => mode
    } });
    const active = mode === 'preview' ? preview : source;
    const hidden = mode === 'preview' ? source : preview;
    assert(modeContainer.children.some(child => child.cls === 'infobox-panel'), `${mode} desktop panel must belong to the stable leaf`);
    assert.equal(active.children.length, 0);
    assert.equal(hidden.children.length, 0, `${mode} must not use the hidden sizer`);
}
{
    // Narrow panes stack the card above the note, directly in the leaf. It must
    // never be placed inside the editor (CodeMirror) or the virtualized reading
    // view, where it covered text and shared input with the editor (#12, #17).
    const observers = [];
    const frames = [];
    global.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    global.cancelAnimationFrame = () => {};
    global.MutationObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target, options) { this.target = target; this.options = options; }
        disconnect() { this.disconnected = true; }
    };
    Object.defineProperty(TestElement.prototype, 'parentElement', { get() { return this.parent; }, configurable: true });
    Object.defineProperty(TestElement.prototype, 'nextSibling', {
        get() { const s = this.parent?.children; return s ? s[s.indexOf(this) + 1] || null : null; }, configurable: true
    });
    TestElement.prototype.insertBefore = function insertBefore(child, ref) {
        if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
        child.parent = this;
        const index = this.children.indexOf(ref);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        return child;
    };
    const inSizer = sizer => sizer.children.some(child => child.cls === 'infobox-panel');

    for (const mode of ['preview', 'source']) {
        const leafEl = new TestElement('div');
        leafEl.isConnected = true;
        leafEl.clientWidth = 400;
        const header = leafEl.createDiv({ cls: 'view-header' });
        const content = leafEl.createDiv({ cls: 'view-content' });
        const preview = content.createDiv({ cls: 'markdown-preview-sizer' });
        const source = content.createDiv({ cls: 'cm-sizer' });
        leafEl.previewSizer = preview;
        leafEl.sourceSizer = source;
        leafEl.contentSizer = mode === 'preview' ? preview : source;
        const leaf = { view: {
            containerEl: leafEl, contentEl: content,
            file: { path: 'Long.md' }, getViewType: () => 'markdown', getMode: () => mode
        } };
        plugin.processLeaf(leaf);
        const panel = leafEl.children.find(child => child.cls === 'infobox-panel');
        assert(panel, `${mode}: narrow panel belongs to the leaf`);
        assert.equal(panel.nextSibling, content, `${mode}: narrow panel sits directly above the note`);
        assert.equal(leafEl.children.indexOf(header), 0, 'view header stays first');
        assert(!inSizer(preview) && !inSizer(source), `${mode}: panel is never inside editor or reading DOM`);
        assert(leafEl.classList.contains('infobox-stacked'));
        assert(!leafEl.classList.contains('infobox-docked'));
        assert(panel.classList.contains('infobox-panel-stacked'));

        const observer = observers.at(-1);
        assert.equal(observer.target, leafEl);
        assert(!observer.options.subtree, 'observer must not watch editor keystrokes (subtree)');

        // Something removes the card: it is put back in the same place.
        leafEl.children = leafEl.children.filter(child => child !== panel);
        panel.parent = null;
        observer.callback([]);
        frames.shift()();
        assert.equal(panel.nextSibling, content, `${mode}: card is restored above the note`);

        // Widening the pane docks the same card in the reserved gutter.
        leafEl.clientWidth = 1000;
        observer.callback([]);
        frames.shift()();
        assert(leafEl.children.includes(panel));
        assert(leafEl.classList.contains('infobox-docked'));
        assert(!leafEl.classList.contains('infobox-stacked'));
        assert(!panel.classList.contains('infobox-panel-stacked'));
        assert(!inSizer(preview) && !inSizer(source));

        // Narrowing again stacks it, with no duplicate card.
        leafEl.clientWidth = 500;
        observer.callback([]);
        frames.shift()();
        assert.equal(panel.nextSibling, content);
        assert.equal(leafEl.children.filter(child => child.cls === 'infobox-panel').length, 1);

        plugin.processLeaf(leaf);
        assert(observer.disconnected, 'refreshing must disconnect the previous observer');
    }
    delete global.MutationObserver;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
    delete TestElement.prototype.parentElement;
    delete TestElement.prototype.nextSibling;
    delete TestElement.prototype.insertBefore;
}
const css = require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8');
assert(css.includes('.infobox-docked > .view-content'), 'docked card must reserve a gutter so it never covers text');
assert(!css.includes('infobox-panel-inline'), 'in-editor inline placement is gone');
assert(!require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8').includes('padding-right: 300px'));

console.log('infobox-layout tests passed');
