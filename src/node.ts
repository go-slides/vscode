// The desktop entry (package.json "main"): everything, exporting included.
import type * as vscode from 'vscode';
import { activate as activateCommon, type Api } from './extension';
import { registerExport } from './export';

export function activate(context: vscode.ExtensionContext): Promise<Api> {
  return activateCommon(context, { registerExport });
}

export function deactivate(): void {}
