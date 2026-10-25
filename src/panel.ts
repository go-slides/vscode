// What a presenting panel is made of, with nothing from VS Code in it, so that
// it runs under Node and in a browser test as well.
//
// The viewer's pages (go-slides' viewer package) follow one another through
// messages to their parent window (viewer.SyncParent): a page posts
// {slidesSync: {index, fragmentIndex}} to its parent after every change of slide
// or step, takes the same from it, and posts {slidesPresent: true} to ask for the
// presenter view. A webview's own parent is VS Code's page, which would never
// relay them, so the panel is a shell page that holds the deck in a sandboxed
// frame and is the frame's parent:
//
//	extension host <-- postMessage --> shell page <-- postMessage --> deck frame
//	                                   (acquireVsCodeApi)             (sandbox="allow-scripts",
//	                                                                   opaque origin, srcdoc)
//
// The deck frame has no allow-same-origin, no network but images, styles and
// fonts, and runs only the scripts the engine reported by hash. The shell runs
// one script, by nonce, and speaks only the few message shapes below.

/** The three panels of a talk. */
export type PanelKind = 'slides' | 'overview' | 'presenter';

/** Where a page is: the slide and the step in it. */
export interface Sync {
  index: number;
  fragmentIndex: number;
}

/** What the extension host tells a shell. */
export type ToShell = { type: 'doc'; html: string } | { type: 'sync'; data: Sync };

/** What a shell tells the extension host. */
export type FromShell = { type: 'ready' } | { type: 'sync'; data: Sync } | { type: 'present' } | { type: 'close' };

const isIndex = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100_000;

/** A message from a shell, checked: anything of another shape is dropped. */
export function parseFromShell(x: unknown): FromShell | undefined {
  if (typeof x !== 'object' || x === null) {
    return undefined;
  }
  const m = x as { type?: unknown; data?: { index?: unknown; fragmentIndex?: unknown } };
  switch (m.type) {
    case 'ready':
    case 'present':
    case 'close':
      return { type: m.type };
    case 'sync':
      if (isIndex(m.data?.index) && isIndex(m.data?.fragmentIndex)) {
        return { type: 'sync', data: { index: m.data.index, fragmentIndex: m.data.fragmentIndex } };
      }
  }
  return undefined;
}

/** The view an engine page is built for. */
export const viewOf = { slides: '', overview: 'overview', presenter: 'presenter' } as const;

/** What a panel's title says. */
export const titleOf: Record<PanelKind, string> = { slides: 'Slides', overview: 'Overview', presenter: 'Presenter' };

/**
 * The Content Security Policy of the deck's frame, and (with the shell's own
 * scripts added) of the shell: a frame made from srcdoc inherits its parent's
 * policy and adds its own, so what the shell allows is the most the deck can.
 *
 * Nothing loads but images, media, styles and fonts, from the workspace
 * (cspSource) and from https: (a deck links its pictures and fonts). No frame,
 * no form, no connection. The base is the deck's folder, so that its relative
 * pictures resolve.
 */
export function policy(scripts: string, cspSource: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `media-src ${cspSource} https: data:`,
    `style-src 'unsafe-inline' ${cspSource} https:`,
    `font-src ${cspSource} https: data:`,
    `script-src ${scripts}`,
    `base-uri ${cspSource}`,
    "form-action 'none'",
    "frame-src 'none'",
  ].join('; ');
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The shim the viewer's own page runs first, as in the playground: in a frame
 * with an opaque origin, history and localStorage may throw, and the viewer
 * does not expect it to.
 */
export const frameShim =
  `(function(){try{var h=history;["replaceState","pushState"].forEach(function(n){var f=h[n].bind(h);h[n]=function(){try{return f.apply(null,arguments)}catch(e){}}})}catch(e){}` +
  `try{window.localStorage}catch(e){var m={};try{Object.defineProperty(window,"localStorage",{configurable:true,value:{getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}}})}catch(e){}}})();`;

