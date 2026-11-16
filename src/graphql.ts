// github-core-clone-01: GraphQL v4 at /api/graphql. A small parser (operations, fields,
// arguments, variables, inline fragments) and a resolver over the same store REST uses.
// Unknown fields answer 200 with an errors array naming the field; unauthenticated is 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit } from './gitobj.ts';
import { findMergeBase, flattenTree, isAncestor, readBody, sendJson, threeWayMerge, buildTreeFromFlat, createCommit, type RestContext } from './rest.ts';
import { VIEWER_ID, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------------------------------------
// a small GraphQL parser
// ---------------------------------------------------------------------------------------------

interface ArgumentValue {
  readonly kind: 'string' | 'int' | 'boolean' | 'enum' | 'variable' | 'list' | 'object' | 'null';
  readonly value: unknown;
}

interface FieldNode {
  readonly name: string;
  readonly alias: string | null;
  readonly arguments: Map<string, ArgumentValue>;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}

type SelectionNode = { readonly kind: 'field'; readonly field: FieldNode } | { readonly kind: 'fragment'; readonly fragment: FragmentNode };

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly selection: SelectionNode[];
}

class GraphQLParser {
  private pos = 0;
  private readonly text: string;
  constructor(text: string) {
    this.text = text;
  }

  private skipWhitespace(): void {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') this.pos += 1;
      else if (ch === '#') {
        while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos += 1;
      } else break;
    }
  }

  private peek(): string {
    this.skipWhitespace();
    return this.text[this.pos] ?? '';
  }

  private expect(char: string): void {
    this.skipWhitespace();
    if (this.text[this.pos] !== char) throw new Error(`expected ${char} at ${this.pos}, found ${JSON.stringify(this.text[this.pos])}`);
    this.pos += 1;
  }

  private readName(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.text.length && /[A-Za-z0-9_]/.test(this.text[this.pos])) this.pos += 1;
    if (this.pos === start) throw new Error(`expected a name at ${this.pos}`);
    return this.text.slice(start, this.pos);
  }

  private readString(): string {
    this.skipWhitespace();
    if (this.text[this.pos] !== '"') throw new Error(`expected a string at ${this.pos}`);
    this.pos += 1;
    let out = '';
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos];
      if (ch === '"') {
        this.pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.text[this.pos + 1];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === '"') out += '"';
        else if (next === '\\') out += '\\';
        else if (next === '/') out += '/';
        else if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.text.slice(this.pos + 2, this.pos + 6), 16));
          this.pos += 4;
        } else out += next;
        this.pos += 2;
        continue;
      }
      out += ch;
      this.pos += 1;
    }
    throw new Error('unterminated string');
  }

  private readValue(): ArgumentValue {
    this.skipWhitespace();
    const ch = this.text[this.pos];
    if (ch === '"') return { kind: 'string', value: this.readString() };
    if (ch === '$') {
      this.pos += 1;
      return { kind: 'variable', value: this.readName() };
    }
    if (ch === '[') {
      this.pos += 1;
      const items: ArgumentValue[] = [];
      while (this.peek() !== ']') items.push(this.readValue());
      this.expect(']');
      return { kind: 'list', value: items };
    }
    if (ch === '{') {
      this.pos += 1;
      const fields = new Map<string, ArgumentValue>();
      while (this.peek() !== '}') {
        const name = this.readName();
        this.expect(':');
        fields.set(name, this.readValue());
      }
      this.expect('}');
      return { kind: 'object', value: fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.pos;
      if (ch === '-') this.pos += 1;
      while (this.pos < this.text.length && /[0-9]/.test(this.text[this.pos])) this.pos += 1;
      return { kind: 'int', value: Number.parseInt(this.text.slice(start, this.pos), 10) };
    }
    const name = this.readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null', value: null };
    return { kind: 'enum', value: name };
  }

  private readArguments(): Map<string, ArgumentValue> {
    const args = new Map<string, ArgumentValue>();
    this.skipWhitespace();
    if (this.text[this.pos] !== '(') return args;
    this.pos += 1;
    while (this.peek() !== ')') {
      const name = this.readName();
      this.expect(':');
      args.set(name, this.readValue());
    }
    this.expect(')');
    return args;
  }

  private readSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '.' && this.text.slice(this.pos, this.pos + 3) === '...') {
        this.pos += 3;
        this.skipWhitespace();
        let typeCondition: string | null = null;
        if (this.text.slice(this.pos, this.pos + 2) === 'on') {
          this.pos += 2;
          typeCondition = this.readName();
        }
        const selection = this.readSelectionSet();
        selections.push({ kind: 'fragment', fragment: { typeCondition, selection } });
        continue;
      }
      let name = this.readName();
      let alias: string | null = null;
      this.skipWhitespace();
      if (this.text[this.pos] === ':') {
        this.pos += 1;
        alias = name;
        name = this.readName();
      }
      const args = this.readArguments();
      let selection: SelectionNode[] = [];
      if (this.peek() === '{') selection = this.readSelectionSet();
      selections.push({ kind: 'field', field: { name, alias, arguments: args, selection } });
    }
    this.expect('}');
    return selections;
  }

  parse(): OperationNode {
    this.skipWhitespace();
    let kind: 'query' | 'mutation' = 'query';
    if (this.text.slice(this.pos, this.pos + 5) === 'query') {
      this.pos += 5;
      kind = 'query';
    } else if (this.text.slice(this.pos, this.pos + 8) === 'mutation') {
      this.pos += 8;
      kind = 'mutation';
    }
    this.skipWhitespace();
    // An optional operation name.
    if (/[A-Za-z_]/.test(this.peek())) {
      this.readName();
      this.skipWhitespace();
    }
    // Optional variable definitions: ($name: Type, ...). Skip them; values come from the variables map.
    if (this.peek() === '(') {
      let depth = 0;
      while (this.pos < this.text.length) {
        const ch = this.text[this.pos];
        if (ch === '(') depth += 1;
        else if (ch === ')') {
          depth -= 1;
          this.pos += 1;
          if (depth === 0) break;
          continue;
        }
        this.pos += 1;
      }
    }
    const selection = this.readSelectionSet();
    return { kind, selection };
  }
}

