const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const notices = [];
const sandbox = { module: { exports: {} }, require: () => ({
    Plugin: class {}, Modal: class { setTitle() {} },
    parseYaml: yaml.load, stringifyYaml: yaml.dump,
    Notice: class { constructor(message) { notices.push(message); } }
}) };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') +
    '\nmodule.exports.Editor = InfoboxEditModal;', sandbox);
const Plugin = sandbox.module.exports;
function fixture() {
    const plugin = new Plugin();
    const files = new Map();
    const fm = { unrelated: 'preserved' };
    plugin.app = {
        vault: {
            getAbstractFileByPath: p => files.get(p),
            createFolder: async p => files.set(p, { path: p }),
            create: async (p, text) => files.set(p, { path: p, text }),
            read: async file => file.text,
            getMarkdownFiles: () => [...files.values()].filter(f => f.path.endsWith('.md'))
        },
        metadataCache: { getFileCache: file => ({ frontmatter: yaml.load(file.text?.split('---')[1] || '') }) },
        fileManager: { processFrontMatter: async (_, callback) => callback(fm) }
    };
    plugin.scheduleRefresh = () => {};
    return { plugin, files, fm };
}

test('templates save nested YAML, filter folder boundaries, and never overwrite existing files', async () => {
    const { plugin, files } = fixture();
    plugin.settings.templateFolder = 'Templates/Infobox';
    const data = { fields: [{ section: 'Identity' }, { Name: '[[A|Alias]]' }], colors: { background: '#123456' } };
    await plugin.saveTemplate('Character', data);
    const template = files.get('Templates/Infobox/Character.md');
    assert.deepEqual(yaml.load(template.text.split('---')[1]).infobox, data);
    files.set('Templates/InfoboxOther/Ignore.md', { path: 'Templates/InfoboxOther/Ignore.md', text: template.text });
    assert.equal(plugin.getTemplateFiles().length, 1);
    await assert.rejects(plugin.saveTemplate('Character', {}), /already exists/);
    assert.equal(files.get(template.path), template);
});

test('invalid paths and names cannot write outside the configured vault folder', async () => {
    const { plugin, files } = fixture();
    for (const folder of ['../Outside', '/absolute', 'C:/outside', 'Templates/../outside', 'a//b', '.']) {
        plugin.settings.templateFolder = folder;
        await assert.rejects(plugin.saveTemplate('Character', {}), /vault-relative/);
    }
    plugin.settings.templateFolder = 'Templates';
    for (const name of ['', '../Outside', 'a/b', 'a\\b', 'name:', '..', 'ends.']) {
        await assert.rejects(plugin.saveTemplate(name, {}), /valid template name/);
    }
    assert.equal(files.size, 0);
});

test('import copies the latest template, preserves unrelated properties, and requires replacement consent', async () => {
    const { plugin, files, fm } = fixture();
    const data = { title: 'Source title', fields: [{ Name: '' }], colors: { text: '#222' } };
    await plugin.saveTemplate('Character', data);
    const template = files.get('Infobox templates/Character.md');
    await plugin.importTemplate({ basename: 'New character' }, template);
    assert.equal(fm.infobox.title, 'New character');
    assert.equal(fm.unrelated, 'preserved');
    fm.infobox.fields[0].Name = 'Existing value';
    await plugin.importTemplate({ basename: 'Another title' }, template);
    assert.equal(fm.infobox.fields[0].Name, 'Existing value');
    assert.match(notices.at(-1), /already has an infobox/);
    await plugin.importTemplate({ basename: 'Another title' }, template, true);
    assert.equal(fm.infobox.fields[0].Name, '');
    assert.equal(yaml.load(template.text.split('---')[1]).infobox.title, 'Source title');
});

test('malformed and deleted templates report failure without changing the destination', async () => {
    const { plugin, fm } = fixture();
    for (const text of ['---\ninfobox: [\n---\n', 'No frontmatter', '---\ninfobox: []\n---\n']) {
        await plugin.importTemplate({}, { text });
        assert.equal(fm.infobox, undefined);
        assert.match(notices.at(-1), /Could not insert/);
    }
    plugin.app.vault.read = async () => { throw new Error('Missing template'); };
    await plugin.importTemplate({}, {});
    assert.match(notices.at(-1), /Missing template/);
});

test('color editing accepts only supported hex colors and reset restores theme inheritance', async () => {
    const { plugin, fm } = fixture();
    const data = { title: 'Example', colors: { background: '#abc', text: '#123456', border: '#12345678',
        section: 'url(https://invalid)', sectionText: '#1234', unexpected: '#000' } };
    const editor = new Plugin.Editor(plugin.app, {}, data);
    editor.app = plugin.app;
    await editor.saveDetails();
    assert.deepEqual(JSON.parse(JSON.stringify(fm.infobox.colors)), { background: '#abc', text: '#123456', border: '#12345678' });
    data.colors = {};
    await editor.saveDetails();
    assert.equal(fm.infobox.colors, undefined);
    assert.equal(fm.unrelated, 'preserved');
});
