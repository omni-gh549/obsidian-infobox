# Omni Infobox

An Obsidian plugin that renders Wikipedia-style infoboxes from YAML frontmatter, featuring an interactive visual editor and a floating panel pinned to the top-right of the reading and editing panes.

## Features

- Frontmatter-driven: no special syntax in note body required
- In-note visual editor for updating fields, tags, and images without writing raw YAML
- Supports supertitle, title, subtitle, images, captions, tags, and key-value fields
- Single images or multi-image tabbed galleries with custom tab labels and captions
- Drag-and-drop reordering for fields, sections, and tags
- Smart list formatting: YAML arrays, multiline bullets, pipes (`|`), and commas (`,`) automatically render as bulleted lists
- Supports internal wikilinks with aliases throughout titles, captions, and fields
- Tag integration with add, remove, reorder, and toggle visibility
- Automatic light/dark theme support
- Works on desktop and mobile

## Installation

### Manual

1. Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](../../releases/latest)
2. Copy them into `.obsidian/plugins/omni-infobox/` inside your vault
3. Enable the plugin in **Settings → Community Plugins**

### Community Plugins

Search for **Omni Infobox** in the Obsidian community plugin browser.

## Usage

### Command Palette

Open the Command Palette (`Ctrl/Cmd + P`) to access:

- **Omni Infobox: Add/Edit Infobox** — initializes an infobox on the current note, or opens the editor if one already exists
- **Omni Infobox: Remove Infobox** — removes the `infobox` block from frontmatter entirely (only available when the note has an infobox)

### Visual editor

Every rendered infobox includes an **Edit** button at the bottom of the panel. Clicking it opens a modal where you can:

- Edit the supertitle, title, and subtitle
- Add, remove, and drag-and-drop reorder tags
- Manage images, browse vault image files, and edit tab labels and captions
- Add section dividers and data fields with multiline text support
- Drag-and-drop or use arrow buttons to reorder fields and sections

Changes save back to the note's YAML frontmatter automatically.

### YAML frontmatter

Add an `infobox:` block to your note's YAML frontmatter:

```yaml
---
infobox:
  supertitle: Historical Figure
  title: Albert Einstein
  subtitle: Theoretical Physicist
  images:
    - label: Portrait
      image: einstein.jpg
      caption: Photograph from [[1921]]
    - label: Lecture
      image: "[[einstein-lecture.jpg]]"
      caption: Einstein giving a lecture
  tags: [science, physics]
  showTags: true
  fields:
    - section: Personal
    - Born: March 14, 1879
    - Died: April 18, 1955
    - Nationality: [[Germany|German]] / [[United States|American]]
    - section: Career
    - Field: Theoretical physics
    - Known for: General relativity | Special relativity | Photoelectric effect
    - Awards: Nobel Prize in Physics (1921)
---
```

### Frontmatter fields

| Key | Type | Description |
|---|---|---|
| `supertitle` | string | Optional italicized header rendered above the main title |
| `title` | string | Bold heading at the top of the card |
| `subtitle` | string | Italic line below the title |
| `image` | string | A single filename or URL. Supports `[[wikilinks]]` and `![[wikilinks]]` |
| `caption` | string | Small italic text below a single `image` |
| `images` | list | Image gallery entries, each with `image` and optional `label` and `caption` |
| `tags` | list/string | Optional tags to show in the infobox. Falls back to the note's frontmatter and inline tags |
| `showTags` | boolean | Set to `false` to hide tags for a note |
| `fields` | list | Array of single-key objects (see below) |

Text values in `title`, `subtitle`, `caption`, section headers, field labels, and field values can include internal links such as `[[Mondstadt]]` or `[[Knights of Favonius|the Knights]]`. Quote values that begin with a wikilink, especially when text follows it:

```yaml
  - Ancestors: "[[Marlow Sonners]] (maternal great-grandmother, deceased)"
```

An unquoted `[[link]]` is interpreted as a YAML array, and adding text after it makes the YAML invalid. For this specific error, the plugin offers **Add YAML quotes** in place of the infobox. This repairs the values only when the resulting frontmatter parses successfully; it preserves the note body. Other YAML errors must be corrected manually.

### Fields list

Each item in `fields` is a single-key YAML object:

- **Regular row**: any key/value pair renders as a label + value row
- **Section header**: use the key `section` to insert a divider with a category label

```yaml
fields:
  - section: Category Name   # renders as a section divider
  - Label: Value             # renders as a data row
```

Field values containing multiple items are automatically rendered as a bulleted list:

- YAML lists: `Known for: [General relativity, Special relativity]`
- Multiline strings with `- ` bullets
- Pipe-separated: `Known for: General relativity | Special relativity`
- Comma-separated: `Known for: General relativity, Special relativity`

Delimiters inside wikilinks (such as alias pipes or commas) are preserved and will not split the link.

For titled groups of lists inside one field, use Markdown headings and bullets in a YAML block scalar. These can also be entered directly in the visual editor's value box:

```yaml
fields:
  - Aliases: |
      #### Codenames
      - Black King
      - Iron God

      #### Nicknames
      - Armored Avenger
      - [[Golden Boy]]
```

Each heading becomes a compact divider within the value column, with its list underneath. Inside a block scalar, wikilinks do not need YAML quotes.

### Images

Images can be specified as:
- A plain filename: `image: einstein.jpg` (resolved via vault)
- A wikilink: `image: "[[einstein.jpg]]"` or `image: "![[einstein.jpg]]"`
- A remote URL: `image: https://example.com/photo.jpg`

For a gallery, use `images` instead of `image`. With more than one entry, the infobox shows image tabs:

```yaml
images:
  - label: Portrait
    image: "[[einstein.jpg]]"
    caption: Photograph from 1921
  - label: Lecture
    image: "[[einstein-lecture.jpg]]"
    caption: Einstein giving a lecture
```

## Contributing

Issues and pull requests are welcome.

## License

MIT see [LICENSE](LICENSE)