// ---------------------------------------------------------------------------------------------
// the resolver
// ---------------------------------------------------------------------------------------------

interface GraphQLError {
  readonly message: string;
  readonly path?: string[];
}

interface ResolverContext {
  readonly store: Store;
  readonly variables: Record<string, unknown>;
  readonly errors: GraphQLError[];
}

function resolveArgumentValue(value: ArgumentValue, variables: Record<string, unknown>): unknown {
  if (value.kind === 'variable') return variables[value.value as string];
  if (value.kind === 'list') return (value.value as ArgumentValue[]).map((item) => resolveArgumentValue(item, variables));
  if (value.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of value.value as Map<string, ArgumentValue>) out[key] = resolveArgumentValue(entry, variables);
    return out;
  }
  return value.value;
}

function argString(field: FieldNode, name: string, variables: Record<string, unknown>): string | undefined {
  const value = field.arguments.get(name);
  if (!value) return undefined;
  const resolved = resolveArgumentValue(value, variables);
  return typeof resolved === 'string' ? resolved : undefined;
}

function argInt(field: FieldNode, name: string, variables: Record<string, unknown>): number | undefined {
  const value = field.arguments.get(name);
  if (!value) return undefined;
  const resolved = resolveArgumentValue(value, variables);
  return typeof resolved === 'number' ? resolved : undefined;
}

function argList(field: FieldNode, name: string, variables: Record<string, unknown>): unknown[] | undefined {
  const value = field.arguments.get(name);
  if (!value) return undefined;
  const resolved = resolveArgumentValue(value, variables);
  return Array.isArray(resolved) ? resolved : undefined;
}

