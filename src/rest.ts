// github-core-clone-01: REST v3 under /api/v3. Every reply is JSON and carries
// X-GitHub-Request-Id. Auth is a single bearer token (the token in the process's
// MAKEFUN_SHOP_TOKEN); a request without it is 401, and a repository belongs to the
// login the token names, so the same name under another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObjectType,
} from './gitobj.ts';
import { VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

export interface RestContext {
  readonly store: Store;
  readonly expectedToken: string;
}

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function sendJson(response: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': nextRequestId(),
    ...extra,
  });
  response.end(payload);
}

export function sendNoContent(response: ServerResponse): void {
  response.writeHead(204, { 'X-GitHub-Request-Id': nextRequestId() });
  response.end();
}

function sendError(response: ServerResponse, status: number, message: string): void {
  sendJson(response, status, { message, documentation_url: 'https://docs.github.com/rest' });
}

export function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

export function isAuthenticated(context: RestContext, request: IncomingMessage): boolean {
  const token = bearerToken(request);
  if (token === null || token === '') return false;
  if (context.expectedToken !== '' && token !== context.expectedToken) return false;
  return true;
}

function baseOf(request: IncomingMessage): string {
  const host = request.headers.host ?? 'localhost';
  return `http://${host}`;
}

function repoJson(repo: Repo, request: IncomingMessage): Record<string, unknown> {
  const base = baseOf(request);
  return {
    id: repo.id,
    databaseId: repo.id,
    node_id: Buffer.from(`R:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User', html_url: `${base}/${repo.owner}` },
    private: repo.private,
    description: repo.description,
    fork: false,
    html_url: `${base}/${repo.owner}/${repo.name}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    watchers_count: 0,
    stargazers_count: 0,
    forks_count: 0,
  };
}

function labelJson(label: { id: number; name: string; color: string }): Record<string, unknown> {
  return { id: label.id, node_id: Buffer.from(`L:${label.id}`, 'utf8').toString('base64'), name: label.name, color: label.color, default: false };
}

function issueJson(issue: Issue, repo: Repo, request: IncomingMessage): Record<string, unknown> {
  const base = baseOf(request);
  return {
    id: issue.id,
    node_id: Buffer.from(`I:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((candidate) => candidate.name === name);
      return label ? labelJson(label) : { id: 0, name, color: '000000' };
    }),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function pullJson(pull: Pull, repo: Repo, request: IncomingMessage): Record<string, unknown> {
  const base = baseOf(request);
  return {
    id: pull.id,
    node_id: Buffer.from(`PR:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function refName(branch: string): string {
  return `refs/heads/${branch}`;
}

function listBranches(repo: Repo): { name: string; commit: { sha: string } }[] {
  const branches: { name: string; commit: { sha: string } }[] = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
  }
  branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return branches;
}

/** Flatten a tree object into path -> {mode, oid}, following nested trees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, currentPrefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = currentPrefix === '' ? entry.name : `${currentPrefix}/${entry.name}`;
      if (entry.mode === '40000') {
        walk(entry.oid, path);
      } else if (entry.mode !== '160000') {
        out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    }
  };
  walk(treeOid, prefix);
  return out;
}

/** Build a tree object from a flat path map; returns the tree oid. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>, store: Store): string {
  const nested = new Map<string, Map<string, { mode: string; oid: string }>>();
  const root = new Map<string, { mode: string; oid: string }>();
  nested.set('', root);
  const sortedPaths = [...flat.keys()].sort();
  for (const path of sortedPaths) {
    const parts = path.split('/');
    const fileName = parts[parts.length - 1];
    const dirPath = parts.slice(0, -1).join('/');
    let dir = nested.get(dirPath);
    if (!dir) {
      dir = new Map();
      nested.set(dirPath, dir);
    }
    dir.set(fileName, flat.get(path)!);
  }
  const buildDir = (dirPath: string): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const dir = nested.get(dirPath)!;
    for (const [name, value] of dir) entries.push({ mode: value.mode, name, oid: value.oid });
    // Add subdirectories that are not already represented as files.
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    for (const [otherPath] of nested) {
      if (otherPath === dirPath || otherPath === '') continue;
      if (!otherPath.startsWith(prefix)) continue;
      const rest = otherPath.slice(prefix.length);
      if (rest.includes('/')) continue;
      entries.push({ mode: '40000', name: rest, oid: buildDir(otherPath) });
    }
    const data = buildTree(entries);
    return store.addObject(repo, 'tree', data);
  };
  return buildDir('');
}

/**
 * A three-way tree merge: `base` is the merge base, `ours` and `theirs` are the two sides.
 * Returns the merged flat map, or null when both sides changed the same path differently.
 */
export function threeWayMerge(
  base: Map<string, { mode: string; oid: string }>,
  ours: Map<string, { mode: string; oid: string }>,
  theirs: Map<string, { mode: string; oid: string }>,
): Map<string, { mode: string; oid: string }> | null {
  const out = new Map<string, { mode: string; oid: string }>();
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const baseEntry = base.get(path);
    const ourEntry = ours.get(path);
    const theirEntry = theirs.get(path);
    const same = (a: { oid: string } | undefined, b: { oid: string } | undefined): boolean =>
      (a?.oid ?? null) === (b?.oid ?? null);
    if (same(ourEntry, theirEntry)) {
      if (ourEntry) out.set(path, ourEntry);
    } else if (same(ourEntry, baseEntry)) {
      if (theirEntry) out.set(path, theirEntry);
    } else if (same(theirEntry, baseEntry)) {
      if (ourEntry) out.set(path, ourEntry);
    } else {
      return null;
    }
  }
  return out;
}

/** Diff two flat trees: added / removed / modified paths, with line counts. */
export function diffTrees(
  repo: Repo,
  fromTree: string | null,
  toTree: string | null,
): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }[] {
  const from = fromTree ? flattenTree(repo, fromTree) : new Map<string, { mode: string; oid: string }>();
  const to = toTree ? flattenTree(repo, toTree) : new Map<string, { mode: string; oid: string }>();
  const out: { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number }[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const fromEntry = from.get(path);
    const toEntry = to.get(path);
    if (fromEntry && !toEntry) {
      out.push({ filename: path, status: 'removed', additions: 0, deletions: countLines(repo, fromEntry.oid) });
    } else if (!fromEntry && toEntry) {
      out.push({ filename: path, status: 'added', additions: countLines(repo, toEntry.oid), deletions: 0 });
    } else if (fromEntry && toEntry && fromEntry.oid !== toEntry.oid) {
      out.push({ filename: path, status: 'modified', additions: countLines(repo, toEntry.oid), deletions: countLines(repo, fromEntry.oid) });
    }
  }
  return out;
}

function countLines(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'blob') return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** Find a merge base of two commits (the newest common ancestor by commit depth). */
export function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOf = (start: string): Map<string, number> => {
    const seen = new Map<string, number>();
    const queue: { oid: string; depth: number }[] = [{ oid: start, depth: 0 }];
    while (queue.length) {
      const { oid, depth } = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.set(oid, depth);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: depth + 1 });
    }
    return seen;
  };
  const aAncestors = ancestorsOf(a);
  const bAncestors = ancestorsOf(b);
  let best: string | null = null;
  let bestDepth = Number.POSITIVE_INFINITY;
  for (const [oid, depth] of aAncestors) {
    if (bAncestors.has(oid) && depth < bestDepth) {
      best = oid;
      bestDepth = depth;
    }
  }
  return best;
}

