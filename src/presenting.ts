// The overview and the presenter view as panels of VS Code: the viewer's pages
// (go-slides' viewer package, built by the engine) in webview panels, one session
// per deck. What a panel holds, and what passes between panels, is panel.ts and
// session.ts; this file is what needs VS Code: the panels, the documents the
// decks come from, the editor a slide is shown in.
import * as vscode from 'vscode';
import type { Engine, Diagnostic as GoDiagnostic, PresentResult } from './engine';
import type { WorkspaceFiles } from './files';
import { frameDoc, lineOf, newNonce, parseFromShell, shellHTML, titleOf, viewOf, type PanelKind, type Sync, type ToShell } from './panel';
import { Session, type Panel } from './session';

/** What the panels need from the extension. */
export interface Deps {
  engine: Engine;
  files: WorkspaceFiles;
  /** All raw HTML: the user's setting, in a trusted workspace. */
  allowHTML(): boolean;
  /** Whether marp: true decks are ours. */
  acceptMarp(): boolean;
}

/** Where a panel is: for the tests, which cannot see inside a webview. */
export interface PanelState {
  kind: PanelKind;
  /** The Content Security Policy script sources the shell allows. */
  scripts: string[];
  /** The number of pages the panel has been sent. */
  shown: number;
  /** The last position it was told. */
  at: Sync | undefined;
  /** The shell's HTML. */
  html: string;
}

/** What the commands leave behind, for the tests. */
export interface PresentingApi {
  /** The open talks, by deck. */
  talks(): { deck: string; panels: PanelState[]; last: Sync | undefined }[];
  /** Says, as the panel's shell would, what a page of a panel said. */
  receive(deck: vscode.Uri, kind: PanelKind, message: unknown): void;
  /** Builds the pages again, and resolves when every panel has been sent its page. */
  refresh(): Promise<void>;
}

interface Talk {
  deck: vscode.Uri;
  session: Session;
  /** The source line of each slide, from the last build. */
  lines: number[];
  panels: Map<PanelKind, ShellPanel>;
  timer?: ReturnType<typeof setTimeout>;
}

const deckDir = (deck: vscode.Uri): vscode.Uri => deck.with({ path: deck.path.slice(0, deck.path.lastIndexOf('/')) || '/' });

/** A webview panel with a shell page in it (panel.ts). */
class ShellPanel implements Panel {
  readonly panel: vscode.WebviewPanel;
  scripts: string[] = [];
  shown = 0;
  at: Sync | undefined;
  private doc = '';
  private ready = false;

  constructor(
    readonly kind: PanelKind,
    deck: vscode.Uri,
    column: vscode.ViewColumn,
    preserveFocus: boolean,
    readonly onMessage: (m: unknown) => void,
    readonly onDispose: () => void,
  ) {
    const roots = [deckDir(deck), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)];
    this.panel = vscode.window.createWebviewPanel(`goSlides.${kind}`, `${titleOf[kind]}: ${deck.path.slice(deck.path.lastIndexOf('/') + 1)}`, { viewColumn: column, preserveFocus }, {
      enableScripts: true,
      // a talk is not rebuilt each time its tab is shown again
      retainContextWhenHidden: true,
      localResourceRoots: roots,
    });
    this.panel.webview.onDidReceiveMessage((m) => {
      if ((m as { type?: unknown })?.type === 'ready') {
        this.ready = true;
      }
      onMessage(m);
    });
    this.panel.onDidDispose(onDispose);
  }

  get html(): string {
    return this.panel.webview.html;
  }

  private post(m: ToShell): void {
    void this.panel.webview.postMessage(m);
  }

  sync(at: Sync): void {
    this.at = at;
    this.post({ type: 'sync', data: at });
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  close(): void {
    this.panel.dispose();
  }

  show(): void {
    if (this.doc) {
      this.shown++;
      this.post({ type: 'doc', html: this.doc });
    }
  }

  /**
   * Gives the panel a new page. The shell's policy names the scripts it may run
   * and is fixed once the shell loads: a page whose scripts are not among them
   * (the first, or a newer viewer) gets a new shell.
   */
  async update(doc: string, scripts: string[]): Promise<void> {
    this.doc = doc;
    const known = new Set(this.scripts);
    if (scripts.every((s) => known.has(s)) && this.panel.webview.html) {
      if (this.ready) {
        this.show();
      }
      return;
    }
    this.scripts = [...new Set([...this.scripts, ...scripts])];
    this.ready = false;
    this.panel.webview.html = await shellHTML({ title: this.panel.title, cspSource: this.panel.webview.cspSource, nonce: newNonce(), scripts: this.scripts });
  }
}

const escapeHTML = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page of a deck that did not build: its problems, as text. */
function problemsPage(diagnostics: GoDiagnostic[], reading: boolean): string {
  const text = reading ? 'go-slides: reading the deck\'s files from the workspace…' : diagnostics.map((d) => `${d.file}:${d.line + 1}: ${d.message}`).join('\n') || 'go-slides: nothing to show';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font:14px/1.5 sans-serif;margin:2em;color:#c0392b;background:#fff}pre{white-space:pre-wrap}</style></head><body><pre>${escapeHTML(text)}</pre></body></html>`;
}

