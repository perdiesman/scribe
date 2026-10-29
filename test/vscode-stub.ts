import path from 'node:path';
import { lstat, stat, readFile } from 'node:fs/promises';

// Only the URI and filesystem surface used by asset validation is mocked here.
export class Uri {
  constructor(public path: string) {}
  static file(value: string) { return new Uri(value); }
  static joinPath(uri: Uri, ...fragments: string[]) { return new Uri(path.posix.join(uri.path, ...fragments)); }
  with(change: { path: string }) { return new Uri(change.path); }
}
export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
let root: Uri | undefined;
export function workspaceRoot(uri?: Uri) { root = uri; }
export const workspace = {
  getWorkspaceFolder: (_uri: Uri) => root ? { uri: root } : undefined,
  fs: {
    async stat(uri: Uri) {
      const info = await stat(uri.path), link = await lstat(uri.path);
      return { size: info.size, type: (info.isDirectory() ? FileType.Directory : FileType.File) | (link.isSymbolicLink() ? FileType.SymbolicLink : 0) };
    },
    async readFile(uri: Uri) { return readFile(uri.path); },
  },
};
