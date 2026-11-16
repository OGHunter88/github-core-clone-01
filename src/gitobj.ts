// github-core-clone-01: the git object model, packfile codec and pkt-line codec.
// Dependency-free, Node built-ins only (node:crypto, node:zlib). Everything here is
// byte-exact with git's own formats, so objects round-trip through the suite's client.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(objectHeader(type, body.length));
  hash.update(body);
  return hash.digest('hex');
}

export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------------------------------------
// commits and tags
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  return {
    object,
    type: type as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author?: string;
  readonly committer?: string;
  readonly timestamp?: number;
  readonly timezone?: string;
}

/** Build a commit object's bytes. `author`/`committer` are full "Name <email>" identities. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const who = `${fields.author ?? 'Conformance <conformance@make.fun>'} ${timestamp} ${timezone}`;
  const committer = `${fields.committer ?? fields.author ?? 'Conformance <conformance@make.fun>'} ${timestamp} ${timezone}`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger?: string;
  timestamp?: number;
  timezone?: string;
}): Buffer {
  const timestamp = fields.timestamp ?? 1700000000;
  const timezone = fields.timezone ?? '+0000';
  const tagger = `${fields.tagger ?? 'Conformance <conformance@make.fun>'} ${timestamp} ${timezone}`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${tagger}\n\n${fields.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`: commit -> tree + parents, tree -> entries
 * (gitlinks skipped), tag -> its target, blob -> nothing.
 * `stopAtParents` names commits whose parents are NOT followed (a shallow boundary:
 * the caller holds the commit and its tree, but not its parents).
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { allowMissing?: boolean; stopAtParents?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!options.stopAtParents?.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

export interface PackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly size: number;
  readonly data: Buffer;
  readonly oid: string;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: PackEntry[];
  readonly trailer: string;
  readonly deltaCount: number;
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuffer = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += deltaBuffer[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out.
 */
export function readPack(pack: Uint8Array, options: { resolveBase?: ObjectLookup } = {}): PackReadResult {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  if (trailer !== packChecksum(buffer)) throw new Error('pack trailer checksum mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      size: entry.size,
      data: entry.data,
      oid: resolved.oid,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }
  return { version, declaredCount, objects, entries, trailer, deltaCount };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). The trailer is SHA-1 over everything before it.
 * Order: commits first, then trees, then blobs, then tags — a stable, index-friendly order.
 */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const order: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  list.sort((a, b) => order[a.type] - order[b.type] || (a.data.length - b.data.length));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function encodePktLines(items: readonly (string | Uint8Array | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type GitPacket =
  | { readonly kind: 'data'; readonly payload: Buffer; readonly raw: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete buffer into packets. */
export function decodePktLines(bytes: Uint8Array): GitPacket[] {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length === 3 || length > PKT_LINE_MAX) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error(`truncated pkt-line: ${length} announced, ${buffer.length - offset} available`);
    const raw = buffer.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return packets;
}

/** The decoded text of every data packet, control packets dropped. */
export function packetsToLines(packets: readonly GitPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** Split a sideband payload's first byte (band) from its data. */
export function sidebandPacket(band: 1 | 2 | 3, data: Uint8Array): Buffer {
  return encodePktLine(Buffer.concat([Buffer.from([band]), Buffer.isBuffer(data) ? data : Buffer.from(data)]));
}
