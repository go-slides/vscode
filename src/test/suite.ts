// Smoke test, run inside VS Code: activation, the preview plugin, the
// workspace-file loop (slides.yaml -> kinds.yaml), diagnostics, completion,
// hover; then timings on the 100-slide benchmark deck.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';
import type { Api } from '../extension';

const fixture = (name: string) => vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, name);

async function until<T>(what: string, f: () => T | undefined | Promise<T | undefined>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<Api>('go-slides.go-slides');
  assert.ok(ext, 'extension not found');
  const t0 = performance.now();
  const api = await ext.activate();
  const activateWallMs = performance.now() - t0;
  assert.match(api.engine.version, /v\d|devel/);

  // The preview plugin, as VS Code's Markdown engine drives it.
  const deckUri = fixture('deck.md');
  const doc = await vscode.workspace.openTextDocument(deckUri);
  await vscode.window.showTextDocument(doc);
  const md = api.extendMarkdownIt(new MarkdownIt({ html: true }) as never) as unknown as MarkdownIt;
  const env = () => ({ currentDocument: deckUri });
  const renderDeck = () => md.renderer.render(md.parse(doc.getText(), {}), md.options, env());
  // The first pass asks for slides.yaml, which names kinds.yaml: both are
  // read from the workspace, and the preview says so meanwhile.
  const first = renderDeck();
  assert.ok(first.includes('go-slides-reading'), first.slice(0, 400));
  const html = await until('kinds.yaml to be read', () => {
    const h = renderDeck();
    return h.includes('from kinds.yaml') ? h : undefined;
  });
  assert.equal((html.match(/<svg data-marpit-svg/g) ?? []).length, 2, html.slice(0, 400));
  assert.ok(html.includes('Hello World'));
  assert.ok(html.includes('Page 2 of 2'));
  assert.ok(html.includes('lead invert'));
  // Scroll sync: VS Code's preview maps editor lines to elements marked
  // class="code-line" data-line="N" (0-based), here the slide frames and
  // their blocks.
  const frames = [...html.matchAll(/<svg data-marpit-svg="" viewBox="[^"]*" class="code-line" data-line="(\d+)">/g)].map((m) => +m[1]);
  assert.deepEqual(frames, [6, 10], 'slide lines');
  assert.match(html, /<h1[^>]* class="code-line" data-line="7"[^>]*>Hello World/);
  assert.match(html, /<h1[^>]* class="code-line" data-line="13"[^>]*>Page 2 of 2/);

  // A plain Markdown document is left to VS Code.
  const plain = md.render('# just Markdown\n');
  assert.ok(!plain.includes('go-slides') && plain.includes('<h1>'));

  // Diagnostics on the line of the error, after a code block.
  const broken = await vscode.workspace.openTextDocument(fixture('broken.md'));
  const diags = await until('diagnostics', () => {
    const d = vscode.languages.getDiagnostics(broken.uri);
    return d.length > 0 ? d : undefined;
  });
  assert.equal(diags[0].range.start.line, 10, diags[0].message);
  assert.equal(diags[0].source, 'go-slides');

  // Completion of a kind from kinds.yaml, at "_kind: ".
  const line = doc.getText().split('\n').findIndex((l) => l.includes('_kind: hero'));
  const pos = new vscode.Position(line, '<!-- _kind: '.length);
  const items = await until('kind completions', async () => {
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', deckUri, pos);
    const labels = list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
    return labels.includes('hero') ? labels : undefined;
  });
  assert.ok(items.includes('title'));
  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', deckUri, new vscode.Position(1, 2));
  assert.ok(hovers.some((h) => h.contents.some((c) => (c as vscode.MarkdownString).value?.includes('go-slides'))));

  // Timings on the 100-slide benchmark deck (marp: true).
  const marp = vscode.extensions.getExtension<{ extendMarkdownIt(md: unknown): unknown }>('marp-team.marp-vscode');
  if (marp) {
    // Both installed: render marp: true decks with go-slides too.
    await vscode.workspace.getConfiguration('goSlides').update('preview.marpDocuments', 'always', vscode.ConfigurationTarget.Global);
  }
  const bench = await vscode.workspace.openTextDocument(fixture('bench100.md'));
  const ours = time(md, bench, '<svg data-marpit-svg');
  const timings: Record<string, number> = {
    activateMs: Math.round(api.timings.activateMs),
    activateWallMs: Math.round(activateWallMs),
    wasmLoadMs: Math.round(api.timings.wasmLoadMs),
    previewFirstMs: ours.first,
    previewMedianMs: ours.median,
    previewMinMs: ours.min,
  };
  // The reference, when the comparison run installed it: Marp for VS
  // Code's own markdown-it plugin on the same deck, interleaved rounds.
  if (marp) {
    const m0 = performance.now();
    const marpApi = await marp.activate();
    timings.marpActivateWallMs = Math.round(performance.now() - m0);
    const marpMd = marpApi.extendMarkdownIt(new MarkdownIt({ html: true })) as MarkdownIt;
    const theirs = time(marpMd, bench, '<svg data-marpit-svg');
    const again = time(md, bench, '<svg data-marpit-svg');
    timings.marpPreviewFirstMs = theirs.first;
    timings.marpPreviewMedianMs = theirs.median;
    timings.marpPreviewMinMs = theirs.min;
    timings.previewMedianMsRound2 = again.median;
  }
  console.log('GO_SLIDES_TIMINGS ' + JSON.stringify(timings));
}

/** Renders a deck 15 times through a markdown-it instance; checks it made 100 slides. */
function time(md: MarkdownIt, doc: vscode.TextDocument, marker: string): { first: number; median: number; min: number } {
  const src = doc.getText();
  // After the first render, every other one has a character typed at the end
  // of a paragraph line in the middle of the deck: an edit, as the preview
  // sees keystrokes, so that neither renderer is timed on unchanged text.
  let at = src.indexOf('\n', Math.floor(src.length / 2));
  while (src.slice(0, at).endsWith('---') || src.slice(0, at).endsWith('\n')) {
    at = src.indexOf('\n', at + 1);
  }
  const edited = src.slice(0, at) + 'x' + src.slice(at);
  const times: number[] = [];
  let out = '';
  for (let i = 0; i < 15; i++) {
    const text = i % 2 === 0 ? src : edited;
    const s = performance.now();
    out = md.renderer.render(md.parse(text, {}), md.options, { currentDocument: doc.uri });
    times.push(performance.now() - s);
  }
  const slides = out.split(marker).length - 1;
  assert.equal(slides, 100, out.slice(0, 300));
  return { first: Math.round(times[0]), median: Math.round(median(times.slice(1))), min: Math.round(Math.min(...times.slice(1))) };
}
