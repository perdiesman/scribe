import * as vscode from 'vscode';
import path from 'node:path';

export function assetRoot(document: vscode.Uri): vscode.Uri {
  return vscode.workspace.getWorkspaceFolder(document)?.uri ?? vscode.Uri.joinPath(document, '..');
}

export function resolveAsset(document: vscode.Uri, resource: string): vscode.Uri {
  if (!resource || /^[a-z][a-z\d+.-]*:/i.test(resource) || resource.startsWith('//')) {
    throw new Error('Only relative workspace image paths are available locally.');
  }
  const decoded = decodeURIComponent(resource.split(/[?#]/)[0]);
  if (decoded.includes('\0') || decoded.includes('\\')) throw new Error('Invalid asset path.');
  const base = vscode.Uri.joinPath(document, '..');
  const uri = base.with({ path: path.posix.resolve(base.path, decoded) });
  const root = assetRoot(document);
  if (uri.path !== root.path && !uri.path.startsWith(root.path.replace(/\/$/, '') + '/')) {
    throw new Error('Images must be inside the document workspace or folder.');
  }
  return uri;
}

const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif' };

export async function checkedAsset(document: vscode.Uri, resource: string): Promise<vscode.Uri> {
  const uri = resolveAsset(document, resource), root = assetRoot(document);
  const relative = path.posix.relative(root.path, uri.path);
  let current = root;
  for (const segment of relative.split('/').filter(Boolean)) {
    current = vscode.Uri.joinPath(current, segment);
    const stat = await vscode.workspace.fs.stat(current);
    if (stat.type & vscode.FileType.SymbolicLink) throw new Error('Linked assets are not read; use a file inside the workspace.');
  }
  return uri;
}

export async function embeddedImages(html: string, document: vscode.Uri, pdf: boolean) {
  const warnings: string[] = [];
  const sources = [...new Set(Array.from(html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g), match => match[1]))];
  for (const encoded of sources) {
    const source = encoded.replace(/&amp;/g, '&').replace(/&#x22;/g, '"').replace(/&#x27;/g, "'");
    if (/^https?:\/\//i.test(source)) {
      warnings.push(`${source}: ${pdf ? 'remote images are blocked in PDF export' : 'requires a network connection'}`);
      if (pdf) html = html.split(`src="${encoded}"`).join('data-missing-image="remote"');
      continue;
    }
    try {
      const uri = await checkedAsset(document, source);
      const type = mime[path.posix.extname(uri.path).toLowerCase()];
      if (!type) throw new Error('Unsupported image format');
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 32 * 1024 * 1024) throw new Error('Image exceeds 32 MB');
      const bytes = await vscode.workspace.fs.readFile(uri);
      html = html.split(`src="${encoded}"`).join(`src="data:${type};base64,${Buffer.from(bytes).toString('base64')}"`);
    } catch (error) {
      warnings.push(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      html = html.split(`src="${encoded}"`).join('data-missing-image="local"');
    }
  }
  return { html, warnings };
}
