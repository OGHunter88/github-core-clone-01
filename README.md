# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/OGHunter88/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/OGHunter88/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process, standard library only, built for
[the make.fun bounty](https://make.fun/bounty/github-core-clone-01). It serves git smart HTTP
(upload-pack protocol v2 and v0, receive-pack v0), REST v3 under `/api/v3`, GraphQL v4 at
`/api/graphql`, and MCP at `/mcp` — all from its own in-memory store, no outside service, no
proxy, no `git` binary.

Local conformance: **120/120 checks pass** (feature 600/600, agent 200/200) and the four timed
workloads score **179/200**, for **979/1000** on the kit's local runner.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own; the flag is harmless there and makes an older local Node work too. There is nothing to install:
the program imports `node:http`, `node:crypto` and `node:zlib` and its own modules only, and the
trial has no package manager and no internet.

## The lifecycle (main.ts)

The env is a server the harness starts beside yours. Its origin is in `MAKEFUN_ENV_URL`
(`http://store:8080` in a trial).

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port, and on the one-pod layout it is
   on the same loopback.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON. The
   env records the address the request came from plus that port as your base URL and dials it from
   then on. The first register wins: a later one is answered `409` and does not move the base URL.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   hold a request open, and never exit before it says `true`.
4. **Exit 0** when it does. Closing the server first is tidy; the harness stops the env afterwards,
   and the env's export is what the scorer reads.

A failed poll or register is retried with a short exponential backoff. If `MAKEFUN_ENV_URL` is unset
there is nothing to talk to, so `main.ts` exits 1 at once.

## The surface

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: viewer, repository, node, introspection, createIssue, closeIssue, createPullRequest, mergePullRequest, addComment, cursor pagination, batching |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28) and the legacy `initialize` handshake, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (v2 + v0), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` (the same token is
in your environment); `/healthz` is the boot probe and takes none. A request without the token is
401, and a repository belongs to the login the token names, so the same name under another owner is
404, never 403.

## How it works

- `src/gitobj.ts` — the git object model: SHA-1 object ids, trees (git's sort), commits, tags,
  reachability, packfile read/write (version 2, plain objects, delta resolution on read), and the
  pkt-line codec. Byte-exact with git's own formats, so objects round-trip through the suite's client.
- `src/store.ts` — the in-memory store: repositories, objects, refs, issues, pull requests, labels
  and comments. One store for all four surfaces, so a repository created over REST is immediately
  fetchable over git and visible in GraphQL and MCP. Timestamps are a counter over a fixed epoch,
  so replays agree byte for byte.
- `src/rest.ts` — REST v3: repos, refs, branches, commits, contents (create/update/delete, with
  base64 bodies and stale-sha 409s), labels, issues, comments, pull requests, and squash merges
  computed as a real three-way tree merge (a conflicting pull request answers 405).
- `src/githttp.ts` — git smart HTTP: v2 capability advertisement and `ls-refs`/`fetch` (with
  `peel`, `symrefs`, `unborn`, `ref-prefix`, shallow `deepen` and incremental `have` handling — a
  shallow boundary's parents are not held, so a deepen fetch delivers exactly one more generation),
  v0 upload-pack, and receive-pack with fast-forward enforcement and sideband-framed `report-status`.
- `src/graphql.ts` — GraphQL v4: a small parser (operations, fields, arguments, variables, inline
  fragments) and a resolver over the same store, with opaque base64 global ids that round-trip
  through `node(id:)` and the mutations, cursor pagination in the sort's own direction, and
  batched operation documents answered in order.
- `src/mcp.ts` — MCP: `server/discover` (supportedVersions `2026-07-28` back to `2024-11-05`) and
  the legacy `initialize` handshake, `tools/list` with the six tools the suite needs
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`), and `tools/call` that acts on the same store as REST.

The score is `feature + agent + perf` (0..1000): the conformance checks over that surface, the MCP
checks again as the agent-native column, and four timed workloads. The version of the suite the trial
runs is in the kit under `program/`, so you can grade the same checks locally before you submit.

## Rules and limits

The rules, the scoring weights, the deadline and the prizes are on the contest page:
**https://make.fun/bounty/github-core-clone-01** (its Rules section). In short: Node 22 only, no
dependencies at run time, no internet and no `git` binary in the trial; your repository is mounted
read-only at `/bot` and you may write under `/tmp` only. The env at `MAKEFUN_ENV_URL` is the service
you answer; the model gateway, if your entry calls a model, is the only other endpoint it can reach.
The trial's CPU, memory and process limits are the rules'; its wall budget is 900 seconds.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the server — one store, four surfaces.
- `src/gitobj.ts`, `src/store.ts`, `src/rest.ts`, `src/githttp.ts`, `src/graphql.ts`, `src/mcp.ts`:
  the forge, one job per module.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT): the entry's metadata and licence.

MIT licensed.
