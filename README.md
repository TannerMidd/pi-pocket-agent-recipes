# Agent recipes for Pi Pocket

Save read-only team briefs, preview each role and model, and approve a linked team in a source session. No external service is needed to save recipes or build requests. Starting a team uses the model providers already set in Pocket.

**Version:** 0.1.0. It needs Pi Pocket 0.14 or later, extension API 1, and the **experimental** public `host.linkedSessions` API. The module checks that the API exists. A future Pocket minor release can change this experimental API.

## Install

1. In Pocket, open **Menu → Extensions**. Review the full module and its browser files before you turn it on.
2. For a manual install, copy `agent-recipes.ts` and the complete `agent-recipes/` folder into the `extensions/` folder of your Pocket data folder. The default is `~/.pi-pocket/extensions/`. If you set `PI_POCKET_DIR`, use its `extensions/` folder instead. Do not copy tests, development dependencies, or this repository's `node_modules` link.
3. In **Menu → Extensions**, turn on **Agent recipes**. It starts off, like other drop-ins.
4. Select the source session. As the owner, send `/agent-recipes-sync` there.
5. Open **Menu → Agent recipes**, then tap **Refresh**. The rail and launcher also have an Agent recipes action.

No install or restart is automatic. When you update `agent-recipes/domain.ts` or another imported server helper, use **Menu → Restart server** after you put the files in place. Node caches these helper files. A root module reload alone is not enough. Review and test an update before you use it on a live server.

The extension does not install itself or change Pocket core. Review the source before installation.

## Use

### Save a recipe

The library starts with three recipes, each with distinct roles:

- **Review branch:** correctness, security, and coverage review.
- **Investigate regression:** code-path tracing, local history, and reproduction planning.
- **Prepare release:** readiness review, release notes draft, and a verification plan.

Select a recipe and tap **Edit selected recipe**, or tap **New recipe**. Set its identifier, title, and 1–4 read-only role briefs. Tap **Build save command**. Copy the command into an owner session and send it. Return to Agent recipes, close the editor, and tap **Refresh**.

The command, not the page, saves the data. Edits left only in the page are not saved. A revision check rejects stale edits. There is room for 20 recipes; this version does not delete recipes.

### Approve and launch a team

1. Select the source session and run `/agent-recipes-sync` there. Open Agent recipes and tap **Refresh**. The selected session must match the last synced source; otherwise launch generation is blocked.
2. Select a saved recipe. Enter a **Target** and optional **Context**. Do not put secrets in these fields. They go into linked sessions and to model providers.
3. For each role, explicitly choose an owner-allowed model, or keep **Use source session model (omit model)**. Extra choices come only from **Menu → Providers → Models for subagents**. The source-model option sends no `model` override.
4. Read the preview and tap **Build launch request**.
5. Copy the **Approval command** into the source session and send it as the owner. It saves an immutable, session-scoped approval with the recipe revision, role briefs, target, context, chosen models, owner ID, and per-role start keys.
6. Copy the **Launch message** and send it as a **new message in that same source session**. Pi can now call `agent_recipes_launch` with that launch ID. A command's toast is not sent to Pi, so this second message is required.

The page never launches a session itself. Clipboard access can fail on plain LAN HTTP. Each copy box also has selectable text. Identifiers use `crypto.getRandomValues`, which works on plain HTTP; they do not require `crypto.randomUUID`.

All roles receive an explicit read-only brief. They must report once, then stop. Publishing, deployment, merging, commits, pushes, and public comments need a **separate explicit owner request outside this recipe**. Prepare release drafts text; it does not make a release.

### Status, retry, and revoke

- Run `/agent-recipes-sync` in the source session, then tap **Refresh**, to load that session's saved launch progress.
- Ask Pi to use `agent_recipes_status` in the source session, then tap **Refresh**, for a linked team activity snapshot. This uses only public `linkedSessions.list`. Pocket can withhold titles and activity fields. There is no automatic polling or autonomous loop.
- On a partial failure, use the **same launch ID**. Never build a new launch to retry an existing team. Completed roles are skipped. Errors can be caused by plan mode, turn-taking, spend limits, unavailable models, or team limits.
- An approval permits starts for 24 hours. After that it fails closed. Do not assume that an old launch did nothing.
- Send `/agent-recipes-cancel <launch ID>` to revoke future starts. This does **not** stop sessions that already started. Use Pocket's normal session controls to stop them. There is no public linked-session stop API used here.

Before each side effect, the module records its role key, attempt time, and the visible linked-address baseline. The host normally deduplicates the start key. Its documented retention is 30 days and the last 1,000 calls per source; the shorter 24-hour window alone does not protect against count eviction.

For an unconfirmed start, the module first uses the public list API to reconcile a stable, role-specific title. If the session exists, it records that address **without another start**. The first message may still be unconfirmed; inspect the session. If the team gained an address with a changed or withheld title, or a baseline is unavailable, retry fails closed. If the visible team has no new addresses, the module can safely retry the same key. It never silently creates a replacement team to resolve uncertainty. Do not delete or rename linked sessions during recovery; doing so can make reconciliation incomplete. No extension can promise idempotency after someone deletes its stored data or changes the server's guarantees.

## Access and data

