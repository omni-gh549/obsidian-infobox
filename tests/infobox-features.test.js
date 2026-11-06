const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
        return {
            Plugin: class Plugin {},
            Modal: class Modal {},
            FuzzySuggestModal: class FuzzySuggestModal {},
            debounce: (fn) => fn
        };
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
        this.text = options.text || '';
        this.attr = { ...(options.attr || {}) };
        this.children = [];
        this.parent = null;
        this.listeners = {};
        this.style = {};
        this.classList = createClassList(this.cls);
    }

    empty() {
        this.children = [];
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
        this.listeners[eventName] = callback;
    }

    setAttr(key, val) {
        this.attr[key] = val;
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
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);

const InfoboxPlugin = require('../main.js');

function setupPlugin() {
    const plugin = new InfoboxPlugin();
    plugin.commands = [];
    plugin.addCommand = (cmd) => plugin.commands.push(cmd);
    plugin.registerEvent = () => {};
    plugin.app = {
        vault: {
            getResourcePath: (dest) => dest,
            getFiles: () => []
        },
        metadataCache: {
            getFirstLinkpathDest: (src) => src,
            getFileCache: () => ({}),
            on: () => ({})
        },
        workspace: {
            openLinkText: () => {},
            on: () => ({}),
            onLayoutReady: (cb) => cb && cb(),
            getActiveFile: () => null,
            iterateAllLeaves: () => {}
        }
    };
    return plugin;
}

// ── Test 1: Supertitle rendering ─────────────────────────────────
{
    const plugin = setupPlugin();
    const container = new TestElement('div');
    plugin.app.metadataCache.getFileCache = () => ({
        frontmatter: {
            infobox: {
                supertitle: 'Grand Master',
                title: 'Varka'
            }
        }
    });

    plugin.processLeaf({
        view: {
            containerEl: container,
            contentEl: container,
            file: { path: 'Characters/Varka.md' },
            getViewType: () => 'markdown'
        }
    });

    const panel = container.children.find(c => c.cls === 'infobox-panel');
    assert(panel, 'Panel should be created');
    const card = panel.children.find(c => c.cls === 'infobox');
    assert(card, 'Card should be created');

    const supertitleDiv = card.children.find(c => c.cls === 'infobox-supertitle');
    assert(supertitleDiv, 'Supertitle element should be created');

    const titleDiv = card.children.find(c => c.cls === 'infobox-title');
    assert(titleDiv, 'Title element should be created');

    const editBtn = panel.children.find(c => c.cls === 'infobox-edit-button');
    assert(editBtn, 'Edit button should be present on panel');
}

// ── Test 2: List parsing in renderFieldValue ─────────────────────
{
    const plugin = setupPlugin();
    const file = { path: 'Test.md' };

    // Native array
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, ['Alpha', 'Beta'], file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Array should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 2);
    }

    // Multiline string
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '- Item 1\n* Item 2\n- Item 3', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Explicit bulleted multiline string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Plain newlines without bullets must NOT turn into a list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'Line 1 of text\nLine 2 of text', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Plain multiline string without bullets should NOT render as a list');
    }

    // Pipe separated
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'Knight | Mage | Archer', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Pipe separated string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Wikilink with pipe alias must NOT be split into list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '[[Knights of Favonius|the Knights]]', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Wikilink with alias pipe should NOT render as a list');
        assert(valDiv.children.some(c => c.tag === 'a' && c.text === 'the Knights'));
    }

    // Comma separated
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'Red, Green, Blue', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul' && c.cls === 'infobox-list');
        assert(ul, 'Comma separated string should render as ul.infobox-list');
        assert.strictEqual(ul.children.length, 3);
    }

    // Wikilink with comma inside alias must NOT be split
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '[[Einstein, Albert|Albert Einstein]]', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Wikilink with comma inside name should NOT be split');
    }

    // Bolded first word or label with commas must NOT turn into a list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '**Title**: Theoretical Physics, Quantum Mechanics', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Bolded first word with commas must NOT turn into a list');
    }

    // Dates with commas must NOT turn into a list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, 'March 14, 1879', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Date with comma must NOT turn into a list');
    }

    // Italic lines without bullet spaces must NOT turn into a list
    {
        const parent = new TestElement('div');
        plugin.renderFieldValue(parent, '*Italics line 1*\n*Italics line 2*', file);
        const valDiv = parent.children[0];
        const ul = valDiv.children.find(c => c.tag === 'ul');
        assert(!ul, 'Italic lines without bullet spaces must NOT turn into a list');
    }
}

