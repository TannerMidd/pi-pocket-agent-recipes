# Agent recipes for Pi Pocket

Save reusable role briefs, configure models and thinking, and start a linked team directly from an owner-approved run preview.

**Version 0.2.0 · Requires Pi Pocket 0.16 or later, extension API 1.** Uses public conversation routes and human-bound linked sessions. The optional model status tool uses the experimental host list API; its absence does not disable the page. On older servers, the page shows an update notice and disables changes and starts.

## Install

1. Review `agent-recipes.ts` and the complete `agent-recipes/` folder. A drop-in runs with the server owner's rights.
2. Copy those files into the `extensions/` folder of your Pocket data folder (normally `~/.pi-pocket/extensions/`). Do not copy this repository's tests, development dependencies, or `node_modules` link.
3. Open **Menu → Extensions** and turn on **Agent recipes**. Then use **Menu → Agent recipes**, its rail button, or the launcher.

No install or restart is automatic. After you update an imported server helper such as `agent-recipes/domain.ts`, use **Menu → Restart server**: Node caches imported helpers. Test updates on an isolated server first.

## Use

### Recipes

The library includes **Review branch**, **Investigate regression**, and **Prepare release**. Select a recipe to edit it, or choose **New recipe**. Set its name, work mode, and 1–4 roles. Each role has a name, brief, default model, and default thinking level. Empty model and thinking choices inherit the selected source session at approval time.

Choose **Save recipe** to save directly. Saves do not require a selected session or its turn. You can duplicate or delete recipes from the library. Stale edits and deletes are rejected; a save conflict keeps your draft so you can load the latest version. Deleting a recipe does not change existing runs.

### Start a run

1. Select the source session in Pocket. Choose a saved recipe and **Run…**.
2. Check the source name and folder. Enter the required task and optional context. These fields and the role briefs go to the linked sessions and their model providers; do not include secrets.
3. Check the work mode and every role's effective model and thinking. Choices come from the source model and **Menu → Providers → Models for subagents**. A missing or unsupported choice must be changed explicitly; it is never silently replaced or lowered.
4. Choose **Start run**. This is the owner's approval and starts the saved snapshot directly. No command copying or agent mediation is needed.

The preview stays bound to its source. If the source model, thinking, or folder changes before approval, refresh the preview. Approval records exact effective choices, role briefs, task, context, and work mode. Later recipe edits do not change them. Each remaining start checks current model permission, availability, thinking support, and the source thinking limit again. A changed source folder blocks pending starts until the approved folder is restored.

### Runs and recovery

Open **Runs** to inspect runs for the selected source. **Refresh** gives a status snapshot, not continuous monitoring. **Open session** opens a visible linked role. A started or idle session does **not** mean its task is complete. Pocket can withhold session metadata; the page does not invent it.

Use **Retry safe remaining** after a partial start. It keeps the same launch ID and immutable snapshot and skips confirmed starts. Never make a replacement run to recover an uncertain start. Identical network reposts return the original run; a changed payload under the same ID is rejected.

**Cancel pending starts** prevents further starts when cancellation is observed. It does not stop existing sessions. A start already in flight can still create a session after you cancel. Use Pocket's normal session controls to stop sessions that were created.

Starts can fail because of plan mode, turn-taking, spending limits, model availability, or team limits. The retry window is 24 hours. After that, inspect the existing sessions rather than assume the run did nothing.

Before each start, the module stores the role's stable key, attempt time, and visible linked-address baseline. It stores the result separately, never inside the start transaction. After a lost response or result commit, retry first reconciles the role's frozen title through the public linked-session list. New runs use readable titles with unique run and role numbers; old approvals keep their hashed titles. A proved match is recorded without another start; its initial message can still be unconfirmed. Renamed, hidden, missing, or ambiguous sessions fail closed. Do not rename or delete linked sessions during recovery. Host receipts and module documents remain authoritative; the in-flight guard is not a durable queue.

## Configuration and limits

- **Read-only** tells roles not to edit files or change state. **Allow local edits** permits task-related edits and tests inside the source folder. Existing saved briefs keep their own restrictions; changing mode does not rewrite them.
- Work modes are **instruction policy, not a sandbox**. All roles use the **same working folder**, not separate worktrees. Coordinate shared files. Writes outside that folder, commits, merges, pushes, publication, deployment, and public comments need separate explicit owner authorization outside the recipe.
- Models and thinking can be set per recipe role or overridden per run. Unavailable saved defaults remain saved and visible. Launches reject unsupported inherited thinking and ask for an explicit supported level.
- Limits: 20 recipes, 1–4 roles each, 30 saved runs per source; recipe name 60 characters, role name 40, role brief 5,000, task 2,000, context 6,000. Pocket's own linked-session limits remain authoritative.

## Security and stored data

The UI and all routes are owner-only. Routes use Pocket authentication and its `X-Pocket` check through `pocket.api`. Source routes bind an explicitly selected conversation and start/list as the signed-in person, not the source agent's last requester. Pocket checks source visibility, steering rights, turn-taking, plan mode, spend, and linked-session limits. Library changes are global owner actions and do not need a source.

Only the owner-bound human routes approve or start runs. There is no model-start or self-approval tool, and old approvals remain recoverable through Runs. The read-only `agent_recipes_status` tool only lists visible linked sessions in its own source. Model-facing results are fenced as untrusted data.

Stored document contracts are unchanged:

- `x.agent-recipes.catalog`: session scope (the whole Pocket store).
- `x.agent-recipes.launches`: conversation scope, `history: latest`, `fork: initial`. Forks do not inherit approval.

Old recipes normalize to read-only with inherited choices without changing stored data on a read. Existing launch IDs, role IDs, start keys, and legacy `models[]` records remain usable. Turning the module off or removing its files does not erase its documents. No automatic cleanup is performed.

The module reads no outside files, transcripts, database handles, tokens, or sign-ins. It starts no subprocesses and makes no direct network requests. It uses only public Pocket APIs and its own durable documents; there is no command-context cache or private endpoint workflow. Normal linked agents can still use their configured tools and providers. Other server extensions and the owner's shell can read document data; namespacing is not isolation.

## Development

Use Node 24 or later and an independent checkout:

```sh
npm install
npm run check
npm test
```

Pocket runs the TypeScript directly; there is no build output. `_pocket.d.ts` is an editor-only copy of Pocket's public API. It is not a runtime import. A gitignored `node_modules` symlink to a compatible Pocket checkout is convenient for local development, but must not be shipped.

The server tests use real Pi Durable in-memory documents with fake public host and request-bound linked-session services. They cover owner/source boundaries, immutable approval and revision conflicts, current model/thinking/folder checks, uncertain-start recovery, concurrent retry/cancellation, and legacy records. They require no model provider, browser, live installation, or owner data. They do not replace integration tests against a compatible Pocket server. Use an isolated temporary data directory for those checks, never the owner's live data.

## Distribution

Install only these runtime files:

```text
agent-recipes.ts
agent-recipes/domain.ts
agent-recipes/index.js
agent-recipes/style.css
```

Source: [TannerMidd/pi-pocket-agent-recipes](https://github.com/TannerMidd/pi-pocket-agent-recipes). Gallery availability depends on a reviewed index entry. **Menu → Extensions → Share…** can prepare an entry from an installed copy.

## License

MIT. See [LICENSE](LICENSE).
