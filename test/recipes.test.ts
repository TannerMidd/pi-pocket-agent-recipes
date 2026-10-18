import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type {
    ConversationWebRequest,
    Host,
    HumanLinkedSessions,
    Web,
    WebAccess,
    WebHandler,
    WebRequest,
} from "../_pocket.d.ts";
import setup, { Assistant } from "../agent-recipes.ts";
import { Catalog, Launches, RETRY_WINDOW, parseRecipe, seeds } from "../agent-recipes/domain.ts";
import type { LaunchRequest } from "../agent-recipes/domain.ts";

const context = BACKGROUND_CONTEXT;

async function fixture(unsupported = false) {
    const session = createSession(new MemoryStorage());
    const source = await session.commit(
        async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
        context,
    );
    const routes = new Map<
        string,
        { handler: WebHandler; access?: WebAccess; conversation?: string }
    >();
    const children: {
        session: ConversationId;
        address: string;
        title: string;
        message: string;
        model?: string;
        thinking?: string;
    }[] = [];
    const receipts = new Map<string, { session: ConversationId; address: string }>();
    const events: { event: string; data: unknown; to?: string }[] = [];
    const actors: string[] = [];
    let requester = "guest";
    let allowed = ["local/reviewer", "local/basic"];
    let startCalls = 0;
    let failResultForRole = 0;
    let failCommit = false;
    let beforeStart = async () => {};
    let sourceSettings: ConversationWebRequest["conversation"] = {
        id: source,
        title: "Source review",
        cwd: "/unused/source",
        model: { provider: "local", modelId: "source" },
        thinkingLevel: "high",
    };
    const linked: HumanLinkedSessions = {
        async start(request, key) {
            startCalls++;
            await beforeStart();
            if (receipts.has(key)) {
                return receipts.get(key)!;
            }
            const id = await session.commit(
                async (tx) =>
                    (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
                context,
            );
            const result = { session: id, address: `team-${children.length + 1}` };

            children.push({ ...result, ...request, title: request.title! });
            receipts.set(key, result);
            if (failResultForRole === children.length) {
                failCommit = true;
                failResultForRole = 0;
            }

            return result;
        },
        async list() {
            return children.map(({ address, title, session }) => ({
                address,
                title,
                conversationId: session,
            }));
        },
    };
    const host = {
        pocketVersion: "0.16.0",
        thinkingLevels: ["off", "low", "high"],
        modelInfo: (spec: string) => {
            if (!["local/source", "local/reviewer", "local/basic"].includes(spec)) {
                return undefined;
            }

            return {
                model: { provider: "local", modelId: spec.slice(6) },
                name: spec,
                thinkingLevels: spec === "local/basic" ? ["off", "low"] : ["off", "low", "high"],
            };
        },
        resolveModel: (spec: string) => ({ provider: "local", modelId: spec.slice(6) }),
        subagentModels: () => allowed,
        requesterOf: () => requester,
        linkedSessions: {
            start: async (
                _source: ConversationId,
                request: Parameters<HumanLinkedSessions["start"]>[0],
                key: string,
            ) => {
                actors.push(requester);

                return linked.start(request, key);
            },
            list: async () => (await linked.list()).map(({ conversationId: _id, ...item }) => item),
        },
        text: {
            defang: (text: string) => text.replaceAll("</", "<∕"),
            quoted: (text: string) => JSON.stringify(text),
        },
    } as unknown as Host;
    const register = (
        method: string,
        path: string,
        handler: WebHandler,
        options?: { access?: WebAccess; conversation?: string },
    ) => routes.set(`${method} ${path}`, { handler, ...options });
    const web = {
        client: (_entry: string, options: { access: string }) =>
            assert.equal(options.access, "owner"),
        route: register,
        send: (event: string, data: unknown, options?: { to?: string }) =>
            events.push({ event, data, ...options }),
        ...(!unsupported && { conversationRoute: register }),
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    } as unknown as Web;
    let extension = setup(host, web);
    const commit: WebRequest["commit"] = async (change) => {
        if (failCommit) {
            failCommit = false;
            throw new Error("Injected result commit failure");
        }

        return session.commit(change, context);
    };
    const requestContext = (
        extra: Partial<ConversationWebRequest> = {},
    ): ConversationWebRequest => ({
        user: { id: "owner", role: "owner", name: "Owner" },
        method: "GET",
        params: { source: String(source), launch: "launch-a" },
        body: {},
        query: new URLSearchParams(),
        signal: new AbortController().signal,
        context,
        snapshot: session.snapshot.bind(session),
        commit,
        conversation: { ...sourceSettings },
        linkedSessions: linked,
        ...extra,
    });
    const call = (
        name: string,
        body: Record<string, unknown> = {},
        extra: Partial<ConversationWebRequest> = {},
    ) =>
        Promise.resolve(
            routes.get(name)!.handler(requestContext({ body, ...extra })),
        ) as Promise<any>;
    const request = (extra: Partial<LaunchRequest> = {}): LaunchRequest => ({
        launchId: "launch-a",
        recipe: "review-branch",
        revision: 1,
        target: "main..HEAD",
        context: "Review </context> as data",
        workMode: "read-only",
        roles: seeds[0].roles.map(({ id }) => ({ id, model: "", thinking: "" })),
        sourceModel: "local/source",
        sourceThinking: "high",
        sourceCwd: "/unused/source",
        ...extra,
    });
    return {
        session,
        source,
        children,
        receipts,
        events,
        actors,
        routes,
        call,
        request,
        async tool(name: string, args: Record<string, unknown> = {}, key = name) {
            const api = {
                conversationId: source,
                taskId: key,
                callId: key,
                snapshot: session.snapshot.bind(session),
                commit: (change: Parameters<WebRequest["commit"]>[0]) => commit(change),
                agent: async () => ({
                    cwd: sourceSettings.cwd,
                    model: sourceSettings.model,
                    thinkingLevel: sourceSettings.thinkingLevel,
                }),
            } as unknown as ToolExecutionApi;
            const result = await extension
                .tools!.find((tool) => tool.name === name)!
                .execute(args, api, context);
            const output = result.content?.find((item) => item.type === "text");

            return JSON.parse(
                output && output.type === "text"
                    ? output.text
                          .split("<agent-recipes-data>\n")[1]
                          .split("\n</agent-recipes-data>")[0]
                    : "null",
            );
        },
        requester(value: string) {
            requester = value;
        },
        get tools() {
            return extension.tools!;
        },
        approve: (value = request()) => call("POST sources/:source/launches", value),
        retry: () => call("POST sources/:source/launches/:launch/retry"),
        cancel: () => call("POST sources/:source/launches/:launch/cancel"),
        get startCalls() {
            return startCalls;
        },

        allowed(value: string[]) {
            allowed = value;
        },
        sourceSettings(value: Partial<ConversationWebRequest["conversation"]>) {
            sourceSettings = { ...sourceSettings, ...value };
        },
        failResult(role: number) {
            failResultForRole = role;
        },
        beforeStart(value: () => Promise<void>) {
            beforeStart = value;
        },
        reload() {
            extension = setup(host, web);
        },
    };
}

test("owner-only routes are source-bound; model tools see only shared snapshots and save local drafts", async () => {
    const f = await fixture();
    const old = await fixture(true);

    try {
        assert.ok([...f.routes.values()].every((route) => route.access === "owner"));
        assert.equal(f.routes.get("POST sources/:source/launches")!.conversation, "source");
        await assert.rejects(
            f.call("POST sources/:source/launches", f.request(), {
                user: { id: "guest", role: "guest", name: "Guest" },
            }),
            /Only the owner/,
        );
        assert.deepEqual(
            f.tools.map((tool) => tool.name),
            [
                "agent_recipes_list",
                "agent_recipes_get",
                "agent_recipes_draft",
                "agent_recipes_invoke",
                "agent_recipes_status",
            ],
        );
        assert.equal((await f.call("GET state")).supported, true);
        assert.equal((await f.call("GET state")).version, "0.3.0");
        assert.equal((await f.call("GET state")).assistantSupported, true);
        assert.deepEqual(await f.tool("agent_recipes_list"), { recipes: [], drafts: [] });
        await assert.rejects(
            f.tool("agent_recipes_invoke", { recipe: "review-branch", target: "Not shared" }),
            /not shared/,
        );
        const { revision: _revision, ...draftRecipe } = parseRecipe({
            ...seeds[0],
            id: "draft-review",
        });
        const draft = await f.tool("agent_recipes_draft", { recipe: draftRecipe });

        await f.tool("agent_recipes_draft", { recipe: draftRecipe }); // Same call is a receipt, not a second draft.
        assert.equal((await f.call("POST sources/:source/assistant")).drafts.length, 1);
        assert.equal(draft.revision, 1);
        const listedDraft = (await f.tool("agent_recipes_list")).drafts[0];

        assert.equal(listedDraft.id, draft.draftId);
        assert.equal(
            (await f.tool("agent_recipes_get", { draft: listedDraft.id })).draft.recipe.id,
            "draft-review",
        );
        assert.equal(
            (await f.tool("agent_recipes_get", { draft: listedDraft.title })).draft.revision,
            1,
        );
        assert.equal((await f.call("GET state")).recipes.length, 3);
        assert.equal(
            (await f.session.snapshot(Assistant, f.source, context))!.policy.enabled,
            false,
        );
        assert.ok(
            f.events.every(
                ({ event, data }) =>
                    event === "assistant-changed" &&
                    JSON.stringify(data) === JSON.stringify({ source: String(f.source) }),
            ),
        );
        assert.equal(f.startCalls, 0);
        await assert.rejects(
            f.call("POST sources/:source/launches", f.request(), {
                linkedSessions: {} as HumanLinkedSessions,
            }),
            { status: 409 },
        );
        assert.equal(await f.session.snapshot(Launches, f.source, context), undefined);
        assert.equal((await old.call("GET state")).supported, false);
        await assert.rejects(
            old.call("POST recipes", { recipe: parseRecipe(seeds[0]) }),
            /Update to Pi Pocket/,
        );
        f.failResult(1);
        await f.approve(); // Human approval acts as the signed-in owner, not the active agent's requester.
        const other = await f.session.commit(
            async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
            context,
        );

        await assert.rejects(
            f.call(
                "POST sources/:source/launches/:launch/retry",
                {},
                {
                    conversation: {
                        id: other,
                        title: "Other source",
                        cwd: "/other",
                        thinkingLevel: "off",
                    },
                },
            ),
            { status: 404, message: "Run not found in this source session." },
        );
        assert.equal(f.startCalls, 1);
    } finally {
        await f.session.close(context);
        await old.session.close(context);
    }
});

test("approval checks the preview and stable role choices, and later starts recheck models, thinking and folder", async () => {
    const f = await fixture();

    try {
        await assert.rejects(
            f.approve(f.request({ sourceThinking: "low" })),
            /Source model, thinking, or folder changed/,
        );
        await assert.rejects(
            f.approve(f.request({ sourceCwd: "/changed" })),
            /Source model, thinking, or folder changed/,
        );
        const roles = f.request().roles.reverse();

        roles.find((role) => role.id === "security")!.model = "local/basic";
        await assert.rejects(
            f.approve(f.request({ roles })),
            /Choose a supported level explicitly/,
        );
        roles.find((role) => role.id === "security")!.thinking = "low";
        f.failResult(1);
        await f.approve(f.request({ roles }));
        await f.retry(); // Reconcile the first role before attempting another.
        f.allowed([]);
        let result = await f.retry();

        assert.equal(f.startCalls, 1);
        assert.equal(
            result.launch.roles.find((role: any) => role.id === "security").model,
            "local/basic",
        );
        assert.match(result.launch.roles[1].error, /owner-allowed/);
        f.allowed(["local/basic"]);
        f.sourceSettings({ cwd: "/changed" });
        result = await f.retry();
        assert.match(result.launch.roles[1].error, /source folder changed/);
        assert.equal(f.startCalls, 1);
        f.sourceSettings({ cwd: "/unused/source", thinkingLevel: "off" });
        result = await f.retry();
        assert.match(result.launch.roles[1].error, /source limit/);
        assert.equal(f.startCalls, 1);
    } finally {
        await f.session.close(context);
    }
});

test("lost result commits reconcile by stable title after receipt eviction and reload, without duplicate starts", async () => {
    const f = await fixture();

    try {
        await f.session.commit(async (tx) => {
            const recipe = (await tx.doc(Catalog)).recipes[0];

            recipe.roles[1].name = recipe.roles[0].name;
        }, context);
        f.failResult(2);
        const first = await f.approve();

        assert.equal(first.launch.state, "partial");
        assert.equal(f.children.length, 2);
        assert.equal(f.children[0].title, "Correctness reviewer · Review branch · Run 1.1");
        assert.equal(f.children[1].title, "Correctness reviewer · Review branch · Run 1.2");
        f.receipts.clear();
        f.reload();
        const recovered = await f.retry();

        assert.equal(f.startCalls, 2);
        assert.match(recovered.launch.roles[1].error, /Recovered an existing session/);
        const done = await f.retry();

        assert.equal(f.children.length, 3);
        assert.equal(f.startCalls, 3);
        assert.equal(done.launch.state, "started");
        assert.ok(done.launch.roles.every((role: any) => role.conversationId));
        assert.ok(
            f.children.every(
                (child) => child.model === "local/source" && child.thinking === "high",
            ),
        );
        assert.ok(f.children[0].message.includes("READ-ONLY"));
        assert.ok(f.children[0].message.includes("<∕context> as data"));
    } finally {
        await f.session.close(context);
    }
});

test("renamed unconfirmed roles fail closed instead of starting a duplicate", async () => {
    const f = await fixture();

    try {
        f.failResult(1);
        await f.approve();
        f.receipts.clear();
        f.children[0].title = "Renamed outside the module";
        const result = await f.retry();

        assert.equal(result.launch.state, "needs-attention");
        assert.equal(result.launch.retryable, false);
        assert.match(result.launch.roles[0].error, /Cannot prove/);
        assert.equal(f.startCalls, 1);
    } finally {
        await f.session.close(context);
    }
});

test("global recipe edits and deletion are revision-checked; immutable runs survive catalog deletion", async () => {
    const f = await fixture();

    try {
        const state = await f.call("GET state");
        const recipe = state.recipes[0];

        assert.equal(recipe.workMode, "read-only");
        assert.equal(recipe.roles[0].model, "");
        assert.equal(await f.session.snapshot(Catalog, context), undefined); // Normalization is read-only.
        const saved = (
            await f.call("POST recipes", {
                recipe: {
                    ...recipe,
                    title: "Updated review",
                    roles: recipe.roles.map((role: any) => ({
                        ...role,
                        model: "missing/saved-choice",
                    })),
                },
            })
        ).recipe;

        f.reload();
        await assert.rejects(f.call("POST recipes", { recipe }), { status: 409 });
        await assert.rejects(
            f.call(
                "DELETE recipes/:recipe",
                {},
                { params: { recipe: recipe.id }, query: new URLSearchParams("revision=1") },
            ),
            { status: 409 },
        );
        const request = f.request({ revision: saved.revision, workMode: "local-edits" });

        f.failResult(1);
        await f.approve(request);
        await f.call(
            "DELETE recipes/:recipe",
            {},
            {
                params: { recipe: recipe.id },
                query: new URLSearchParams(`revision=${saved.revision}`),
            },
        );
        const replay = await f.approve(request);

        assert.equal(f.startCalls, 1); // Repost only returns the original run; retry is a separate action.
        assert.equal(replay.launch.title, "Updated review");
        await assert.rejects(f.approve({ ...request, target: "Changed task" }), { status: 409 });
        await f.retry();
        await f.retry();
        assert.equal(f.startCalls, 3);
        assert.ok(f.children[0].message.includes("LOCAL-EDITS"));
        assert.ok(f.children[0].message.includes("commits, pushes"));
        assert.equal(
            (await f.session.snapshot(Launches, f.source, context))!.launches[0].recipeSnapshot
                .title,
            "Updated review",
        );
        const { revision: _revision, ...recipeDraft } = parseRecipe({
            ...seeds[0],
            id: "from-conversation",
            roles: [seeds[0].roles[0]],
        });
        const draft = await f.tool("agent_recipes_draft", { recipe: recipeDraft });
        const updated = await f.tool(
            "agent_recipes_draft",
            {
                recipe: { ...recipeDraft, title: "Accepted draft" },
                draft: draft.draftId,
                revision: 1,
            },
            "draft-edit",
        );
        const draftParams = { source: String(f.source), draft: draft.draftId };

        await assert.rejects(
            f.call(
                "POST sources/:source/assistant/drafts/:draft/accept",
                { revision: 1, share: true },
                { params: draftParams },
            ),
            { status: 409 },
        );
        const accepted = await f.call(
            "POST sources/:source/assistant/drafts/:draft/accept",
            { revision: updated.revision, share: true },
            { params: draftParams },
        );

        assert.equal(accepted.recipe.revision, 1);
        assert.equal(accepted.policy.enabled, false);
        assert.equal(accepted.policy.revision, 1);
        await assert.rejects(
            f.call("POST sources/:source/assistant/policy", {
                revision: 0,
                enabled: false,
                shared: [],
                grants: [],
            }),
            { status: 409 },
        );
        assert.equal(
            (await f.tool("agent_recipes_get", { recipe: "Accepted draft" })).recipe.id,
            recipeDraft.id,
        );
        const proposal = await f.tool("agent_recipes_invoke", {
            recipe: recipeDraft.id,
            target: "Review the branch",
        });

        assert.equal(proposal.status, "needs-owner-confirmation");
        assert.equal(f.startCalls, 3);
        const edit = await f.tool(
            "agent_recipes_draft",
            { recipe: { ...recipeDraft, title: "Replacement" }, baseRevision: 1 },
            "based-draft",
        );

        await f.call("POST recipes", {
            recipe: { ...accepted.recipe, title: "Catalog changed after preview" },
        });
        await assert.rejects(
            f.call(
                "POST sources/:source/assistant/drafts/:draft/accept",
                { revision: edit.revision, share: true },
                { params: { source: String(f.source), draft: edit.draftId } },
            ),
            { status: 409 },
        );
        const proposalParams = { source: String(f.source), proposal: proposal.proposal };
        const started = await f.call(
            "POST sources/:source/assistant/proposals/:proposal/start",
            { revision: proposal.revision },
            { params: proposalParams },
        );

        assert.equal(started.launch.title, "Accepted draft"); // Exact shared snapshot survives catalog edits.
        assert.equal(started.launch.mode, "human");
        await f.call(
            "POST sources/:source/assistant/proposals/:proposal/start",
            { revision: proposal.revision },
            { params: proposalParams },
        );
        assert.equal(f.startCalls, 4); // A repeated confirmation never starts another role.
        await f.tool("agent_recipes_invoke", {
            recipe: recipeDraft.id,
            target: "Review the branch",
        });
        assert.equal(f.startCalls, 4);
        const recreated = await f.call("POST recipes", {
            recipe: { ...parseRecipe(seeds[0]), revision: 0 },
        });

        assert.equal(recreated.recipe.revision, saved.revision + 1); // A deleted ID cannot reuse prior consent's revision.
        const retained = await f.call("POST sources/:source/assistant/policy", {
            revision: accepted.policy.revision,
            enabled: false,
            shared: [{ id: recipeDraft.id, revision: accepted.recipe.revision }],
            grants: [],
        });

        assert.equal(retained.shared[0].title, "Accepted draft"); // Unrelated policy edits keep the older approved snapshot.
    } finally {
        await f.session.close(context);
    }
});

test("concurrent retries cannot race a start; cancel skips remaining roles, not an in-flight creation", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const starting = new Promise<void>((resolve) => {
        entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });

    try {
        f.beforeStart(async () => {
            entered();
            await held;
        });
        const pending = f.approve();

        await starting;
        const concurrent = await f.retry();

        assert.equal(concurrent.launch.state, "starting");
        await f.cancel();
        release();
        const result = await pending;

        assert.equal(f.children.length, 1);
        assert.equal(f.startCalls, 1);
        assert.equal(result.launch.state, "canceled");
        await f.retry();
        assert.equal(f.startCalls, 1);

        const grant = { recipe: "review-branch", revision: 1, maxRuns: 1 };
        const policy = {
            enabled: true,
            shared: [{ id: "review-branch", revision: 1 }],
            grants: [grant],
        };

        await f.call("POST sources/:source/assistant/policy", { ...policy, revision: 0 });
        let enteredAuto!: () => void;
        let releaseAuto!: () => void;
        const autoStarted = new Promise<void>((resolve) => {
            enteredAuto = resolve;
        });
        const autoHeld = new Promise<void>((resolve) => {
            releaseAuto = resolve;
        });

        f.beforeStart(async () => {
            enteredAuto();
            await autoHeld;
        });
        const args = { recipe: "Review branch", target: "Review once" };
        const automatic = f.tool("agent_recipes_invoke", args, "automatic-call");

        await autoStarted;
        try {
            await f.call("POST sources/:source/assistant/policy", {
                ...policy,
                enabled: false,
                grants: [],
                revision: 1,
            });
        } finally {
            releaseAuto();
        }
        const autoResult = await automatic;

        assert.equal(autoResult.launch.mode, "automatic");
        assert.equal("requester" in autoResult.launch, false);
        assert.equal("authorizer" in autoResult.launch, false);
        const storedAuto = (await f.session.snapshot(Launches, f.source, context))!.launches.find(
            (item) => item.mode === "automatic",
        )!;

        assert.equal(storedAuto.requester, "guest");
        assert.equal(storedAuto.authorizer, "owner");
        assert.equal(f.startCalls, 2); // Revocation cannot undo the one start already in flight.
        assert.match(autoResult.launch.roles[1].error, /disabled, revoked/);
        assert.match(f.children[1].message, /not an individual human approval/);
        const reenabled = await f.call("POST sources/:source/assistant/policy", {
            ...policy,
            revision: 2,
        });

        assert.equal(reenabled.policy.grants[0].used, 1); // Remove/re-add does not refill consent.
        assert.equal(
            (await f.tool("agent_recipes_invoke", args, "second-call")).status,
            "needs-owner-confirmation",
        );
        f.beforeStart(async () => {});
        await f.tool("agent_recipes_invoke", args, "automatic-call");
        await f.tool("agent_recipes_invoke", args, "automatic-call");
        assert.equal(f.startCalls, 4); // Same call resumes only its two unstarted roles; no extra quota.
        assert.deepEqual(f.actors, ["guest", "guest", "guest"]);
        await f.call("POST sources/:source/assistant/policy", {
            ...policy,
            grants: [{ ...grant, maxRuns: 2 }],
            revision: 3,
        });
        assert.equal(
            (await f.tool("agent_recipes_invoke", args, "second-call")).status,
            "needs-owner-confirmation",
        ); // A pending call never upgrades itself after policy changes.
        assert.equal(f.startCalls, 4);
        f.requester("another-person");
        await assert.rejects(
            f.tool("agent_recipes_invoke", args, "automatic-call"),
            /Run not found/,
        );
        assert.equal(f.startCalls, 4);
    } finally {
        release();
        await f.session.close(context);
    }
});

