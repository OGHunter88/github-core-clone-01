// github-core-clone-01: git smart HTTP — upload-pack (protocol v2 and v0) and
// receive-pack (v0). The wire is pkt-line framed; packfiles are plain (no deltas),
// version 2, with a SHA-1 trailer. Pushes enforce fast-forward and report-status.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLineDelim,
  pktLineFlush,
  readPack,
  sidebandPacket,
  writePack,
  ZERO_OID,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { isAncestor, readBody, sendJson, type RestContext } from './rest.ts';
import type { Repo, Store } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_PACK_V2_CAPABILITIES = ['fetch', 'ls-refs', 'object-format=sha1', 'fetch=shallow', 'object-info', `agent=${AGENT}`];
const UPLOAD_PACK_V0_CAPABILITIES = ['side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'multi_ack', 'multi_ack_detailed', 'no-progress', 'object-format=sha1', `agent=${AGENT}`];
const RECEIVE_PACK_CAPABILITIES = ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', `agent=${AGENT}`];

function sendBuffer(response: ServerResponse, status: number, contentType: string, body: Buffer): void {
  response.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
  response.end(body);
}

function refLines(repo: Repo): { ref: string; oid: string }[] {
  const lines: { ref: string; oid: string }[] = [];
  lines.push({ ref: 'HEAD', oid: repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID });
  for (const [ref, oid] of repo.refs) lines.push({ ref, oid });
  lines.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
  return lines;
}

function peeledOid(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'tag') {
    const tag = parseTag(object.data);
    return tag.type === 'commit' ? tag.object : peeledOid(repo, tag.object);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

function advertisementV2UploadPack(): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('# service=git-upload-pack\n'));
  parts.push(pktLineFlush());
  parts.push(encodePktLine('version 2\n'));
  parts.push(pktLineFlush());
  for (const capability of UPLOAD_PACK_V2_CAPABILITIES) parts.push(encodePktLine(`${capability}\n`));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities = service === 'git-receive-pack' ? RECEIVE_PACK_CAPABILITIES : UPLOAD_PACK_V0_CAPABILITIES;
  const lines = refLines(repo);
  const parts: Buffer[] = [];
  parts.push(encodePktLine(`# service=${service}\n`));
  parts.push(pktLineFlush());
  const capabilityText = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} ${capabilities.join(' ')}`
    : capabilities.join(' ');
  if (lines.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\u0000${capabilityText}\n`));
  } else {
    lines.forEach((line, index) => {
      const extra = index === 0 ? `\u0000${capabilityText}` : '';
      const oid = line.ref === 'HEAD' && line.oid === ZERO_OID ? ZERO_OID : line.oid;
      parts.push(encodePktLine(`${oid} ${line.ref}${extra}\n`));
      // A peeled tag line follows its tag.
      const peeled = peeledOid(repo, line.oid);
      if (peeled) parts.push(encodePktLine(`${peeled} ${line.ref}^{}\n`));
    });
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------------------------

function lsRefsV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArguments = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArguments = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArguments) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultOid = repo.refs.get(defaultRef);
  if (symrefs && keep('HEAD')) {
    const oid = defaultOid ?? ZERO_OID;
    const target = `symref-target:${defaultRef}`;
    if (oid === ZERO_OID) {
      if (unborn) parts.push(encodePktLine(`unborn HEAD ${target}\n`));
    } else {
      parts.push(encodePktLine(`${oid} HEAD ${target}\n`));
    }
  }
  const sortedRefs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [ref, oid] of sortedRefs) {
    if (!keep(ref)) continue;
    const attributes: string[] = [];
    if (peel) {
      const peeled = peeledOid(repo, oid);
      if (peeled) attributes.push(`peeled:${peeled}`);
    }
    const suffix = attributes.length ? ` ${attributes.join(' ')}` : '';
    parts.push(encodePktLine(`${oid} ${ref}${suffix}\n`));
  }
  // An unborn default branch is reported when the repo has no refs at all.
  if (repo.refs.size === 0 && unborn && keep(defaultRef)) {
    parts.push(encodePktLine(`unborn ${defaultRef}\n`));
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch: computing what to send
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** Commits reachable from `wants` within `depth` (depth 1 = the wants themselves). */
function shallowCommitSet(repo: Repo, wants: readonly string[], depth: number): { commits: Map<string, number>; boundary: Set<string> } {
  const commits = new Map<string, number>();
  const queue: { oid: string; depth: number }[] = wants.map((oid) => ({ oid, depth: 1 }));
  while (queue.length) {
    const { oid, depth: currentDepth } = queue.shift()!;
    if (commits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    commits.set(oid, currentDepth);
    if (currentDepth >= depth) continue;
    for (const parent of parseCommit(object.data).parents) queue.push({ oid: parent, depth: currentDepth + 1 });
  }
  const boundary = new Set<string>();
  for (const [oid, commitDepth] of commits) {
    const object = repo.objects.get(oid)!;
    const parents = parseCommit(object.data).parents;
    if (commitDepth === depth || parents.length === 0) boundary.add(oid);
  }
  return { commits, boundary };
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  shallowBoundaries: readonly string[],
): FetchPlan {
  // What the client already holds: reachable from its haves, but a shallow boundary's
  // parents are NOT held (a shallow clone has the boundary commit and its tree, not its
  // history), so the expansion stops at the shallow boundaries the client named.
  const haveReachable = collectReachable(haves, (oid) => repo.objects.get(oid), {
    allowMissing: true,
    stopAtParents: new Set(shallowBoundaries),
  });
  let wantedReachable: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null) {
    const { commits, boundary } = shallowCommitSet(repo, wants, depth);
    const roots = [...commits.keys()];
    wantedReachable = collectReachable(roots, (oid) => repo.objects.get(oid), { allowMissing: true });
    // A shallow fetch only carries the trees/blobs of the commits inside the depth window.
    // collectReachable already walks trees and blobs of those commits, but it also follows
    // parents — so restrict to the depth window by re-collecting from the boundary commits'
    // trees only. Instead: start from the commit set and walk trees/blobs, not parents.
    const limited = new Set<string>();
    const walkFrom = (oid: string): void => {
      if (limited.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      limited.add(oid);
      if (object.type === 'commit') {
        walkFrom(parseCommit(object.data).tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) if (entry.mode !== '160000') walkFrom(entry.oid);
      } else if (object.type === 'tag') {
        walkFrom(parseTag(object.data).object);
      }
    };
    for (const commitOid of commits.keys()) walkFrom(commitOid);
    wantedReachable = limited;
    shallow = [...boundary].sort();
    const oldBoundaries = new Set(shallowBoundaries);
    for (const old of oldBoundaries) {
      if (!boundary.has(old) && commits.has(old)) unshallow.push(old);
    }
    unshallow.sort();
  } else {
    wantedReachable = collectReachable(wants, (oid) => repo.objects.get(oid), { allowMissing: true });
  }
  const objects = new Map<string, GitObject>();
  for (const oid of wantedReachable) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) objects.set(oid, object);
  }
  return { objects, shallow, unshallow };
}

