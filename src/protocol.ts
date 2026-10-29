export type Profile = 'github' | 'gitlab';
export interface Settings { autoFormatMarkdown: boolean; profile: Profile }
export interface Snapshot {
  type: 'document'; source: string; version: number; settings: Settings; acknowledgment?: number;
}
export type HostMessage = Snapshot | { type: 'settings'; settings: Settings }
  | { type: 'reveal'; block: number; select?: boolean } | { type: 'status'; text: string; error?: boolean }
  | { type: 'asset'; request: number; uri?: string; error?: string };
export type EditorMessage = { type: 'ready' }
  | { type: 'profile'; profile: Profile }
  | { type: 'edit'; version: number; sequence: number; markdown: string }
  | { type: 'command'; command: 'source' | 'split' | 'normalize' | 'auto' | 'html' | 'pdf' }
  | { type: 'copy'; text: string }
  | { type: 'recover'; markdown: string }
  | { type: 'history'; direction: 'undo' | 'redo' }
  | { type: 'reveal'; block: number; select?: boolean }
  | { type: 'link'; href: string }
  | { type: 'asset'; request: number; path: string };

export interface EditChain { version: number; sequence: number; bases: Set<number> }

/** Accept queued local edits only while the source still follows this editor's own changes. */
export function editBases(edit: Extract<EditorMessage, { type: 'edit' }>, currentVersion: number, chain?: EditChain): Set<number> | undefined {
  if (chain && edit.sequence <= chain.sequence) return;
  const follows = chain?.version === currentVersion && chain.bases.has(edit.version);
  if (edit.version !== currentVersion && !follows) return;
  const bases = new Set<number>(follows ? chain!.bases : []);
  for (const base of bases) if (base < edit.version) bases.delete(base);
  bases.add(edit.version);
  return bases;
}

export function validMessage(value: unknown): value is EditorMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as Record<string, unknown>;
  const integer = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  switch (msg.type) {
    case 'ready': return true;
    case 'profile': return msg.profile === 'github' || msg.profile === 'gitlab';
    case 'edit': return integer(msg.version) && integer(msg.sequence) && typeof msg.markdown === 'string';
    case 'command': return typeof msg.command === 'string' && ['source', 'split', 'normalize', 'auto', 'html', 'pdf'].includes(msg.command);
    case 'copy': return typeof msg.text === 'string';
    case 'recover': return typeof msg.markdown === 'string';
    case 'history': return msg.direction === 'undo' || msg.direction === 'redo';
    case 'reveal': return integer(msg.block) && (msg.select === undefined || typeof msg.select === 'boolean');
    case 'link': return typeof msg.href === 'string';
    case 'asset': return integer(msg.request) && typeof msg.path === 'string';
    default: return false;
  }
}
