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

        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
        if (!fm?.infobox || typeof fm.infobox !== 'object') return;

        const ib = fm.infobox;

        // ── Build panel ──────────────────────────────────────────
        const panel = createDiv({ cls: 'infobox-panel' });
        const card  = panel.createDiv({ cls: 'infobox' });
        const themeClass = this.getThemeClass();
        panel.addClass(themeClass);
        card.addClass(themeClass);

        // Title
        if (ib.title) {
            card.createDiv({ cls: 'infobox-title', text: String(ib.title) });
        }

        // Subtitle
        if (ib.subtitle) {
            card.createDiv({ cls: 'infobox-subtitle', text: String(ib.subtitle) });
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
            card.createDiv({ cls: 'infobox-caption', text: String(ib.caption) });
        }

        // Fields (array of single-key objects)
        if (Array.isArray(ib.fields)) {
            for (const item of ib.fields) {
                if (!item || typeof item !== 'object') continue;
                const key = Object.keys(item)[0];
                if (!key) continue;
                const val = item[key];

                if (key.toLowerCase() === 'section') {
                    card.createDiv({ cls: 'infobox-section', text: String(val) });
                } else {
                    const row = card.createDiv({ cls: 'infobox-row' });
                    row.createEl('span', { cls: 'infobox-label', text: key });
                    row.createEl('span', { cls: 'infobox-value', text: String(val ?? '') });
                }
            }
        }

        ct.appendChild(panel);
        ct.classList.add('has-infobox');
    }
}

module.exports = InfoboxPlugin;