/** Split a pack into sideband band-1 packets (max 65515 data bytes each: the 1-byte band prefix counts toward the 65516-byte pkt-line payload limit). */
function packToSideband(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const MAX = 65515;
  for (let offset = 0; offset < pack.length; offset += MAX) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + MAX));
    parts.push(sidebandPacket(1, chunk));
  }
  return parts;
}

function fetchResponseV2(repo: Repo, plan: FetchPlan, wants: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  // acknowledgments
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(encodePktLine('ready\n'));
  parts.push(pktLineDelim());
  // shallow-info
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  // wanted-refs: each wanted oid with the ref name that points at it.
  parts.push(encodePktLine('wanted-refs\n'));
  const sortedRefs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const want of wants) {
    const ref = sortedRefs.find(([, oid]) => oid === want)?.[0] ?? want;
    parts.push(encodePktLine(`${want} ${ref}\n`));
  }
  parts.push(pktLineDelim());
  // packfile
  parts.push(encodePktLine('packfile\n'));
  const pack = writePack(plan.objects.values());
  for (const packet of packToSideband(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodePktLine('NAK\n'));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects.values());
  for (const packet of packToSideband(pack)) parts.push(packet);
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

function parseFetchV2(body: Buffer): {
  command: string;
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
  done: boolean;
} {
  const packets = decodePktLines(body);
  const result = { command: '', wants: [] as string[], haves: [] as string[], depth: null as number | null, shallow: [] as string[], done: false };
  let inArguments = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArguments = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArguments) {
      if (line.startsWith('command=')) result.command = line.slice('command='.length);
      continue;
    }
    if (line.startsWith('want ')) result.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) result.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) result.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) result.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') result.done = true;
  }
  return result;
}

