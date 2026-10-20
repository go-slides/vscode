// The web entry (package.json "browser", vscode.dev): preview, diagnostics
// and completion. Exporting runs a program, which a browser cannot.
import * as vscode from 'vscode';
import { activate as activateCommon, type Api } from './extension';

export function activate(context: vscode.ExtensionContext): Promise<Api> {
  return activateCommon(context, {
    registerExport(ctx) {
      const unavailable = () =>
        vscode.window.showInformationMessage('go-slides: exporting runs the slides command, which VS Code for the Web cannot. Use VS Code on the desktop, or run slides yourself.');
      ctx.subscriptions.push(vscode.commands.registerCommand('goSlides.export', unavailable), vscode.commands.registerCommand('goSlides.installCli', unavailable));
    },
  });
}

export function deactivate(): void {}
