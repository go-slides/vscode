// Activation and wiring, shared by the desktop (node.ts) and web (web.ts)
// entries. Nothing here parses or renders: the Engine (Go) does, and this
// file hands its answers to VS Code.
import * as vscode from 'vscode';
import { Engine, type Item, type Diagnostic as GoDiagnostic } from './engine';
import { WorkspaceFiles } from './files';

const marpExtension = 'marp-team.marp-vscode';

/** What the desktop entry adds: exporting through the slides command. */
export interface Platform {
  registerExport?(context: vscode.ExtensionContext): void;
}

/** Timings of the last activation, for the version command and the tests. */
export interface Timings {
  activateMs: number;
  wasmLoadMs: number;
}

export interface Api {
  extendMarkdownIt(md: MarkdownIt): MarkdownIt;
  engine: Engine;
  timings: Timings;
}

// The few markdown-it members this file touches.
interface Token {
  type: string;
  meta: unknown;
}
interface MarkdownIt {
  parse(src: string, env: unknown): Token[];
  renderer: { render(tokens: Token[], options: unknown, env: unknown): string };
  core: { State: { prototype: { Token: new (type: string, tag: string, nesting: number) => Token } } };
}

function config() {
  return vscode.workspace.getConfiguration('goSlides');
}

/** Whether marp: true decks are ours to render. */
function acceptMarp(): boolean {
  switch (config().get<string>('preview.marpDocuments', 'auto')) {
    case 'always':
      return true;
    case 'never':
      return false;
  }
  return vscode.extensions.getExtension(marpExtension) === undefined;
}

/** All raw HTML: the user's setting, honoured only in a trusted workspace. */
function allowHTML(): boolean {
  return vscode.workspace.isTrusted && config().get<boolean>('html', false);
}

