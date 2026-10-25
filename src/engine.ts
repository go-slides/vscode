// The Go side: go-slides compiled to WebAssembly (dist/slides.wasm), loaded
// once, answering synchronously through globalThis.goSlides.call. This file
// only loads it and moves JSON across; what the answers mean is decided in
// Go (github.com/go-slides/slides/editor).
import * as vscode from 'vscode';
import './gen/wasm_exec.js';

/** editor.Request */
export interface Request {
  path: string;
  source: string;
  files?: Record<string, string>;
  dirs?: Record<string, string[]>;
  html?: boolean;
}

/** editor.Diagnostic */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: 'error' | 'warning';
  message: string;
}

/** editor.Result */
export interface Result {
  html: string;
  slides: number;
  diagnostics: Diagnostic[];
  missing: string[] | null;
}

/** editor.Item */
export interface Item {
  label: string;
  kind: string;
  detail?: string;
  doc?: string;
  insert?: string;
}

/** editor.Hover */
export interface Hover {
  doc: string;
  line: number;
  column: number;
  endColumn: number;
}

/** The views of a presenting page: the slides, the grid of every slide, the speaker's view. */
export type View = '' | 'overview' | 'presenter';

/** api.PresentResult */
export interface PresentResult {
  /** The whole HTML document; empty when the deck did not build. */
  page: string;
  /** The 0-based source line of each slide. */
  lines: number[];
  /** Content Security Policy sources ("'sha256-…'") of the page's own scripts. */
  scripts: string[];
  diagnostics: Diagnostic[];
  missing: string[] | null;
}

interface GoSlides {
  call(method: string, json: string): string;
  version: string;
}

interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}

export class Engine {
  private constructor(private readonly go: GoSlides, readonly loadMs: number) {}

  /** Loads dist/slides.wasm from the extension, through vscode.workspace.fs so that it works on vscode.dev too. */
  static async load(extensionUri: vscode.Uri): Promise<Engine> {
    const start = performance.now();
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, 'dist', 'slides.wasm'));
    const GoClass = (globalThis as unknown as { Go: new () => GoRuntime }).Go;
    const go = new GoClass();
    const { instance } = await WebAssembly.instantiate(bytes, go.importObject);
    // run returns when the Go program exits, which it never does: by the
    // time run has returned its promise, main has set globalThis.goSlides.
    void go.run(instance);
    const api = (globalThis as unknown as { goSlides?: GoSlides }).goSlides;
    if (!api) {
      throw new Error('go-slides: the WebAssembly module did not start');
    }
    return new Engine(api, performance.now() - start);
  }

  get version(): string {
    return this.go.version;
  }

  private call<T>(method: string, request: unknown): T {
    const res = JSON.parse(this.go.call(method, JSON.stringify(request))) as { result?: T; error?: string };
    if (res.error) {
      throw new Error(res.error);
    }
    return res.result as T;
  }

  detect(source: string, marp: boolean): boolean {
    return this.call<boolean>('detect', { source, marp });
  }

  render(req: Request): Result {
    return this.call<Result>('render', req);
  }

  /** The deck as a presenting page that syncs through its parent window (see panel.ts). */
  present(req: Request, view: View): PresentResult {
    return this.call<PresentResult>('present', { ...req, view });
  }

  complete(req: Request, line: number, character: number): Item[] {
    return this.call<Item[]>('complete', { ...req, line, character });
  }

  hover(req: Request, line: number, character: number): Hover | null {
    return this.call<Hover | null>('hover', { ...req, line, character });
  }
}
