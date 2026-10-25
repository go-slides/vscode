// The presenting panels' shell page in headless Chrome, with the real engine's
// pages (dist/slides.wasm) and a stand-in for VS Code's webview API. It checks
// what cannot be seen from inside VS Code: that the deck's frame runs under the
// policy (its scripts by hash, a deck's own refused, no network, an opaque
// origin, no VS Code API), that the viewer's three views work in it, and that the
// messages the host relays reach the page and back.
//
//   node test/shell.cjs     (CHROME names the browser; NODE_PATH finds puppeteer-core)
//
// Run after `npm run build:go` (it needs dist/slides.wasm and src/gen/wasm_exec.js)
// and `npm run build:panel`.
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-core");

const root = path.join(__dirname, "..");
require(path.join(root, "src/gen/wasm_exec.js"));
const panel = require(path.join(root, "dist/test/panel.cjs"));

const fail = (m) => { console.error("FAIL " + m); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cspSource = "https://example.vscode-cdn.net";

const DECK = "---\nslides: true\ntheme: default\n---\n\n# One\n\nfirst slide\n\n---\n\n# Two\n\nsecond slide\n\n<!-- a note for the speaker -->\n";
const OWN = "<script>window.__pwn=1;document.title='pwned'</script>";

async function engine() {
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(path.join(root, "dist/slides.wasm")), go.importObject);
  void go.run(instance);
  return (method, req) => JSON.parse(globalThis.goSlides.call(method, JSON.stringify(req))).result;
}