function argObject(field: FieldNode, name: string, variables: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = field.arguments.get(name);
  if (!value) return undefined;
  const resolved = resolveArgumentValue(value, variables);
  return typeof resolved === 'object' && resolved !== null && !Array.isArray(resolved) ? (resolved as Record<string, unknown>) : undefined;
}

function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0];
    const repoId = Number.parseInt(parts[1], 10);
    const number = parts.length >= 3 ? Number.parseInt(parts[2], 10) : 0;
    if (!Number.isFinite(repoId)) return null;
    return { kind, repoId, number };
  } catch {
    return null;
  }
}

function encodeCursor(kind: string, repoId: number, number: number): string {
  return Buffer.from(`${kind}:${repoId}:${number}`, 'utf8').toString('base64');
}

type ResolverValue =
  | { readonly __typename: 'Repository'; readonly repo: Repo }
  | { readonly __typename: 'Issue'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'PullRequest'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'User'; readonly login: string; readonly id: number }
  | { readonly __typename: 'Ref'; readonly name: string }
  | { readonly __typename: 'IssueConnection'; readonly repo: Repo; readonly issues: Issue[]; readonly total: number; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: 'PullRequestConnection'; readonly repo: Repo; readonly pulls: Pull[]; readonly total: number; readonly hasNextPage: boolean; readonly endCursor: string | null }
  | { readonly __typename: 'IssueEdge'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'PullRequestEdge'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'PageInfo'; readonly hasNextPage: boolean; readonly endCursor: string | null; readonly hasPreviousPage: boolean; readonly startCursor: string | null }
  | { readonly __typename: 'TypeInfo'; readonly name: string }
  | { readonly __typename: 'TypeField'; readonly name: string }
  | { readonly __typename: 'EnumValue'; readonly name: string }
  | { readonly __typename: 'CreateIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'CloseIssuePayload'; readonly repo: Repo; readonly issue: Issue }
  | { readonly __typename: 'CreatePullRequestPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'MergePullRequestPayload'; readonly repo: Repo; readonly pull: Pull }
  | { readonly __typename: 'AddCommentPayload'; readonly repo: Repo; readonly issue: Issue; readonly comment: { id: number; body: string } }
  | { readonly __typename: 'CommentEdge'; readonly comment: { id: number; body: string } }
  | { readonly __typename: 'Comment'; readonly comment: { id: number; body: string } }
  | { readonly __typename: 'FileConnection'; readonly files: { path: string }[] }
  | { readonly __typename: 'FileEdge'; readonly file: { path: string } }
  | { readonly __typename: 'File'; readonly path: string };

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt'],
  SearchType: [],
};
const TYPE_ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
};

function resolveSelections(
  value: ResolverValue | null,
  typeName: string,
  selections: readonly SelectionNode[],
  context: ResolverContext,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const condition = selection.fragment.typeCondition;
      if (condition && condition !== typeName && condition !== value.__typename) continue;
      const nested = resolveSelections(value, typeName, selection.fragment.selection, context);
      if (nested) Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    out[key] = resolveField(value, typeName, field, context);
  }
  return out;
}

