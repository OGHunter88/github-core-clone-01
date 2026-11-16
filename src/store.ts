// github-core-clone-01: the forge's in-memory store. One process, one store; every
// surface (REST, GraphQL, MCP, git smart HTTP) reads and writes the same maps, so a
// repository created over REST is immediately fetchable over git and visible in GraphQL.

import { hashObject, type GitObject, type GitObjectType } from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

export interface Identity {
  readonly login: string;
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

export interface User {
  readonly login: string;
  readonly id: number;
  readonly type: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
  user: User;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: User;
  readonly createdAt: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  user: User;
  mergeable: boolean;
}

export type RepoEvent = { readonly kind: 'repo'; readonly repo: Repo };
export type StoreEvent = RepoEvent;

export class Store {
  readonly reposByKey = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private repoIdCounter = 5000;
  private labelIdCounter = 0;
  private issueIdCounter = 10000;
  private pullIdCounter = 20000;
  private commentIdCounter = 30000;
  private seq = 0;
  readonly epochSec = 1700000000;
  readonly identity: Identity = {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
  };

  constructor() {
    // A fresh process starts with no repositories; the suite creates the ones it names.
  }

  key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  /** Deterministic timestamp: a counter over a fixed epoch, so replays agree. */
  tick(): { iso: string; epochSec: number } {
    const epochSec = this.epochSec + this.seq;
    this.seq += 1;
    return { iso: new Date(epochSec * 1000).toISOString(), epochSec };
  }

  viewerUser(): User {
    return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' };
  }

  globalId(repo: Repo): string {
    return Buffer.from(`R:${repo.id}`, 'utf8').toString('base64');
  }

  globalIdFor(kind: 'Issue' | 'PullRequest', repo: Repo, number: number): string {
    return Buffer.from(`${kind}:${repo.id}:${number}`, 'utf8').toString('base64');
  }

  createRepo(fields: { name: string; description?: string; private?: boolean; defaultBranch?: string }): Repo {
    const { iso } = this.tick();
    const repo: Repo = {
      id: this.repoIdCounter++,
      name: fields.name,
      owner: VIEWER_LOGIN,
      description: fields.description ?? '',
      private: fields.private ?? false,
      defaultBranch: fields.defaultBranch ?? 'main',
      createdAt: iso,
      updatedAt: iso,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
    };
    this.reposByKey.set(this.key(repo.owner, repo.name), repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.reposByKey.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (!repo) return false;
    this.reposByKey.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    return true;
  }

  listUserRepos(): Repo[] {
    return [...this.reposByKey.values()].filter((repo) => repo.owner === VIEWER_LOGIN);
  }

  // -------------------------------------------------------------------------------------------
  // git objects
  // -------------------------------------------------------------------------------------------

  addObject(repo: Repo, type: GitObjectType, data: Uint8Array): string {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const oid = hashObject(type, body);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data: body });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, pulls
  // -------------------------------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.find((label) => label.name === name);
    if (existing) return existing;
    const label: Label = { id: ++this.labelIdCounter, name, color };
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, fields: { title: string; body?: string; labels?: string[] }): Issue {
    const { iso } = this.tick();
    const issue: Issue = {
      id: this.issueIdCounter++,
      number: repo.nextIssueNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      labels: [...(fields.labels ?? [])],
      comments: [],
      createdAt: iso,
      updatedAt: iso,
      user: this.viewerUser(),
    };
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, fields: {
    title: string;
    body?: string;
    headRef: string;
    headSha: string;
    baseRef: string;
    baseSha: string;
    mergeable: boolean;
  }): Pull {
    const { iso } = this.tick();
    const pull: Pull = {
      id: this.pullIdCounter++,
      number: repo.nextPullNumber++,
      title: fields.title,
      body: fields.body ?? '',
      state: 'open',
      headRef: fields.headRef,
      headSha: fields.headSha,
      baseRef: fields.baseRef,
      baseSha: fields.baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: iso,
      updatedAt: iso,
      user: this.viewerUser(),
      mergeable: fields.mergeable,
    };
    repo.pulls.push(pull);
    return pull;
  }

  createComment(issue: Issue, body: string): Comment {
    const { iso } = this.tick();
    const comment: Comment = { id: this.commentIdCounter++, body, user: this.viewerUser(), createdAt: iso };
    issue.comments.push(comment);
    return comment;
  }
}