(async () => {
  const call = await engine();
  const present = async (source, view, html) => {
    const r = call("present", { path: "/w/deck.md", source, view, html });
    if (!r.page) fail("no page for " + view + ": " + JSON.stringify(r.diagnostics));
    return panel.frameDoc(r.page, r.scripts, cspSource, undefined).then((d) => ({ ...d, lines: r.lines }));
  };
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: "new",
    args: ["--no-sandbox"],
  });
  const log = [];
  // SHELL_SHOTS names a directory (outside every repository) to write screenshots to
  const shot = async (page, name) => {
    if (!process.env.SHELL_SHOTS) return;
    await page.setViewport({ width: 1000, height: 640 });
    await sleep(300);
    await page.screenshot({ path: path.join(process.env.SHELL_SHOTS, `panel-${name}.png`) });
  };

  // a shell, with the stand-in for acquireVsCodeApi; `out` collects what it posts to the host
  const shell = async (scripts) => {
    const page = await browser.newPage();
    page.on("pageerror", (e) => fail("pageerror: " + e.message));
    const violations = [];
    await page.exposeFunction("__violation", (v) => violations.push(v));
    await page.evaluateOnNewDocument(() => {
      document.addEventListener("securitypolicyviolation", (e) => window.__violation(e.violatedDirective + " " + e.blockedURI));
      // the shell only: VS Code gives its webview's API to that page, not to a frame in it
      if (window !== window.top) return;
      window.__out = [];
      window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__out.push(m), getState: () => window.__state, setState: (s) => (window.__state = s) });
    });
    // a data: URL, so that the stand-in above runs before the page's own script
    const html = await panel.shellHTML({ title: "Slides: deck.md", cspSource, nonce: panel.newNonce(), scripts });
    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html));
    return { page, violations };
  };
  const out = (page) => page.evaluate(() => window.__out.splice(0));
  const deckFrame = async (page) => {
    for (let i = 0; i < 100; i++) {
      const f = page.frames().find((x) => x !== page.mainFrame());
      if (f) {
        try {
          if (await f.evaluate(() => document.readyState === "complete" && !!document.querySelector("svg[data-marpit-svg]"))) return f;
        } catch {}
      }
      await sleep(50);
    }
    fail("the deck's frame did not load");
  };
  const toShell = (page, m) => page.evaluate((x) => window.postMessage(x, "*"), m);
  const active = (f) => f.evaluate(() => [...document.querySelectorAll("div.marpit > svg[data-marpit-svg]")].findIndex((s) => s.classList.contains("active")));

  // --- the slides view ---------------------------------------------------------------
  {
    const doc = await present(DECK, "", false);
    const { page, violations } = await shell(doc.scripts);
    if (!(await out(page)).some((m) => m.type === "ready")) fail("the shell did not say ready");
    await toShell(page, { type: "doc", html: doc.doc });
    const f = await deckFrame(page);
    if (violations.length) fail("the deck's own scripts are refused: " + violations.join("; "));
    // isolation: opaque origin, no VS Code API, no network, no reaching the shell
    const iso = await f.evaluate(async () => {
      let net = "allowed", parentDoc = "allowed";
      try { await fetch("https://example.com/", { mode: "no-cors" }); } catch { net = "refused"; }
      try { void parent.document.body; } catch { parentDoc = "refused"; }
      return { origin: window.origin, api: typeof acquireVsCodeApi, net, parentDoc };
    });
    if (iso.origin !== "null" || iso.api !== "undefined" || iso.net !== "refused" || iso.parentDoc !== "refused") fail("the deck's frame is not isolated: " + JSON.stringify(iso));
    if ((await active(f)) !== 0) fail("the slides start on the first slide");
    // the page's own keys: a position goes to the host
    await page.focus("#deck");
    await page.keyboard.press("ArrowRight");
    await sleep(200);
    const sync = (await out(page)).filter((m) => m.type === "sync");
    if (sync.length !== 1 || sync[0].data.index !== 1 || sync[0].data.fragmentIndex !== 0) fail("a slide change is told to the host: " + JSON.stringify(sync));
    // the host moves the page
    await toShell(page, { type: "sync", data: { index: 0, fragmentIndex: 0 } });
    await sleep(200);
    if ((await active(f)) !== 0) fail("the host's position moves the page");
    if ((await out(page)).some((m) => m.type === "sync")) fail("a position from the host must not be echoed back");
    // an edit reloads the document: the page is put back where the talk is
    await toShell(page, { type: "sync", data: { index: 1, fragmentIndex: 0 } });
    await sleep(150);
    await toShell(page, { type: "doc", html: doc.doc });
    await sleep(500);
    const f2 = await deckFrame(page);
    if ((await active(f2)) !== 1) fail("a reloaded page returns to where the talk was: " + (await active(f2)));
    // p asks for the presenter view
    await page.focus("#deck");
    await page.keyboard.press("p");
    await sleep(200);
    if (!(await out(page)).some((m) => m.type === "present")) fail("the p key asks the host for the presenter view");
    // nothing the host says can break the shell
    for (const bad of [null, 1, "x", { type: "doc" }, { type: "doc", html: 5 }, { type: "sync", data: { index: -1, fragmentIndex: 0 } }, { type: "sync", data: { index: "1", fragmentIndex: 0 } }, { type: "sync" }, { type: "nope" }]) {
      await toShell(page, bad);
    }
    await sleep(100);
    if ((await active(await deckFrame(page))) !== 1) fail("a malformed message moved the page");
    // a page the deck's frame posts that is not a position or a request is dropped
    await f2.evaluate(() => { parent.postMessage({ slidesSync: { index: 99999999, fragmentIndex: 0 } }, "*"); parent.postMessage({ type: "close" }, "*"); parent.postMessage({ other: 1 }, "*"); });
    await sleep(150);
    if ((await out(page)).length) fail("the shell passes on what the deck's frame says beyond a position and two requests");
    await page.close();
    log.push("slides: isolated, relays positions both ways, restored after a reload, asks for the presenter view");
  }

  // --- a deck's own script, with raw HTML allowed -----------------------------------------
  {
    const doc = await present(DECK + "\n" + OWN + "\n", "", true);
    if (!doc.doc.includes(OWN)) fail("html: true should keep the deck's script in the page (the test is not testing)");
    const { page, violations } = await shell(doc.scripts);
    await toShell(page, { type: "doc", html: doc.doc });
    const f = await deckFrame(page);
    await sleep(200);
    if (await f.evaluate(() => window.__pwn === 1 || document.title === "pwned")) fail("a deck's own script ran");
    if (!violations.some((v) => v.startsWith("script-src"))) fail("the deck's script was not refused by the policy: " + JSON.stringify(violations));
    await page.close();
    log.push("a deck's own script is refused by the policy, with raw HTML allowed");
  }

  // --- the presenter view -------------------------------------------------------------------
  {
    const doc = await present(DECK, "presenter", false);
    const { page, violations } = await shell(doc.scripts);
    await toShell(page, { type: "doc", html: doc.doc });
    const f = await deckFrame(page);
    if (violations.length) fail("the presenter view is refused by the policy: " + violations.join("; "));
    const pv = await f.evaluate(() => ({ view: document.body.dataset.slidesView, notes: document.body.textContent.includes("a note for the speaker") }));
    if (pv.view !== "presenter") fail("not the presenter view: " + JSON.stringify(pv));
    await toShell(page, { type: "sync", data: { index: 1, fragmentIndex: 0 } });
    await sleep(300);
    if (!(await f.evaluate(() => document.body.textContent.includes("a note for the speaker")))) fail("the presenter view shows the speaker's notes of the slide it is on");
    await shot(page, "presenter");
    await page.close();
    log.push("presenter: the speaker's view, its notes follow the slide the host says");
  }

  // --- the overview ---------------------------------------------------------------------------
  {
    const doc = await present(DECK, "overview", false);
    const { page, violations } = await shell(doc.scripts);
    await toShell(page, { type: "doc", html: doc.doc });
    const f = await deckFrame(page);
    if (violations.length) fail("the overview is refused by the policy: " + violations.join("; "));
    if ((await f.evaluate(() => document.body.dataset.slidesView)) !== "overview") fail("not the overview");
    await out(page);
    const second = await f.$$("div.marpit > svg[data-marpit-svg]");
    await second[1].click();
    await sleep(300);
    const sync = (await out(page)).filter((m) => m.type === "sync");
    if (!sync.length || sync[sync.length - 1].data.index !== 1) fail("choosing a slide in the overview is told to the host: " + JSON.stringify(sync));
    await shot(page, "overview");
    await page.focus("#deck");
    await page.keyboard.press("Escape");
    await sleep(200);
    if (!(await out(page)).some((m) => m.type === "close")) fail("Escape in the overview asks the host to close it");
    await page.close();
    log.push("overview: a chosen slide is told to the host, Escape closes");
  }

  // --- the shell's own policy ------------------------------------------------------------------
  {
    const { page } = await shell([]);
    const shellCSP = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
    if (/unsafe-eval|allow-same-origin|script-src[^;]*unsafe-inline|default-src (?!'none')/.test(shellCSP)) fail("the shell's policy is loose: " + shellCSP);
    const sandbox = await page.evaluate(() => document.getElementById("deck").getAttribute("sandbox"));
    if (sandbox !== "allow-scripts") fail("the deck's frame sandbox is " + sandbox);
    await page.close();
    log.push("the shell: sandbox=allow-scripts, no unsafe-eval or unsafe-inline scripts");
  }

  await browser.close();
  console.log("SHELL_OK\n" + log.join("\n"));
})();
