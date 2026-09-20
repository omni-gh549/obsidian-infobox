'use strict';

const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const Modal = obsidian.Modal || class Modal { };
const FuzzySuggestModal = obsidian.FuzzySuggestModal || class FuzzySuggestModal { };
const debounce = obsidian.debounce || ((fn, delay) => fn);
const MarkdownRenderer = obsidian.MarkdownRenderer;
const Menu = obsidian.Menu || class Menu { };
const Keymap = obsidian.Keymap;

// Only offer a repair when quoting standalone wikilink values makes the entire
// frontmatter valid. The original note is changed only by the repair button.
function repairWikilinkFrontmatter(source) {
    const match = source.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    if (!match || typeof obsidian.parseYaml !== 'function') return null;
    try { obsidian.parseYaml(match[2]); return null; } catch (_) { }
    let blockIndent = null;
    const repaired = match[2].split('\n').map(line => {
        const indent = line.match(/^ */)[0].length;
        if (blockIndent !== null) {
            if (!line.trim() || indent > blockIndent) return line;
            blockIndent = null;
        }
        if (/:\s*[|>][+-]?\d?\s*(?:#.*)?\r?$/.test(line)) {
            blockIndent = indent;
            return line;
        }
        const value = line.match(/^(\s*(?:-\s+)?[^:\r\n]+:\s*)(!?\[\[[^\r\n]*\]\][^\r\n]*)(\r?)$/);
        if (!value) return line;
        // Do not guess whether an unquoted hash is a YAML comment or note text.
        if (/\s#/.test(value[2])) return line;
        return value[1] + JSON.stringify(value[2]) + value[3];
    }).join('\n');
    if (repaired === match[2]) return null;
    try {
        const parsed = obsidian.parseYaml(repaired);
        if (!parsed?.infobox || typeof parsed.infobox !== 'object') return null;
    } catch (_) { return null; }
    return match[1] + repaired + match[3] + source.slice(match[0].length);
}

/*
 * Infobox plugin — reads structured data from YAML frontmatter and renders
 * a Wikipedia-style panel pinned to the right side of the reading pane.
 *
 * Usage — add an `infobox:` block to your note's frontmatter:
 *
 *   ---
 *   infobox:
 *     supertitle: Professor
 *     title: Albert Einstein
 *     subtitle: Theoretical Physicist
 *     image: einstein.jpg
 *     caption: Photograph from 1921
 *     tags: [science, physics]
 *     fields:
 *       - section: Personal
 *       - Born: March 14, 1879
 *       - Died: April 18, 1955
 *       - section: Career
 *       - Field: Theoretical physics
 *       - Known for: General relativity
 *   ---
 */

function splitOutsideLinks(str, delimiter) {
    if (typeof str !== 'string') return [String(str ?? '')];
    const tokens = [];
    let current = '';
    let inWikilink = 0;
    let inBracket = 0;
    let inParen = 0;
    let inQuote = null;

    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        const next = str[i + 1];

        // Track quotes (only outside links)
        if ((ch === '"' || ch === "'") && inWikilink === 0 && inBracket === 0 && inParen === 0) {
            if (inQuote === ch) {
                inQuote = null;
            } else if (inQuote === null) {
                inQuote = ch;
            }
            current += ch;
            continue;
        }

        if (inQuote !== null) {
            current += ch;
            continue;
        }

        // Track wikilinks [[ ... ]]
        if (ch === '[' && next === '[') {
            inWikilink++;
            current += '[[';
            i++;
            continue;
        }
        if (ch === ']' && next === ']') {
            if (inWikilink > 0) inWikilink--;
            current += ']]';
            i++;
            continue;
        }

        // Track markdown brackets [ ... ] and parens ( ... )
        if (inWikilink === 0) {
            if (ch === '[') {
                inBracket++;
            } else if (ch === ']') {
                if (inBracket > 0) inBracket--;
            } else if (ch === '(' && inBracket === 0) {
                inParen++;
            } else if (ch === ')') {
                if (inParen > 0) inParen--;
            }
        }

        // Delimiter matching (only split when outside all links, brackets, and quotes)
        if (ch === delimiter && inWikilink === 0 && inBracket === 0 && inParen === 0 && inQuote === null) {
            if (current.trim().length > 0) {
                tokens.push(current.trim());
            }
            current = '';
        } else {
            current += ch;
        }
    }

    if (current.trim().length > 0) {
        tokens.push(current.trim());
    }
    return tokens.filter(Boolean);
}

// Backward compatibility alias for tests
const splitOutsideWikilinks = splitOutsideLinks;

function extractListItems(value, normalizeFn) {
    if (value == null) return [];
    if (Array.isArray(value)) {
        return value.map(item => typeof normalizeFn === 'function' ? normalizeFn(item) : String(item)).filter(Boolean);
    }
    if (typeof value !== 'string') {
        return [String(value)];
    }

    const str = value.trim();
    if (!str) return [];

    // 1. Multiline strings: only convert to a list if lines start with bullet markers (- , * , + , • , 1. )
    if (str.includes('\n')) {
        const rawLines = str.split('\n').map(s => s.trim()).filter(Boolean);
        // Distinguish true list bullets ('* ') from bold/italics ('**word**' or '*word*')
        const isBulletLine = s => /^[-+•]\s+|^\*\s+|^\d+[.)]\s+/.test(s);
        const hasBulletPrefix = rawLines.length > 1 && rawLines.every(isBulletLine);
        if (hasBulletPrefix) {
            return rawLines.map(s => s.replace(/^[-+•]\s+|^\*\s+|^\d+[.)]\s+/, '').trim()).filter(Boolean);
        }
        // If multiline without explicit list bullets, keep as single multiline string
        return [str];
    }

    // 2. Pipe delimiter outside links (e.g. "[[Link 1]] | [[Link 2]]" or "Knight | Mage | Archer")
    const pipeParts = splitOutsideLinks(str, '|');
    if (pipeParts.length > 1) {
        return pipeParts;
    }

    // 3. Comma delimiter outside links: ONLY for link lists or simple token lists, NOT sentences, dates, or bolded labels
    const commaParts = splitOutsideLinks(str, ',');
    if (commaParts.length > 1) {
        const isLink = s => /^!?\[\[.*\]\]$/.test(s.trim()) || /^\[.*\]\(.*\)$/.test(s.trim());
        const allLinks = commaParts.every(isLink);
        const isDate = /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},\s*\d{4}\b/i.test(str) || /\b\d{1,2},\s*\d{4}\b/.test(str);
        const isFormattedSentence = str.includes(':') || /^\*\*|^\*|^_/.test(str);
        if (allLinks || (!isDate && !isFormattedSentence)) {
            return commaParts;
        }
    }

    // 4. Semicolon delimiter outside links (e.g. "[[Link 1]]; [[Link 2]]")
    const semiParts = splitOutsideLinks(str, ';');
    if (semiParts.length > 1) {
        return semiParts;
    }

    return [str];
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