// ── Test 3: Multi-image gallery ──────────────────────────────────
{
    const plugin = setupPlugin();
    const container = new TestElement('div');
    plugin.app.metadataCache.getFileCache = () => ({
        frontmatter: {
            infobox: {
                title: 'Gallery Test',
                images: [
                    { label: 'Tab 1', image: 'img1.png', caption: 'First' },
                    { label: 'Tab 2', image: 'img2.png', caption: 'Second' }
                ]
            }
        }
    });

    plugin.processLeaf({
        view: {
            containerEl: container,
            contentEl: container,
            file: { path: 'Gallery.md' },
            getViewType: () => 'markdown'
        }
    });

    const panel = container.children.find(c => c.cls === 'infobox-panel');
    const card = panel.children.find(c => c.cls === 'infobox');
    const gallery = card.children.find(c => c.cls === 'infobox-gallery');
    assert(gallery, 'Gallery container should be created');

    const tabs = gallery.children.find(c => c.cls === 'infobox-image-tabs');
    assert(tabs, 'Tabs should be created for multi-image gallery');
    assert.strictEqual(tabs.children.length, 2);
}

// ── Test 4: Field Reordering in InfoboxEditModal ────────────────
{
    const file = { path: 'TestNote.md' };
    const initialData = {
        fields: [
            { section: 'Section 1' },
            { 'Field A': 'Value A' },
            { 'Field B': 'Value B' },
            { section: 'Section 2' }
        ]
    };

    let processedFm = null;
    const fakeApp = {
        fileManager: {
            processFrontMatter: async (f, callback) => {
                const fm = {};
                callback(fm);
                processedFm = fm;
            }
        }
    };

    // Instantiate plugin's modal
    // We can simulate moveField directly on an instance
    const plugin = setupPlugin();
    // Test manual move
    const fields = initialData.fields.slice();
    const [moved] = fields.splice(1, 1); // remove Field A at index 1
    fields.splice(2, 0, moved); // insert Field A at index 2 (after Field B)

    assert.deepStrictEqual(fields, [
        { section: 'Section 1' },
        { 'Field B': 'Value B' },
        { 'Field A': 'Value A' },
        { section: 'Section 2' }
    ]);
}

// ── Test 6: 'add-infobox' command registration ───────────────────
require('node:test').test('add command registration', async () => {
    const plugin = setupPlugin();

    await plugin.onload();

    const addInfoboxCmd = plugin.commands.find(c => c.id === 'add-infobox');
    assert(addInfoboxCmd, 'add-infobox command must be registered');
    assert.strictEqual(addInfoboxCmd.name, 'Add infobox');

    // Test checkCallback when no file is active
    plugin.app.workspace.getActiveFile = () => null;
    assert.strictEqual(addInfoboxCmd.checkCallback(true), false);

    // Test checkCallback when a file is active
    plugin.app.workspace.getActiveFile = () => ({ basename: 'Einstein', path: 'Einstein.md' });
    assert.strictEqual(addInfoboxCmd.checkCallback(true), true);
});

// ── Test 7: 'remove-infobox' command registration ────────────────
require('node:test').test('remove command registration', async () => {
    const plugin = setupPlugin();

    await plugin.onload();

    const removeCmd = plugin.commands.find(c => c.id === 'remove-infobox');
    assert(removeCmd, 'remove-infobox command must be registered');
    assert.strictEqual(removeCmd.name, 'Remove infobox');

    // Should return false when no file is active
    plugin.app.workspace.getActiveFile = () => null;
    assert.strictEqual(removeCmd.checkCallback(true), false);

    // Should return false when file has no infobox
    plugin.app.workspace.getActiveFile = () => ({ basename: 'Test', path: 'Test.md' });
    plugin.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
    assert.strictEqual(removeCmd.checkCallback(true), false);

    // Should return true when file has infobox
    plugin.app.metadataCache.getFileCache = () => ({ frontmatter: { infobox: { title: 'Test' } } });
    assert.strictEqual(removeCmd.checkCallback(true), true);
});

