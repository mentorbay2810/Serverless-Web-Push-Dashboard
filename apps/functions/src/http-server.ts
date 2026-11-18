import { createServer, type Server } from 'node:http';

export type Handler = (request: Request) => Promise<Response>;
export function httpServer(handler: Handler) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 8192) {
          outgoing.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', 'Cache-Control': 'no-store' });
          outgoing.end(JSON.stringify({ error: 'Request is too large.' })); return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
      const request = new Request(`http://${incoming.headers.host ?? 'invalid'}${incoming.url}`, { method: incoming.method, headers,
        ...(size ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch {
      if (outgoing.destroyed || outgoing.writableEnded || outgoing.headersSent) return;
      outgoing.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ error: 'The local request could not be completed.' }));
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  return server;
}
export const listen = (server: Server, port: number, host: string) => new Promise<void>((resolve, reject) => {
  const failed = (error: Error) => { server.off('listening', ready); reject(error); };
  const ready = () => { server.off('error', failed); resolve(); };
  server.once('error', failed); server.once('listening', ready); server.listen(port, host);
});
export const close = (server: Server) => new Promise<void>(resolve => {
  if (!server.listening) { resolve(); return; }
  const timeout = setTimeout(() => server.closeAllConnections(), 15_000); timeout.unref();
  server.close(() => { clearTimeout(timeout); resolve(); });
});
