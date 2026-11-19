const configured = import.meta.env.VITE_API_ORIGIN?.trim() ?? '';
export function apiUrl(path: string) {
  if (!configured) return path;
  const origin = new URL(configured);
  if (origin.origin !== configured || (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname))) throw new Error('Invalid API origin configuration.');
  return new URL(path, origin).href;
}
