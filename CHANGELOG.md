# Changelog

## 0.5.0

- Built on go-slides v0.14.0 (it was v0.9.0). The preview shows what the engine now draws correctly: `![bg right:N%]` on the right, gaia's inline `code` no longer broken inside its word, percentage padding and margins (`padding-left: 60%`), and a fixed-height block keeping its top margin. `# <!-- fit -->` headings are fitted natively, without JavaScript.
- Exports through the `slides` command (*go-slides: Export Slide Deck...*) now give an **accessible PDF**: with `slides` v0.12.0 or later, a vector PDF is tagged for screen readers and declares PDF/UA-1, with the deck's `title` and `lang` and a section per slide. `slides --pdf-tags=false` writes the untagged file. Since v0.11.0 theme fonts are fetched on demand, and since v0.14.0 `slides --allowed-host` lets its server answer to a reverse proxy's name. Run *go-slides: Install the slides Command* again to update the command.
- The extension itself calls no API that changed: the `export` package now takes a `doc.Doc`, but the extension exports by running the command, and its preview uses `deck`, `editor`, `project`, `vfs` and `viewer`, which build and pass their tests unchanged.

## 0.4.0

- Built on go-slides v0.9.0. In the preview, hovering or focusing a code callout's number shows its note, and a note its number, with a style sheet and no script (Quarto's code annotations do it with one). A number can take the keyboard's focus and is described by its note.
- *go-slides: Open Overview* and *go-slides: Start Presenter View*. The overview shows every slide in a grid; choosing one shows its source in the editor. The presenter view opens the slides and the speaker's view (the slide and the next step, the speaker's notes, a timer) in panels beside the editor. The panels of a deck follow one another, follow the deck as it is edited, and the `p` key in the slides opens the presenter view. The slides panel can be moved to the other screen with *View: Move Editor into New Window*.
- The panels run go-slides' viewer pages under a stricter policy than the preview: each panel is a page that holds the deck in a sandboxed frame without `allow-same-origin` (an opaque origin, no access to VS Code's webview API), loading only images, media, styles and fonts, and running only the scripts go-slides built into the page, named by hash. A script a deck wrote with `goSlides.html` on does not run. The extension host passes between the panels the slide and the step, and nothing else.
- Ready for the Marketplace and Open VSX: an icon, a gallery banner, categories (Visualization, Education, Other), keywords, a README written for the listing, and a `publish.yml` workflow that publishes on a release when the `VSCE_PAT` and `OVSX_PAT` secrets exist and otherwise says it did not. CI checks the package on every change (`vsce ls`, `vsce package`, and `go run ./cmd/build verify-vsix`: the listing's metadata, the icon, what must not travel in the `.vsix`).

## 0.3.0

- Built on go-slides v0.8.0.
- The preview re-renders only the slides an edit changed. On a 100-slide deck, the preview after an edit takes 19 ms, against 23–24 ms for Marp for VS Code (#7).
- The preview shows what go-slides v0.8.0 adds:
  - line numbers on code blocks (```` ```go {lineNumbers} ```` or the `lineNumbers` directive);
  - code callouts (`// <1>` at a line's end, then a numbered list after the block).

## 0.2.2

- Built on go-slides v0.7.1. The preview after an edit takes 24 ms on a 100-slide deck at Go's default GOGC, level with Marp for VS Code's 23 ms; it took 44 ms with go-slides v0.7.0 at the default and 35 ms with the GOGC=400 override that 0.2.1 set. The first preview takes 52 ms, against Marp's 78 ms. The override is gone: the default now meets the target with a smaller heap.

## 0.2.1

- Built on go-slides v0.7.0. The preview after an edit is faster: 35 ms instead of 61 ms on a 100-slide deck, because go-regexp/engine v0.3.2 allocates far less while highlighting code. The first preview takes 68 ms instead of 93 ms.

## 0.2.0

- Scroll sync between the editor and the preview, both ways, slide by slide and block by block, as VS Code's Markdown preview and Marp for VS Code do it. Lines are traced through templates: a slide a `{{ range }}` generates follows its template's line, an `{{ include }}` its include line. (go-slides after v0.6.0.)

## 0.1.0

- Preview go-slides decks (`slides: true`) and Marp decks (`marp: true`, unless Marp for VS Code is installed) in VS Code's Markdown preview, rendered by go-slides compiled to WebAssembly: no binary, works on vscode.dev.
- Go templates, slide kinds (front matter, kinds files, `slides.yaml`/`slides.hcl`) and HCL front matter, read from the workspace.
- Problems panel: template, YAML and HCL errors on their lines.
- Completion and hover for directives, `kind`/`_kind`, themes, size presets and template functions.
- Export to HTML, PDF, PPTX, ODP, PNG and JPEG through the installed `slides` command (trusted workspaces).
