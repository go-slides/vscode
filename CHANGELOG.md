# Changelog

## 0.1.0

- Preview go-slides decks (`slides: true`) and Marp decks (`marp: true`, unless Marp for VS Code is installed) in VS Code's Markdown preview, rendered by go-slides compiled to WebAssembly: no binary, works on vscode.dev.
- Go templates, slide kinds (front matter, kinds files, `slides.yaml`/`slides.hcl`) and HCL front matter, read from the workspace.
- Problems panel: template, YAML and HCL errors on their lines.
- Completion and hover for directives, `kind`/`_kind`, themes, size presets and template functions.
- Export to HTML, PDF, PPTX, ODP, PNG and JPEG through the installed `slides` command (trusted workspaces).