export async function activate(context: vscode.ExtensionContext, platform: Platform): Promise<Api> {
  const start = performance.now();
  const engine = await Engine.load(context.extensionUri);
  const files = new WorkspaceFiles();
  const diagnostics = vscode.languages.createDiagnosticCollection('go-slides');
  context.subscriptions.push(files, diagnostics);

  const refreshPreview = () => void vscode.commands.executeCommand('markdown.preview.refresh');

  /** Builds, then reads what the build asked for and asks for another pass. */
  const build = (deck: vscode.Uri, source: string) => {
    const res = engine.render(files.request(deck, source, allowHTML()));
    const reading = files.wants(res.missing);
    if (reading) {
      void files.fetch(deck, res.missing).then((added) => {
        if (added) {
          refreshPreview();
          refreshDiagnostics();
        }
      });
    }
    return { ...res, reading };
  };

  // Diagnostics, whether the preview is open or not.
  const publish = (deck: vscode.Uri, list: GoDiagnostic[]) => {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of list) {
      const range = new vscode.Range(d.line, d.column, d.endLine, d.endColumn);
      const diag = new vscode.Diagnostic(range, d.message, d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
      diag.source = 'go-slides';
      const all = byFile.get(d.file) ?? [];
      all.push(diag);
      byFile.set(d.file, all);
    }
    diagnostics.set(deck, byFile.get(deck.path) ?? []);
    for (const [file, list] of byFile) {
      if (file !== deck.path) {
        diagnostics.set(deck.with({ path: file }), list);
      }
    }
  };
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const check = (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'markdown') {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (!engine.detect(doc.getText(), acceptMarp())) {
          diagnostics.delete(doc.uri);
          return;
        }
        const res = build(doc.uri, doc.getText());
        if (!res.reading) {
          // While files are being read, the errors are about their
          // absence; the next pass publishes.
          publish(doc.uri, res.diagnostics);
        }
      }, 300),
    );
  };
  const refreshDiagnostics = () => vscode.workspace.textDocuments.forEach(check);
  vscode.workspace.textDocuments.forEach(check);
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => check(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => diagnostics.delete(doc.uri)),
    files.onDidChange(() => {
      refreshPreview();
      refreshDiagnostics();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goSlides')) {
        refreshPreview();
        refreshDiagnostics();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      refreshPreview();
      refreshDiagnostics();
    }),
  );

  // Completion and hover, in decks only.
  const deckRequest = (doc: vscode.TextDocument) =>
    engine.detect(doc.getText(), acceptMarp()) ? files.request(doc.uri, doc.getText(), allowHTML()) : undefined;
  const kinds: Record<string, vscode.CompletionItemKind> = {
    directive: vscode.CompletionItemKind.Property,
    value: vscode.CompletionItemKind.EnumMember,
    kind: vscode.CompletionItemKind.Class,
    theme: vscode.CompletionItemKind.Color,
    function: vscode.CompletionItemKind.Function,
    data: vscode.CompletionItemKind.Field,
  };
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      'markdown',
      {
        provideCompletionItems(doc, pos) {
          const req = deckRequest(doc);
          if (!req) {
            return undefined;
          }
          return engine.complete(req, pos.line, pos.character).map((i: Item) => {
            const item = new vscode.CompletionItem(i.label, kinds[i.kind] ?? vscode.CompletionItemKind.Text);
            item.detail = i.detail;
            item.documentation = i.doc ? new vscode.MarkdownString(i.doc) : undefined;
            item.insertText = i.insert;
            return item;
          });
        },
      },
      ':',
      ' ',
      '_',
      '.',
      '{',
      '=',
    ),
    vscode.languages.registerHoverProvider('markdown', {
      provideHover(doc, pos) {
        const req = deckRequest(doc);
        const h = req && engine.hover(req, pos.line, pos.character);
        if (!h) {
          return undefined;
        }
        return new vscode.Hover(new vscode.MarkdownString(h.doc), new vscode.Range(h.line, h.column, h.line, h.endColumn));
      },
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('goSlides.showVersion', () =>
      vscode.window.showInformationMessage(`go-slides ${engine.version}: WebAssembly loaded in ${engine.loadMs.toFixed(0)} ms.`),
    ),
  );
  platform.registerExport?.(context);

  // The Markdown preview: a markdown-it plugin, as Marp for VS Code does.
  const extendMarkdownIt = (md: MarkdownIt): MarkdownIt => {
    const parse = md.parse.bind(md);
    const render = md.renderer.render.bind(md.renderer);
    const TokenClass = md.core.State.prototype.Token;
    md.parse = (src, env) => {
      const tokens = parse(src, env);
      if (engine.detect(src, acceptMarp())) {
        // The ordinary tokens stay, for the outline and links; a marker
        // in front carries the source to render.
        const marker = new TokenClass('go_slides', '', 0);
        marker.meta = { source: src };
        tokens.unshift(marker);
      }
      return tokens;
    };
    md.renderer.render = (tokens, options, env) => {
      const marker = tokens[0];
      if (marker?.type !== 'go_slides') {
        return render(tokens, options, env);
      }
      const source = (marker.meta as { source: string }).source;
      const deck = (env as { currentDocument?: vscode.Uri } | undefined)?.currentDocument ?? vscode.Uri.parse('untitled:/deck.md');
      const res = build(deck, source);
      if (res.html) {
        return res.html;
      }
      if (res.reading) {
        // The build needs workspace files being read; the preview
        // refreshes when they are in.
        return '<p id="go-slides-reading">go-slides: reading the deck\'s files from the workspace…</p>';
      }
      const lines = res.diagnostics.map((d) => `${d.file}:${d.line + 1}: ${d.message}`).join('\n');
      return `<pre id="go-slides-error">${escapeHTML(lines || 'go-slides: nothing to show')}</pre>`;
    };
    return md;
  };

  const timings = { activateMs: performance.now() - start, wasmLoadMs: engine.loadMs };
  return { extendMarkdownIt, engine, timings };
}

function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