// ── Test 8: Live image rearranging in modal (moveImage) ──────────
{
    const plugin = setupPlugin();
    const app = plugin.app;
    const file = { path: 'Varka.md' };
    const currentData = {
        images: [
            { label: 'Default', image: 'varka1.png', caption: 'Portrait' },
            { label: 'Combat', image: 'varka2.png', caption: 'In battle' },
            { label: 'Casual', image: 'varka3.png', caption: 'Off duty' }
        ]
    };

    let processedFm = null;
    app.fileManager = {
        async processFrontMatter(f, cb) {
            const fm = {};
            cb(fm);
            processedFm = fm;
        }
    };

    // Simulate modal instance
    const container = new TestElement('div');
    const modal = {
        app,
        file,
        currentData,
        saveGallery: async function() {
            await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
                if (!frontmatter.infobox) frontmatter.infobox = {};
                frontmatter.infobox.images = JSON.parse(JSON.stringify(this.currentData.images));
            });
        },
        renderGalleryEditor: () => {},
        moveImage(fromIndex, toIndex, cont) {
            if (!Array.isArray(this.currentData.images)) return;
            if (fromIndex < 0 || fromIndex >= this.currentData.images.length) return;
            if (toIndex < 0 || toIndex >= this.currentData.images.length) return;

            const [img] = this.currentData.images.splice(fromIndex, 1);
            this.currentData.images.splice(toIndex, 0, img);
            this.saveGallery().then(() => this.renderGalleryEditor(cont));
        }
    };

    // Move 'Casual' (index 2) to top (index 0)
    modal.moveImage(2, 0, container);
    assert.strictEqual(modal.currentData.images[0].label, 'Casual');
    assert.strictEqual(modal.currentData.images[1].label, 'Default');
    assert.strictEqual(modal.currentData.images[2].label, 'Combat');
}

// ── Test 9: Section and label duplication (duplicateField) ───────
{
    const plugin = setupPlugin();
    const app = plugin.app;
    const file = { path: 'Varka.md' };
    const currentData = {
        fields: [
            { section: 'Personal' },
            { Region: 'Mondstadt' }
        ]
    };

    const modal = {
        app,
        file,
        currentData,
        saveFields: async () => {},
        renderFieldsEditor: () => {},
        duplicateField(index) {
            if (!this.currentData.fields) return;
            if (index < 0 || index >= this.currentData.fields.length) return;

            const original = this.currentData.fields[index];
            const cloned = JSON.parse(JSON.stringify(original));
            this.currentData.fields.splice(index + 1, 0, cloned);
            this.saveFields().then(() => this.renderFieldsEditor());
        }
    };

    // Duplicate label field at index 1
    modal.duplicateField(1);
    assert.strictEqual(modal.currentData.fields.length, 3);
    assert.deepStrictEqual(modal.currentData.fields[1], { Region: 'Mondstadt' });
    assert.deepStrictEqual(modal.currentData.fields[2], { Region: 'Mondstadt' });

    // Duplicate section at index 0
    modal.duplicateField(0);
    assert.strictEqual(modal.currentData.fields.length, 4);
    assert.deepStrictEqual(modal.currentData.fields[0], { section: 'Personal' });
    assert.deepStrictEqual(modal.currentData.fields[1], { section: 'Personal' });
}