function resolveField(value: ResolverValue, typeName: string, field: FieldNode, context: ResolverContext): unknown {
  const { store, variables } = context;
  const error = (message: string): null => {
    context.errors.push({ message, path: [field.name] });
    return null;
  };
  switch (value.__typename) {
    case 'Repository': {
      const repo = value.repo;
      switch (field.name) {
        case 'id': return store.globalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return resolveSelections({ __typename: 'User', login: repo.owner, id: VIEWER_ID }, 'User', field.selection, context);
        case 'defaultBranchRef': return resolveSelections({ __typename: 'Ref', name: repo.defaultBranch }, 'Ref', field.selection, context);
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'issue': {
          const number = argInt(field, 'number', variables);
          const issue = repo.issues.find((candidate) => candidate.number === number);
          if (!issue) return null;
          return resolveSelections({ __typename: 'Issue', repo, issue }, 'Issue', field.selection, context);
        }
        case 'issues': {
          const first = argInt(field, 'first', variables);
          const after = argString(field, 'after', variables);
          const states = argList(field, 'states', variables) as string[] | undefined;
          const orderBy = argObject(field, 'orderBy', variables);
          let list = [...repo.issues];
          if (states && states.length) {
            const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const direction = orderBy?.direction === 'ASC' ? 1 : -1;
          list.sort((a, b) => (a.number - b.number) * direction);
          const total = list.length;
          const afterNumber = after ? decodeGlobalId(after)?.number ?? 0 : 0;
          // The cursor continues in the sort's own direction: after the last item seen.
          const filtered = afterNumber
            ? list.filter((issue) => (direction === 1 ? issue.number > afterNumber : issue.number < afterNumber))
            : list;
          const page = first !== undefined ? filtered.slice(0, first) : filtered;
          const hasNextPage = filtered.length > page.length;
          const endCursor = page.length ? encodeCursor('Issue', repo.id, page[page.length - 1].number) : null;
          const connection: ResolverValue = { __typename: 'IssueConnection', repo, issues: page, total, hasNextPage, endCursor };
          return resolveSelections(connection, 'IssueConnection', field.selection, context);
        }
        case 'pullRequest': {
          const number = argInt(field, 'number', variables);
          const pull = repo.pulls.find((candidate) => candidate.number === number);
          if (!pull) return null;
          return resolveSelections({ __typename: 'PullRequest', repo, pull }, 'PullRequest', field.selection, context);
        }
        case 'pullRequests': {
          const first = argInt(field, 'first', variables);
          const after = argString(field, 'after', variables);
          const list = [...repo.pulls].sort((a, b) => a.number - b.number);
          const total = list.length;
          const afterNumber = after ? decodeGlobalId(after)?.number ?? 0 : 0;
          const filtered = afterNumber ? list.filter((pull) => pull.number > afterNumber) : list;
          const page = first !== undefined ? filtered.slice(0, first) : filtered;
          const hasNextPage = filtered.length > page.length;
          const endCursor = page.length ? encodeCursor('PullRequest', repo.id, page[page.length - 1].number) : null;
          const connection: ResolverValue = { __typename: 'PullRequestConnection', repo, pulls: page, total, hasNextPage, endCursor };
          return resolveSelections(connection, 'PullRequestConnection', field.selection, context);
        }
        default:
          return error(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Issue': {
      const issue = value.issue;
      const repo = value.repo;
      switch (field.name) {
        case 'id': return store.globalIdFor('Issue', repo, issue.number);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'author': return resolveSelections({ __typename: 'User', login: issue.user.login, id: issue.user.id }, 'User', field.selection, context);
        case 'labels': return issue.labels;
        case 'comments': return issue.comments.map((comment) => comment.body);
        default:
          return error(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const pull = value.pull;
      const repo = value.repo;
      switch (field.name) {
        case 'id': return store.globalIdFor('PullRequest', repo, pull.number);
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.state === 'open' ? 'OPEN' : pull.merged ? 'MERGED' : 'CLOSED';
        case 'merged': return pull.merged;
        case 'mergeable': return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'headRef': return resolveSelections({ __typename: 'Ref', name: pull.headRef }, 'Ref', field.selection, context);
        case 'baseRef': return resolveSelections({ __typename: 'Ref', name: pull.baseRef }, 'Ref', field.selection, context);
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'author': return resolveSelections({ __typename: 'User', login: pull.user.login, id: pull.user.id }, 'User', field.selection, context);
        case 'files': {
          const first = argInt(field, 'first', variables);
          const headObject = repo.objects.get(pull.headSha);
          const baseObject = repo.objects.get(pull.baseSha);
          const headTree = headObject && headObject.type === 'commit' ? parseCommit(headObject.data).tree : null;
          const baseTree = baseObject && baseObject.type === 'commit' ? parseCommit(baseObject.data).tree : null;
          const headFlat = headTree ? flattenTree(repo, headTree) : new Map();
          const baseFlat = baseTree ? flattenTree(repo, baseTree) : new Map();
          const paths = new Set<string>([...headFlat.keys(), ...baseFlat.keys()]);
          const files = [...paths].sort().filter((path) => headFlat.get(path)?.oid !== baseFlat.get(path)?.oid).map((path) => ({ path }));
          const page = first !== undefined ? files.slice(0, first) : files;
          return resolveSelections({ __typename: 'FileConnection', files: page }, 'FileConnection', field.selection, context);
        }
        default:
          return error(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'User': {
      if (field.name === 'login') return value.login;
      if (field.name === 'id') return value.id;
      return error(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Ref': {
      if (field.name === 'name') return value.name;
      return error(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') {
        return value.issues.map((issue) => resolveSelections({ __typename: 'Issue', repo: value.repo, issue }, 'Issue', field.selection, context));
      }
      if (field.name === 'edges') {
        return value.issues.map((issue) => resolveSelections({ __typename: 'IssueEdge', repo: value.repo, issue }, 'IssueEdge', field.selection, context));
      }
      if (field.name === 'totalCount') return value.total;
      if (field.name === 'pageInfo') {
        return resolveSelections({ __typename: 'PageInfo', hasNextPage: value.hasNextPage, endCursor: value.endCursor, hasPreviousPage: false, startCursor: value.issues.length ? encodeCursor('Issue', value.repo.id, value.issues[0].number) : null }, 'PageInfo', field.selection, context);
      }
      return error(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return value.pulls.map((pull) => resolveSelections({ __typename: 'PullRequest', repo: value.repo, pull }, 'PullRequest', field.selection, context));
      }
      if (field.name === 'edges') {
        return value.pulls.map((pull) => resolveSelections({ __typename: 'PullRequestEdge', repo: value.repo, pull }, 'PullRequestEdge', field.selection, context));
      }
      if (field.name === 'totalCount') return value.total;
      if (field.name === 'pageInfo') {
        return resolveSelections({ __typename: 'PageInfo', hasNextPage: value.hasNextPage, endCursor: value.endCursor, hasPreviousPage: false, startCursor: value.pulls.length ? encodeCursor('PullRequest', value.repo.id, value.pulls[0].number) : null }, 'PageInfo', field.selection, context);
      }
      return error(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'IssueEdge': {
      if (field.name === 'node') return resolveSelections({ __typename: 'Issue', repo: value.repo, issue: value.issue }, 'Issue', field.selection, context);
      if (field.name === 'cursor') return encodeCursor('Issue', value.repo.id, value.issue.number);
      return error(`Cannot query field "${field.name}" on type "IssueEdge".`);
    }
    case 'PullRequestEdge': {
      if (field.name === 'node') return resolveSelections({ __typename: 'PullRequest', repo: value.repo, pull: value.pull }, 'PullRequest', field.selection, context);
      if (field.name === 'cursor') return encodeCursor('PullRequest', value.repo.id, value.pull.number);
      return error(`Cannot query field "${field.name}" on type "PullRequestEdge".`);
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return value.hasNextPage;
      if (field.name === 'endCursor') return value.endCursor;
      if (field.name === 'hasPreviousPage') return value.hasPreviousPage;
      if (field.name === 'startCursor') return value.startCursor;
      return error(`Cannot query field "${field.name}" on type "PageInfo".`);
    }
    case 'TypeInfo': {
      if (field.name === 'name') return value.name;
      if (field.name === 'kind') return 'OBJECT';
      if (field.name === 'fields') {
        const names = TYPE_FIELDS[value.name] ?? [];
        return names.map((name) => resolveSelections({ __typename: 'TypeField', name }, 'TypeField', field.selection, context));
      }
      if (field.name === 'enumValues') {
        const names = TYPE_ENUM_VALUES[value.name] ?? [];
        return names.map((name) => resolveSelections({ __typename: 'EnumValue', name }, 'EnumValue', field.selection, context));
      }
      return error(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case 'TypeField': {
      if (field.name === 'name') return value.name;
      return error(`Cannot query field "${field.name}" on type "__Field".`);
    }
    case 'EnumValue': {
      if (field.name === 'name') return value.name;
      return error(`Cannot query field "${field.name}" on type "__EnumValue".`);
    }
    case 'FileConnection': {
      if (field.name === 'nodes') return value.files.map((file) => resolveSelections({ __typename: 'File', path: file.path }, 'File', field.selection, context));
      if (field.name === 'edges') return value.files.map((file) => resolveSelections({ __typename: 'FileEdge', file }, 'FileEdge', field.selection, context));
      if (field.name === 'totalCount') return value.files.length;
      return error(`Cannot query field "${field.name}" on type "FileConnection".`);
    }
    case 'FileEdge': {
      if (field.name === 'node') return resolveSelections({ __typename: 'File', path: value.file.path }, 'File', field.selection, context);
      if (field.name === 'cursor') return encodeCursor('File', 0, 0);
      return error(`Cannot query field "${field.name}" on type "FileEdge".`);
    }
    case 'File': {
      if (field.name === 'path') return value.path;
      return error(`Cannot query field "${field.name}" on type "File".`);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return resolveSelections({ __typename: 'Issue', repo: value.repo, issue: value.issue }, 'Issue', field.selection, context);
      return error(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return resolveSelections({ __typename: 'Issue', repo: value.repo, issue: value.issue }, 'Issue', field.selection, context);
      return error(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return resolveSelections({ __typename: 'PullRequest', repo: value.repo, pull: value.pull }, 'PullRequest', field.selection, context);
      return error(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return resolveSelections({ __typename: 'PullRequest', repo: value.repo, pull: value.pull }, 'PullRequest', field.selection, context);
      return error(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') {
        return resolveSelections({ __typename: 'CommentEdge', comment: value.comment }, 'CommentEdge', field.selection, context);
      }
      return error(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
    case 'CommentEdge': {
      if (field.name === 'node') return resolveSelections({ __typename: 'Comment', comment: value.comment }, 'Comment', field.selection, context);
      if (field.name === 'cursor') return encodeCursor('Comment', 0, value.comment.id);
      return error(`Cannot query field "${field.name}" on type "IssueCommentEdge".`);
    }
    case 'Comment': {
      if (field.name === 'id') return Buffer.from(`C:${value.comment.id}`, 'utf8').toString('base64');
      if (field.name === 'body') return value.comment.body;
      return error(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
    default:
      return error(`Cannot query field "${field.name}" on type "${typeName}".`);
  }
}

function resolveTopLevel(operation: OperationNode, context: ResolverContext): Record<string, unknown> {
  const { store, variables } = context;
  const out: Record<string, unknown> = {};
  for (const selection of operation.selection) {
    if (selection.kind === 'fragment') continue;
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (operation.kind === 'query') {
      if (field.name === 'viewer') {
        out[key] = resolveSelections({ __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID }, 'User', field.selection, context);
        continue;
      }
      if (field.name === 'repository') {
        const owner = argString(field, 'owner', variables);
        const name = argString(field, 'name', variables);
        const repo = owner && name ? store.getRepo(owner, name) : undefined;
        out[key] = repo ? resolveSelections({ __typename: 'Repository', repo }, 'Repository', field.selection, context) : null;
        continue;
      }
      if (field.name === 'node') {
        const id = argString(field, 'id', variables);
        const decoded = id ? decodeGlobalId(id) : null;
        let resolved: ResolverValue | null = null;
        if (decoded) {
          const repo = store.reposById.get(decoded.repoId);
          if (repo) {
            if (decoded.kind === 'R' || decoded.kind === 'Repository') resolved = { __typename: 'Repository', repo };
            else if (decoded.kind === 'Issue') {
              const issue = repo.issues.find((candidate) => candidate.number === decoded.number);
              if (issue) resolved = { __typename: 'Issue', repo, issue };
            } else if (decoded.kind === 'PullRequest' || decoded.kind === 'PR') {
              const pull = repo.pulls.find((candidate) => candidate.number === decoded.number);
              if (pull) resolved = { __typename: 'PullRequest', repo, pull };
            }
          }
        }
        out[key] = resolved ? resolveSelections(resolved, resolved.__typename, field.selection, context) : null;
        continue;
      }
      if (field.name === '__type') {
        const name = argString(field, 'name', variables);
        if (!name || !(name in TYPE_FIELDS) && !(name in TYPE_ENUM_VALUES)) {
          out[key] = null;
          continue;
        }
        out[key] = resolveSelections({ __typename: 'TypeInfo', name }, '__Type', field.selection, context);
        continue;
      }
      if (field.name === '__schema') {
        out[key] = { types: Object.keys(TYPE_FIELDS).map((name) => ({ name })) };
        continue;
      }
      context.errors.push({ message: `Cannot query field "${field.name}" on type "Query".`, path: [field.name] });
      out[key] = null;
      continue;
    }
    // mutations
    if (field.name === 'createIssue') {
      const input = argObject(field, 'input', variables) ?? {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      if (!repo || !title) {
        context.errors.push({ message: 'createIssue: repository or title is missing', path: [field.name] });
        out[key] = null;
        continue;
      }
      const issue = store.createIssue(repo, { title, body });
      out[key] = resolveSelections({ __typename: 'CreateIssuePayload', repo, issue }, 'CreateIssuePayload', field.selection, context);
      continue;
    }
    if (field.name === 'closeIssue') {
      const input = argObject(field, 'input', variables) ?? {};
      const issueId = typeof input.issueId === 'string' ? input.issueId : '';
      const decoded = decodeGlobalId(issueId);
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const issue = repo?.issues.find((candidate) => candidate.number === decoded?.number);
      if (!issue) {
        context.errors.push({ message: 'closeIssue: issue not found', path: [field.name] });
        out[key] = null;
        continue;
      }
      issue.state = 'closed';
      const { iso } = store.tick();
      issue.updatedAt = iso;
      out[key] = resolveSelections({ __typename: 'CloseIssuePayload', repo: repo!, issue }, 'CloseIssuePayload', field.selection, context);
      continue;
    }
    if (field.name === 'createPullRequest') {
      const input = argObject(field, 'input', variables) ?? {};
      const repositoryId = typeof input.repositoryId === 'string' ? input.repositoryId : '';
      const baseRefName = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const headRefName = typeof input.headRefName === 'string' ? input.headRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(repositoryId);
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const headSha = repo?.refs.get(`refs/heads/${headRefName}`);
      const baseSha = repo?.refs.get(`refs/heads/${baseRefName}`);
      if (!repo || !headSha || !baseSha || !title) {
        context.errors.push({ message: 'createPullRequest: repository, head or base is missing', path: [field.name] });
        out[key] = null;
        continue;
      }
      const mergeBase = findMergeBase(repo, headSha, baseSha);
      let mergeable = false;
      if (mergeBase) {
        const headObject = repo.objects.get(headSha);
        const baseObject = repo.objects.get(baseSha);
        const mergeBaseObject = repo.objects.get(mergeBase);
        if (headObject && baseObject && mergeBaseObject) {
          const merged = threeWayMerge(
            flattenTree(repo, parseCommit(mergeBaseObject.data).tree),
            flattenTree(repo, parseCommit(baseObject.data).tree),
            flattenTree(repo, parseCommit(headObject.data).tree),
          );
          mergeable = merged !== null;
        }
      }
      const pull = store.createPull(repo, { title, body, headRef: headRefName, headSha, baseRef: baseRefName, baseSha, mergeable });
      out[key] = resolveSelections({ __typename: 'CreatePullRequestPayload', repo, pull }, 'CreatePullRequestPayload', field.selection, context);
      continue;
    }
    if (field.name === 'mergePullRequest') {
      const input = argObject(field, 'input', variables) ?? {};
      const pullRequestId = typeof input.pullRequestId === 'string' ? input.pullRequestId : '';
      const decoded = decodeGlobalId(pullRequestId);
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const pull = repo?.pulls.find((candidate) => candidate.number === decoded?.number);
      if (!pull || !repo || pull.state !== 'open') {
        context.errors.push({ message: 'mergePullRequest: pull request not found or not open', path: [field.name] });
        out[key] = null;
        continue;
      }
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
      if (!merged) {
        context.errors.push({ message: 'mergePullRequest: merge conflict', path: [field.name] });
        out[key] = null;
        continue;
      }
      const treeOid = buildTreeFromFlat(repo, merged, store);
      const mergeOid = createCommit({ repo, treeOid, parents: [currentBaseSha], message: `${pull.title} (#${pull.number})`, store });
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeOid);
      pull.state = 'closed';
      pull.merged = true;
      const { iso } = store.tick();
      pull.mergedAt = iso;
      pull.mergeCommitSha = mergeOid;
      pull.updatedAt = iso;
      out[key] = resolveSelections({ __typename: 'MergePullRequestPayload', repo, pull }, 'MergePullRequestPayload', field.selection, context);
      continue;
    }
    if (field.name === 'addComment') {
      const input = argObject(field, 'input', variables) ?? {};
      const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = decodeGlobalId(subjectId);
      const repo = decoded ? store.reposById.get(decoded.repoId) : undefined;
      const issue = repo?.issues.find((candidate) => candidate.number === decoded?.number);
      if (!issue || !body) {
        context.errors.push({ message: 'addComment: subject not found or body is missing', path: [field.name] });
        out[key] = null;
        continue;
      }
      const comment = store.createComment(issue, body);
      out[key] = resolveSelections({ __typename: 'AddCommentPayload', repo: repo!, issue, comment: { id: comment.id, body: comment.body } }, 'AddCommentPayload', field.selection, context);
      continue;
    }
    context.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".`, path: [field.name] });
    out[key] = null;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------------------------

export async function handleGraphQL(
  context: RestContext,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  if (pathname !== '/api/graphql') return false;
  if ((request.method ?? 'GET') !== 'POST') {
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
    sendJson(response, 400, { errors: [{ message: 'request body must be valid JSON' }] });
    return true;
  }
  const operations = Array.isArray(payload) ? payload : [payload];
  const results: unknown[] = [];
  for (const operation of operations) {
    if (typeof operation !== 'object' || operation === null) {
      results.push({ errors: [{ message: 'operation must be an object' }] });
      continue;
    }
    const record = operation as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = typeof record.variables === 'object' && record.variables !== null ? (record.variables as Record<string, unknown>) : {};
    if (!query) {
      results.push({ errors: [{ message: 'query is required' }] });
      continue;
    }
    let parsed: OperationNode;
    try {
      parsed = new GraphQLParser(query).parse();
    } catch (error) {
      results.push({ errors: [{ message: error instanceof Error ? error.message : 'query parse error' }] });
      continue;
    }
    const resolverContext: ResolverContext = { store: context.store, variables, errors: [] };
    const data = resolveTopLevel(parsed, resolverContext);
    const result: Record<string, unknown> = { data };
    if (resolverContext.errors.length) result.errors = resolverContext.errors;
    results.push(result);
  }
  sendJson(response, 200, Array.isArray(payload) ? results : results[0]);
  return true;
}

export { isAncestor };
