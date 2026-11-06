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
    // Reading mode virtualization empties the preview sizer while scrolling (#12).
    const observers = [];
    const frames = [];
    global.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    global.cancelAnimationFrame = () => {};
    global.MutationObserver = class {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observe(target) { this.target = target; }
        disconnect() { this.disconnected = true; }
    };
    Object.defineProperty(TestElement.prototype, 'parentElement', { get() { return this.parent; }, configurable: true });
    const readingContainer = new TestElement('div');
    readingContainer.isConnected = true;
    readingContainer.clientWidth = 400;
    const readable = new TestElement('div', { cls: 'is-readable-line-width' });
    const preview = new TestElement('div', { cls: 'markdown-preview-sizer' });
    readable.appendChild(preview);
    readingContainer.previewSizer = preview;
    const leaf = { view: {
        containerEl: readingContainer, contentEl: readingContainer,
        file: { path: 'Long.md' }, getViewType: () => 'markdown', getMode: () => 'preview'
    } };
    plugin.processLeaf(leaf);
    const panel = preview.children.find(child => child.cls === 'infobox-panel');
    assert(panel, 'reading mode should render the panel');
    preview.children = [];
    panel.parent = null;
    observers.at(-1).callback([]);
    frames.shift()();
    assert(preview.children.includes(panel), 'narrow panel must be re-attached after the reading view drops it');

    // Replacing the entire sizer is the case the old observer never saw (#13).
    const replacement = new TestElement('div', { cls: 'markdown-preview-sizer' });
    readingContainer.previewSizer = replacement;
    observers.at(-1).callback([]);
    frames.shift()();
    assert(replacement.children.includes(panel), 'panel must follow a replacement sizer');

    // Widening a split must move the existing card back to the stable leaf.
    readingContainer.clientWidth = 1000;
    observers.at(-1).callback([]);
    frames.shift()();
    assert(readingContainer.children.includes(panel));
    assert(readingContainer.classList.contains('infobox-docked'));

    plugin.processLeaf(leaf);
    assert(observers.at(-2).disconnected, 'refreshing must disconnect the previous observer');
    delete global.MutationObserver;
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
    delete TestElement.prototype.parentElement;
}
assert(!require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8').includes('padding-right: 300px'));

console.log('infobox-layout tests passed');
