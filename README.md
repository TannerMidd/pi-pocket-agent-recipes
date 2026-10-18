# Agent recipes for Pi Pocket

Create reusable agent teams from a conversation or from the recipe editor. Pi can draft recipes, find recipes made available to the conversation, and prepare a run by name. The owner can review proposals in a sheet without slash commands or a trip through the editor. Automatic use is optional and off by default.

**Version 0.3.0 · Requires Pi Pocket 0.16.0 or later · Extension API 1.**

## Install and update

Use **Menu → Extensions → Find extensions** to find Agent recipes. Review the source, install it, and turn it on. Review the file diff before an update. The gallery supplies an exact, reviewed source commit; its version must match this source before you install it.

For manual installation, copy only these runtime files into your Pocket data folder's `extensions/` directory:

```text
agent-recipes.ts
agent-recipes/index.js
agent-recipes/style.css
```

Do not copy tests, development dependencies, `node_modules`, or `_pocket.d.ts`. Pocket supplies the runtime packages and editor types.

The 0.3 server module contains its runtime helpers. It does not import the old `agent-recipes/domain.ts`, so a 0.2-to-0.3 update does not depend on clearing Node's helper cache. Existing recipes and run history remain stored. No installer or restart runs automatically. Changing Pocket's core still requires **Menu → Restart server**.

## Create a recipe with Pi

Ask in a conversation, for example:

> Create a review recipe with correctness, security, and test reviewers. Keep all roles read-only.

Pi can save and revise a draft in that conversation. A draft is not a trusted library recipe and cannot enable automatic use. The owner reviews the roles, instructions, models, and work mode before accepting it into the library. Review can take place in the extension's sheet, without copying text into the editor or sending a slash command.

An edit proposal records the saved recipe revision that it changes. If the library changes first, the owner must resolve the conflict rather than overwrite a newer version. Model tools cannot publish a recipe into the library, delete a saved recipe, or change their own permissions.

## Let Pi find and use recipes

The library is owner-managed. It is not automatically exposed to every conversation or every guest.

From **Agent recipes**, use the selected conversation's controls to make particular saved recipe versions available to Pi. Pi can list and read only the versions shared with that conversation. Short discovery instructions tell Pi how to use its recipe tools. A saved recipe name alone does not authorize a run.

Then ask, for example:

> Use Review branch to check the current diff for regressions. Do not change files.

Without automatic permission, Pi prepares a pending run. The owner reviews the source, task, context, roles, models, thinking, and work mode in a confirmation sheet, then chooses **Start run**. This is a direct owner action through a conversation-bound route. It does not require the owner to post another message or type a command.

A run freezes its recipe and effective choices. Editing the library later does not alter existing runs or silently expand an existing automatic-use policy.

## Optional automatic use

Automatic use is **off by default**. The owner can allow a specific recipe snapshot in a specific conversation, with a bounded run allowance. Models cannot enable, expand, reset, or renew that allowance. Changing a recipe does not give Pi permission to use the changed version automatically.

A use is consumed when a logical automatic run is reserved, even if some or all role starts fail. Replaying that same call keeps its existing run and does not consume another use.

Permission applies to this extension's workflow in that conversation. It does **not** delegate the owner's identity or grant extra Pocket rights. An automatic tool acts through the public model-facing linked-session API as the conversation's **current requester**. That host-linked API, also used by the status tool, is experimental. Pocket still checks source access, steering, turns, plan mode, spend, allowed models, provider availability, and team limits. Automatic runs are labeled separately from runs approved by an owner click.

Automatic starts do not have all of the stronger guarantees of human-bound starts. The model-facing API has no atomic expected-requester, expected-folder, or expected-source-settings parameter, and its thinking policy can cap a level. Checks in the extension cannot close every race while a start waits. Do not use automatic mode when your requirement is "start only as this previously approved person, with exactly these source settings, or reject atomically." Use the human confirmation route for that requirement.

Revoking permission or canceling pending work does not undo admitted work or reliably stop a start already in flight. A finite allowance is not a promise that every run will start successfully: Pocket's own team and spend limits remain authoritative.

## Use the editor directly

Open **Menu → Agent recipes**, the rail button, or the launcher. The supplied recipes are **Review branch**, **Investigate regression**, and **Prepare release**.

Choose a recipe or **New recipe**. Set its name, work mode, and 1–4 roles. Each role has a name, brief, optional model, and optional thinking level. Empty choices inherit the source at run approval time. **Save recipe**, duplicate, and delete work directly in the page; they do not require a selected conversation or its turn.