- **Owner-only UI and routes.** Guests and viewers, including people invited to one session, cannot read this module's catalog or UI cache through its routes. Every route uses the normal Pocket authentication and `X-Pocket` check through `pocket.api`.
- All four commands have `scope: "global"` and check the owner's role again. Launch approval must be a human command. A model cannot approve itself with the launch tool.
- `agent_recipes_launch` reads only its current session's approval document. The active requester must match the owner who approved it. It cannot take an arbitrary session ID or working directory. Approvals are not copied into forks.
- `agent_recipes_status` can be called by agents in their current session. The host applies the active requester's linked-session visibility rules. It reads no global recipe document. Tool results are fenced and labeled as untrusted data.
- Recipe documents use `x.agent-recipes.catalog` (Pi Durable **session scope**, meaning the whole Pocket store). Per-conversation approvals and progress use `x.agent-recipes.launches` (`history: latest`, `fork: initial`). These names and semantics are stable storage contracts.
- These documents are stored by Pocket in its normal database. Turning the module off or uninstalling its files does not erase them. There is no automatic data cleanup. There is room for 30 approvals per source session, including revoked approvals; use a new source session for new teams after that.
- Routes have **no public document reader, commit API, session resolver, or working directory**. The host has no public database handle. Therefore `/agent-recipes-sync` explicitly copies authorized document snapshots into an owner-keyed, read-only in-memory UI cache. Saves and approvals refresh that cache too. A reload or restart clears the cache, not the documents; sync again. There is no file-store workaround and no private API call.
- The UI cache shows only the last synced source, not an unrelated session. It can become stale until you refresh or sync. Status is a snapshot, not a live monitor. It does not contain source transcripts.
- No filesystem reads, subprocesses, direct network calls, tokens, sign-ins, or arbitrary shell commands are used by this extension. Its runtime imports are bundled helpers, Node's `crypto`, and Pocket-supplied packages. `_pocket.d.ts` is an editor-only copy of the public types; it is not a runtime import.

## Security and limits

A drop-in runs in the Pocket server with the owner's rights. It is **not a sandbox**. The browser part runs with the signed-in owner's rights. Review all code before enabling it.

Linked sessions are ordinary agents. **Every linked role uses the source session's working directory, NOT a separate worktree.** They receive copied source agent settings, but not source history, plan mode, or a separate spending budget. Read-only role prompts are guidance only; the linked agents still have their normal tools. Do not use these recipes as a security boundary.

The host enforces source access, right to steer, plan mode, turn-taking, spending limits, allowed models, and linkage limits. This module does not weaken them. Linked sessions cannot start another team. The current Pocket host permits at most 10 starts per source and limits inter-agent messages; the host remains authoritative if these limits change. This extension does not relay messages, raise budgets, raise thinking levels, start autonomous loops, edit files, or publish anything.

The owner's allowed-model choices are checked at approval and again before a start. Revoking an allowed model blocks a later start. An explicit source-model ID is not offered as a bypass: use the omission option for the source's model. The host checks current model availability.

Do not use secret prompts or private context in a session shared with other people. Tool calls and results are visible to the people who can read that source session; normal linked-session visibility rules also apply. The document namespace prevents collisions, not access by other server extensions or the owner's shell.

## Develop and test

Use Node 24 or later and an independent checkout. No build output is needed; Pocket runs TypeScript with Node's type stripping.

Portable setup:

```sh
npm install
npm run check
npm test
```

`npm run check` checks the actual server files, public type declarations, tests, and browser JavaScript imports. The server is strict TypeScript. Browser JavaScript uses `checkJs` with relaxed implicit parameter and null inference. It also runs `node --check` on the browser entry. `npm test` uses real Pi Durable in-memory documents and fake public linked-session services. No model provider, Pocket source import, owner data, live server, or browser is needed.

The five focused tests cover approval access boundaries, revoked models, recovery after a successful start with a lost result commit and an evicted host receipt, changed-title uncertainty, and stale recipe edits across a module reload. They do not claim a full real-provider or real-browser integration test.

For local development beside a compatible Pocket checkout, you may replace a local install with a gitignored `node_modules` symlink to that checkout's `node_modules`. This repository currently uses that convenience link. It is not an installation dependency and must not be shipped. The package versions in `package.json` give the portable development dependencies.

For a browser test, use a separate Pocket test server and a temporary data directory, not the owner's live install. Copy only the module and its folder to that test server's extension directory. Do not set `PI_POCKET_DIR` to a live data folder. Review desktop and mobile layouts, clipboard fallback, the sync/source mismatch warning, recipe save, and the two-step approval flow. A scripted echo model does not call the launch tool; use a scripted tool-calling model for that check. A manual smoke test on an isolated Pocket 0.15 copy checked desktop/mobile layout, sync, approval-request generation, and an approved three-role launch through the real public linked-session service. No real model provider was used. Separate HTTP checks confirmed that guests and viewers cannot reach the route.

## Files for a gallery entry

```text
agent-recipes.ts
agent-recipes/domain.ts
agent-recipes/index.js
agent-recipes/style.css
```

The module has the required root name and a single namespaced support folder. It imports no Pocket source code or machine-specific runtime path. Tests, documentation, development files, and `_pocket.d.ts` need not be installed. Source: [TannerMidd/pi-pocket-agent-recipes](https://github.com/TannerMidd/pi-pocket-agent-recipes). Gallery installation becomes available after its index entry is reviewed and merged. For later updates, **Menu → Extensions → Share…** can generate an entry from the installed files.

## License

MIT. See [LICENSE](LICENSE).
