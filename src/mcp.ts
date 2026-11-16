// github-core-clone-01: MCP at /mcp — JSON-RPC 2.0 over Streamable HTTP, plain JSON
// responses. Both eras are served: the modern 2026-07-28 `server/discover` (no
// handshake, no session) and the legacy `initialize` + `notifications/initialized`.
// Tools act on the same store as REST, so ids are stable across reads.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './gitobj.ts';
import { findMergeBase, flattenTree, readBody, sendJson, threeWayMerge, buildTreeFromFlat, createCommit, type RestContext } from './rest.ts';
import { VIEWER_ID, VIEWER_LOGIN, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, { readonly type: string; readonly description: string }>;
    readonly required: string[];
  };
}

const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
      },
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: [],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, "owner/repo".' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
        number: { type: 'integer', description: 'The pull request number (alias of pull_number).' },
      },
      required: [],
    },
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRepo(store: Store, args: Record<string, unknown>): Repo | null {
  let owner = typeof args.owner === 'string' ? args.owner : undefined;
  let repoName = typeof args.repo === 'string' ? args.repo : undefined;
  const fullName = typeof args.full_name === 'string' ? args.full_name : undefined;
  if ((!owner || !repoName) && fullName) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = fullName.slice(0, slash);
      repoName = fullName.slice(slash + 1);
    }
  }
  if (!owner || !repoName) return null;
  return store.getRepo(owner, repoName) ?? null;
}

function toolResult(data: unknown, isError = false): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return {
    content: [{ type: 'text', text }],
    structuredContent: isRecord(data) || Array.isArray(data) ? data : { result: data },
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function repoSummary(repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.id,
    node_id: store.globalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueSummary(issue: { id: number; number: number; title: string; body: string; state: string; labels: string[]; createdAt: string; updatedAt: string }, repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.globalIdFor('Issue', repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullSummary(pull: { id: number; number: number; title: string; body: string; state: string; headRef: string; headSha: string; baseRef: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; createdAt: string; updatedAt: string }, repo: Repo, store: Store): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: store.globalIdFor('PullRequest', repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (!repoName) return toolError('create_repo requires a name');
      const existing = store.getRepo(VIEWER_LOGIN, repoName);
      if (existing) return toolResult(repoSummary(existing, store));
      const repo = store.createRepo({
        name: repoName,
        description: typeof args.description === 'string' ? args.description : '',
        private: args.private === true,
      });
      return toolResult(repoSummary(repo, store));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      return toolResult(repoSummary(repo, store));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (!title) return toolError('create_issue requires a title');
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, { title, body });
      return toolResult(issueSummary(issue, repo, store));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
      return toolResult(list.map((issue) => issueSummary(issue, repo, store)));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!title || !head || !base) return toolError('create_pull_request requires a title, head and base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('head or base ref does not exist');
      const mergeBase = findMergeBase(repo, headSha, baseSha);
      let mergeable = false;
      if (mergeBase) {
        const headObject = repo.objects.get(headSha);
        const baseObject = repo.objects.get(baseSha);
        const mergeBaseObject = repo.objects.get(mergeBase);
        if (headObject && baseObject && mergeBaseObject) {
          mergeable = threeWayMerge(
            flattenTree(repo, parseCommit(mergeBaseObject.data).tree),
            flattenTree(repo, parseCommit(baseObject.data).tree),
            flattenTree(repo, parseCommit(headObject.data).tree),
          ) !== null;
        }
      }
      const pull = store.createPull(repo, {
        title,
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        headSha,
        baseRef: base,
        baseSha,
        mergeable,
      });
      return toolResult(pullSummary(pull, repo, store));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (!repo) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : typeof args.number === 'number' ? args.number : NaN;
      if (!Number.isFinite(number)) return toolError('merge_pull_request requires a pull_number');
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (!pull) return toolError('pull request not found');
      if (pull.state !== 'open') return toolError('pull request is not open');
      const currentHeadSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
      const currentBaseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
      const mergeBase = findMergeBase(repo, currentHeadSha, currentBaseSha);
      let merged: Map<string, { mode: string; oid: string }> | null = null;
      if (mergeBase) {
        const headObject = repo.objects.get(currentHeadSha);
        const baseObject = repo.objects.get(currentBaseSha);
        const mergeBaseObject = repo.objects.get(mergeBase);
        if (headObject && baseObject && mergeBaseObject) {
          merged = threeWayMerge(
            flattenTree(repo, parseCommit(mergeBaseObject.data).tree),
            flattenTree(repo, parseCommit(baseObject.data).tree),
            flattenTree(repo, parseCommit(headObject.data).tree),
          );
        }
      }
      if (!merged) return toolError('merge conflict');
      const treeOid = buildTreeFromFlat(repo, merged, store);
      const mergeOid = createCommit({ repo, treeOid, parents: [currentBaseSha], message: `${pull.title} (#${pull.number})`, store });
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      const { iso } = store.tick();
      pull.mergedAt = iso;
      pull.mergeCommitSha = mergeOid;
      pull.updatedAt = iso;
      return toolResult({ sha: mergeOid, merged: true, message: `${pull.title} (#${pull.number})`, pull: pullSummary(pull, repo, store) });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export async function handleMcp(
  context: RestContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/mcp') return false;
  const method = request.method ?? 'GET';
  if (method === 'DELETE') {
    // A legacy session goodbye; nothing is held, so it is a no-op.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
    return true;
  }
  if (method !== 'POST') {
    sendJson(response, 405, { message: 'Method Not Allowed' });
    return true;
  }
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendJson(response, 401, { message: 'Requires authentication' });
    return true;
  }
  const token = authHeader.slice('Bearer '.length);
  if (context.expectedToken !== '' && token !== context.expectedToken) {
    sendJson(response, 401, { message: 'Requires authentication' });
    return true;
  }
  const body = await readBody(request);
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(payload) || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
    sendJson(response, 400, { jsonrpc: '2.0', id: isRecord(payload) ? payload.id ?? null : null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = payload.id ?? null;
  const params = isRecord(payload.params) ? payload.params : {};
  const reply = (result: unknown): void => {
    sendJson(response, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(response, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  const capabilities = { tools: {} };
  switch (payload.method) {
    case 'server/discover': {
      reply({
        protocolVersion: SUPPORTED_VERSIONS[0],
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities,
        serverInfo,
      });
      return true;
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SUPPORTED_VERSIONS[0];
      const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      reply({
        protocolVersion: negotiated,
        capabilities,
        serverInfo,
      });
      // A legacy session id is returned when the client negotiates a pre-discover revision.
      response.setHeader('mcp-session-id', `session-${VIEWER_LOGIN}`);
      return true;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress': {
      // Notifications carry no id and expect no result; answer 202 with an empty body.
      response.writeHead(202, { 'Content-Type': 'application/json' });
      response.end('');
      return true;
    }
    case 'tools/list': {
      reply({ tools: TOOLS });
      return true;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) {
        replyError(-32602, `unknown tool ${name}`);
        return true;
      }
      const missing = tool.inputSchema.required.filter((property) => !(property in args) || args[property] === undefined || args[property] === '');
      if (missing.length) {
        reply({ ...toolError(`missing required argument(s): ${missing.join(', ')}`), isError: true });
        return true;
      }
      reply(callTool(context.store, name, args));
      return true;
    }
    case 'ping': {
      reply({});
      return true;
    }
    default: {
      replyError(-32601, `method not found: ${payload.method}`);
      return true;
    }
  }
}
