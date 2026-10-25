// The relay between a talk's panels, and what a panel's messages may be, run
// under Node: nothing here needs VS Code (session.ts and panel.ts do not import
// it).
import * as assert from 'node:assert/strict';
import { frameDoc, hashOf, lineOf, newNonce, parseFromShell, policy, shellHTML, type PanelKind, type Sync } from '../panel';
import { Session, type Host, type Panel } from '../session';

class Fake implements Panel {
  synced: Sync[] = [];
  revealed = 0;
  shown = 0;
  closed = false;
  constructor(
    readonly kind: PanelKind,
    private readonly onClose: () => void,
  ) {}
  sync(at: Sync) {
    this.synced.push(at);
  }
  reveal() {
    this.revealed++;
  }
  show() {
    this.shown++;
  }
  close() {
    this.closed = true;
    this.onClose();
  }
}

function talk() {
  const panels = new Map<PanelKind, Fake>();
  const sources: number[] = [];
  const host: Host = {
    open: (kind) => {
      const p = new Fake(kind, () => session.closed(kind));
      panels.set(kind, p);
      return p;
    },
    revealSource: (i) => sources.push(i),
  };
  const session = new Session(host);
  return { session, panels, sources };
}

const at = (index: number, fragmentIndex = 0): Sync => ({ index, fragmentIndex });