class InfoboxEditModal extends Modal {
    constructor(app, file, currentData) {
        super(app);
        this.setTitle('Edit Infobox');
        this.file = file;
        this.currentData = currentData;
        this.debouncedSave = debounce(this.saveDetails.bind(this), 300, true);
        this.debouncedSaveFields = debounce(this.saveFields.bind(this), 300, true);
        this.debouncedSaveGallery = debounce(this.saveGallery.bind(this), 300, true);
        this.debouncedSaveTags = debounce(this.saveTags.bind(this), 300, true);
        this.draggedIndex = null;
        this.draggedTagIndex = null;
        this.draggedImageIndex = null;
        this.boundHandleKeyDown = this.handleKeyDown.bind(this);
        this.boundHandlePaste = this.handlePaste.bind(this);
    }

    normalizeInlineValue(value) {
        return InfoboxPlugin.prototype.normalizeInlineValue.call(this, value);
    }

    async saveDetails() {
        const details = { ...this.currentData };
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            for (const key of ['supertitle', 'title', 'subtitle']) {
                if (details[key] === '' || details[key] == null) delete frontmatter.infobox[key];
                else frontmatter.infobox[key] = details[key];
            }
        });
    }

    async updateYaml(key, value) {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (value === '' || value == null) {
                delete frontmatter.infobox[key];
            } else {
                frontmatter.infobox[key] = value;
            }
        });
    }

    async saveFields() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            frontmatter.infobox.fields = JSON.parse(JSON.stringify(this.currentData.fields || []));
        });
    }

    async saveGallery() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (Array.isArray(this.currentData.images) && this.currentData.images.length > 0) {
                frontmatter.infobox.images = JSON.parse(JSON.stringify(this.currentData.images));
                delete frontmatter.infobox.image;
                delete frontmatter.infobox.caption;
            } else {
                delete frontmatter.infobox.images;
                delete frontmatter.infobox.image;
                delete frontmatter.infobox.caption;
            }
        });
    }

    async saveTags() {
        await this.app.fileManager.processFrontMatter(this.file, frontmatter => {
            if (!frontmatter.infobox) frontmatter.infobox = {};
            if (Array.isArray(this.currentData.tags) && this.currentData.tags.length > 0) {
                frontmatter.infobox.tags = JSON.parse(JSON.stringify(this.currentData.tags));
            } else {
                delete frontmatter.infobox.tags;
            }
            if (this.currentData.showTags !== undefined) {
                frontmatter.infobox.showTags = this.currentData.showTags;
            }
        });
    }

    addField(defaultObj) {
        if (!this.currentData.fields) this.currentData.fields = [];
        this.currentData.fields.push(defaultObj);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    duplicateField(index) {
        if (!this.currentData.fields) return;
        if (index < 0 || index >= this.currentData.fields.length) return;

        const original = this.currentData.fields[index];
        const cloned = JSON.parse(JSON.stringify(original));
        this.currentData.fields.splice(index + 1, 0, cloned);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    removeField(index) {
        if (!this.currentData.fields) return;
        this.currentData.fields.splice(index, 1);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    moveField(fromIndex, toIndex) {
        if (!this.currentData.fields) return;
        if (fromIndex < 0 || fromIndex >= this.currentData.fields.length) return;
        if (toIndex < 0 || toIndex >= this.currentData.fields.length) return;

        const [item] = this.currentData.fields.splice(fromIndex, 1);
        this.currentData.fields.splice(toIndex, 0, item);
        this.saveFields().then(() => this.renderFieldsEditor());
    }

    moveImage(fromIndex, toIndex, container) {
        if (!Array.isArray(this.currentData.images)) return;
        if (fromIndex < 0 || fromIndex >= this.currentData.images.length) return;
        if (toIndex < 0 || toIndex >= this.currentData.images.length) return;

        const [img] = this.currentData.images.splice(fromIndex, 1);
        this.currentData.images.splice(toIndex, 0, img);
        this.saveGallery().then(() => this.renderGalleryEditor(container));
    }

    moveTag(fromIndex, toIndex, container) {
        if (!Array.isArray(this.currentData.tags)) return;
        if (fromIndex < 0 || fromIndex >= this.currentData.tags.length) return;
        if (toIndex < 0 || toIndex >= this.currentData.tags.length) return;

        const [tag] = this.currentData.tags.splice(fromIndex, 1);
        this.currentData.tags.splice(toIndex, 0, tag);
        this.debouncedSaveTags();
        this.renderTagsEditor(container);
    }

    handleKeyDown(e) {
        const input = e.target;
        if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) return;
        if (input.type && input.type !== 'text' && input.tagName === 'INPUT') return;

        const key = e.key;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        if (start === null || end === null) return;

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

        // 1. Skip over closing character if typed immediately before it without selection
        if (!hasSelection && closingKeys.has(key) && val[start] === key) {
            e.preventDefault();
            input.setSelectionRange(start + 1, start + 1);
            return;
        }

        // 2. Selection wrapping: cleanly wrap selected text in matching pair
        if (hasSelection && pairs[key]) {
            e.preventDefault();
            const openChar = key;
            const closeChar = pairs[key];
            insertTextWithUndo(input, `${openChar}${selectedText}${closeChar}`, start + 1, end + 1, start, end);
            return;
        }

        // 3. Auto-insert closing pair without selection
        if (!hasSelection && pairs[key]) {
            e.preventDefault();
            const openChar = key;
            const closeChar = pairs[key];
            insertTextWithUndo(input, `${openChar}${closeChar}`, start + 1, start + 1, start, start);
            return;
        }

        // 4. Backspace pair deletion: if cursor is between matching pair, delete both
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

        // Case 1: If clipboard contains a URL and user has selected text -> create markdown link [selected](url)
        if (hasSelection && text && /^(https?:\/\/|mailto:|obsidian:\/\/)[^\s]+$/i.test(text.trim())) {
            e.preventDefault();
            const url = text.trim();
            const markdownLink = `[${selectedText}](${url})`;
            insertTextWithUndo(input, markdownLink, start + markdownLink.length, start + markdownLink.length, start, end);
            return;
        }

        // Case 2: If HTML was pasted and contains anchor tags <a href="...">...</a> -> convert all links to markdown
        if (html && !text.includes('[[') && !text.includes('](') && /<a\s+[^>]*href=/i.test(html)) {
            e.preventDefault();
            let converted = text;

            // Try Obsidian's native htmlToMarkdown if available
            if (typeof obsidian !== 'undefined' && typeof obsidian.htmlToMarkdown === 'function') {
                try {
                    const md = obsidian.htmlToMarkdown(html);
                    if (md && md.trim()) {
                        converted = md.replace(/\[([^\]]+)\]\(app:\/\/obsidian\.md\/([^)]+)\)/g, (m, label, target) => {
                            const cleanTarget = decodeURI(target).replace(/\.md$/, '');
                            return cleanTarget === label ? `[[${cleanTarget}]]` : `[[${cleanTarget}|${label}]]`;
                        }).trim();
                    }
                } catch (err) {
                    converted = text;
                }
            }

            // Fallback: global regex replacing all anchor tags in HTML
            if (converted === text) {
                converted = html.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (match, href, innerHtml) => {
                    const linkText = innerHtml.replace(/<[^>]+>/g, '').trim() || href;
                    if (/^https?:\/\//i.test(href)) {
                        return `[${linkText}](${href})`;
                    }
                    const cleanHref = decodeURI(href.replace(/^app:\/\/obsidian\.md\//, '').replace(/\.md$/, ''));
                    return (cleanHref === linkText) ? `[[${cleanHref}]]` : `[[${cleanHref}|${linkText}]]`;
                }).replace(/<[^>]+>/g, '').trim();
            }

            if (converted) {
                insertTextWithUndo(input, converted, start + converted.length, start + converted.length, start, end);
                return;
            }
        }
    }

    renderFieldsEditor() {
        this.fieldsContainer.empty();
        const fields = this.currentData.fields || [];

        fields.forEach((item, index) => {
            if (!item || typeof item !== 'object') return;
            const key = Object.keys(item)[0];
            const val = item[key];
            if (!key) return;
            const isSection = key.toLowerCase() === 'section';
            const rowCls = isSection
                ? 'infobox-edit-field-row is-section'
                : 'infobox-edit-field-row is-label';

            const row = this.fieldsContainer.createDiv({ cls: rowCls });

            // Drag handle (only the handle initiates dragging to prevent text selection from triggering drag)
            const dragHandle = row.createEl('span', {
                text: '⠿',
                cls: 'infobox-edit-drag-handle',
                attr: {
                    title: 'Drag to reorder',
                    'aria-label': 'Drag to reorder'
                }
            });

            dragHandle.addEventListener('mousedown', () => {
                row.setAttribute('draggable', 'true');
            });
            dragHandle.addEventListener('mouseup', () => {
                if (this.draggedIndex === null) row.removeAttribute('draggable');
            });
            dragHandle.addEventListener('mouseleave', () => {
                if (this.draggedIndex === null) row.removeAttribute('draggable');
            });

            // Reorder buttons for keyboard & accessibility
            const reorderBtns = row.createDiv({ cls: 'infobox-edit-reorder-btns' });
            const moveUpBtn = reorderBtns.createEl('button', {
                text: '▲',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move field up',
                    title: 'Move field up',
                    type: 'button'
                }
            });
            if (index === 0) moveUpBtn.disabled = true;
            moveUpBtn.addEventListener('click', () => this.moveField(index, index - 1));

            const moveDownBtn = reorderBtns.createEl('button', {
                text: '▼',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move field down',
                    title: 'Move field down',
                    type: 'button'
                }
            });
            if (index === fields.length - 1) moveDownBtn.disabled = true;
            moveDownBtn.addEventListener('click', () => this.moveField(index, index + 1));

            // Drag & Drop events
            row.addEventListener('dragstart', e => {
                if (e.target.closest('input, textarea, button, select') || !row.hasAttribute('draggable')) {
                    e.preventDefault();
                    return false;
                }
                this.draggedIndex = index;
                row.classList.add('is-dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(index));
                }
            });

            row.addEventListener('dragend', () => {
                this.draggedIndex = null;
                row.removeAttribute('draggable');
                row.classList.remove('is-dragging');
                this.fieldsContainer.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
            });

            row.addEventListener('dragover', e => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                if (!row.classList.contains('is-dragover')) {
                    row.classList.add('is-dragover');
                }
            });

            row.addEventListener('dragleave', () => {
                row.classList.remove('is-dragover');
            });

            row.addEventListener('drop', e => {
                e.preventDefault();
                row.classList.remove('is-dragover');
                if (this.draggedIndex !== null && this.draggedIndex !== index) {
                    this.moveField(this.draggedIndex, index);
                }
            });

            if (isSection) {
                const secInput = row.createEl('input', {
                    type: 'text',
                    cls: 'infobox-edit-field-section-input',
                    value: val ?? '',
                    attr: {
                        placeholder: 'Section title',
                        'aria-label': 'Section title',
                        draggable: 'false'
                    }
                });
                secInput.addEventListener('dragstart', e => e.stopPropagation());

                secInput.addEventListener('input', e => {
                    this.currentData.fields[index] = { section: e.target.value };
                    this.debouncedSaveFields();
                });
            } else {
                const labelInput = row.createEl('input', {
                    type: 'text',
                    cls: 'infobox-edit-field-label-input',
                    value: key ?? '',
                    attr: {
                        placeholder: 'Label',
                        'aria-label': 'Field label',
                        draggable: 'false'
                    }
                });
                labelInput.addEventListener('dragstart', e => e.stopPropagation());

                const valInput = row.createEl('textarea', {
                    cls: 'infobox-edit-field-val-input',
                    attr: {
                        placeholder: 'Value (supports [[links]], lists, multiline)',
                        'aria-label': 'Field value',
                        draggable: 'false'
                    }
                });
                valInput.value = Array.isArray(val)
                    ? val.map(item => `- ${this.normalizeInlineValue(item)}`).join('\n')
                    : (val ?? '');
                valInput.addEventListener('dragstart', e => e.stopPropagation());

                labelInput.addEventListener('change', e => {
                    const newKey = e.target.value.trim() || 'Label';
                    this.currentData.fields[index] = { [newKey]: valInput.value };
                    this.saveFields().then(() => this.renderFieldsEditor());
                });

                valInput.addEventListener('input', e => {
                    this.currentData.fields[index] = { [labelInput.value]: e.target.value };
                    this.debouncedSaveFields();
                });
            }

            const actionsDiv = row.createDiv({ cls: 'infobox-edit-field-actions' });

            const dupBtn = actionsDiv.createEl('button', {
                text: '⧉',
                cls: 'infobox-edit-duplicate-btn',
                attr: {
                    'aria-label': isSection ? 'Duplicate section' : 'Duplicate field',
                    title: isSection ? 'Duplicate section' : 'Duplicate field',
                    type: 'button'
                }
            });
            dupBtn.addEventListener('click', () => this.duplicateField(index));

            const removeBtn = actionsDiv.createEl('button', {
                text: '✕',
                cls: 'infobox-edit-remove-btn',
                attr: {
                    'aria-label': isSection ? 'Delete section' : 'Delete field',
                    title: isSection ? 'Delete section' : 'Delete field',
                    type: 'button'
                }
            });
            removeBtn.addEventListener('click', () => this.removeField(index));
        });
    }

    renderGalleryEditor(container) {
        container.empty();
        const images = this.currentData.images || [];

        if (images.length === 0) {
            container.createEl('span', {
                text: 'No images added yet.',
                cls: 'infobox-edit-empty-notice'
            });
        }

        images.forEach((entry, index) => {
            const card = container.createDiv({ cls: 'infobox-edit-gallery-item' });

            const header = card.createDiv({ cls: 'infobox-edit-gallery-header' });
            const headerLeft = header.createDiv({ cls: 'infobox-edit-gallery-header-left' });

            // Drag handle (only the handle initiates dragging to prevent text selection in inputs from dragging card)
            const dragHandle = headerLeft.createEl('span', {
                text: '⠿',
                cls: 'infobox-edit-drag-handle',
                attr: {
                    title: 'Drag to reorder image',
                    'aria-label': 'Drag to reorder image'
                }
            });

            dragHandle.addEventListener('mousedown', () => {
                card.setAttribute('draggable', 'true');
            });
            dragHandle.addEventListener('mouseup', () => {
                if (this.draggedImageIndex === null) card.removeAttribute('draggable');
            });
            dragHandle.addEventListener('mouseleave', () => {
                if (this.draggedImageIndex === null) card.removeAttribute('draggable');
            });

            // Drag & drop events on gallery card
            card.addEventListener('dragstart', e => {
                if (e.target.closest('input, textarea, button, select') || !card.hasAttribute('draggable')) {
                    e.preventDefault();
                    return false;
                }
                this.draggedImageIndex = index;
                card.classList.add('is-dragging');
                if (e.dataTransfer) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', String(index));
                }
            });

            card.addEventListener('dragend', () => {
                this.draggedImageIndex = null;
                card.removeAttribute('draggable');
                card.classList.remove('is-dragging');
                container.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
            });

            card.addEventListener('dragover', e => {
                e.preventDefault();
                if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                if (!card.classList.contains('is-dragover')) {
                    card.classList.add('is-dragover');
                }
            });

            card.addEventListener('dragleave', () => {
                card.classList.remove('is-dragover');
            });

            card.addEventListener('drop', e => {
                e.preventDefault();
                card.classList.remove('is-dragover');
                if (this.draggedImageIndex !== null && this.draggedImageIndex !== index) {
                    this.moveImage(this.draggedImageIndex, index, container);
                }
            });

            // Reorder buttons for gallery
            const reorderBtns = headerLeft.createDiv({ cls: 'infobox-edit-reorder-btns' });
            const moveUpBtn = reorderBtns.createEl('button', {
                text: '▲',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move image up',
                    title: 'Move image up',
                    type: 'button'
                }
            });
            if (index === 0) moveUpBtn.disabled = true;
            moveUpBtn.addEventListener('click', () => this.moveImage(index, index - 1, container));

            const moveDownBtn = reorderBtns.createEl('button', {
                text: '▼',
                cls: 'infobox-edit-move-btn',
                attr: {
                    'aria-label': 'Move image down',
                    title: 'Move image down',
                    type: 'button'
                }
            });
            if (index === images.length - 1) moveDownBtn.disabled = true;
            moveDownBtn.addEventListener('click', () => this.moveImage(index, index + 1, container));

            headerLeft.createEl('span', { text: images.length > 1 ? `Image ${index + 1}` : 'Image' });

            const removeBtn = header.createEl('button', {
                text: '✕',
                cls: 'infobox-edit-remove-btn',
                attr: {
                    'aria-label': 'Remove image',
                    title: 'Remove image',
                    type: 'button'
                }
            });
            removeBtn.addEventListener('click', () => {
                this.currentData.images.splice(index, 1);
                this.saveGallery().then(() => this.renderGalleryEditor(container));
            });

            // Tab label
            const labelRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            labelRow.createEl('span', { text: 'Tab label:', cls: 'infobox-edit-label' });
            const labelInput = labelRow.createEl('input', {
                type: 'text',
                value: entry.label || '',
                attr: { placeholder: `Image ${index + 1} (optional)`, 'aria-label': 'Tab label', draggable: 'false' }
            });
            labelInput.addEventListener('dragstart', e => e.stopPropagation());
            labelInput.addEventListener('input', e => {
                entry.label = e.target.value;
                this.debouncedSaveGallery();
            });

            // Image path + browse
            const pathRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            pathRow.createEl('span', { text: 'Source:', cls: 'infobox-edit-label' });
            const pathInput = pathRow.createEl('input', {
                type: 'text',
                value: entry.image || '',
                attr: { placeholder: 'Image file or URL', 'aria-label': 'Image path', draggable: 'false' }
            });
            pathInput.addEventListener('dragstart', e => e.stopPropagation());
            pathInput.addEventListener('input', e => {
                entry.image = e.target.value;
                this.debouncedSaveGallery();
            });

            const browseBtn = pathRow.createEl('button', {
                text: 'Browse',
                attr: { 'aria-label': 'Browse vault images', type: 'button' }
            });
            browseBtn.addEventListener('click', () => {
                new ImageSuggestModal(this.app, chosenPath => {
                    pathInput.value = chosenPath;
                    entry.image = chosenPath;
                    this.debouncedSaveGallery();
                }).open();
            });

            // Caption
            const captionRow = card.createDiv({ cls: 'infobox-edit-gallery-row' });
            captionRow.createEl('span', { text: 'Caption:', cls: 'infobox-edit-label' });
            const captionInput = captionRow.createEl('input', {
                type: 'text',
                value: entry.caption || '',
                attr: { placeholder: 'Image caption', 'aria-label': 'Image caption', draggable: 'false' }
            });
            captionInput.addEventListener('dragstart', e => e.stopPropagation());
            captionInput.addEventListener('input', e => {
                entry.caption = e.target.value;
                this.debouncedSaveGallery();
            });
        });

        const addImgBtn = container.createEl('button', {
            text: '+ Add image',
            attr: { 'aria-label': 'Add image', type: 'button' }
        });
        addImgBtn.addEventListener('click', () => {
            if (!this.currentData.images) this.currentData.images = [];
            this.currentData.images.push({ label: '', image: '', caption: '' });
            this.saveGallery().then(() => this.renderGalleryEditor(container));
        });
    }

    renderTagsEditor(container) {
        container.empty();

        const tagsContainer = container.createDiv({ cls: 'infobox-edit-tags-container' });
        const tags = Array.isArray(this.currentData.tags) ? this.currentData.tags : [];

        if (tags.length === 0) {
            tagsContainer.createEl('span', {
                text: 'No tags added yet.',
                cls: 'infobox-edit-empty-notice'
            });
        } else {
            tags.forEach((tag, idx) => {
                const pill = tagsContainer.createDiv({ cls: 'infobox-edit-tag-pill' });
                pill.setAttribute('draggable', 'true');
                pill.setAttribute('title', 'Drag to reorder tag');

                // Drag & drop events for tag pill
                pill.addEventListener('dragstart', e => {
                    this.draggedTagIndex = idx;
                    pill.classList.add('is-dragging');
                    if (e.dataTransfer) {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', String(idx));
                    }
                });

                pill.addEventListener('dragend', () => {
                    this.draggedTagIndex = null;
                    pill.classList.remove('is-dragging');
                    tagsContainer.querySelectorAll('.is-dragover').forEach(el => el.classList.remove('is-dragover'));
                });

                pill.addEventListener('dragover', e => {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                    if (!pill.classList.contains('is-dragover')) {
                        pill.classList.add('is-dragover');
                    }
                });

                pill.addEventListener('dragleave', () => {
                    pill.classList.remove('is-dragover');
                });

                pill.addEventListener('drop', e => {
                    e.preventDefault();
                    pill.classList.remove('is-dragover');
                    if (this.draggedTagIndex !== null && this.draggedTagIndex !== idx) {
                        this.moveTag(this.draggedTagIndex, idx, container);
                    }
                });

                pill.createEl('span', { text: `#${tag}` });
                const removeBtn = pill.createEl('button', {
                    text: '✕',
                    cls: 'infobox-edit-tag-remove',
                    attr: {
                        'aria-label': `Remove tag ${tag}`,
                        title: `Remove tag ${tag}`,
                        type: 'button'
                    }
                });
                removeBtn.addEventListener('click', e => {
                    e.stopPropagation();
                    this.currentData.tags.splice(idx, 1);
                    this.debouncedSaveTags();
                    this.renderTagsEditor(container);
                });
            });
        }

        // Input row to add new tags
        const inputRow = container.createDiv({ cls: 'infobox-edit-tag-input-row' });
        const tagInput = inputRow.createEl('input', {
            type: 'text',
            attr: {
                placeholder: 'Add tag (press Enter or comma)...',
                'aria-label': 'Add tag'
            }
        });

        const suggestions = inputRow.createEl('datalist');
        suggestions.id = `infobox-tag-suggestions-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        tagInput.setAttribute('list', suggestions.id);
        const knownTags = new Set();
        const collectTags = value => {
            const values = Array.isArray(value) ? value : String(value || '').split(/[\s,]+/);
            values.forEach(value => {
                const tag = String(value).trim().replace(/^#+/, '');
                if (tag && !tags.includes(tag)) knownTags.add(tag);
            });
        };
        for (const file of this.app.vault.getMarkdownFiles()) {
            const cache = this.app.metadataCache.getFileCache(file);
            collectTags(cache?.frontmatter?.tags);
            collectTags(cache?.frontmatter?.infobox?.tags);
            for (const entry of cache?.tags || []) collectTags(entry.tag);
        }
        Array.from(knownTags).sort((a, b) => a.localeCompare(b)).forEach(tag => {
            suggestions.createEl('option', { value: tag });
        });

        const addTag = () => {
            const val = tagInput.value.trim().replace(/^#+/, '').replace(/,+$/, '');
            if (!val) return;
            const newTags = val.split(/[\s,]+/).map(t => t.trim().replace(/^#+/, '')).filter(Boolean);
            if (!this.currentData.tags || !Array.isArray(this.currentData.tags)) {
                this.currentData.tags = [];
            }
            newTags.forEach(t => {
                if (!this.currentData.tags.includes(t)) {
                    this.currentData.tags.push(t);
                }
            });
            tagInput.value = '';
            this.debouncedSaveTags();
            this.renderTagsEditor(container);
        };

        tagInput.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                addTag();
            }
        });

        const addBtn = inputRow.createEl('button', {
            text: '+ Add',
            attr: { 'aria-label': 'Add tag', type: 'button' }
        });
        addBtn.addEventListener('click', addTag);

        // Show tags toggle
        const toggleRow = container.createDiv({ cls: 'infobox-edit-toggle-row' });
        const toggleLabel = toggleRow.createEl('label', {
            cls: 'infobox-edit-toggle-label'
        });
        const checkbox = toggleLabel.createEl('input', { type: 'checkbox' });
        checkbox.checked = this.currentData.showTags !== false;
        toggleLabel.createSpan({ text: 'Show tags in infobox' });

        checkbox.addEventListener('change', () => {
            this.currentData.showTags = checkbox.checked;
            this.debouncedSaveTags();
        });
    }

    onOpen() {
        const { modalEl, contentEl } = this;
        contentEl.empty();

        modalEl.id = 'infobox-edit-modal';

        // Setup auto-pairing and smart markdown paste across all modal inputs & textareas
        modalEl.addEventListener('keydown', this.boundHandleKeyDown);
        modalEl.addEventListener('paste', this.boundHandlePaste);

        // Normalize tags data if needed
        if (this.currentData.tags && !Array.isArray(this.currentData.tags)) {
            if (typeof this.currentData.tags === 'string') {
                this.currentData.tags = this.currentData.tags.split(/[\s,]+/).map(t => t.trim().replace(/^#+/, '')).filter(Boolean);
            } else {
                this.currentData.tags = [];
            }
        }

        // Normalize images data to array
        if (!Array.isArray(this.currentData.images) || this.currentData.images.length === 0) {
            if (this.currentData.image) {
                this.currentData.images = [{
                    label: '',
                    image: this.currentData.image || '',
                    caption: this.currentData.caption || ''
                }];
            } else {
                this.currentData.images = [];
            }
        }

        // Basic Details Section
        const basicSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        const standardFields = ['supertitle', 'title', 'subtitle'];

        standardFields.forEach(key => {
            const row = basicSection.createDiv({ cls: 'infobox-edit-row' });
            const labelText = key.charAt(0).toUpperCase() + key.slice(1);
            row.createEl('label', { text: labelText, cls: 'infobox-edit-label' });

            const inputContainer = row.createDiv({ cls: 'infobox-edit-input-container' });
            const inputEl = inputContainer.createEl('input', {
                type: 'text',
                value: this.currentData[key] || '',
                attr: { 'aria-label': labelText }
            });

            inputEl.addEventListener('input', e => {
                this.currentData[key] = e.target.value;
                this.debouncedSave(key, e.target.value);
            });
        });

        // Tags Section
        const tagsSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        tagsSection.createEl('h3', {
            text: 'Tags',
            cls: 'infobox-edit-section-header'
        });
        const tagsSectionContainer = tagsSection.createDiv();
        this.renderTagsEditor(tagsSectionContainer);

        // Images Section
        const imageSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        imageSection.createEl('h3', {
            text: 'Images',
            cls: 'infobox-edit-section-header'
        });
        const imageSectionContainer = imageSection.createDiv();
        this.renderGalleryEditor(imageSectionContainer);

        // Sections & Labels
        const fieldsSection = contentEl.createDiv({ cls: 'infobox-edit-section' });
        fieldsSection.createEl('h3', {
            text: 'Sections & labels',
            cls: 'infobox-edit-section-header'
        });

        this.fieldsContainer = fieldsSection.createDiv({ cls: 'infobox-edit-fields-container' });
        this.renderFieldsEditor();

        const addButtonsRow = fieldsSection.createDiv({ cls: 'infobox-edit-buttons-row' });

        const addSectionBtn = addButtonsRow.createEl('button', {
            text: '+ Add section',
            attr: { 'aria-label': 'Add section', type: 'button' }
        });
        addSectionBtn.addEventListener('click', () => this.addField({ section: 'New section' }));

        const addLabelBtn = addButtonsRow.createEl('button', {
            text: '+ Add label',
            attr: { 'aria-label': 'Add label', type: 'button' }
        });
        addLabelBtn.addEventListener('click', () => this.addField({ 'New label': 'Value' }));

        const footer = contentEl.createDiv({ cls: 'infobox-edit-footer' });
        const saveStatus = footer.createEl('span', { attr: { role: 'status' } });
        const saveBtn = footer.createEl('button', {
            text: 'Save',
            cls: 'mod-cta',
            attr: { type: 'button', 'aria-label': 'Save infobox' }
        });
        saveBtn.addEventListener('click', async () => {
            saveBtn.disabled = true;
            saveStatus.textContent = 'Saving...';
            for (const save of [this.debouncedSave, this.debouncedSaveFields,
                this.debouncedSaveGallery, this.debouncedSaveTags]) {
                save.cancel?.();
            }
            try {
                await this.saveDetails();
                await this.saveFields();
                await this.saveGallery();
                await this.saveTags();
                this.close();
            } catch (error) {
                console.error('[Infobox] Save failed', error);
                saveStatus.textContent = 'Could not save. Please try again.';
                saveBtn.disabled = false;
            }
        });
    }

    onClose() {
        if (this.modalEl) {
            this.modalEl.removeEventListener('keydown', this.boundHandleKeyDown);
            this.modalEl.removeEventListener('paste', this.boundHandlePaste);
        }
        this.contentEl.empty();
    }
}

class ImageSuggestModal extends FuzzySuggestModal {
    constructor(app, onChoose) {
        super(app);
        this.onChoose = onChoose;
    }

    getItems() {
        const files = this.app.vault.getFiles();
        const imageExtensions = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'webp'];
        return files.filter(file => imageExtensions.includes(file.extension.toLowerCase()));
    }

    getItemText(file) {
        return file.path;
    }

    onChooseItem(file) {
        this.onChoose(file.path);
    }
}

class InfoboxPlugin extends Plugin {
    _pending = null;
    _repairRequests = new WeakMap();

    async onload() {
        const r = () => this.scheduleRefresh();
        this.registerEvent(this.app.workspace.on('layout-change', r));
        this.registerEvent(this.app.workspace.on('active-leaf-change', r));
        this.registerEvent(this.app.metadataCache.on('changed', r));
        this.registerEvent(this.app.workspace.on('css-change', r));
        this.app.workspace.onLayoutReady(r);

        this.addCommand({
            id: 'add-infobox',
            name: 'Add infobox',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;

                if (!checking) {
                    const cache = this.app.metadataCache.getFileCache(file);
                    const hasExisting = cache?.frontmatter?.infobox && typeof cache.frontmatter.infobox === 'object';
                    const currentIb = hasExisting
                        ? JSON.parse(JSON.stringify(cache.frontmatter.infobox))
                        : { title: file.basename, fields: [] };

                    // If no infobox exists yet, write the initial structure to frontmatter
                    if (!hasExisting) {
                        this.app.fileManager.processFrontMatter(file, frontmatter => {
                            frontmatter.infobox = JSON.parse(JSON.stringify(currentIb));
                        });
                    }

                    new InfoboxEditModal(this.app, file, currentIb).open();
                }
                return true;
            }
        });

        this.addCommand({
            id: 'remove-infobox',
            name: 'Remove infobox',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (!file) return false;

                const cache = this.app.metadataCache.getFileCache(file);
                const hasInfobox = cache?.frontmatter?.infobox && typeof cache.frontmatter.infobox === 'object';
                if (!hasInfobox) return false;

                if (!checking) {
                    this.app.fileManager.processFrontMatter(file, frontmatter => {
                        delete frontmatter.infobox;
                    });
                }
                return true;
            }
        });
    }

    onunload() {
        this._repairRequests = new WeakMap();
        if (this._pending != null) cancelAnimationFrame(this._pending);
        document.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        document.querySelectorAll('.has-infobox').forEach(e => e.classList.remove('has-infobox'));
        document.querySelectorAll('.infobox-readable-host').forEach(e => e.classList.remove('infobox-readable-host'));
    }

    scheduleRefresh() {
        if (this._pending != null) cancelAnimationFrame(this._pending);
        this._pending = requestAnimationFrame(() => {
            this._pending = null;
            this.refresh();
        });
    }

    refresh() {
        this.app.workspace.iterateAllLeaves(leaf => {
            try { this.processLeaf(leaf); }
            catch (e) { console.error('[Infobox]', e); }
        });
    }

    getThemeClass() {
        return document.body.classList.contains('theme-dark')
            ? 'infobox-theme-dark'
            : 'infobox-theme-light';
    }

    normalizeTags(value) {
        const tags = [];
        const seen = new Set();

        const addTag = raw => {
            if (raw == null) return;

            if (Array.isArray(raw)) {
                raw.forEach(addTag);
                return;
            }

            if (typeof raw === 'object') {
                addTag(raw.tag ?? raw.name ?? '');
                return;
            }

            const parts = String(raw)
                .split(/[\s,]+/)
                .map(tag => tag.trim().replace(/^#+/, '').replace(/,+$/, ''))
                .filter(Boolean);

            for (const tag of parts) {
                const key = tag.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                tags.push(tag);
            }
        };

        addTag(value);
        return tags;
    }

    getTags(ib, fm, cache) {
        if (ib.showTags === false) return [];
        if (ib.tags != null) return this.normalizeTags(ib.tags);

        const sources = [];

        if (fm.tags != null) sources.push(fm.tags);
        if (Array.isArray(cache?.tags)) {
            sources.push(cache.tags.map(tagCache => tagCache.tag));
        }

        return this.normalizeTags(sources);
    }

    getLinkDisplayText(linkText) {
        const target = String(linkText ?? '').trim();
        const withoutSubpath = target.replace(/[#^].*$/, '');
        const pageName = withoutSubpath.split('/').filter(Boolean).pop();
        return pageName || target;
    }

    normalizeInlineValue(value) {
        if (value == null) return '';

        if (Array.isArray(value)) {
            // Case A: Single item array [ "Target" ] or 2D array [ [ "Target" ] ] from unquoted wikilinks in YAML
            if (value.length === 1) {
                const inner = value[0];
                if (Array.isArray(inner) && inner.length === 1 && inner[0] != null && typeof inner[0] !== 'object') {
                    const text = String(inner[0]).trim();
                    return text.startsWith('[[') && text.endsWith(']]') ? text : `[[${text}]]`;
                }
                if (typeof inner === 'string') {
                    const text = inner.trim();
                    return text.startsWith('[[') && text.endsWith(']]') ? text : `[[${text}]]`;
                }
            }

            // Case B: Array of items, e.g. [ ["Note 1"], ["Note 2"] ] or [ "[[Note 1]]", "[[Note 2]]" ]
            return value.map(item => {
                if (Array.isArray(item) && item.length === 1 && item[0] != null && typeof item[0] !== 'object') {
                    const text = String(item[0]).trim();
                    return text.startsWith('[[') && text.endsWith(']]') ? text : `[[${text}]]`;
                }
                return this.normalizeInlineValue(item);
            }).join(', ');
        }

        return String(value);
    }

    handleTagClick(tag, file) {
        const cleanTag = String(tag || '').replace(/^#+/, '').trim();
        if (!cleanTag) return;

        const searchPlugin = this.app?.internalPlugins?.getPluginById?.('global-search')?.instance
            || this.app?.internalPlugins?.plugins?.['global-search']?.instance;

        if (searchPlugin && typeof searchPlugin.openGlobalSearch === 'function') {
            searchPlugin.openGlobalSearch(`tag:#${cleanTag}`);
        } else if (this.app?.workspace?.openLinkText) {
            this.app.workspace.openLinkText(`#${cleanTag}`, file ? file.path : '');
        }
    }

    renderInlineTextFallback(parent, text, file) {
        // Support wikilinks: [[Target|Display]] or [[Target]] and markdown links: [Display](Target)
        const linkPattern = /!?\[\[([^\]]+)\]\]|\[([^\]]+)\]\(([^)]+)\)/g;
        let lastIndex = 0;
        let match;

        while ((match = linkPattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            let target = '';
            let display = '';

            if (match[1]) {
                const rawLink = match[1].trim();
                const pipeIndex = rawLink.indexOf('|');
                target = (pipeIndex >= 0 ? rawLink.slice(0, pipeIndex) : rawLink).trim();
                display = (pipeIndex >= 0 ? rawLink.slice(pipeIndex + 1) : this.getLinkDisplayText(target)).trim();
            } else if (match[2] && match[3]) {
                display = match[2].trim();
                target = match[3].trim().replace(/^<|>$/g, '');
            }

            if (target) {
                const cleanTarget = target.includes('%') ? decodeURI(target) : target;
                const link = parent.createEl('a', {
                    cls: 'internal-link infobox-link',
                    text: display || target,
                    attr: {
                        href: target,
                        'data-href': target
                    }
                });
                link.addEventListener('click', event => {
                    if (event && typeof event.preventDefault === 'function') {
                        event.preventDefault();
                    }
                    const isMod = Keymap && typeof Keymap.isModEvent === 'function'
                        ? Keymap.isModEvent(event)
                        : Boolean(event && (event.ctrlKey || event.metaKey));
                    this.app.workspace.openLinkText(cleanTarget, file ? file.path : '', isMod);
                });
            } else {
                parent.appendChild(document.createTextNode(match[0]));
            }

            lastIndex = linkPattern.lastIndex;
        }

        if (lastIndex < text.length) {
            parent.appendChild(document.createTextNode(text.slice(lastIndex)));
        }
    }

    renderInlineText(parent, value, file, component) {
        const text = this.normalizeInlineValue(value);
        const sourcePath = file ? file.path : '';
        const comp = component || this;

        if (typeof MarkdownRenderer !== 'undefined' && (MarkdownRenderer.render || MarkdownRenderer.renderMarkdown)) {
            const temp = createDiv();
            const renderPromise = typeof MarkdownRenderer.render === 'function'
                ? MarkdownRenderer.render(this.app, text, temp, sourcePath, comp)
                : MarkdownRenderer.renderMarkdown(text, temp, sourcePath, comp);

            const handleRendered = () => {
                temp.querySelectorAll('a').forEach(a => {
                    a.classList.add('infobox-link');
                });
                if (temp.childNodes.length === 1 && temp.firstChild.nodeName === 'P') {
                    const p = temp.firstChild;
                    while (p.firstChild) {
                        parent.appendChild(p.firstChild);
                    }
                } else {
                    while (temp.firstChild) {
                        parent.appendChild(temp.firstChild);
                    }
                }
            };

            if (renderPromise && typeof renderPromise.then === 'function') {
                renderPromise.then(handleRendered);
            } else {
                handleRendered();
            }
            return;
        }

        this.renderInlineTextFallback(parent, text, file);
    }

    createTextDiv(parent, cls, value, file, component) {
        return this.createTextEl(parent, 'div', cls, value, file, component);
    }

    createTextEl(parent, tag, cls, value, file, component) {
        const el = parent.createEl(tag, { cls });
        this.renderInlineText(el, value, file, component);
        return el;
    }

    renderFieldValue(parent, value, file, component) {
        const container = parent.createDiv({ cls: 'infobox-value' });
        const items = extractListItems(value, val => this.normalizeInlineValue(val));

        if (items.length > 1) {
            const ul = container.createEl('ul', { cls: 'infobox-list' });
            items.forEach(item => {
                const li = ul.createEl('li');
                this.renderInlineText(li, item, file, component);
            });
        } else {
            this.renderInlineText(container, items[0] || '', file, component);
        }
    }

    processLeaf(leaf) {
        const view = leaf.view;
        if (!view || view.getViewType() !== 'markdown') return;

        const ct = view.containerEl;
        if (!ct) return;
        const request = {};
        this._repairRequests.set(ct, request);

        // Always clean up first
        ct.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        ct.classList.remove('has-infobox');
        ct.querySelectorAll('.infobox-readable-host').forEach(e => e.classList.remove('infobox-readable-host'));

        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm?.infobox || typeof fm.infobox !== 'object') {
            if (!fm && this.app.vault?.cachedRead) {
                this.showFrontmatterRepair(view, file, request).catch(error => {
                    console.error('[Infobox] Could not inspect frontmatter', error);
                });
            }
            return;
        }

        const ib = fm.infobox;
        const tags = this.getTags(ib, fm, cache);

        // ── Build panel ──────────────────────────────────────────
        const panel = createDiv({ cls: 'infobox-panel' });
        const card = panel.createDiv({ cls: 'infobox' });
        const themeClass = this.getThemeClass();
        panel.addClass(themeClass);
        card.addClass(themeClass);

        // ── Attach panel interactions for internal links & tags ─────
        panel.addEventListener('click', event => {
            if (event.defaultPrevented) return;
            const link = event.target?.closest ? event.target.closest('a') : null;
            if (!link) return;

            // Tags
            if (link.classList?.contains('tag') || link.classList?.contains('infobox-tag')) {
                event.preventDefault();
                event.stopPropagation();
                const tag = link.getAttribute('data-tag') || (link.textContent || link.text || '').replace(/^#/, '').trim();
                if (tag) {
                    this.handleTagClick(tag, file);
                }
                return;
            }

            // In-app internal links
            const isInternal = link.classList?.contains('internal-link') ||
                link.classList?.contains('infobox-link') ||
                link.hasAttribute('data-href');
            const rawHref = link.getAttribute('data-href') || link.getAttribute('href');

            if (isInternal && rawHref && !link.classList?.contains('external-link') && !/^(https?|mailto|obsidian):/i.test(rawHref)) {
                event.preventDefault();
                event.stopPropagation();
                const isMod = Keymap && typeof Keymap.isModEvent === 'function'
                    ? Keymap.isModEvent(event)
                    : Boolean(event && (event.ctrlKey || event.metaKey));
                const href = rawHref.includes('%') ? decodeURI(rawHref) : rawHref;
                this.app.workspace.openLinkText(href, file.path, isMod);
            }
        });

        panel.addEventListener('auxclick', event => {
            if (event.button !== 1 || event.defaultPrevented) return;
            const link = event.target?.closest ? event.target.closest('a') : null;
            if (!link) return;

            const isInternal = link.classList?.contains('internal-link') ||
                link.classList?.contains('infobox-link') ||
                link.hasAttribute('data-href');
            const rawHref = link.getAttribute('data-href') || link.getAttribute('href');

            if (isInternal && rawHref && !link.classList?.contains('external-link') && !/^(https?|mailto|obsidian):/i.test(rawHref)) {
                event.preventDefault();
                event.stopPropagation();
                const href = rawHref.includes('%') ? decodeURI(rawHref) : rawHref;
                this.app.workspace.openLinkText(href, file.path, 'tab');
            }
        });

        panel.addEventListener('mouseover', event => {
            const link = event.target?.closest ? event.target.closest('a') : null;
            if (!link) return;

            const isInternal = link.classList?.contains('internal-link') ||
                link.classList?.contains('infobox-link') ||
                link.hasAttribute('data-href');
            const rawHref = link.getAttribute('data-href') || link.getAttribute('href');

            if (isInternal && rawHref && !link.classList?.contains('external-link') && !/^(https?|mailto|obsidian):/i.test(rawHref)) {
                const href = rawHref.includes('%') ? decodeURI(rawHref) : rawHref;
                this.app.workspace.trigger('hover-link', {
                    event,
                    source: 'infobox',
                    hoverParent: view,
                    targetEl: link,
                    linktext: href,
                    sourcePath: file.path
                });
            }
        });

        panel.addEventListener('contextmenu', event => {
            const link = event.target?.closest ? event.target.closest('a') : null;
            if (!link) return;

            const isInternal = link.classList?.contains('internal-link') ||
                link.classList?.contains('infobox-link') ||
                link.hasAttribute('data-href');
            const rawHref = link.getAttribute('data-href') || link.getAttribute('href');

            if (isInternal && rawHref && !link.classList?.contains('external-link') && !/^(https?|mailto|obsidian):/i.test(rawHref)) {
                if (typeof obsidian.Menu === 'function') {
                    event.preventDefault();
                    event.stopPropagation();
                    const href = rawHref.includes('%') ? decodeURI(rawHref) : rawHref;
                    const menu = new obsidian.Menu();
                    menu.addItem(item => {
                        item.setTitle('Open in new tab')
                            .setIcon('file-plus')
                            .onClick(() => {
                                this.app.workspace.openLinkText(href, file.path, 'tab');
                            });
                    });
                    menu.addItem(item => {
                        item.setTitle('Open to the right')
                            .setIcon('separator-vertical')
                            .onClick(() => {
                                this.app.workspace.openLinkText(href, file.path, 'split');
                            });
                    });
                    menu.addItem(item => {
                        item.setTitle('Open in new window')
                            .setIcon('scan')
                            .onClick(() => {
                                this.app.workspace.openLinkText(href, file.path, 'window');
                            });
                    });
                    menu.showAtMouseEvent(event);
                }
            }
        });

        // Supertitle
        if (ib.supertitle) {
            this.createTextDiv(card, 'infobox-supertitle', ib.supertitle, file, view);
        }

        // Title
        if (ib.title) {
            this.createTextDiv(card, 'infobox-title', ib.title, file, view);
        }

        // Subtitle
        if (ib.subtitle) {
            this.createTextDiv(card, 'infobox-subtitle', ib.subtitle, file, view);
        }

        // Image / image gallery
        const images = Array.isArray(ib.images) && ib.images.length > 0
            ? ib.images.filter(e => e && e.image)
            : ib.image
                ? [{
                    label: '',
                    image: ib.image,
                    caption: ib.caption || ''
                }]
                : [];

        if (images.length > 0) {
            const gallery = card.createDiv({ cls: 'infobox-gallery' });

            let tabs = null;

            if (images.length > 1) {
                tabs = gallery.createDiv({ cls: 'infobox-image-tabs' });
            }

            const wrap = gallery.createDiv({ cls: 'infobox-image' });
            const img = wrap.createEl('img');

            const caption = gallery.createDiv({
                cls: 'infobox-caption infobox-gallery-caption'
            });

            const resolveImage = imageValue => {
                if (!imageValue) return '';

                let src = String(imageValue).trim();

                src = src
                    .replace(/^!?\[\[(.+?)(\|.*)?\]\]$/, '$1')
                    .trim();

                if (src.startsWith('http')) {
                    return src;
                }

                const resolved =
                    this.app.metadataCache.getFirstLinkpathDest(
                        src,
                        file.path
                    );

                return resolved
                    ? this.app.vault.getResourcePath(resolved)
                    : '';
            };

            const showImage = (entry, index) => {
                const src = resolveImage(entry.image);

                if (src) {
                    img.src = src;
                } else {
                    img.removeAttribute('src');
                }

                img.alt = String(
                    entry.caption ||
                    entry.label ||
                    ib.title ||
                    ''
                );

                caption.empty();

                if (entry.caption) {
                    this.renderInlineText(
                        caption,
                        entry.caption,
                        file,
                        view
                    );
                }
                caption.classList.toggle('is-hidden', !entry.caption);

                if (tabs) {
                    const tabElements =
                        tabs.querySelectorAll('.infobox-image-tab');

                    tabElements.forEach((tab, tabIndex) => {
                        tab.classList.toggle(
                            'is-active',
                            tabIndex === index
                        );
                    });
                }
            };

            if (tabs) {
                images.forEach((entry, index) => {
                    const tab = tabs.createEl('button', {
                        cls: 'infobox-image-tab',
                        text: entry.label || `Image ${index + 1}`,
                        attr: {
                            type: 'button',
                            'aria-label': entry.label || `Image ${index + 1}`
                        }
                    });

                    tab.addEventListener('click', event => {
                        event.preventDefault();
                        event.stopPropagation();

                        showImage(entry, index);
                    });
                });
            }

            showImage(images[0], 0);
        }

        // Tags
        if (tags.length > 0) {
            const tagList = card.createDiv({ cls: 'infobox-tags' });
            for (const tag of tags) {
                const displayTag = `#${tag}`;
                const tagEl = tagList.createEl('a', {
                    cls: 'infobox-tag tag',
                    text: displayTag,
                    attr: { href: displayTag }
                });
                tagEl.setAttr('data-tag', tag);
                tagEl.addEventListener('click', event => {
                    event.preventDefault();
                    this.handleTagClick(tag, file);
                });
            }
        }

        // Fields (array of single-key objects)
        if (Array.isArray(ib.fields)) {
            for (const item of ib.fields) {
                if (!item || typeof item !== 'object') continue;
                const key = Object.keys(item)[0];
                if (!key) continue;
                const val = item[key];

                if (key.toLowerCase() === 'section') {
                    this.createTextDiv(card, 'infobox-section', val, file, view);
                } else {
                    const row = card.createDiv({ cls: 'infobox-row' });
                    this.createTextEl(row, 'span', 'infobox-label', key, file, view);
                    this.renderFieldValue(row, val, file, view);
                }
            }
        }

        // Edit button
        const editBtn = panel.createEl('button', {
            cls: 'infobox-edit-button',
            attr: {
                'aria-label': 'Edit infobox',
                title: 'Edit infobox',
                type: 'button'
            }
        });
        obsidian.setIcon?.(editBtn, 'pencil');
        editBtn.addEventListener('click', () => {
            new InfoboxEditModal(this.app, file, JSON.parse(JSON.stringify(ib))).open();
        });

        // Both sizers may exist; the inactive mode's DOM is hidden.
        const mode = view.getMode?.();
        const contentSizer = ct.querySelector(mode === 'preview'
            ? '.markdown-preview-sizer'
            : mode === 'source' ? '.cm-sizer' : '.markdown-preview-sizer, .cm-sizer');
        const readableContainer = contentSizer?.closest('.is-readable-line-width') ||
            ct.closest('.is-readable-line-width') ||
            view.contentEl?.closest('.is-readable-line-width');
        if (contentSizer && readableContainer) {
            contentSizer.classList.add('infobox-readable-host');
            panel.classList.add('infobox-panel-readable');
            contentSizer.appendChild(panel);
        } else {
            ct.appendChild(panel);
        }
        ct.classList.add('has-infobox');
    }
    async showFrontmatterRepair(view, file, request) {
        const source = await this.app.vault.cachedRead(file);
        if (!repairWikilinkFrontmatter(source)) return;
        const ct = view.containerEl;
        if (view.file !== file || this._repairRequests.get(ct) !== request) return;
        const panel = ct.createDiv({ cls: 'infobox-panel infobox-repair' });
        ct.classList.add('has-infobox');
        panel.createEl('p', {
            text: 'This infobox contains unquoted wikilink values that are invalid YAML.'
        });
        const button = panel.createEl('button', { text: 'Add YAML quotes', attr: { type: 'button' } });
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                await this.app.vault.process(file, latest => repairWikilinkFrontmatter(latest) || latest);
                this.scheduleRefresh();
            } catch (error) {
                button.disabled = false;
                console.error('[Infobox] Could not repair frontmatter', error);
                new obsidian.Notice('Could not repair infobox YAML. Please quote the wikilink values manually.');
            }
        });
    }
}

module.exports = InfoboxPlugin;
