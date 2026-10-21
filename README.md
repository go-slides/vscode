# go-slides for VS Code

Preview, check, complete and export [go-slides](https://github.com/go-slides/slides) decks in VS Code — Marp Markdown plus Go templates, slide kinds and HCL front matter — the way [Marp for VS Code](https://github.com/marp-team/marp-vscode) does for Marp, without Chrome.

- **Preview** in VS Code's own Markdown preview, rendered by go-slides compiled to WebAssembly: nothing to install, and it works on [vscode.dev](https://vscode.dev) too.
- **Scroll sync** (v0.2.0): scrolling the editor scrolls the preview to the slide and block under it, and the other way round, through templates too: a slide a `{{ range }}` generates follows its template's line, what an `{{ include }}` brings follows the include.
- **Templates and kinds**: `{{ .data }}`, `{{ page }}/{{ total }}`, `include`; `kind:`/`_kind:` from the built-ins, the front matter, kinds files and `slides.yaml`/`slides.hcl`; `---hcl` front matter. The files a deck uses are read from the workspace.
- **Problems panel**: template, YAML and HCL errors on their line, in the deck or in the kinds file they come from.
- **Completion and hover**: directives (spot `_` ones in comments), `kind` values with what they set, themes, size presets, `paginate`, template functions and data fields.
- **Export** to HTML, vector PDF, editable PPTX and ODP, PNG and JPEG with the `slides` command (*go-slides: Export Slide Deck...*).

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

## Install

The extension is not on the Marketplace yet. Download `go-slides-<version>.vsix` from the [releases](https://github.com/go-slides/vscode/releases) and run *Extensions: Install from VSIX...*, or:

```sh
code --install-extension go-slides-0.2.0.vsix
```

Exporting needs the command, Go 1.27 or later:

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
- The preview reads only files of the deck's workspace folder (or, for a deck outside any folder, its own directory), through `vscode.workspace.fs`; symbolic links are not followed, files over 2 MiB and more than 512 entries are not read. Templates see no environment variables (`env` is empty in the preview).
- Exporting runs a program: it needs a trusted workspace, and the program comes from a machine-scoped setting or `PATH`, never from the workspace.

## Performance

Measured by the smoke test in VS Code 1.142 (Apple M4 Max, load below 8) on go-slides' 100-slide benchmark deck (`test/fixtures/bench100.md`, from `internal/benchdeck.Large(100)`), against Marp for VS Code 3.6.1 on the same deck in the same VS Code, interleaved (`COMPARE_MARP=1 npm test`):

| | go-slides | Marp for VS Code |
|---|---:|---:|
| activation (loading the WebAssembly module) | 180 ms | — (already active: both activate on Markdown) |
| first preview of the deck | 52 ms | 78 ms |
| preview after an edit (median of 14) | 24 ms | 23 ms |

Four interleaved rounds on 2026-10-21 (load 5.9–7.5), medians, at Go's default `GOGC`. The edit latency now matches Marp's (it was 44 ms at the default, 36 ms with the former `GOGC=400` override, which this version drops; with it, 19 ms). go-slides caches parsed themes, packed style sheets and highlighted code between renders, and marks source lines for scroll sync without going byte by byte; earlier, the regular-expression engine behind code highlighting stopped allocating a table the size of the code block per lookaround ([go-regexp/engine#10](https://github.com/go-regexp/engine/issues/10)). A render of the deck allocates 5.7 MB, against 52.7 MB in v0.2.0.

## How it is built

The rule of the go-slides fleet is *Go only*. A VS Code extension cannot avoid a JavaScript entry point, so the boundary is:

| Go | TypeScript (`src/`, a thin shell) |
|---|---|
| rendering, front matter, templates, kinds, themes (`github.com/go-slides/slides`, compiled to `dist/slides.wasm`) | loading the module, calling `goSlides.call(method, json)` |
| deciding which documents are decks, positioning errors, completion and hover contents (`slides/editor`) | turning the answers into VS Code diagnostics, completion items and hovers |
| which files a build needs (`vfs.Map` reports them) | reading them with `vscode.workspace.fs`, bounded to the workspace |
| the build steps: compiling the module, copying `wasm_exec.js`, writing the preview script, measuring sizes (`cmd/build`, cobra) | the export command: running `slides` with the chosen output |

`npm` and `vsce` do the rest: `npm run build` runs `go run ./cmd/build`, then bundles `src/node.ts` (desktop) and `src/web.ts` (vscode.dev) with esbuild. No shell script, Python or Makefile.

Why WebAssembly for the preview and the command for exports: compiled to WebAssembly, the preview engine is 23.4 MiB (7.4 MiB gzip, 5.8 MiB brotli; the `.vsix` is 7.5 MB, Marp for VS Code 3.6.1's is 36.3 MB); the whole command with its export engines (go-webengine, PDF, OOXML, ODF) is 72.2 MiB (21.0 MiB gzip) — `go run ./cmd/build measure`.

## Develop

```sh
npm ci
npm run build     # Go module + bundles
npm run check     # tsc
npm test          # VS Code smoke test (downloads VS Code)
go test ./...     # Go tests, the WebAssembly build included
npm run package   # go-slides-<version>.vsix
```

## License

BSD 3-Clause, as go-slides.
