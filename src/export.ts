// Exporting, desktop only: runs the installed slides command, which writes
// HTML, vector PDF, editable PPTX/ODP and PNG/JPEG without a browser. The
// export engine is not in the WebAssembly module: compiled to wasm it is
// three times its size (cmd/build measure; see the README).
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

const installCommand = 'go install github.com/go-slides/slides/cmd/slides@latest';

const formats: Record<string, { label: string; ext: string[] }> = {
  html: { label: 'HTML presentation', ext: ['html'] },
  pdf: { label: 'PDF (vector)', ext: ['pdf'] },
  pptx: { label: 'PowerPoint (editable)', ext: ['pptx'] },
  odp: { label: 'OpenDocument presentation (editable)', ext: ['odp'] },
  png: { label: 'PNG image (first slide)', ext: ['png'] },
  jpeg: { label: 'JPEG image (first slide)', ext: ['jpg', 'jpeg'] },
};

function config() {
  return vscode.workspace.getConfiguration('goSlides');
}

/** The slides command: goSlides.cliPath (a machine setting, never the workspace's), else slides on PATH. */
function cli(): string {
  return config().get<string>('cliPath', '') || 'slides';
}

function run(file: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, timeout: 5 * 60_000, maxBuffer: 16 << 20, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function requireTrust(): Promise<boolean> {
  if (vscode.workspace.isTrusted) {
    return true;
  }
  const manage = 'Manage Workspace Trust...';
  if ((await vscode.window.showErrorMessage('go-slides exports by running the slides command, which needs a trusted workspace.', manage)) === manage) {
    void vscode.commands.executeCommand('workbench.trust.manage');
  }
  return false;
}

async function install(): Promise<void> {
  if (!(await requireTrust())) {
    return;
  }
  const t = vscode.window.createTerminal({ name: 'go-slides: install', cwd: homedir() });
  t.show();
  t.sendText(installCommand);
}

/** Checks the command runs; offers to install it when it does not. */
async function found(): Promise<boolean> {
  try {
    await run(cli(), ['version'], homedir());
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    const why = code === 'ENOENT' ? `"${cli()}" was not found` : `"${cli()} version" failed`;
    const choice = await vscode.window.showErrorMessage(
      `go-slides exports with the slides command, and ${why}. Install it with "${installCommand}" (Go 1.27), or set goSlides.cliPath.`,
      'Install with go install',
      'Open Settings',
    );
    if (choice === 'Install with go install') {
      await install();
    } else if (choice === 'Open Settings') {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'goSlides.cliPath');
    }
    return false;
  }
}

async function exportDeck(): Promise<void> {
  if (!(await requireTrust())) {
    return;
  }
  const doc = vscode.window.activeTextEditor?.document;
  if (!doc || doc.languageId !== 'markdown') {
    void vscode.window.showWarningMessage('go-slides: open a Markdown deck to export it.');
    return;
  }
  if (doc.uri.scheme !== 'file') {
    void vscode.window.showErrorMessage('go-slides: exporting needs the deck on disk; save it to a local file first.');
    return;
  }
  if (doc.isDirty && !(await doc.save())) {
    return;
  }
  if (!(await found())) {
    return;
  }
  const first = config().get<string>('exportType', 'pdf');
  const order = [first, ...Object.keys(formats).filter((f) => f !== first)];
  const filters: Record<string, string[]> = {};
  for (const f of order) {
    if (formats[f]) {
      filters[formats[f].label] = formats[f].ext;
    }
  }
  const deck = doc.uri.fsPath;
  const ext = formats[first]?.ext[0] ?? 'pdf';
  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(deck.slice(0, deck.length - path.extname(deck).length) + '.' + ext),
    filters,
    saveLabel: 'Export',
    title: 'Export slide deck',
  });
  if (!target) {
    return;
  }
  const args = ['-o', target.fsPath];
  if (config().get<boolean>('html', false)) {
    args.push('--html');
  }
  args.push(deck);
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `go-slides: exporting to ${path.basename(target.fsPath)}...` },
      () => run(cli(), args, path.dirname(deck)),
    );
  } catch (e) {
    const err = e as Error & { stderr?: string };
    void vscode.window.showErrorMessage(`go-slides: export failed: ${(err.stderr || err.message).trim()}`);
    return;
  }
  if (config().get<boolean>('exportAutoOpen', true)) {
    void vscode.env.openExternal(target);
  } else {
    void vscode.window.showInformationMessage(`go-slides: exported to ${target.fsPath}.`);
  }
}

export function registerExport(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('goSlides.export', exportDeck),
    vscode.commands.registerCommand('goSlides.installCli', install),
  );
}