/** Is `ancestor` an ancestor of `descendant` (or the same commit)? */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

interface CommitContext {
  readonly repo: Repo;
  readonly treeOid: string;
  readonly parents: string[];
  readonly message: string;
  readonly store: Store;
}

/** Create a commit object in the repo and return its oid. */
export function createCommit(context: CommitContext): string {
  const { epochSec } = context.store.tick();
  const identity = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid>`;
  const data = buildCommit({
    tree: context.treeOid,
    parents: context.parents,
    message: context.message,
    author: identity,
    committer: identity,
    timestamp: epochSec,
  });
  return context.store.addObject(context.repo, 'commit', data);
}

export async function handleRest(
  context: RestContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/v3')) return false;
  const store = context.store;

  if (!isAuthenticated(context, request)) {
    sendJson(response, 401, { message: 'Requires authentication', documentation_url: 'https://docs.github.com/rest' });
    return true;
  }

  const body = await readBody(request);
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
  const method = request.method ?? 'GET';
  const segments = pathname.split('/').filter((part) => part !== '');
  // segments[0] = 'api', segments[1] = 'v3', then the resource path.

  // GET /api/v3/ — the API root.
  if (segments.length === 2 && method === 'GET') {
    const base = baseOf(request);
    sendJson(response, 200, {
      current_user_url: `${base}/api/v3/user`,
      current_user_authorizations_html_url: `${base}/settings/applications`,
      authorizations_url: `${base}/api/v3/authorizations`,
      code_search_url: `${base}/api/v3/search/code?q={query}`,
      commit_search_url: `${base}/api/v3/search/commits?q={query}`,
      emails_url: `${base}/api/v3/user/emails`,
      emojis_url: `${base}/api/v3/emojis`,
      events_url: `${base}/api/v3/events`,
      feeds_url: `${base}/api/v3/feeds`,
      followers_url: `${base}/api/v3/user/followers`,
      following_url: `${base}/api/v3/user/following{/target}`,
      gists_url: `${base}/api/v3/gists{/gist_id}`,
      hub_url: `${base}/api/v3/hub`,
      issue_search_url: `${base}/api/v3/search/issues?q={query}`,
      issues_url: `${base}/api/v3/issues`,
      keys_url: `${base}/api/v3/user/keys`,
      label_search_url: `${base}/api/v3/search/labels?q={query}`,
      notifications_url: `${base}/api/v3/notifications`,
      organization_url: `${base}/api/v3/orgs/{org}`,
      organization_repositories_url: `${base}/api/v3/orgs/{org}/repos`,
      organization_teams_url: `${base}/api/v3/orgs/{org}/teams`,
      public_gists_url: `${base}/api/v3/gists/public`,
      rate_limit_url: `${base}/api/v3/rate_limit`,
      repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
      repository_search_url: `${base}/api/v3/search/repositories?q={query}`,
      current_user_repositories_url: `${base}/api/v3/user/repos{?type,page,per_page,sort}`,
      starred_url: `${base}/api/v3/user/starred{/owner}{/repo}`,
      starred_gists_url: `${base}/api/v3/gists/starred`,
      topic_search_url: `${base}/api/v3/search/topics?q={query}`,
      user_url: `${base}/api/v3/users/{user}`,
      user_organizations_url: `${base}/api/v3/user/orgs`,
      user_repositories_url: `${base}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
      user_search_url: `${base}/api/v3/search/users?q={query}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (segments.length === 3 && segments[2] === 'meta' && method === 'GET') {
    sendJson(response, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', github_enterprise_version: '3.0.0' });
    return true;
  }

  // GET /api/v3/user — the token's own user.
  if (segments.length === 3 && segments[2] === 'user' && method === 'GET') {
    const base = baseOf(request);
    sendJson(response, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      node_id: Buffer.from(`U:${VIEWER_ID}`, 'utf8').toString('base64'),
      type: 'User',
      name: 'ada iversen',
      email: `${VIEWER_LOGIN}@example.invalid`,
      html_url: `${base}/${VIEWER_LOGIN}`,
      url: `${base}/api/v3/users/${VIEWER_LOGIN}`,
      avatar_url: `${base}/${VIEWER_LOGIN}.png`,
    });
    return true;
  }

  // /api/v3/user/repos — list (GET) and create (POST).
  if (segments.length === 4 && segments[2] === 'user' && segments[3] === 'repos') {
    if (method === 'GET') {
      const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const all = store.listUserRepos();
      const start = (page - 1) * perPage;
      const slice = all.slice(start, start + perPage);
      const extra: Record<string, string> = {};
      const lastPage = Math.max(1, Math.ceil(all.length / perPage));
      if (page < lastPage) {
        const base = baseOf(request);
        extra.Link = `<${base}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}>; rel="next", <${base}/api/v3/user/repos?per_page=${perPage}&page=${lastPage}>; rel="last"`;
      }
      sendJson(response, 200, slice.map((repo) => repoJson(repo, request)), extra);
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(response, 400, 'Problems parsing JSON');
        return true;
      }
      const value = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof value.name === 'string' ? value.name : '';
      if (!name) {
        sendError(response, 422, 'Validation Failed: name is required');
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        sendError(response, 422, `Validation Failed: name already exists on this account`);
        return true;
      }
      const repo = store.createRepo({
        name,
        description: typeof value.description === 'string' ? value.description : '',
        private: value.private === true,
        defaultBranch: typeof value.default_branch === 'string' ? value.default_branch : 'main',
      });
      sendJson(response, 201, repoJson(repo, request));
      return true;
    }
  }

  // /api/v3/repos/{owner}/{repo} and below.
  if (segments.length >= 4 && segments[2] === 'repos') {
    const owner = decodeURIComponent(segments[3]);
    const repoName = decodeURIComponent(segments[4]);
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendError(response, 404, 'Not Found');
      return true;
    }
    const rest = segments.slice(5);

    // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(response, 200, repoJson(repo, request));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(response, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        if (typeof value.description === 'string') repo.description = value.description;
        if (typeof value.default_branch === 'string') repo.defaultBranch = value.default_branch;
        if (typeof value.private === 'boolean') repo.private = value.private;
        const { iso } = store.tick();
        repo.updatedAt = iso;
        sendJson(response, 200, repoJson(repo, request));
        return true;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        sendNoContent(response);
        return true;
      }
    }

    // POST /api/v3/repos/{o}/{r}/git/refs — create a reference.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(response, 400, 'Problems parsing JSON');
        return true;
      }
      const value = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof value.ref === 'string' ? value.ref : '';
      const sha = typeof value.sha === 'string' ? value.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) {
        sendError(response, 422, 'Validation Failed: ref and sha are required');
        return true;
      }
      if (!repo.objects.has(sha)) {
        sendError(response, 422, 'Validation Failed: sha does not exist');
        return true;
      }
      repo.refs.set(ref, sha);
      sendJson(response, 201, { ref, node_id: Buffer.from(`R:${ref}`, 'utf8').toString('base64'), url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`, object: { sha, type: 'commit', url: '' } });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/git/refs — list all refs.
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([ref, sha]) => ({
        ref,
        node_id: Buffer.from(`R:${ref}`, 'utf8').toString('base64'),
        url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: '' },
      }));
      sendJson(response, 200, refs);
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/git/refs/{ref...} — one ref (e.g. heads/{branch}).
    if (rest.length >= 3 && rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      const ref = `refs/${rest.slice(2).map((part) => decodeURIComponent(part)).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) {
        sendError(response, 404, 'Not Found');
        return true;
      }
      sendJson(response, 200, {
        ref,
        node_id: Buffer.from(`R:${ref}`, 'utf8').toString('base64'),
        url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/git/refs/${encodeURIComponent(ref)}`,
        object: { sha, type: 'commit', url: '' },
      });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      sendJson(response, 200, listBranches(repo));
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/branches/{branch} — one branch.
    if (rest.length === 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = decodeURIComponent(rest[1]);
      const sha = repo.refs.get(refName(branch));
      if (!sha) {
        sendError(response, 404, 'Not Found');
        return true;
      }
      sendJson(response, 200, { name: branch, commit: { sha }, protected: false });
      return true;
    }

    // GET /api/v3/repos/{o}/{r}/commits[?sha=]
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let start = shaParam ?? repo.refs.get(refName(repo.defaultBranch));
      if (!start) {
        sendJson(response, 200, []);
        return true;
      }
      // A branch name is accepted in place of a sha.
      if (!/^[0-9a-f]{40}$/.test(start)) {
        const branchRef = repo.refs.get(refName(start));
        if (!branchRef) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        start = branchRef;
      }
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [start];
      while (queue.length) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const commit = parseCommit(object.data);
        out.push({
          sha: oid,
          node_id: Buffer.from(`C:${oid}`, 'utf8').toString('base64'),
          commit: {
            message: commit.message,
            author: { name: commit.author.split(' <')[0] ?? '', email: '', date: '' },
            committer: { name: commit.committer.split(' <')[0] ?? '', email: '', date: '' },
            tree: { sha: commit.tree },
          },
          parents: commit.parents.map((parent) => ({ sha: parent })),
          url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
        });
        for (const parent of commit.parents) queue.push(parent);
      }
      sendJson(response, 200, out);
      return true;
    }

    // /contents/{path...}
    if (rest.length >= 2 && rest[0] === 'contents') {
      const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
      const refParam = query.get('ref');
      const branchRef = refParam ? repo.refs.get(refName(refParam)) : repo.refs.get(refName(repo.defaultBranch));
      if (method === 'GET') {
        const tip = branchRef;
        if (!tip) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        const tipObject = repo.objects.get(tip);
        if (!tipObject || tipObject.type !== 'commit') {
          sendError(response, 404, 'Not Found');
          return true;
        }
        const flat = flattenTree(repo, parseCommit(tipObject.data).tree);
        const exact = flat.get(path);
        if (exact) {
          const blob = repo.objects.get(exact.oid)!;
          sendJson(response, 200, {
            type: 'file',
            encoding: 'base64',
            size: blob.data.length,
            name: path.split('/').pop(),
            path,
            content: blob.data.toString('base64'),
            sha: exact.oid,
            url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}`,
            html_url: `${baseOf(request)}/${owner}/${repoName}/blob/${repo.defaultBranch}/${encodeURIComponent(path)}`,
          });
          return true;
        }
        const prefix = `${path}/`;
        const children = new Map<string, { type: string; sha: string; size: number }>();
        for (const [filePath, entry] of flat) {
          if (!filePath.startsWith(prefix)) continue;
          const restPath = filePath.slice(prefix.length);
          if (restPath.includes('/')) continue;
          const blob = repo.objects.get(entry.oid);
          children.set(restPath, { type: 'file', sha: entry.oid, size: blob ? blob.data.length : 0 });
        }
        // Subdirectories.
        const dirPrefix = prefix;
        const seenDirs = new Set<string>();
        for (const filePath of flat.keys()) {
          if (!filePath.startsWith(dirPrefix)) continue;
          const restPath = filePath.slice(dirPrefix.length);
          const slash = restPath.indexOf('/');
          if (slash > 0) {
            const dirName = restPath.slice(0, slash);
            if (!seenDirs.has(dirName)) {
              seenDirs.add(dirName);
              children.set(dirName, { type: 'dir', sha: '', size: 0 });
            }
          }
        }
        if (children.size === 0) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        const listing = [...children.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) => ({
          type: entry.type,
          size: entry.size,
          name,
          path: `${path}/${name}`,
          sha: entry.sha,
          url: `${baseOf(request)}/api/v3/repos/${owner}/${repoName}/contents/${encodeURIComponent(path)}/${encodeURIComponent(name)}`,
          html_url: `${baseOf(request)}/${owner}/${repoName}/tree/${repo.defaultBranch}/${encodeURIComponent(path)}/${encodeURIComponent(name)}`,
        }));
        sendJson(response, 200, listing);
        return true;
      }
      if (method === 'PUT') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(response, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const contentB64 = typeof value.content === 'string' ? value.content : '';
        const message = typeof value.message === 'string' ? value.message : `Update ${path}`;
        const providedSha = typeof value.sha === 'string' ? value.sha : undefined;
        // A `branch` in the body writes to that branch; otherwise the query `ref`, else the default branch.
        const bodyBranch = typeof value.branch === 'string' ? value.branch : undefined;
        const targetBranch = bodyBranch ?? refParam ?? repo.defaultBranch;
        const targetRef = refName(targetBranch);
        const tip = repo.refs.get(targetRef);
        if (!contentB64) {
          sendError(response, 422, 'Validation Failed: content is required');
          return true;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          sendError(response, 422, 'Validation Failed: content must be base64');
          return true;
        }
        let currentFlat = new Map<string, { mode: string; oid: string }>();
        let parent: string[] = [];
        let isUpdate = false;
        if (tip) {
          const tipObject = repo.objects.get(tip);
          if (tipObject && tipObject.type === 'commit') {
            currentFlat = flattenTree(repo, parseCommit(tipObject.data).tree);
            parent = [tip];
            if (currentFlat.has(path)) isUpdate = true;
          }
        }
        if (isUpdate && providedSha && currentFlat.get(path)!.oid !== providedSha) {
          sendError(response, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        if (!isUpdate && providedSha) {
          sendError(response, 422, 'Validation Failed: sha does not match (file does not exist)');
          return true;
        }
        const blobOid = store.addObject(repo, 'blob', content);
        const nextFlat = new Map(currentFlat);
        nextFlat.set(path, { mode: '100644', oid: blobOid });
        const treeOid = buildTreeFromFlat(repo, nextFlat, store);
        const commitOid = createCommit({ repo, treeOid, parents: parent, message, store });
        repo.refs.set(targetRef, commitOid);
        const { iso } = store.tick();
        repo.updatedAt = iso;
        sendJson(response, isUpdate ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, encoding: 'base64', type: 'file' },
          commit: { sha: commitOid, message, author: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` }, committer: { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid` } },
        });
        return true;
      }
      if (method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(response, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const message = typeof value.message === 'string' ? value.message : `Delete ${path}`;
        const providedSha = typeof value.sha === 'string' ? value.sha : undefined;
        const tip = branchRef;
        if (!tip) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        const tipObject = repo.objects.get(tip);
        if (!tipObject || tipObject.type !== 'commit') {
          sendError(response, 404, 'Not Found');
          return true;
        }
        const currentFlat = flattenTree(repo, parseCommit(tipObject.data).tree);
        if (!currentFlat.has(path)) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        if (providedSha && currentFlat.get(path)!.oid !== providedSha) {
          sendError(response, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        const nextFlat = new Map(currentFlat);
        nextFlat.delete(path);
        const treeOid = buildTreeFromFlat(repo, nextFlat, store);
        const commitOid = createCommit({ repo, treeOid, parents: [tip], message, store });
        repo.refs.set(refName(repo.defaultBranch), commitOid);
        sendJson(response, 200, {
          commit: { sha: commitOid, message },
        });
        return true;
      }
    }

    // POST /api/v3/repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels' && method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(response, 400, 'Problems parsing JSON');
        return true;
      }
      const value = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof value.name === 'string' ? value.name : '';
      const color = typeof value.color === 'string' ? value.color : '000000';
      if (!name) {
        sendError(response, 422, 'Validation Failed: name is required');
        return true;
      }
      const label = store.createLabel(repo, name, color);
      sendJson(response, 201, labelJson(label));
      return true;
    }
    if (rest.length === 1 && rest[0] === 'labels' && method === 'GET') {
      sendJson(response, 200, repo.labels.map(labelJson));
      return true;
    }

    // /issues
    if (rest.length >= 1 && rest[0] === 'issues') {
      // POST /issues — create.
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(response, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof value.title === 'string' ? value.title : '';
        if (!title) {
          sendError(response, 422, 'Validation Failed: title is required');
          return true;
        }
        const labels = Array.isArray(value.labels) ? value.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.some((candidate) => candidate.name === label)) {
            sendError(response, 422, `Validation Failed: label "${label}" does not exist`);
            return true;
          }
        }
        const issue = store.createIssue(repo, {
          title,
          body: typeof value.body === 'string' ? value.body : '',
          labels,
        });
        sendJson(response, 201, issueJson(issue, repo, request));
        return true;
      }
      // GET /issues — list, filtered and sorted.
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state !== 'all') list = list.filter((issue) => issue.state === state);
        const compare = (a: Issue, b: Issue): number => {
          if (sort === 'created') {
            const time = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
            return time !== 0 ? time : a.number - b.number;
          }
          return a.number - b.number;
        };
        list.sort((a, b) => (direction === 'asc' ? compare(a, b) : -compare(a, b)));
        sendJson(response, 200, list.map((issue) => issueJson(issue, repo, request)));
        return true;
      }
      // /issues/{n}
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (rest.length >= 2 && Number.isFinite(number)) {
        const issue = repo.issues.find((candidate) => candidate.number === number);
        if (!issue) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(response, 200, issueJson(issue, repo, request));
          return true;
        }
        if (rest.length === 2 && method === 'PATCH') {
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(response, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          if (typeof value.title === 'string') issue.title = value.title;
          if (typeof value.body === 'string') issue.body = value.body;
          if (value.state === 'open' || value.state === 'closed') issue.state = value.state;
          if (Array.isArray(value.labels)) {
            const labels = value.labels.filter((entry): entry is string => typeof entry === 'string');
            for (const label of labels) {
              if (!repo.labels.some((candidate) => candidate.name === label)) {
                sendError(response, 422, `Validation Failed: label "${label}" does not exist`);
                return true;
              }
            }
            issue.labels = labels;
          }
          const { iso } = store.tick();
          issue.updatedAt = iso;
          sendJson(response, 200, issueJson(issue, repo, request));
          return true;
        }
        // /issues/{n}/comments
        if (rest.length === 3 && rest[2] === 'comments') {
          if (method === 'POST') {
            const parsed = parseJsonBody(body);
            if (!parsed.ok) {
              sendError(response, 400, 'Problems parsing JSON');
              return true;
            }
            const value = isRecord(parsed.value) ? parsed.value : {};
            const commentBody = typeof value.body === 'string' ? value.body : '';
            if (!commentBody) {
              sendError(response, 422, 'Validation Failed: body is required');
              return true;
            }
            const comment = store.createComment(issue, commentBody);
            sendJson(response, 201, {
              id: comment.id,
              node_id: Buffer.from(`C:${comment.id}`, 'utf8').toString('base64'),
              body: comment.body,
              user: { login: comment.user.login, id: comment.user.id, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
              html_url: `${baseOf(request)}/${owner}/${repoName}/issues/${issue.number}#issuecomment-${comment.id}`,
            });
            return true;
          }
          if (method === 'GET') {
            sendJson(response, 200, issue.comments.map((comment) => ({
              id: comment.id,
              node_id: Buffer.from(`C:${comment.id}`, 'utf8').toString('base64'),
              body: comment.body,
              user: { login: comment.user.login, id: comment.user.id, type: 'User' },
              created_at: comment.createdAt,
              updated_at: comment.createdAt,
            })));
            return true;
          }
        }
      }
    }

    // /pulls
    if (rest.length >= 1 && rest[0] === 'pulls') {
      // POST /pulls — create.
      if (rest.length === 1 && method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendError(response, 400, 'Problems parsing JSON');
          return true;
        }
        const value = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof value.title === 'string' ? value.title : '';
        const head = typeof value.head === 'string' ? value.head : '';
        const base = typeof value.base === 'string' ? value.base : '';
        if (!title || !head || !base) {
          sendError(response, 422, 'Validation Failed: title, head and base are required');
          return true;
        }
        const headSha = repo.refs.get(refName(head));
        const baseSha = repo.refs.get(refName(base));
        if (!headSha || !baseSha) {
          sendError(response, 422, 'Validation Failed: head or base ref does not exist');
          return true;
        }
        const mergeable = computeMergeable(repo, headSha, baseSha);
        const pull = store.createPull(repo, {
          title,
          body: typeof value.body === 'string' ? value.body : '',
          headRef: head,
          headSha,
          baseRef: base,
          baseSha,
          mergeable,
        });
        sendJson(response, 201, pullJson(pull, repo, request));
        return true;
      }
      // GET /pulls — list.
      if (rest.length === 1 && method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state !== 'all') list = list.filter((pull) => pull.state === state);
        sendJson(response, 200, list.map((pull) => pullJson(pull, repo, request)));
        return true;
      }
      const number = Number.parseInt(rest[1] ?? '', 10);
      if (rest.length >= 2 && Number.isFinite(number)) {
        const pull = repo.pulls.find((candidate) => candidate.number === number);
        if (!pull) {
          sendError(response, 404, 'Not Found');
          return true;
        }
        if (rest.length === 2 && method === 'GET') {
          sendJson(response, 200, pullJson(pull, repo, request));
          return true;
        }
        // GET /pulls/{n}/files
        if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
          const headObject = repo.objects.get(pull.headSha);
          const baseObject = repo.objects.get(pull.baseSha);
          const headTree = headObject && headObject.type === 'commit' ? parseCommit(headObject.data).tree : null;
          const baseTree = baseObject && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : null;
          const files = diffTrees(repo, baseTree, headTree).map((file) => ({
            sha: '',
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.additions + file.deletions,
          }));
          sendJson(response, 200, files);
          return true;
        }
        // PUT /pulls/{n}/merge — squash merge.
        if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
          if (pull.state !== 'open') {
            sendError(response, 405, 'Method Not Allowed: pull request is not open');
            return true;
          }
          const parsed = parseJsonBody(body);
          if (!parsed.ok) {
            sendError(response, 400, 'Problems parsing JSON');
            return true;
          }
          const value = isRecord(parsed.value) ? parsed.value : {};
          const mergeMethod = typeof value.merge_method === 'string' ? value.merge_method : 'squash';
          if (mergeMethod !== 'squash') {
            sendError(response, 405, 'Method Not Allowed: only squash merges are supported');
            return true;
          }
          const currentHeadSha = repo.refs.get(refName(pull.headRef)) ?? pull.headSha;
          const currentBaseSha = repo.refs.get(refName(pull.baseRef)) ?? pull.baseSha;
          const mergeBase = findMergeBase(repo, currentHeadSha, currentBaseSha);
          if (!mergeBase) {
            sendError(response, 405, 'Method Not Allowed: no merge base');
            return true;
          }
          const merged = mergeTreesForPull(repo, mergeBase, currentHeadSha, currentBaseSha);
          if (!merged) {
            sendError(response, 405, 'Method Not Allowed: merge conflict');
            return true;
          }
          const treeOid = buildTreeFromFlat(repo, merged, store);
          const message = `${pull.title} (#${pull.number})`;
          const mergeOid = createCommit({ repo, treeOid, parents: [currentBaseSha], message, store });
          repo.refs.set(refName(pull.baseRef), mergeOid);
          pull.state = 'closed';
          pull.merged = true;
          const { iso } = store.tick();
          pull.mergedAt = iso;
          pull.mergeCommitSha = mergeOid;
          pull.updatedAt = iso;
          sendJson(response, 200, { sha: mergeOid, merged: true, message });
          return true;
        }
      }
    }

    // A path under a known repo that matches nothing is a JSON 404.
    sendError(response, 404, 'Not Found');
    return true;
  }

  // Any other /api/v3 path is a JSON 404.
  sendError(response, 404, 'Not Found');
  return true;
}

