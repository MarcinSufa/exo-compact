export async function captureBeforeNext<T>(capture: () => Promise<void>, next: () => Promise<T>, onError: () => void): Promise<T> {
  const result = await next();
  try { await capture(); } catch { onError(); }
  return result;
}
