// github-core-clone-01: the forge's HTTP server. One process, one in-memory store; four
// surfaces read and write the same maps, so a repository created over REST is immediately
// fetchable over git smart HTTP and visible in GraphQL and MCP.
//
//   GET  /healthz                       the env's boot probe: 200 {"ok":true}
//   /{owner}/{repo}.git/*              git smart HTTP (upload-pack v2 + v0, receive-pack v0)
//   /api/v3/*                          REST v3
//   POST /api/graphql                  GraphQL v4
//   POST /mcp                          MCP (JSON-RPC 2.0, Streamable HTTP)
//
// Every reply is JSON and carries X-GitHub-Request-Id; the git surfaces answer with their
// own smart-HTTP content types. Auth is one bearer token (the process's MAKEFUN_SHOP_TOKEN);
// a request without it is 401.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './src/githttp.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';
import { handleRest, type RestContext } from './src/rest.ts';
import { Store } from './src/store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer one request with a JSON body; `headers` go beside the JSON ones. */
function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const context: RestContext = {
    store,
    expectedToken: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        // MCP: JSON-RPC 2.0 over Streamable HTTP.
        if (path === '/mcp') {
          if (await handleMcp(context, req, res, path)) return;
        }
        // GraphQL v4.
        if (path === '/api/graphql') {
          if (await handleGraphQL(context, req, res, path)) return;
        }
        // REST v3.
        if (path.startsWith('/api/v3')) {
          if (await handleRest(context, req, res, path)) return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}.
        if (/^\/[^/]+\/[^/]+\.git\//.test(path)) {
          if (await handleGitHttp(context, req, res, path)) return;
        }
        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // A handler that throws must not kill the process: the suite proves the server stays
        // healthy after a malformed request, so answer 500 and keep serving.
        if (!res.headersSent) {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
