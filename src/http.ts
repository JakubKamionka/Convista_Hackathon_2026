import http from "http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./index";
import { cleanup } from "./lib/utils";
import { startSapConnection } from "./btp";

async function toWebRequest(req: http.IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const host = req.headers.host ?? "localhost";
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value])
      headers.append(name, v);
  }
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${host}${req.url}`, {
    method: req.method,
    headers,
    body,
  });
}

async function sendWebResponse(res: http.ServerResponse, response: Response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

export function serveHttp(port: number) {
  const handler = createMcpHandler(() => createServer());

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      await sendWebResponse(res, await handler.fetch(await toWebRequest(req)));
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });

  server.listen(port);

  const stop = async () => {
    server.close();
    await handler.close();
    cleanup();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  return server;
}

if (require.main === module) {
  // Fail fast: without a resolved SAP destination every tool call would fail.
  startSapConnection()
    .then(() => serveHttp(Number(process.env.PORT) || 8080))
    .catch((error: Error) => {
      console.error(`Failed to resolve SAP connection: ${error.message}`);
      process.exit(1);
    });
}