To run manually, select a source conversation, choose **Run…**, enter the task and optional context, check every role, and choose **Start run**. Missing or unsupported model choices must be changed explicitly; they are not silently substituted. Source changes can invalidate a human preview, which must then be refreshed.

The page adapts to its panel width, not only the browser width. Narrow desktop panels use the same single-pane navigation as a phone. Unsaved editor drafts and uncertain run requests are retained for recovery rather than silently discarded.

## What a run does

Each role starts in an ordinary linked Pocket session. It receives its role brief, the task, and the supplied context—not a copy of the source conversation's full history. Its normal tools and provider are available, and normal model costs apply. Do not put secrets in text that goes to a model provider.

All roles use the **same working folder**, not separate worktrees. Coordinate shared files.

- **Read-only** tells roles not to change files or other state.
- **Local edits** permits task-related edits and tests inside the source folder.
- These are **instructions, not a sandbox**. Existing briefs can impose stricter limits.
- Changes outside the source folder, commits, merges, pushes, publication, deployment, and public comments need separate explicit authorization outside the recipe.

A linked role cannot start another team. Pocket's team limits still apply. A started or idle session does not prove that its task is complete.

## Runs and recovery

Open **Runs** to inspect work for the source. **Open session** navigates through Pocket's public conversation API. Status is a snapshot, not a guarantee of task completion; withheld metadata is not invented.

For an owner-confirmed run, **Retry safe remaining** retains the run's launch ID, immutable snapshot, and stable per-role keys. It skips confirmed starts. Automatic runs can resume only through their original model call under the current policy, not through the human retry button; the owner can cancel their remaining roles. Never create a replacement run to recover an uncertain start. Identical reposts return the original run; a changed payload under the same ID is rejected.

Before a start, the module stores the role key, attempt time, and visible linked-session baseline. After a lost result, recovery reconciles the frozen role title through the public linked-session list. Renamed, hidden, missing, or ambiguous sessions fail closed. Do not rename or delete sessions during recovery. Receipts have finite retention: this is not a lifetime exactly-once guarantee.

The retry window is 24 hours. **Cancel pending starts** prevents further starts when cancellation is observed; it does not stop sessions already created or reliably cancel a start in flight. Stop those through Pocket's session controls.

Each conversation has room for 8 active drafts, 20 retained run requests, and 30 saved runs. Draft changes and consent identities also have finite receipt limits, and assistant state is capped at 768 KiB. Completed requests and receipt history are not silently erased to make replay protection disappear; use a new conversation when a retained-history limit is reached. Pocket's linked-team limit may be reached earlier.

## Stored data and access

The library and browser UI are owner-only. Model drafts, shared snapshots, automatic-use policies, and pending proposals are conversation-scoped. Model tools do not take an arbitrary conversation ID and cannot use request capabilities saved from an earlier human action. A fork must not inherit grants or approvals.

Existing durable contracts remain unchanged:

- `x.agent-recipes.catalog`: session scope, for the whole Pocket store.
- `x.agent-recipes.launches`: conversation scope, `history: latest`, `fork: initial`.

Old recipes normalize without rewriting stored data on a read. Existing launch IDs, role IDs, start keys, and legacy `models[]` records remain usable. New workflow state uses additional module-owned documents. Disabling or removing the extension does not erase those documents. No automatic pruning of old runs is performed.

The extension reads no outside files, transcripts, database handles, tokens, or sign-ins. It starts no subprocesses and makes no direct external network requests. Linked agents can still use their normal tools and providers. Text from tools, drafts, tasks, and linked sessions is treated as untrusted data. Module namespacing is not a sandbox against other extensions or an owner with shell access.

## Development

Use Node 24 or later and an independent checkout:

```sh
npm install
npm run check
npm test
```

Pocket runs the server TypeScript directly. `_pocket.d.ts` is an editor-only copy of the public API. A development `node_modules` symlink is not part of the runtime payload. `agent-recipes/domain.ts` is a test/editor compatibility entry, not a production server dependency.

Keep tests lean and tied to real risks. Existing fixtures cover legacy data, owner/source boundaries, frozen run approvals, model/thinking checks, retries, cancellation, and uncertain starts. The conversational workflow also needs checks for draft/revision isolation, unavailable recipe disclosure, owner-only policy changes, and replay-safe automatic quotas.

Use isolated temporary Pocket data for HTTP and desktop/mobile checks. Test the in-place upgrade from the published 0.2.0 files with the old helper already loaded, a saved custom recipe, and an existing run. A fresh-process import alone does not test that path. Do not test on the owner's live data.

## License

MIT. See [LICENSE](LICENSE).
