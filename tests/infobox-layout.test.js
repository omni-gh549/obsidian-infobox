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
assert(cmSizer.children.some(child => child.cls === 'infobox-panel'), 'readable sizer should host the panel');
assert(cmSizer.classList.contains('infobox-readable-host'));
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
    assert(active.children.some(child => child.cls === 'infobox-panel'), `${mode} must host the infobox in its active sizer`);
    assert.equal(hidden.children.length, 0, `${mode} must not use the hidden sizer`);
}
assert(!require('fs').readFileSync(require('path').join(__dirname, '../styles.css'), 'utf8').includes('padding-right: 300px'));

console.log('infobox-layout tests passed');