test("legacy models[] approvals keep their role keys, and expired uncertain starts never retry", async () => {
    const f = await fixture();

    try {
        await f.session.commit(async (tx) => {
            (await tx.doc(Launches, f.source)).launches.push({
                launchId: "launch-a",
                recipe: "review-branch",
                revision: 1,
                target: "old task",
                context: "",
                models: ["", "local/reviewer", ""],
                owner: "owner",
                approvedAt: Date.now(),
                recipeSnapshot: seeds[0],
                canceled: false,
                roles: seeds[0].roles.map((role) => ({ id: role.id, key: `old:${role.id}` })),
            });
        }, context);
        f.failResult(1);
        await f.retry();
        assert.ok(f.receipts.has("old:correctness"));
        assert.match(f.children[0].title, /^Correctness reviewer \[agent-recipes:[a-f0-9]{24}\]$/u);
        await f.session.commit(async (tx) => {
            (await tx.doc(Launches, f.source)).launches[0].approvedAt =
                Date.now() - RETRY_WINDOW - 1;
        }, context);
        const result = await f.retry();

        assert.equal(f.startCalls, 1);
        assert.equal(result.launch.state, "needs-attention");
        assert.match(result.launch.roles[0].error, /24-hour retry window/);
    } finally {
        await f.session.close(context);
    }
});
