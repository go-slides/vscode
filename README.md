# go-slides for VS Code

Preview, present, check, complete and export [go-slides](https://github.com/go-slides/slides) decks in VS Code — Marp Markdown plus Go templates, slide kinds and HCL front matter — the way [Marp for VS Code](https://github.com/marp-team/marp-vscode) does for Marp, without Chrome.

- **Preview** in VS Code's own Markdown preview, rendered by go-slides compiled to WebAssembly: nothing to install, and it works on [vscode.dev](https://vscode.dev) too.
- **Overview and presenter view** (v0.4.0): *go-slides: Open Overview* shows every slide in a grid, *go-slides: Start Presenter View* opens the slides and the speaker's view (the next step, your notes, a timer) in panels that follow one another. Move the slides panel to the other screen and present, without leaving VS Code.
- **Scroll sync**: scrolling the editor scrolls the preview to the slide and block under it, and the other way round, through templates too.
- **Templates and kinds**: `{{ .data }}`, `{{ page }}/{{ total }}`, `include`; `kind:`/`_kind:` from the built-ins, the front matter, kinds files and `slides.yaml`/`slides.hcl`; `---hcl` front matter. The files a deck uses are read from the workspace.
- **Problems panel**: template, YAML and HCL errors on their line, in the deck or in the kinds file they come from.
- **Completion and hover**: directives (spot `_` ones in comments), `kind` values with what they set, themes, size presets, `paginate`, template functions and data fields.
- **Export** to HTML, vector PDF, editable PPTX and ODP, PNG and JPEG with the `slides` command (*go-slides: Export Slide Deck...*). The PDF is **accessible** (v0.5.0, `slides` v0.12.0 or later): tagged for screen readers, PDF/UA-1, with the deck's title and language.

Documentation: [go-slides.github.io/docs/latest/vscode](https://go-slides.github.io/docs/latest/vscode/).

## Which documents

A Markdown file whose front matter says `slides: true`:

```markdown
---
slides: true
paginate: true
---

# Hello {{ .Name | default "world" }}
```

Files marked `marp: true` are rendered too, unless Marp for VS Code is installed: both extensions would then render the same document. `goSlides.preview.marpDocuments` decides (`auto`, `always`, `never`).

## Presenting

With a deck in the editor, from the Command Palette or the editor's `…` menu:

| Command | Opens |
|---|---|
| *go-slides: Open Overview* | a panel with every slide in a grid. Arrows and a click choose a slide, and the editor shows its source; `Esc` closes it |
| *go-slides: Start Presenter View* | the slides, and beside them the presenter view: the slide and the next step, the speaker's notes (`<!-- … -->` comments), a timer |

The panels of a deck follow one another: change slide in any of them and the others change with it. The `p` key, or the controller's button, in the slides panel opens the presenter view. To present on a second screen, move the slides panel to its own window (*View: Move Editor into New Window*) and make it full screen with `f`. The panels follow the deck as you edit it.

Keys in the slides: `→` `↓` `Space` `Enter` next, `←` `↑` `Backspace` previous, `Home` `End`, `f` full screen, `p` presenter view.

## Install

Download `go-slides-<version>.vsix` from the [releases](https://github.com/go-slides/vscode/releases) and run *Extensions: Install from VSIX...*, or:

```sh
code --install-extension go-slides-0.5.0.vsix
```

Requires VS Code 1.101 or later. Exporting needs the command, Go 1.27 or later:

```sh
go install github.com/go-slides/slides/cmd/slides@latest
```

(*go-slides: Install the slides Command* runs it in a terminal.)

## Settings

| Setting | Default | |
|---|---|---|
| `goSlides.cliPath` | `""` | the `slides` command; empty: `slides` on `PATH`. Machine scope: a workspace cannot set it |
| `goSlides.exportType` | `pdf` | the format the export dialog proposes first |
| `goSlides.exportAutoOpen` | `true` | open the exported file |
| `goSlides.html` | `false` | allow all raw HTML (otherwise Marp's allowlist); honoured only in a trusted workspace |
| `goSlides.preview.marpDocuments` | `auto` | render `marp: true` decks: `auto` (unless Marp for VS Code is installed), `always`, `never` |

## Security

- The deck is untrusted. Raw HTML follows Marp's allowlist unless `goSlides.html` is on **and** the workspace is trusted; a workspace's `slides.yaml` `html: true` does not turn it on in the preview. The preview runs under VS Code's Markdown preview Content Security Policy: no script from the deck runs.
- The overview and the presenter view run the viewer's own script, so their policy is stricter still. Each panel is a page that holds the deck in a sandboxed frame (`sandbox="allow-scripts"`, no `allow-same-origin`: an opaque origin, no access to VS Code's webview API, to the panel's page or to the workspace). The frame may load images, media, styles and fonts and nothing else (`default-src 'none'`, no connection, no form, no frame), and runs only the scripts go-slides built into the page, named by hash: with `goSlides.html` on, a script a deck wrote is in the page and does not run. The extension host passes between the panels one thing: the slide and the step.
- The preview reads only files of the deck's workspace folder (or, for a deck outside any folder, its own directory), through `vscode.workspace.fs`; symbolic links are not followed, files over 2 MiB and more than 512 entries are not read. Templates see no environment variables (`env` is empty in the preview).
- Exporting runs a program: it needs a trusted workspace, and the program comes from a machine-scoped setting or `PATH`, never from the workspace.

## Performance

Measured by the smoke test in VS Code 1.142 (Apple M4 Max, load below 8) on go-slides' 100-slide benchmark deck (`test/fixtures/bench100.md`, from `internal/benchdeck.Large(100)`), against Marp for VS Code 3.6.1 on the same deck in the same VS Code, interleaved (`COMPARE_MARP=1 npm test`):

| | go-slides | Marp for VS Code |
|---|---:|---:|
| activation (loading the WebAssembly module) | 180 ms | — (already active: both activate on Markdown) |
| first preview of the deck | 54 ms | 78 ms |
| preview after an edit (median of 14) | 19 ms | 24 ms |

Four interleaved rounds on 2026-10-21 (load 5.9–7.4), medians, at Go's default `GOGC`; every other timed render has one character typed into slide 50, so that neither renderer is timed on unchanged text. After an edit go-slides re-renders only the slides whose source or inherited state changed, and reuses the others (`deck.RenderCache`); VS Code's preview then morphs the DOM. go-slides also caches parsed themes, packed style sheets and highlighted code between renders, and marks source lines for scroll sync without going byte by byte. A render of the deck allocates 5.7 MB, against 52.7 MB in v0.2.0.

## How it is built

The rule of the go-slides fleet is *Go only*. A VS Code extension cannot avoid a JavaScript entry point, so the boundary is:

| Go | TypeScript (`src/`, a thin shell) |
|---|---|
| rendering, front matter, templates, kinds, themes (`github.com/go-slides/slides`, compiled to `dist/slides.wasm`) | loading the module, calling `goSlides.call(method, json)` |
| deciding which documents are decks, positioning errors, completion and hover contents (`slides/editor`) | turning the answers into VS Code diagnostics, completion items and hovers |
| the presenting pages: the slides, the overview and the presenter view of go-slides' viewer, their scripts named by hash (`internal/api`) | the panels: a shell page, a frame, and the relay of a position between them (`src/panel.ts`, `src/session.ts`, `src/presenting.ts`) |
| which files a build needs (`vfs.Map` reports them) | reading them with `vscode.workspace.fs`, bounded to the workspace |
| the build steps: compiling the module, copying `wasm_exec.js`, writing the preview script, measuring sizes (`cmd/build`, cobra) | the export command: running `slides` with the chosen output |

`npm` and `vsce` do the rest: `npm run build` runs `go run ./cmd/build`, then bundles `src/node.ts` (desktop) and `src/web.ts` (vscode.dev) with esbuild. No shell script, Python or Makefile.

Why WebAssembly for the preview and the command for exports: compiled to WebAssembly, the preview engine is 23.4 MiB (7.4 MiB gzip, 5.8 MiB brotli; the `.vsix` is 7.5 MB, Marp for VS Code 3.6.1's is 36.3 MB); the whole command with its export engines (go-webengine, PDF, OOXML, ODF) is 72.2 MiB (21.0 MiB gzip) — `go run ./cmd/build measure`.

## Develop

```sh
npm ci
npm run build       # Go module + bundles
npm run check       # tsc
npm run test:unit   # the panels' relay and messages, under Node
npm run test:shell  # the panels' page in Chrome (CHROME, puppeteer-core), with the real engine
npm test            # VS Code smoke test (downloads VS Code)
go test ./...       # Go tests, the WebAssembly build included
npm run package     # go-slides-<version>.vsix
npm run ls          # the files the .vsix holds
```

## Publishing

CI packages the extension on every change (`vsce ls`, `vsce package`) and attaches the `.vsix` to each GitHub release. Publishing to the [Visual Studio Marketplace](https://marketplace.visualstudio.com/) and to [Open VSX](https://open-vsx.org/) is `.github/workflows/publish.yml`, run when a release is published. It needs the publisher's tokens as the repository secrets `VSCE_PAT` and `OVSX_PAT`, and says so and does nothing when they are absent: the maintainer creates the `go-slides` publisher on both, and the tokens. A token is read from the secret by the tool (`VSCE_PAT`, `OVSX_PAT` in its environment), never written on a command line or in a file.

## License

BSD 3-Clause, as go-slides.