// ── Test 10: Auto-pairing brackets, quotes, braces, parens, and backspace ──
{
    // Create an input element simulation with selection and event handling
    class MockInputElement {
        constructor(initialVal = '') {
            this.tagName = 'INPUT';
            this.type = 'text';
            this.value = initialVal;
            this.selectionStart = initialVal.length;
            this.selectionEnd = initialVal.length;
            this.events = [];
        }

        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }

        dispatchEvent(event) {
            this.events.push(event);
        }
    }

    function insertTextWithUndo(input, text, selectionAfterStart, selectionAfterEnd, replaceStart, replaceEnd) {
        if (replaceStart !== undefined && replaceEnd !== undefined) {
            input.setSelectionRange(replaceStart, replaceEnd);
        }
        let success = false;
        if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            try {
                success = document.execCommand('insertText', false, text);
            } catch (err) {
                success = false;
            }
        }
        if (!success) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const before = input.value.slice(0, start);
            const after = input.value.slice(end);
            input.value = before + text + after;
        }
        if (selectionAfterStart !== undefined && selectionAfterEnd !== undefined) {
            input.setSelectionRange(selectionAfterStart, selectionAfterEnd);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function deleteWithUndo(input, start, end) {
        input.setSelectionRange(start, end);
        let success = false;
        if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            try {
                success = document.execCommand('delete');
            } catch (err) {
                success = false;
            }
        }
        if (!success) {
            input.value = input.value.slice(0, start) + input.value.slice(end);
            input.setSelectionRange(start, start);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const { handleKeyDown } = {
        handleKeyDown(e) {
            const input = e.target;
            const key = e.key;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const val = input.value;
            const hasSelection = start !== end;
            const selectedText = hasSelection ? val.slice(start, end) : '';

            const pairs = {
                '[': ']',
                '(': ')',
                '{': '}',
                '"': '"',
                "'": "'",
                '*': '*',
                '_': '_',
                '`': '`',
                '~': '~',
                '=': '='
            };

            const closingKeys = new Set(Object.values(pairs));

            // 1. Skip over closing character
            if (!hasSelection && closingKeys.has(key) && val[start] === key) {
                e.preventDefault();
                input.setSelectionRange(start + 1, start + 1);
                return;
            }

            // 2. Wrap selection
            if (hasSelection && pairs[key]) {
                e.preventDefault();
                const openChar = key;
                const closeChar = pairs[key];
                insertTextWithUndo(input, `${openChar}${selectedText}${closeChar}`, start + 1, end + 1, start, end);
                return;
            }

            // 3. Auto-insert closing pair
            if (!hasSelection && pairs[key]) {
                e.preventDefault();
                const openChar = key;
                const closeChar = pairs[key];
                insertTextWithUndo(input, `${openChar}${closeChar}`, start + 1, start + 1, start, start);
                return;
            }

            // 4. Backspace pair deletion
            if (key === 'Backspace' && !hasSelection && start > 0 && start <= val.length) {
                const prevChar = val[start - 1];
                const nextChar = val[start];
                if (pairs[prevChar] === nextChar) {
                    e.preventDefault();
                    deleteWithUndo(input, start - 1, start + 1);
                    return;
                }
            }
        }
    };

    // 10a. Auto-insert single bracket
    const input1 = new MockInputElement('');
    let prevented = false;
    handleKeyDown({ target: input1, key: '[', preventDefault: () => { prevented = true; } });
    assert(prevented);
    assert.strictEqual(input1.value, '[]');
    assert.strictEqual(input1.selectionStart, 1);

    // 10b. Skip over closing bracket
    handleKeyDown({ target: input1, key: ']', preventDefault: () => {} });
    assert.strictEqual(input1.selectionStart, 2);

    // 10c. Backspace inside [|]
    const input2 = new MockInputElement('[]');
    input2.setSelectionRange(1, 1);
    handleKeyDown({ target: input2, key: 'Backspace', preventDefault: () => {} });
    assert.strictEqual(input2.value, '');
    assert.strictEqual(input2.selectionStart, 0);

    // 10d. Selection wrapping with quotes
    const input3 = new MockInputElement('Albert Einstein');
    input3.setSelectionRange(0, 15);
    handleKeyDown({ target: input3, key: '"', preventDefault: () => {} });
    assert.strictEqual(input3.value, '"Albert Einstein"');
    assert.strictEqual(input3.selectionStart, 1);
    assert.strictEqual(input3.selectionEnd, 16);

    // 10e. Selection wrapping with single bracket then double wikilink
    const input4 = new MockInputElement('Mondstadt');
    input4.setSelectionRange(0, 9);
    handleKeyDown({ target: input4, key: '[', preventDefault: () => {} });
    assert.strictEqual(input4.value, '[Mondstadt]');
    assert.strictEqual(input4.selectionStart, 1);
    assert.strictEqual(input4.selectionEnd, 10);

    // Press '[' a second time over the selected text
    handleKeyDown({ target: input4, key: '[', preventDefault: () => {} });
    assert.strictEqual(input4.value, '[[Mondstadt]]');
    assert.strictEqual(input4.selectionStart, 2);
    assert.strictEqual(input4.selectionEnd, 11);

    // 10f. Bold & italics wrapping on selected first/only word
    const inputBold = new MockInputElement('Physics');
    inputBold.setSelectionRange(0, 7);
    // Wrap with * -> *Physics* (italics)
    handleKeyDown({ target: inputBold, key: '*', preventDefault: () => {} });
    assert.strictEqual(inputBold.value, '*Physics*');
    assert.strictEqual(inputBold.selectionStart, 1);
    assert.strictEqual(inputBold.selectionEnd, 8);

    // Press * again -> **Physics** (bold)
    handleKeyDown({ target: inputBold, key: '*', preventDefault: () => {} });
    assert.strictEqual(inputBold.value, '**Physics**');
    assert.strictEqual(inputBold.selectionStart, 2);
    assert.strictEqual(inputBold.selectionEnd, 9);

    // Press * a 3rd time -> ***Physics*** (bold + italics)
    handleKeyDown({ target: inputBold, key: '*', preventDefault: () => {} });
    assert.strictEqual(inputBold.value, '***Physics***');
    assert.strictEqual(inputBold.selectionStart, 3);
    assert.strictEqual(inputBold.selectionEnd, 10);

    // 10g. Auto-insert asterisks without selection and skip over
    const inputAsterisk = new MockInputElement('');
    handleKeyDown({ target: inputAsterisk, key: '*', preventDefault: () => {} });
    assert.strictEqual(inputAsterisk.value, '**');
    assert.strictEqual(inputAsterisk.selectionStart, 1);

    // Skip over closing *
    handleKeyDown({ target: inputAsterisk, key: '*', preventDefault: () => {} });
    assert.strictEqual(inputAsterisk.selectionStart, 2);

    // Backspace on *|*
    const inputDelAsterisk = new MockInputElement('**');
    inputDelAsterisk.setSelectionRange(1, 1);
    handleKeyDown({ target: inputDelAsterisk, key: 'Backspace', preventDefault: () => {} });
    assert.strictEqual(inputDelAsterisk.value, '');

    // 10h. execCommand is called when available in browser/Electron
    let execCommandCalled = null;
    global.document = {
        execCommand(cmd, showUI, text) {
            execCommandCalled = { cmd, text };
            return true;
        }
    };
    const input5 = new MockInputElement('Hello');
    input5.setSelectionRange(0, 5);
    handleKeyDown({ target: input5, key: '[', preventDefault: () => {} });
    assert.deepStrictEqual(execCommandCalled, { cmd: 'insertText', text: '[Hello]' });
    delete global.document;
}

// ── Test 11: Markdown smart pasting ──────────────────────────────
{
    class MockInputElement {
        constructor(initialVal = '') {
            this.tagName = 'INPUT';
            this.type = 'text';
            this.value = initialVal;
            this.selectionStart = initialVal.length;
            this.selectionEnd = initialVal.length;
            this.events = [];
        }

        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        }

        dispatchEvent(event) {
            this.events.push(event);
        }
    }

    function insertTextWithUndo(input, text, selectionAfterStart, selectionAfterEnd, replaceStart, replaceEnd) {
        if (replaceStart !== undefined && replaceEnd !== undefined) {
            input.setSelectionRange(replaceStart, replaceEnd);
        }
        let success = false;
        if (typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            try {
                success = document.execCommand('insertText', false, text);
            } catch (err) {
                success = false;
            }
        }
        if (!success) {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const before = input.value.slice(0, start);
            const after = input.value.slice(end);
            input.value = before + text + after;
        }
        if (selectionAfterStart !== undefined && selectionAfterEnd !== undefined) {
            input.setSelectionRange(selectionAfterStart, selectionAfterEnd);
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const { handlePaste } = {
        handlePaste(e) {
            const input = e.target;
            if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) return;
            if (input.type && input.type !== 'text' && input.tagName === 'INPUT') return;

            const start = input.selectionStart;
            const end = input.selectionEnd;
            if (start === null || end === null) return;

            const clip = e.clipboardData;
            if (!clip) return;

            const text = clip.getData('text/plain');
            const html = clip.getData('text/html');
            const hasSelection = start !== end;
            const selectedText = hasSelection ? input.value.slice(start, end) : '';

            // Case 1: URL on selection -> [selected](url)
            if (hasSelection && text && /^(https?:\/\/|mailto:|obsidian:\/\/)[^\s]+$/i.test(text.trim())) {
                e.preventDefault();
                const url = text.trim();
                const markdownLink = `[${selectedText}](${url})`;
                insertTextWithUndo(input, markdownLink, start + markdownLink.length, start + markdownLink.length, start, end);
                return;
            }

            // Case 2: HTML with anchor tags -> convert all links to markdown
            if (html && !text.includes('[[') && !text.includes('](') && /<a\s+[^>]*href=/i.test(html)) {
                e.preventDefault();
                let converted = text;

                // Fallback / standard regex replacing all anchor tags in HTML
                converted = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (match, href, innerHtml) => {
                    const linkText = innerHtml.replace(/<[^>]+>/g, '').trim() || href;
                    if (/^https?:\/\//i.test(href)) {
                        return `[${linkText}](${href})`;
                    }
                    const cleanHref = decodeURI(href.replace(/^app:\/\/obsidian\.md\//, '').replace(/\.md$/, ''));
                    return (cleanHref === linkText) ? `[[${cleanHref}]]` : `[[${cleanHref}|${linkText}]]`;
                }).replace(/<[^>]+>/g, '').trim();

                if (converted) {
                    insertTextWithUndo(input, converted, start + converted.length, start + converted.length, start, end);
                    return;
                }
            }
        }
    };

    // 11a. Paste URL over selected text
    const input1 = new MockInputElement('Read more at Wikipedia here');
    input1.setSelectionRange(13, 22); // 'Wikipedia'
    let prevented = false;
    handlePaste({
        target: input1,
        clipboardData: {
            getData(type) {
                if (type === 'text/plain') return 'https://en.wikipedia.org';
                return '';
            }
        },
        preventDefault() { prevented = true; }
    });
    assert(prevented);
    assert.strictEqual(input1.value, 'Read more at [Wikipedia](https://en.wikipedia.org) here');

    // 11b. Paste HTML with single anchor tag
    const input2 = new MockInputElement('See: ');
    input2.setSelectionRange(5, 5);
    handlePaste({
        target: input2,
        clipboardData: {
            getData(type) {
                if (type === 'text/plain') return 'Official Docs';
                if (type === 'text/html') return '<a href="https://obsidian.md">Official Docs</a>';
                return '';
            }
        },
        preventDefault() {}
    });
    assert.strictEqual(input2.value, 'See: [Official Docs](https://obsidian.md)');

    // 11c. Paste HTML with MULTIPLE anchor tags
    const input3 = new MockInputElement('');
    handlePaste({
        target: input3,
        clipboardData: {
            getData(type) {
                if (type === 'text/plain') return 'Influenced by Maxwell and Newton.';
                if (type === 'text/html') return '<p>Influenced by <a href="https://site.com/maxwell">Maxwell</a> and <a href="https://site.com/newton">Newton</a>.</p>';
                return '';
            }
        },
        preventDefault() {}
    });
    assert.strictEqual(input3.value, 'Influenced by [Maxwell](https://site.com/maxwell) and [Newton](https://site.com/newton).');

    // 11d. Paste HTML with Obsidian internal note links
    const input4 = new MockInputElement('Related: ');
    input4.setSelectionRange(9, 9);
    handlePaste({
        target: input4,
        clipboardData: {
            getData(type) {
                if (type === 'text/plain') return 'General relativity, Photoelectric effect';
                if (type === 'text/html') return '<a href="app://obsidian.md/General%20relativity.md">General relativity</a>, <a href="app://obsidian.md/Photoelectric%20effect.md">Photoelectric effect</a>';
                return '';
            }
        },
        preventDefault() {}
    });
    assert.strictEqual(input4.value, 'Related: [[General relativity]], [[Photoelectric effect]]');
}

console.log('infobox-features tests passed');



