import path from 'node:path';
import { lstat, stat, readFile, writeFile, mkdir } from 'node:fs/promises';

// Only the URI and filesystem surface used by asset validation is mocked here.
export class Uri {
  constructor(public path: string) {}
  static file(value: string) { return new Uri(value); }
  static joinPath(uri: Uri, ...fragments: string[]) { return new Uri(path.posix.join(uri.path, ...fragments)); }
  with(change: { path: string }) { return new Uri(change.path); }
  toString() { return 'file://' + this.path; }
}
export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
let root: Uri | undefined;
export function workspaceRoot(uri?: Uri) { root = uri; }
export const workspace = {
  isTrusted: true,
  getWorkspaceFolder: (_uri: Uri) => root ? { uri: root } : undefined,
  fs: {
    async stat(uri: Uri) {
      const info = await stat(uri.path), link = await lstat(uri.path);
      return { size: info.size, type: (info.isDirectory() ? FileType.Directory : FileType.File) | (link.isSymbolicLink() ? FileType.SymbolicLink : 0) };
    },
    async readFile(uri: Uri) { return readFile(uri.path); },
    async writeFile(uri: Uri, bytes: Uint8Array) { await writeFile(uri.path, bytes); },
    async createDirectory(uri: Uri) { await mkdir(uri.path, { recursive: true }); },
  },
};

export class CancellationError extends Error {}
export const ProgressLocation = { Notification: 15 };
export const exportUI = { destination: undefined as Uri | undefined, progressActive: false, notifications: [] as { message: string; progressActive: boolean }[] };
export const window = {
  async showSaveDialog() { return exportUI.destination; },
  async withProgress<T>(_options: unknown, task: (progress: { report(value: unknown): void }, token: { isCancellationRequested: boolean; onCancellationRequested(callback: () => void): { dispose(): void } }) => Promise<T>) {
    exportUI.progressActive = true;
    try { return await task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }); }
    finally { exportUI.progressActive = false; }
  },
  showInformationMessage(message: string) {
    exportUI.notifications.push({ message, progressActive: exportUI.progressActive });
    return new Promise<undefined>(() => {});
  },
  async showWarningMessage(message: string) { exportUI.notifications.push({ message, progressActive: exportUI.progressActive }); return undefined; },
  async showTextDocument() {},
};
