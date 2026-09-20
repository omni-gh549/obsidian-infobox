const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const yaml = require('js-yaml');
const sandbox = {
    module: { exports: {} },
    require: () => ({ Plugin: class {}, parseYaml: yaml.load })
};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8') +
    '\nmodule.exports.repair = repairWikilinkFrontmatter;', sandbox);
const { repair } = sandbox.module.exports;

test('repairs a leading wikilink followed by descriptive text without changing the body', () => {
    const source = '---\ninfobox:\n  fields:\n    - Ancestors: [[Marlow Sonners]] (deceased), [[Another]]\n---\nBody [[Unchanged]]';
    const result = repair(source);
    assert(result.endsWith('\n---\nBody [[Unchanged]]'));
    const parsed = yaml.load(result.split('---')[1]);
    assert.equal(parsed.infobox.fields[0].Ancestors, '[[Marlow Sonners]] (deceased), [[Another]]');
});

test('preserves CRLF, quotes and backslashes in repaired values', () => {
    const value = '[[Note]] says "hi" at C:\\notes';
    const source = `---\r\ninfobox:\r\n  title: ${value}\r\n---\r\nBody`;
    const result = repair(source);
    assert(result.includes('\r\n---\r\nBody'));
    assert.equal(yaml.load(result.split('---')[1]).infobox.title, value);
});

test('leaves valid YAML and ambiguous comments alone', () => {
    assert.equal(repair('---\ninfobox:\n  title: "[[Note]] text"\n---\n'), null);
    assert.equal(repair('---\ninfobox:\n  title: [[Note]] text # comment\n---\n'), null);
    assert.equal(repair('---\ninfobox:\n  title: [[Note]] text\nother: [broken\n---\n'), null);
});

test('does not rewrite list group content inside a block scalar', () => {
    const block = '  fields:\n    - Aliases: |\n        #### Codenames\n        - [[King]]\n        #### Nicknames\n        - Golden Boy\n        Example: [[Example]] text';
    const source = `---\ninfobox:\n${block}\n  title: [[Note]] text\n---\n`;
    const result = repair(source);
    assert(result.includes(block));
    const value = yaml.load(result.split('---')[1]).infobox.fields[0].Aliases;
    const plugin = new sandbox.module.exports();
    let rendered;
    plugin.renderInlineText = (_, text) => { rendered = text; };
    plugin.renderFieldValue({ createDiv: () => ({}) }, value, { path: 'Note.md' });
    assert.equal(rendered, value.trim());
    assert(rendered.includes('#### Nicknames\n- Golden Boy'));
});
