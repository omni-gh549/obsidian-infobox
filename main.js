'use strict';

const { Plugin } = require('obsidian');

/*
 * Infobox plugin — reads structured data from YAML frontmatter and renders
 * a Wikipedia-style panel pinned to the right side of the reading pane.
 *
 * Usage — add an `infobox:` block to your note's frontmatter:
 *
 *   ---
 *   infobox:
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

class InfoboxPlugin extends Plugin {
    _pending = null;

    async onload() {
        const r = () => this.scheduleRefresh();
        this.registerEvent(this.app.workspace.on('layout-change', r));
        this.registerEvent(this.app.workspace.on('active-leaf-change', r));
        this.registerEvent(this.app.metadataCache.on('changed', r));
        this.registerEvent(this.app.workspace.on('css-change', r));
        this.app.workspace.onLayoutReady(r);
    }

    onunload() {
        if (this._pending != null) cancelAnimationFrame(this._pending);
        document.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        document.querySelectorAll('.has-infobox').forEach(e => e.classList.remove('has-infobox'));
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

    renderInlineText(parent, value, file) {
        const text = String(value ?? '');
        const linkPattern = /!?\[\[([^\]]+)\]\]/g;
        let lastIndex = 0;
        let match;

        while ((match = linkPattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
            }

            const rawLink = match[1].trim();
            const pipeIndex = rawLink.indexOf('|');
            const target = (pipeIndex >= 0 ? rawLink.slice(0, pipeIndex) : rawLink).trim();
            const display = (pipeIndex >= 0 ? rawLink.slice(pipeIndex + 1) : this.getLinkDisplayText(target)).trim();

            if (target) {
                const link = parent.createEl('a', {
                    cls: 'internal-link infobox-link',
                    text: display || target,
                    attr: {
                        href: target,
                        'data-href': target
                    }
                });
                link.addEventListener('click', event => {
                    event.preventDefault();
                    this.app.workspace.openLinkText(target, file.path);
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

    createTextDiv(parent, cls, value, file) {
        return this.createTextEl(parent, 'div', cls, value, file);
    }

    createTextEl(parent, tag, cls, value, file) {
        const el = parent.createEl(tag, { cls });
        this.renderInlineText(el, value, file);
        return el;
    }

    processLeaf(leaf) {
        const view = leaf.view;
        if (!view || view.getViewType() !== 'markdown') return;

        const ct = view.containerEl;
        if (!ct) return;

        // Always clean up first
        ct.querySelectorAll('.infobox-panel').forEach(e => e.remove());
        ct.classList.remove('has-infobox');

        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        const fm = cache?.frontmatter;
        if (!fm?.infobox || typeof fm.infobox !== 'object') return;

        const ib = fm.infobox;
        const tags = this.getTags(ib, fm, cache);

        // ── Build panel ──────────────────────────────────────────
        const panel = createDiv({ cls: 'infobox-panel' });
        const card  = panel.createDiv({ cls: 'infobox' });
        const themeClass = this.getThemeClass();
        panel.addClass(themeClass);
        card.addClass(themeClass);

        // Title
        if (ib.title) {
            this.createTextDiv(card, 'infobox-title', ib.title, file);
        }

        // Subtitle
        if (ib.subtitle) {
            this.createTextDiv(card, 'infobox-subtitle', ib.subtitle, file);
        }

        // Image
        if (ib.image) {
            const wrap = card.createDiv({ cls: 'infobox-image' });
            const img  = wrap.createEl('img');
            // Strip ![[...]] or [[...]] wikilink syntax if present
            let src = String(ib.image).trim();
            src = src.replace(/^!?\[\[(.+?)(\|.*)?\]\]$/, '$1').trim();
            if (src.startsWith('http')) {
                img.src = src;
            } else {
                const resolved = this.app.metadataCache.getFirstLinkpathDest(src, file.path);
                if (resolved) img.src = this.app.vault.getResourcePath(resolved);
            }
            img.alt = String(ib.caption || ib.title || '');
        }

        // Caption
        if (ib.caption) {
            this.createTextDiv(card, 'infobox-caption', ib.caption, file);
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
                    this.app.workspace.openLinkText(displayTag, file.path);
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
                    this.createTextDiv(card, 'infobox-section', val, file);
                } else {
                    const row = card.createDiv({ cls: 'infobox-row' });
                    this.createTextEl(row, 'span', 'infobox-label', key, file);
                    this.createTextEl(row, 'span', 'infobox-value', val ?? '', file);
                }
            }
        }

        ct.appendChild(panel);
        ct.classList.add('has-infobox');
    }
}

module.exports = InfoboxPlugin;
