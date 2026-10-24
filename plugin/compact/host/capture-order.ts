export async function captureBeforeNext<T>(capture: () => Promise<void>, next: () => Promise<T>, onError: () => void): Promise<T> {
  try { await capture(); } catch { onError(); }
  return next();
}
