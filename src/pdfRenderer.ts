// Puppeteer serializes this function into Chromium: keep it independent of extension-host variables.
export async function waitForRenderer(): Promise<number> {
  const ready = (globalThis as unknown as { scribeReady?: Promise<void> }).scribeReady;
  if (!ready) throw new Error('The document renderer did not initialize.');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('Document rendering timed out.')), 30_000); })]);
  } finally { clearTimeout(timeout); }
  return globalThis.document.querySelectorAll('.render-error').length;
}
