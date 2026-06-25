const assert = require('assert');
const Module = require('module');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'obsidian') {
        return { Plugin: class Plugin {} };
    }
    return originalLoad.call(this, request, parent, isMain);
};

global.document = {
    createTextNode(text) {
        return { type: 'text', text: String(text) };
    }
};

class TestElement {
    constructor(tag, options = {}) {
        this.tag = tag;
        this.cls = options.cls || '';
        this.text = options.text || '';
        this.attr = { ...(options.attr || {}) };
        this.children = [];
        this.listeners = {};
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    createEl(tag, options = {}) {
        const child = new TestElement(tag, options);
        this.children.push(child);
        return child;
    }

    createDiv(options = {}) {
        return this.createEl('div', options);
    }

    addEventListener(eventName, callback) {
        this.listeners[eventName] = callback;
    }
}

const InfoboxPlugin = require('../main.js');

function render(value) {
    const opened = [];
    const plugin = new InfoboxPlugin();
    plugin.app = {
        workspace: {
            openLinkText(target, sourcePath) {
                opened.push({ target, sourcePath });
            }
        }
    };

    const parent = new TestElement('span');
    plugin.renderInlineText(parent, value, { path: 'Characters/Varka.md' });
    return { parent, opened };
}

function linksOf(parent) {
    return parent.children.filter(child => child.tag === 'a');
}

{
    const { parent, opened } = render('Region: [[Mondstadt]]');
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'Mondstadt');
    assert.strictEqual(links[0].attr.href, 'Mondstadt');
    assert.strictEqual(links[0].attr['data-href'], 'Mondstadt');

    links[0].listeners.click({ preventDefault() {} });
    assert.deepStrictEqual(opened, [{ target: 'Mondstadt', sourcePath: 'Characters/Varka.md' }]);
}

{
    const { parent } = render('[[Knights of Favonius|the Knights]]');
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'the Knights');
    assert.strictEqual(links[0].attr.href, 'Knights of Favonius');
    assert.strictEqual(links[0].attr['data-href'], 'Knights of Favonius');
}

{
    const { parent } = render([['Mondstadt']]);
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'Mondstadt');
    assert.strictEqual(links[0].attr.href, 'Mondstadt');
}

{
    const { parent } = render([['Knights of Favonius|the Knights']]);
    const links = linksOf(parent);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].text, 'the Knights');
    assert.strictEqual(links[0].attr.href, 'Knights of Favonius');
}

console.log('infobox-link-rendering tests passed');