function computeMergeable(repo: Repo, headSha: string, baseSha: string): boolean {
  const mergeBase = findMergeBase(repo, headSha, baseSha);
  if (!mergeBase) return false;
  return mergeTreesForPull(repo, mergeBase, headSha, baseSha) !== null;
}

function mergeTreesForPull(
  repo: Repo,
  mergeBaseSha: string,
  headSha: string,
  baseSha: string,
): Map<string, { mode: string; oid: string }> | null {
  const headObject = repo.objects.get(headSha);
  const baseObject = repo.objects.get(baseSha);
  const mergeBaseObject = repo.objects.get(mergeBaseSha);
  if (!headObject || headObject.type !== 'commit') return null;
  if (!baseObject || baseObject.type !== 'commit') return null;
  if (!mergeBaseObject || mergeBaseObject.type !== 'commit') return null;
  const headTree = parseCommit(headObject.data).tree;
  const baseTree = parseCommit(baseObject.data).tree;
  const mergeBaseTree = parseCommit(mergeBaseObject.data).tree;
  const baseFlat = flattenTree(repo, mergeBaseTree);
  const headFlat = flattenTree(repo, headTree);
  const branchFlat = flattenTree(repo, baseTree);
  return threeWayMerge(baseFlat, branchFlat, headFlat);
}

// Re-exported for the git smart HTTP layer, which shares the object store.
export { ZERO_OID };
export type { GitObjectType };
