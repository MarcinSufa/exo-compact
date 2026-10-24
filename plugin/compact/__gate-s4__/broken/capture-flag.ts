export async function isCaptureEnabled(host: { cwd: () => Promise<string>; exists: (path: string) => Promise<boolean> }): Promise<boolean> {
  const cwd = await host.cwd();
  return host.exists(`${cwd.replace(/[\\/]+$/, '')}/.exovault/s4-compact-active`);
}