/** The CSP hash source of a script's text. */
export async function hashOf(script: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script));
  let bin = '';
  for (const b of new Uint8Array(digest)) {
    bin += String.fromCharCode(b);
  }
  return `'sha256-${btoa(bin)}'`;
}

/**
 * The deck's page as the frame's srcdoc: the shim first, then a policy that names
 * the engine's scripts (and the shim) and nothing else, and the base. The scripts
 * the page holds are not read here: the engine said which are its own.
 */
export async function frameDoc(page: string, scripts: string[], cspSource: string, base: string | undefined): Promise<{ doc: string; scripts: string[] }> {
  const all = [...scripts, await hashOf(frameShim)];
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(policy(all.join(' '), cspSource))}">`;
  const baseTag = base ? `<base href="${escapeAttr(base)}">` : '';
  const head = `${meta}${baseTag}<script>${frameShim}</script>`;
  const i = page.indexOf('<head>');
  const doc = i < 0 ? head + page : page.slice(0, i + '<head>'.length) + head + page.slice(i + '<head>'.length);
  return { doc, scripts: all };
}

/** What the shell page's one script does; see the file's comment. */
export const shellScript = `
const vscode = acquireVsCodeApi();
const frame = document.getElementById('deck');
const num = (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < 100000;
const sync = (d) => d && num(d.index) && num(d.fragmentIndex) ? { index: d.index, fragmentIndex: d.fragmentIndex } : undefined;
let last = (vscode.getState() || {}).last;
const toDeck = (s) => { if (frame.contentWindow) frame.contentWindow.postMessage({ slidesSync: s }, '*'); };
window.addEventListener('message', (e) => {
  const m = e.data;
  if (e.source === frame.contentWindow) {
    // from the deck: what it may say is a position, a request for the presenter
    // view, and the overview's close
    if (m && m.slidesSync) {
      const s = sync(m.slidesSync);
      if (s) { last = s; vscode.setState({ last }); vscode.postMessage({ type: 'sync', data: s }); }
    } else if (m && m.slidesPresent === true) {
      vscode.postMessage({ type: 'present' });
    } else if (m === 'closeOverview') {
      vscode.postMessage({ type: 'close' });
    }
    return;
  }
  // from the extension host
  if (!m) return;
  if (m.type === 'doc' && typeof m.html === 'string') {
    frame.srcdoc = m.html;
  } else if (m.type === 'sync') {
    const s = sync(m.data);
    if (s) { last = s; vscode.setState({ last }); toDeck(s); }
  }
});
// a document that loads again (an edit) is put back where the talk is
frame.addEventListener('load', () => { if (last) toDeck(last); });
vscode.postMessage({ type: 'ready' });
`;

/**
 * The shell page: a sandboxed frame for the deck and the one script above. Its
 * policy is the deck's with the script's nonce, so a deck's frame can never be
 * given more than the shell has.
 */
export async function shellHTML(o: { title: string; cspSource: string; nonce: string; scripts: string[] }): Promise<string> {
  const csp = policy([`'nonce-${o.nonce}'`, ...o.scripts].join(' '), o.cspSource);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(csp)}">` +
    `<title>${escapeAttr(o.title)}</title>` +
    `<style>html,body{margin:0;height:100%;background:#222}iframe{display:block;border:0;width:100%;height:100%;background:#fff}</style>` +
    `</head><body><iframe id="deck" sandbox="allow-scripts" referrerpolicy="no-referrer" title="${escapeAttr(o.title)}"></iframe>` +
    `<script nonce="${escapeAttr(o.nonce)}">${shellScript}</script></body></html>`
  );
}

/** The slide a position names in a deck's slide lines, or undefined. */
export function lineOf(lines: number[], index: number): number | undefined {
  return index >= 0 && index < lines.length ? lines[index] : undefined;
}

/** An unguessable nonce for a shell's script. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  let s = '';
  for (const x of b) {
    s += String.fromCharCode(x);
  }
  return btoa(s).replace(/[+/=]/g, '');
}