export function registerPresenting(context: vscode.ExtensionContext, deps: Deps): PresentingApi {
  const talks = new Map<string, Talk>();
  const isDeck = (doc: vscode.TextDocument | undefined): doc is vscode.TextDocument =>
    !!doc && doc.languageId === 'markdown' && deps.engine.detect(doc.getText(), deps.acceptMarp());

  // The deck a command is for: the one it was given, the active editor's, or the
  // last deck that had the editor (a panel has it when its command runs).
  let lastDeck: vscode.Uri | undefined;
  const track = (e: vscode.TextEditor | undefined) => {
    const deck = isDeck(e?.document);
    void vscode.commands.executeCommand('setContext', 'goSlides.isDeck', deck);
    if (deck) {
      lastDeck = e!.document.uri;
    }
  };
  track(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(track));

  const deckFor = async (arg: unknown): Promise<vscode.TextDocument | undefined> => {
    const uri = arg instanceof vscode.Uri ? arg : vscode.window.activeTextEditor?.document.uri ?? lastDeck;
    const doc = uri && (await vscode.workspace.openTextDocument(uri));
    if (!isDeck(doc)) {
      void vscode.window.showInformationMessage('go-slides: open a deck (a Markdown file with slides: true) first.');
      return undefined;
    }
    return doc;
  };

  /** One build of a panel's page; reads the workspace files it asked for, then builds again. */
  const build = async (talk: Talk, kind: PanelKind): Promise<{ res: PresentResult; reading: boolean }> => {
    const doc = await vscode.workspace.openTextDocument(talk.deck);
    for (let pass = 0; ; pass++) {
      const res = deps.engine.present(deps.files.request(talk.deck, doc.getText(), deps.allowHTML()), viewOf[kind]);
      if (!deps.files.wants(res.missing)) {
        return { res, reading: false };
      }
      if (pass >= 3 || !(await deps.files.fetch(talk.deck, res.missing))) {
        return { res, reading: false };
      }
    }
  };

  const refreshTalk = async (talk: Talk): Promise<void> => {
    for (const [kind, panel] of talk.panels) {
      try {
        const { res, reading } = await build(talk, kind);
        if (res.lines.length) {
          talk.lines = res.lines;
        }
        const page = res.page || problemsPage(res.diagnostics, reading);
        const base = ['file', 'vscode-remote'].includes(talk.deck.scheme) ? panel.panel.webview.asWebviewUri(deckDir(talk.deck)).toString() + '/' : undefined;
        const { doc, scripts } = await frameDoc(page, res.page ? res.scripts : [], panel.panel.webview.cspSource, base);
        await panel.update(doc, scripts);
      } catch (e) {
        void vscode.window.showErrorMessage(`go-slides: ${(e as Error).message}`);
      }
    }
  };

  const refreshAll = () => Promise.all([...talks.values()].map(refreshTalk)).then(() => undefined);
  const later = (talk: Talk) => {
    clearTimeout(talk.timer);
    talk.timer = setTimeout(() => void refreshTalk(talk), 300);
  };

  /** The panel of a kind in a talk, made. */
  const open = (talk: Talk, kind: PanelKind): Panel => {
    const preserve = kind !== 'slides';
    let column = vscode.ViewColumn.Beside;
    const slides = talk.panels.get('slides');
    if (kind === 'presenter' && slides?.panel.viewColumn) {
      // the speaker's view next to the audience's, which can then be moved to
      // the other screen with "Move Editor into New Window"
      column = Math.min(slides.panel.viewColumn + 1, 9) as vscode.ViewColumn;
    }
    const panel = new ShellPanel(
      kind,
      talk.deck,
      column,
      preserve,
      (m) => {
        const msg = parseFromShell(m);
        if (msg) {
          talk.session.receive(kind, msg);
        }
      },
      () => {
        talk.panels.delete(kind);
        talk.session.closed(kind);
        if (!talk.panels.size) {
          clearTimeout(talk.timer);
          talks.delete(talk.deck.toString());
        }
      },
    );
    talk.panels.set(kind, panel);
    void refreshTalk(talk);
    return panel;
  };

  const talkFor = (deck: vscode.Uri): Talk => {
    const key = deck.toString();
    let talk = talks.get(key);
    if (!talk) {
      const t: Talk = {
        deck,
        lines: [],
        panels: new Map(),
        session: new Session({
          open: (kind) => open(t, kind),
          revealSource: (index) => {
            const line = lineOf(t.lines, index);
            const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
            if (line === undefined || !editor) {
              return;
            }
            const at = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
            editor.selection = new vscode.Selection(at, at);
            editor.revealRange(new vscode.Range(at, at), vscode.TextEditorRevealType.AtTop);
          },
        }),
      };
      talk = t;
      talks.set(key, t);
    }
    return talk;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('goSlides.openOverview', async (arg?: unknown) => {
      const doc = await deckFor(arg);
      if (doc) {
        talkFor(doc.uri).session.open('overview');
      }
    }),
    vscode.commands.registerCommand('goSlides.startPresenter', async (arg?: unknown) => {
      const doc = await deckFor(arg);
      if (doc) {
        const talk = talkFor(doc.uri);
        talk.session.open('slides');
        talk.session.open('presenter');
      }
    }),
    // what changes a deck changes its panels
    vscode.workspace.onDidChangeTextDocument((e) => {
      const talk = talks.get(e.document.uri.toString());
      if (talk) {
        later(talk);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('goSlides')) {
        void refreshAll();
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void refreshAll()),
    deps.files.onDidChange(() => void refreshAll()),
    { dispose: () => [...talks.values()].forEach((t) => t.session.end()) },
  );

  return {
    talks: () =>
      [...talks.values()].map((t) => ({
        deck: t.deck.toString(),
        last: t.session.last,
        panels: [...t.panels.values()].map((p) => ({ kind: p.kind, scripts: p.scripts, shown: p.shown, at: p.at, html: p.html })),
      })),
    receive: (deck, kind, message) => {
      const msg = parseFromShell(message);
      const talk = talks.get(deck.toString());
      if (msg && talk) {
        talk.session.receive(kind, msg);
      }
    },
    refresh: refreshAll,
  };
}
