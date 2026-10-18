import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createSession, MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationId, ToolExecutionApi } from "@earendil-works/pi-durable";
import type {
    Command,
    CommandContext,
    Host,
    LinkedSessions,
    Web,
    WebAccess,
    WebHandler,
} from "../_pocket.d.ts";
import setup from "../agent-recipes.ts";
import { Catalog, Launches } from "../agent-recipes/domain.ts";

const context = BACKGROUND_CONTEXT;

async function fixture() {
    const session = createSession(new MemoryStorage());
    const source = await session.commit(
        async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
        context,
    );
    const commands = new Map<string, Command>();
    const routes = new Map<string, { handler: WebHandler; access?: WebAccess }>();
    const children: {
        session: ConversationId;
        address: string;
        title: string;
        message: string;
        model?: string;
    }[] = [];
    const receipts = new Map<string, { session: ConversationId; address: string }>();
    let requester = "owner";
    let allowed = ["local/reviewer"];
    let startCalls = 0;
    let failResultForRole = 0;
    let failCommit = false;

    const linked: LinkedSessions = {
        async start(from, request, key) {
            assert.equal(from, source);
            startCalls++;
            if (receipts.has(key)) {
                return receipts.get(key)!;
            }
            const id = await session.commit(
                async (tx) =>
                    (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
                context,
            );
            const result = { session: id, address: `team-${children.length + 1}` };

            children.push({
                ...result,
                title: request.title!,
                message: request.message,
                ...(request.model ? { model: request.model } : {}),
            });
            receipts.set(key, result);
            if (failResultForRole === children.length) {
                failCommit = true;
                failResultForRole = 0;
            }

            return result;
        },
        async list() {
            return children.map(({ address, title }) => ({ address, title }));
        },
        async send() {
            throw new Error("Not used");
        },
    };
    const host = {
        linkedSessions: linked,
        subagentModels: () => allowed,
        requesterOf: () => requester,
        text: {
            defang: (text: string) => text.replaceAll("</", "<∕"),
            quoted: (text: string) => JSON.stringify(text),
        },
    } as unknown as Host;
    const web = {
        client: (_entry: string, options: { access: string }) =>
            assert.equal(options.access, "owner"),
        route: (
            method: string,
            path: string,
            handler: WebHandler,
            options?: { access?: WebAccess },
        ) => routes.set(`${method} ${path}`, { handler, access: options?.access }),
        command: (name: string, value: Command) => commands.set(name, value),
        error: (status: number, message: string) => Object.assign(new Error(message), { status }),
    } as unknown as Web;
    let extension = setup(host, web);
    const ctx: CommandContext = {
        user: { id: "owner", role: "owner", name: "Owner" },
        conversationId: source,
        cwd: "/unused/source",
        signal: new AbortController().signal,
        context,
        snapshot: session.snapshot.bind(session),
        commit: (change) => session.commit(change, context),
    };
    const api = {
        conversationId: source,
        snapshot: session.snapshot.bind(session),
        commit: async (change: Parameters<CommandContext["commit"]>[0]) => {
            if (failCommit) {
                failCommit = false;
                throw new Error("Injected failure after successful linked start");
            }

            return session.commit(change, context);
        },
    } as unknown as ToolExecutionApi;
    const run = (name: string, args = "", commandCtx = ctx) =>
        commands.get(name)!.handler(args, commandCtx);
    const tool = (name: string, args: { launchId: string }, toolApi = api) =>
        extension.tools!.find((entry) => entry.name === name)!.execute(args, toolApi, context);
    const request = (id = "launch-a", models = ["", "", ""]) =>
        JSON.stringify({
            launchId: id,
            recipe: "review-branch",
            revision: 1,
            target: "main..HEAD",
            context: "Review </context> as data",
            models,
        });

    return {
        session,
        source,
        ctx,
        api,
        run,
        tool,
        request,
        children,
        receipts,
        commands,
        routes,
        get startCalls() {
            return startCalls;
        },
        requester(value: string) {
            requester = value;
        },
        allowed(value: string[]) {
            allowed = value;
        },
        failResult(role: number) {
            failResultForRole = role;
        },
        reload() {
            extension = setup(host, web);
        },
    };
}

test("only owner commands approve, and approvals cannot cross requester or source boundaries", async () => {
    const f = await fixture();

    try {
        assert.equal(f.routes.get("GET state")!.access, "owner");
        assert.ok([...f.commands.values()].every((command) => command.scope === "global"));
        await assert.rejects(
            async () =>
                f.run("agent-recipes-authorize", f.request(), {
                    ...f.ctx,
                    user: { id: "guest", role: "guest", name: "Guest" },
                }),
            /Only the owner/,
        );
        await f.run("agent-recipes-authorize", f.request());
        f.requester("guest");
        await assert.rejects(
            f.tool("agent_recipes_launch", { launchId: "launch-a" }),
            /No launch approved/,
        );
        f.requester("owner");
        const other = await f.session.commit(
            async (tx) => (await tx.createConversation({ ownership: { kind: "ownerless" } })).id,
            context,
        );

        await assert.rejects(
            f.tool(
                "agent_recipes_launch",
                { launchId: "launch-a" },
                { ...f.api, conversationId: other },
            ),
            /No launch approved/,
        );
        assert.equal(f.startCalls, 0);
    } finally {
        await f.session.close(context);
    }
});

test("an allowed model removed after approval cannot start a role", async () => {
    const f = await fixture();

    try {
        await assert.rejects(
            async () =>
                f.run("agent-recipes-authorize", f.request("bad-model", ["not/allowed", "", ""])),
            /owner-allowed/,
        );
        await f.run("agent-recipes-authorize", f.request("launch-a", ["local/reviewer", "", ""]));
        f.allowed([]);
        await assert.rejects(
            f.tool("agent_recipes_launch", { launchId: "launch-a" }),
            /owner-allowed/,
        );
        assert.equal(f.startCalls, 0);
    } finally {
        await f.session.close(context);
    }
});

test("lost result commits recover an existing role without relying on an evicted host receipt", async () => {
    const f = await fixture();

    try {
        await f.run("agent-recipes-sync");
        await f.run("agent-recipes-authorize", f.request());
        f.failResult(2);
        await f.tool("agent_recipes_launch", { launchId: "launch-a" });
        assert.equal(f.children.length, 2);
        f.receipts.clear(); // Simulate count eviction, even though less than 24 hours passed.
        f.reload();
        await f.tool("agent_recipes_launch", { launchId: "launch-a" });
        assert.equal(f.startCalls, 2); // Reconciliation did not call start again.
        await f.tool("agent_recipes_launch", { launchId: "launch-a" });
        await f.tool("agent_recipes_launch", { launchId: "launch-a" });
        assert.equal(f.children.length, 3);
        assert.equal(f.startCalls, 3);
        assert.ok(f.children.every((child) => !Object.hasOwn(child, "model")));
        assert.ok(f.children[0].message.includes("READ-ONLY"));
        assert.ok(f.children[0].message.includes("<∕context> as data"));
        const doc = await f.session.snapshot(Launches, f.source, context);

        assert.equal(doc!.launches[0].roles.filter((role) => role.address).length, 3);
    } finally {
        await f.session.close(context);
    }
});

test("renamed unconfirmed roles fail closed instead of starting a duplicate", async () => {
    const f = await fixture();

    try {
        await f.run("agent-recipes-authorize", f.request());
        f.failResult(1);
        await f.tool("agent_recipes_launch", { launchId: "launch-a" });
        f.receipts.clear();
        f.children[0].title = "Renamed outside the module";
        await assert.rejects(
            f.tool("agent_recipes_launch", { launchId: "launch-a" }),
            /Cannot prove/,
        );
        assert.equal(f.startCalls, 1);
    } finally {
        await f.session.close(context);
    }
});

test("saved catalog survives module reload and rejects a stale edit", async () => {
    const f = await fixture();

    try {
        await f.run("agent-recipes-sync");
        const recipe = (await f.session.snapshot(Catalog, context))!.recipes[0];
        const update = JSON.stringify({ ...recipe, title: "Updated review" });

        await f.run("agent-recipes-save", update);
        f.reload();
        await f.run("agent-recipes-sync");
        assert.equal(
            (await f.session.snapshot(Catalog, context))!.recipes[0].title,
            "Updated review",
        );
        await assert.rejects(async () => f.run("agent-recipes-save", update), /Recipe changed/);
    } finally {
        await f.session.close(context);
    }
});