async function main() {
  // a position one panel reports is the others' position; not its own
  {
    const { session, panels } = talk();
    session.open('slides');
    session.open('presenter');
    session.receive('slides', { type: 'sync', data: at(3, 1) });
    assert.deepEqual(panels.get('presenter')!.synced, [at(3, 1)]);
    assert.deepEqual(panels.get('slides')!.synced, []);
    session.receive('presenter', { type: 'sync', data: at(4) });
    assert.deepEqual(panels.get('slides')!.synced, [at(4)]);
    assert.deepEqual(session.last, at(4));
  }
  // opening a panel again brings it forward, it does not make a second one
  {
    const { session, panels } = talk();
    const a = session.open('overview');
    assert.equal(session.open('overview'), a);
    assert.equal(panels.get('overview')!.revealed, 1);
    assert.equal(session.size, 1);
  }
  // a page that has loaded is shown, and told where the talk is
  {
    const { session, panels } = talk();
    session.open('slides');
    session.receive('slides', { type: 'ready' });
    assert.equal(panels.get('slides')!.shown, 1);
    assert.deepEqual(panels.get('slides')!.synced, []);
    session.receive('slides', { type: 'sync', data: at(2) });
    session.open('presenter');
    session.receive('presenter', { type: 'ready' });
    assert.equal(panels.get('presenter')!.shown, 1);
    assert.deepEqual(panels.get('presenter')!.synced, [at(2)]);
  }
  // the overview's choice is shown in the editor; the others' is not
  {
    const { session, sources } = talk();
    session.open('overview');
    session.open('slides');
    session.receive('overview', { type: 'sync', data: at(5) });
    session.receive('slides', { type: 'sync', data: at(6) });
    assert.deepEqual(sources, [5]);
  }
  // the slides page asks for the presenter view; no other panel may
  {
    const { session, panels } = talk();
    session.open('slides');
    session.receive('overview', { type: 'present' });
    assert.equal(panels.has('presenter'), false);
    session.receive('slides', { type: 'present' });
    assert.equal(panels.has('presenter'), true);
    session.receive('slides', { type: 'present' });
    assert.equal(panels.get('presenter')!.revealed, 1);
  }
  // the overview asks to be closed; no other panel may
  {
    const { session, panels } = talk();
    session.open('overview');
    session.open('slides');
    session.receive('slides', { type: 'close' });
    assert.equal(panels.get('slides')!.closed, false);
    session.receive('overview', { type: 'close' });
    assert.equal(panels.get('overview')!.closed, true);
    assert.equal(session.get('overview'), undefined);
    // a closed panel is not told anything
    session.receive('slides', { type: 'sync', data: at(1) });
    assert.deepEqual(panels.get('overview')!.synced, []);
    session.end();
    assert.equal(panels.get('slides')!.closed, true);
    assert.equal(session.size, 0);
  }
  // a message of a panel that is not open is nothing
  {
    const { session } = talk();
    session.receive('presenter', { type: 'ready' });
    session.receive('presenter', { type: 'sync', data: at(1) });
    assert.deepEqual(session.last, at(1));
  }

  // what a shell may say
  assert.deepEqual(parseFromShell({ type: 'ready' }), { type: 'ready' });
  assert.deepEqual(parseFromShell({ type: 'present', extra: 1 }), { type: 'present' });
  assert.deepEqual(parseFromShell({ type: 'sync', data: { index: 2, fragmentIndex: 0, more: 'x' } }), { type: 'sync', data: at(2) });
  for (const bad of [undefined, null, 1, 'ready', [], {}, { type: 'nope' }, { type: 'sync' }, { type: 'sync', data: {} }, { type: 'sync', data: at(-1) }, { type: 'sync', data: at(1.5) }, { type: 'sync', data: { index: '1', fragmentIndex: 0 } }, { type: 'sync', data: at(1e9) }, { type: 'sync', data: { index: NaN, fragmentIndex: 0 } }]) {
    assert.equal(parseFromShell(bad), undefined, JSON.stringify(bad));
  }
  assert.equal(lineOf([5, 9], 1), 9);
  assert.equal(lineOf([5, 9], 2), undefined);
  assert.equal(lineOf([5, 9], -1), undefined);

  // the policy: nothing loads but what a deck links; scripts only as named
  const csp = policy("'sha256-abc='", 'https://x.vscode-cdn.net');
  assert.match(csp, /^default-src 'none'; /);
  assert.match(csp, /script-src 'sha256-abc='; /);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|script-src[^;]*unsafe-inline|connect-src|\*/);

  // a hash is the CSP's: sha256 of the script's UTF-8, in base64
  assert.equal(await hashOf('alert(1)'), "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");

  // the frame's document: the policy first, then the base, then the shim; what the
  // engine named plus the shim, and nothing else
  const { doc, scripts } = await frameDoc('<!DOCTYPE html><html><head><title>t</title></head><body><script>x()</script></body></html>', ["'sha256-one='"], 'https://x.vscode-cdn.net', 'https://x.vscode-cdn.net/w/"><script>evil()</script>');
  assert.equal(scripts.length, 2);
  assert.ok(doc.indexOf('Content-Security-Policy') < doc.indexOf('<script>'), 'the policy comes before any script');
  const decoded = doc.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)); // what the browser reads of the attribute
  assert.ok(decoded.includes("script-src 'sha256-one=' " + scripts[1] + ';'));
  assert.ok(!doc.includes('<script>evil()'), 'the base is escaped');
  assert.ok(doc.includes('&#34;&#62;&#60;script&#62;evil'), 'the base is escaped as an attribute');
  assert.ok(doc.includes('<script>x()</script>'), 'the page is kept as it is');
  // a page with no head still gets its policy
  assert.ok((await frameDoc('<p>x</p>', [], 'c', undefined)).doc.startsWith('<meta http-equiv="Content-Security-Policy"'));

  // the shell: a sandboxed frame, one script by nonce, the policy with that nonce
  const nonce = newNonce();
  assert.match(nonce, /^[A-Za-z0-9]{16,}$/);
  assert.notEqual(nonce, newNonce());
  const shell = await shellHTML({ title: 'Slides: "a".md', cspSource: 'https://x.vscode-cdn.net', nonce, scripts: scripts });
  assert.ok(shell.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).includes(`script-src 'nonce-${nonce}' ${scripts.join(' ')};`));
  assert.ok(shell.includes('sandbox="allow-scripts"') && !shell.includes('allow-same-origin'));
  assert.equal((shell.match(/<script/g) ?? []).length, 1);
  assert.ok(shell.includes(`<script nonce="${nonce}">`));
  assert.ok(!shell.includes('Slides: "a"'), 'the title is escaped');

  console.log('SESSION_OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
