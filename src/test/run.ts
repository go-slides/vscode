// Launches VS Code (downloaded by @vscode/test-electron) with the extension
// under development and the fixtures folder, and runs suite.ts inside it.
//
// COMPARE_MARP=1 also installs Marp for VS Code from the Marketplace, and
// the suite then times its preview on the same deck.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..');
  // VS Code's IPC socket lives in the user data directory, and a socket
  // path is limited to 103 bytes on macOS: keep it short.
  const data = mkdtempSync(path.join(tmpdir(), 'gs-'));
  const extensionsDir = path.join(data, 'x');
  const vscodeExecutablePath = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
  const compare = process.env.COMPARE_MARP === '1';
  if (compare) {
    const [cli, ...args] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);
    const r = spawnSync(cli, [...args, '--extensions-dir', extensionsDir, '--install-extension', 'marp-team.marp-vscode'], { stdio: 'inherit', shell: false });
    if (r.status !== 0) {
      throw new Error('installing marp-team.marp-vscode failed');
    }
  }
  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [
      path.join(root, 'test', 'fixtures'),
      ...(compare ? [] : ['--disable-extensions']),
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--user-data-dir',
      path.join(data, 'u'),
      '--extensions-dir',
      extensionsDir,
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
