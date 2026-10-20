// The workspace files a build may read. The Go side asks (Result.missing);
// this cache reads what it asked for, if it lies inside the deck's
// workspace folder, through vscode.workspace.fs (so it works on vscode.dev
// and in remote workspaces), and hands it over on the next build.
import * as vscode from 'vscode';
import type { Request } from './engine';

/** A file larger than this is not handed over (HCL's file() takes 1 MiB). */
const maxFileBytes = 2 << 20;
/** How many files and directories one workspace may hand over. */
const maxEntries = 512;

export class WorkspaceFiles implements vscode.Disposable {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Map<string, string[]>();
  /** Paths that were asked for and are not handed over: absent, refused, too large. */
  private readonly refused = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly watcher: vscode.FileSystemWatcher;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor() {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const forget = (uri: vscode.Uri) => {
      const parent = uri.path.slice(0, uri.path.lastIndexOf('/'));
      const known = this.files.has(uri.path) || this.dirs.has(uri.path) || this.refused.has(uri.path) || this.dirs.has(parent);
      this.files.delete(uri.path);
      this.dirs.delete(uri.path);
      this.dirs.delete(parent);
      this.refused.delete(uri.path);
      if (known) {
        this.changed.fire();
      }
    };
    this.watcher.onDidChange(forget);
    this.watcher.onDidCreate(forget);
    this.watcher.onDidDelete(forget);
  }

  dispose(): void {
    this.watcher.dispose();
    this.changed.dispose();
  }

  /** The request for a deck: its text and every file read so far. */
  request(deck: vscode.Uri, source: string, html: boolean): Request {
    const files: Record<string, string> = {};
    for (const [p, text] of this.files) {
      files[p] = text;
    }
    // Open editors hold the newest text of a kinds file or a fragment.
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === deck.scheme && this.files.has(doc.uri.path)) {
        files[doc.uri.path] = doc.getText();
      }
    }
    return { path: deck.path, source, files, dirs: Object.fromEntries(this.dirs), html };
  }

  /** Whether fetch would read any of these paths: some are still to be tried. */
  wants(missing: string[] | null): boolean {
    return (missing ?? []).some((p) => !this.files.has(p) && !this.dirs.has(p) && !this.refused.has(p));
  }

  /**
   * Reads the paths a build asked for. Resolves to true when something new
   * was handed over, so that the caller builds again.
   */
  async fetch(deck: vscode.Uri, missing: string[] | null): Promise<boolean> {
    let added = false;
    for (const p of missing ?? []) {
      if (this.files.has(p) || this.dirs.has(p) || this.refused.has(p) || this.pending.has(p)) {
        continue;
      }
      if (this.files.size + this.dirs.size + this.refused.size >= maxEntries) {
        break;
      }
      this.pending.add(p);
      try {
        added = (await this.read(deck, deck.with({ path: p }))) || added;
      } finally {
        this.pending.delete(p);
      }
    }
    return added;
  }

  private async read(deck: vscode.Uri, uri: vscode.Uri): Promise<boolean> {
    if (!inside(deck, uri)) {
      this.refused.add(uri.path);
      return false;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      this.refused.add(uri.path);
      return false;
    }
    // A symbolic link could lead out of the workspace.
    if (stat.type & vscode.FileType.SymbolicLink) {
      this.refused.add(uri.path);
      return false;
    }
    if (stat.type & vscode.FileType.Directory) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      this.dirs.set(
        uri.path,
        entries
          .filter(([, t]) => !(t & vscode.FileType.SymbolicLink))
          .map(([name, t]) => (t & vscode.FileType.Directory ? name + '/' : name)),
      );
      return true;
    }
    if (stat.size > maxFileBytes) {
      this.refused.add(uri.path);
      return false;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    this.files.set(uri.path, new TextDecoder().decode(bytes));
    return true;
  }
}

/**
 * Whether a build of deck may read uri: same scheme and authority, and
 * inside the deck's workspace folder, or, for a deck outside any folder,
 * inside the deck's own directory.
 */
export function inside(deck: vscode.Uri, uri: vscode.Uri): boolean {
  if (uri.scheme !== deck.scheme || uri.authority !== deck.authority) {
    return false;
  }
  const folder = vscode.workspace.getWorkspaceFolder(deck);
  const root = folder ? folder.uri.path : deck.path.slice(0, deck.path.lastIndexOf('/'));
  const base = root.endsWith('/') ? root : root + '/';
  const p = normalize(uri.path);
  return p === root || p.startsWith(base);
}

/** Resolves . and .. segments; the Go side already cleans its paths. */
function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '..') {
      out.pop();
    } else if (seg !== '.' && seg !== '') {
      out.push(seg);
    }
  }
  return '/' + out.join('/');
}
