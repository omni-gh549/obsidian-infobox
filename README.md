# Obsidian Infobox

An Obsidian plugin that renders Wikipedia-style infoboxes from YAML frontmatter, including a floating panel pinned to the top-right of the reading pane.

## Features

- Frontmatter-driven: no special syntax in note body required
- Supports title, subtitle, image, caption, tags, and key-value fields
- Named section dividers within the field list
- Resolves local vault images (wikilink or plain filename)
- Automatic light/dark theme support
- Works on desktop and mobile

## Installation

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Copy them into `.obsidian/plugins/infobox/` inside your vault
3. Enable the plugin in **Settings → Community Plugins**

### Community Plugins

Search for **Infobox** in the Obsidian community plugin browser.

## Usage

Add an `infobox:` block to your note's YAML frontmatter:

```yaml
---
infobox:
  title: Albert Einstein
  subtitle: Theoretical Physicist
  image: einstein.jpg
  caption: Photograph from 1921
  tags: [science, physics]
  fields:
    - section: Personal
    - Born: March 14, 1879
    - Died: April 18, 1955
    - Nationality: German / American
    - section: Career
    - Field: Theoretical physics
    - Known for: General relativity, Special relativity
    - Awards: Nobel Prize in Physics (1921)
---
```

### Frontmatter fields

| Key | Type | Description |
|---|---|---|
| `title` | string | Bold heading at the top of the card |
| `subtitle` | string | Italic line below the title |
| `image` | string | Filename or URL. Supports `[[wikilinks]]` and `![[wikilinks]]` |
| `caption` | string | Small italic text below the image |
| `tags` | list/string | Optional tags to show in the infobox. Falls back to the note's frontmatter and inline tags |
| `showTags` | boolean | Set to `false` to hide tags for a note |
| `fields` | list | Array of single-key objects (see below) |

### Fields list

Each item in `fields` is a single-key YAML object:

- **Regular row**: any key/value pair renders as a label + value row
- **Section header**: use the key `section` to insert a divider with a category label

```yaml
fields:
  - section: Category Name   # renders as a section divider
  - Label: Value             # renders as a data row
```

### Images

Images can be specified as:
- A plain filename: `image: einstein.jpg` (resolved via vault)
- A wikilink: `image: "[[einstein.jpg]]"` or `image: "![[einstein.jpg]]"`
- A remote URL: `image: https://example.com/photo.jpg`

## Contributing

Issues and pull requests are welcome.

## License

MIT see [LICENSE](LICENSE)