function parseFetchV0(body: Buffer): {
  wants: string[];
  haves: string[];
  depth: number | null;
  shallow: string[];
} {
  const packets = decodePktLines(body);
  const result = { wants: [] as string[], haves: [] as string[], depth: null as number | null, shallow: [] as string[] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) result.wants.push(line.slice(5).split(' ')[0].trim());
    else if (line.startsWith('have ')) result.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) result.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) result.depth = Number.parseInt(line.slice(7), 10);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function receivePack(repo: Repo, body: Buffer, store: Store): Buffer {
  // The body is a pkt-line command list, a flush, then raw pack bytes (no pack for delete-only).
  let flushIndex = -1;
  let offset = 0;
  const packets: GitPacket[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      flushIndex = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length), raw: body.subarray(offset, offset + length) });
    offset += length;
  }
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  const packBytes = flushIndex >= 0 ? body.subarray(flushIndex) : Buffer.alloc(0);
  const report: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackOk = false;
      unpackDetail = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (!current) {
          report.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        } else {
          repo.refs.delete(command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (!current) {
        // Create.
        if (command.oldOid !== ZERO_OID) {
          report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        report.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      // Update: the old value must match, and the new tip must descend from the old.
      if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        report.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
        continue;
      }
      if (!isAncestor(repo, current, command.newOid)) {
        report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push({ ref: command.ref, ok: true, reason: '' });
    }
  } else {
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: `unpack failed: ${unpackDetail}` });
  }
  const lines: string[] = [`unpack ${unpackDetail}\n`];
  for (const entry of report) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const inner = encodePktLines(lines.map((line) => line));
  const outer: Buffer[] = [];
  const MAX = 65515;
  for (let offset = 0; offset < inner.length; offset += MAX) {
    outer.push(sidebandPacket(1, inner.subarray(offset, Math.min(inner.length, offset + MAX))));
  }
  outer.push(pktLineFlush());
  return Buffer.concat(outer);
}

// ---------------------------------------------------------------------------------------------
// the dispatcher
// ---------------------------------------------------------------------------------------------

export async function handleGitHttp(
  context: RestContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const store: Store = context.store;
  const match = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const repoName = decodeURIComponent(match[2]);
  const suffix = match[3];
  const repo = store.getRepo(owner, repoName);
  const method = request.method ?? 'GET';
  const query = new URL(request.url ?? '/', 'http://localhost').searchParams;

  // A missing repo is a 404 on both services; the server stays up.
  if (!repo) {
    if (suffix === 'info/refs' || suffix === 'git-upload-pack' || suffix === 'git-receive-pack') {
      sendJson(response, 404, { message: 'Not Found' });
      return true;
    }
    return false;
  }

  // Auth: the git surfaces use the same bearer token as REST.
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

  if (method === 'GET' && suffix === 'info/refs') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(response, 400, { message: 'service is required' });
      return true;
    }
    const wantsV2 = request.headers['git-protocol'] === 'version=2';
    if (service === 'git-upload-pack' && wantsV2) {
      sendBuffer(response, 200, 'application/x-git-upload-pack-advertisement', advertisementV2UploadPack());
    } else {
      sendBuffer(response, 200, `application/x-${service}-advertisement`, advertisementV0(repo, service));
    }
    return true;
  }

  if (method === 'POST' && suffix === 'git-upload-pack') {
    const body = await readBody(request);
    const wantsV2 = request.headers['git-protocol'] === 'version=2';
    let parsed: GitPacket[];
    try {
      parsed = decodePktLines(body);
    } catch {
      sendJson(response, 400, { message: 'malformed pkt-line' });
      return true;
    }
    const command = parsed
      .filter((packet): packet is Extract<GitPacket, { kind: 'data' }> => packet.kind === 'data')
      .map((packet) => packet.payload.toString('utf8'))
      .find((line) => line.startsWith('command='));
    if (wantsV2 && command === 'command=ls-refs\n') {
      sendBuffer(response, 200, 'application/x-git-upload-pack-result', lsRefsV2(repo, body));
      return true;
    }
    if (wantsV2) {
      const fetch = parseFetchV2(body);
      if (fetch.command !== 'fetch') {
        sendJson(response, 400, { message: 'unknown command' });
        return true;
      }
      const plan = planFetch(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
      sendBuffer(response, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, plan, fetch.wants));
      return true;
    }
    const fetch = parseFetchV0(body);
    const plan = planFetch(repo, fetch.wants, fetch.haves, fetch.depth, fetch.shallow);
    sendBuffer(response, 200, 'application/x-git-upload-pack-result', fetchResponseV0(plan));
    return true;
  }

  if (method === 'POST' && suffix === 'git-receive-pack') {
    const body = await readBody(request);
    const result = receivePack(repo, body, store);
    sendBuffer(response, 200, 'application/x-git-receive-pack-result', result);
    return true;
  }

  return false;
}

export { ZERO_OID };
