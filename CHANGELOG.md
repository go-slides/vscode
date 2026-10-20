# Changelog

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
