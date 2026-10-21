const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

class Element {
    constructor() { this.children = []; }
    empty() { this.children = []; }
    createEl(tag, options = {}) {
        const child = new Element();
        Object.assign(child, { tag, options });
        this.children.push(child);
        return child;
    }
    createDiv(options) { return this.createEl('div', options); }
    addEventListener() {}
}

const pending = new Set();
const sandbox = {
    module: { exports: {} },
    require: () => ({
        Plugin: class {},
        Modal: class { setTitle() {} },
        debounce: fn => {
            let args;
            const invoke = () => fn(...args);
            const wrapped = (...values) => { args = values; pending.add(invoke); };
            wrapped.cancel = () => pending.delete(invoke);
            return wrapped;
        }
    })
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') +
    '\nmodule.exports.Editor = InfoboxEditModal;', sandbox);
const Editor = sandbox.module.exports.Editor;

test('debounced edits to different details all survive the save', async () => {
    const frontmatter = { infobox: { title: 'Old', subtitle: 'Old subtitle' }, unrelated: true };
    const editor = new Editor({}, {}, { ...frontmatter.infobox });
    editor.app = { fileManager: { processFrontMatter: async (_, cb) => cb(frontmatter) } };
    editor.currentData.title = 'New';
    editor.debouncedSave('title', 'New');
    editor.currentData.subtitle = 'New subtitle';
    editor.debouncedSave('subtitle', 'New subtitle');
    assert.equal(pending.size, 1);
    for (const invoke of pending) await invoke();
    pending.clear();
    assert.equal(frontmatter.infobox.title, 'New');
    assert.equal(frontmatter.infobox.subtitle, 'New subtitle');
    assert.equal(frontmatter.unrelated, true);
});

test('editor opens list fields and retains explicit list formatting', () => {
    const editor = new Editor({}, {}, { fields: [{ Roles: ['Engineer', 'Founder'] }, {}] });
    editor.fieldsContainer = new Element();
    editor.renderFieldsEditor();
    const row = editor.fieldsContainer.children[0];
    const value = row.children.find(child => child.tag === 'textarea');
    assert.equal(value.value, '- Engineer\n- Founder');
});

test('multiple links in one field are saved as separate list items for the graph', async () => {
    const frontmatter = {};
    const editor = new Editor({}, {}, {
        fields: [
            { section: 'A, B' },
            { Comma: '[[One]], [[Two]], [[Three]]' },
            { Lines: '[[One]]\n[[Two]]\n[[Three]]' },
            { Bullets: '- [[One]]\n- [[Two]]' },
            { Single: '[[One]]' },
            { Text: 'Paris, France' }
        ]
    });
    editor.app = { fileManager: { processFrontMatter: async (_, cb) => cb(frontmatter) } };
    await editor.saveFields();
    const [, comma, lines, bullets, single, text] = frontmatter.infobox.fields;
    assert.equal(JSON.stringify(comma.Comma), JSON.stringify(['[[One]]', '[[Two]]', '[[Three]]']));
    assert.equal(JSON.stringify(lines.Lines), JSON.stringify(['[[One]]', '[[Two]]', '[[Three]]']));
    assert.equal(JSON.stringify(bullets.Bullets), JSON.stringify(['[[One]]', '[[Two]]']));
    assert.equal(single.Single, '[[One]]');
    assert.equal(text.Text, 'Paris, France');
    assert.equal(frontmatter.infobox.fields[0].section, 'A, B');
});
