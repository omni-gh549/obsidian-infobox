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
    // Narrow panes and phones: the card is the first child of the active mode's
    // scroll area, so it scrolls away with the note (#21). It is never inside a
    // sizer (the note text or the reading view's virtualized sections, #12/#17).
    const observers = [];
    const frames = [];
    global.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    global.cancelAnimationFrame = () => {};
    global.MutationObserver = class {
        constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); }
        observe(target, options) { this.targets.push({ target, options }); }
        disconnect() { this.disconnected = true; }
    };
    const proto = TestElement.prototype;
    Object.defineProperty(proto, 'parentElement', { get() { return this.parent; }, configurable: true });
    Object.defineProperty(proto, 'firstChild', { get() { return this.children[0] || null; }, configurable: true });
    proto.insertBefore = function insertBefore(child, ref) {
        if (child.parent) child.parent.children = child.parent.children.filter(c => c !== child);
        child.parent = this;
        const index = this.children.indexOf(ref);
        this.children.splice(index < 0 ? this.children.length : index, 0, child);
        return child;
    };
    // Minimal "a > b > c" child-chain selector support for the scroller lookup.
    const originalQuery = proto.querySelector;
    proto.querySelector = function querySelector(selector) {
        if (!selector.includes('>')) return originalQuery.call(this, selector);
        const parts = selector.split('>').map(p => p.trim().replace(/^\./, ''));
        let level = [this];
        for (const cls of parts) level = level.flatMap(el => el.children.filter(c => c.classList?.contains(cls)));
        return level[0] || null;
    };
    const style = {};
    const leafFor = (width, mode) => {
        const leafEl = new TestElement('div');
        leafEl.isConnected = true;
        leafEl.clientWidth = width;
        leafEl.style = { setProperty: (k, v) => { style[k] = v; }, removeProperty: k => { delete style[k]; } };
        leafEl.createDiv({ cls: 'view-header' });
        const content = leafEl.createDiv({ cls: 'view-content' });
        const previewScroller = content.createDiv({ cls: 'markdown-reading-view' }).createDiv({ cls: 'markdown-preview-view' });
        const previewSizer = previewScroller.createDiv({ cls: 'markdown-preview-sizer' });
        const editorScroller = content.createDiv({ cls: 'markdown-source-view' }).createDiv({ cls: 'cm-editor' }).createDiv({ cls: 'cm-scroller' });
        const editorSizer = editorScroller.createDiv({ cls: 'cm-sizer' });
        const view = { containerEl: leafEl, contentEl: content, file: { path: 'Long.md' },
            getViewType: () => 'markdown', getMode: () => view.mode, mode };
        return { leaf: { view }, leafEl, content, previewScroller, previewSizer, editorScroller, editorSizer };
    };
    const panelIn = el => el.children.find(child => child.cls === 'infobox-panel');

    for (const mode of ['preview', 'source']) {
        const l = leafFor(400, mode);
        plugin.processLeaf(l.leaf);
        const scroller = mode === 'preview' ? l.previewScroller : l.editorScroller;
        const other = mode === 'preview' ? l.editorScroller : l.previewScroller;
        const panel = panelIn(scroller);
        assert(panel, `${mode}: narrow card is in the note's scroll area`);
        assert.equal(scroller.children[0], panel, `${mode}: card is the first thing in the scroll area`);
        assert(!panelIn(l.previewSizer) && !panelIn(l.editorSizer), `${mode}: card is never inside note text or sections`);
        assert(!panelIn(other) && !panelIn(l.leafEl), `${mode}: only one card`);
        assert(l.leafEl.classList.contains('infobox-stacked'));
        assert(!l.leafEl.classList.contains('infobox-docked'));
        assert(panel.classList.contains('infobox-panel-stacked'));

        const observer = observers.at(-1);
        const leafWatch = observer.targets.find(t => t.target === l.leafEl);
        const scrollerWatch = observer.targets.find(t => t.target === scroller);
        assert(leafWatch && !leafWatch.options.subtree, 'leaf watched without subtree');
        assert(scrollerWatch && scrollerWatch.options.childList && !scrollerWatch.options.subtree,
            'scroll area watched for its own children only, never editor keystrokes');

        // Something removes the card: it goes back to the top of the scroll area.
        scroller.children = scroller.children.filter(child => child !== panel);
        panel.parent = null;
        observer.callback([]);
        frames.shift()();
        assert.equal(scroller.children[0], panel, `${mode}: card is restored at the top`);

        // Switching mode moves the same card to the other mode's scroll area.
        l.leaf.view.mode = mode === 'preview' ? 'source' : 'preview';
        observer.callback([]);
        frames.shift()();
        assert.equal(other.children[0], panel, `${mode}: card follows a mode switch`);
        assert(!panelIn(scroller));

        // Widening the pane docks the card in the leaf and reserves a gutter.
        l.leafEl.clientWidth = 1200;
        observer.callback([]);
        frames.shift()();
        assert.equal(panel.parent, l.leafEl);
        assert(l.leafEl.classList.contains('infobox-docked'));
        assert(!l.leafEl.classList.contains('infobox-stacked'));
        assert(!panel.classList.contains('infobox-panel-stacked'));
        assert.equal(style['--infobox-gutter'], '312px', 'without layout measurements the full card width is reserved');

        // Narrowing again stacks it, clears the gutter, and keeps a single card.
        l.leafEl.clientWidth = 500;
        observer.callback([]);
        frames.shift()();
        assert.equal(other.children[0], panel);
        assert.equal(style['--infobox-gutter'], undefined, 'stacked cards reserve no gutter');
        assert.equal([l.leafEl, l.previewScroller, l.editorScroller].reduce((n, el) => n + el.children.filter(c => c.cls === 'infobox-panel').length, 0), 1);

        plugin.processLeaf(l.leaf);
        assert(observer.disconnected, 'refreshing must disconnect the previous observer');
    }
    {
        // Phones always stack, whatever the reported width.
        document.body.classList.add('is-phone');
        const l = leafFor(1200, 'source');
        l.leafEl.ownerDocument = document;
        plugin.processLeaf(l.leaf);
        assert.equal(l.editorScroller.children[0]?.cls, 'infobox-panel', 'phones stack the card in the scroll area');
        document.body.classList.remove('is-phone');
    }
    {
        // Tablet portrait widths stack; landscape widths dock (#21).
        for (const [width, stacked] of [[768, true], [834, true], [1024, false], [1366, false]]) {
            const l = leafFor(width, 'preview');
            plugin.processLeaf(l.leaf);
            assert.equal(l.leafEl.classList.contains('infobox-stacked'), stacked, `width ${width}`);
        }
    }
    delete global.MutationObserver;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
    delete proto.parentElement;
    delete proto.firstChild;
    delete proto.insertBefore;
    proto.querySelector = originalQuery;
}
const css = require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8');
assert(css.includes('margin-right: var(--infobox-gutter'), 'docked card reserves the measured gutter so it never covers text');
assert(!css.includes('infobox-panel-inline'), 'in-editor inline placement is gone');
assert(!require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8').includes('padding-right: 300px'));

console.log('infobox-layout tests passed');
