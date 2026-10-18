export const pocketApi = 1;

/**
 * @typedef {{id:string,name:string,prompt:string,model:string,thinking:string}} Role
 * @typedef {{id:string,title:string,revision:number,workMode:string,roles:Role[]}} Recipe
 * @typedef {{id:string,name:string,thinkingLevels:string[]}} ModelChoice
 * @typedef {{id:string,title:string,cwd:string,model:string,thinking:string}} Source
 * @typedef {{id:string,name:string,model:string,thinking:string,address?:string,conversationId?:string,state:string,error?:string,busy?:boolean,archived?:boolean}} RunRole
 * @typedef {{launchId:string,title:string,approvedAt:number,canceled:boolean,workMode:string,target:string,context:string,state:string,roles:RunRole[],retryable:boolean}} Run
 * @typedef {{supported:boolean,pocketVersion:string,recipes:Recipe[],models:ModelChoice[],updatedAt:number,error?:string}} Catalog
 * @typedef {{source:Source,models:ModelChoice[],launches:Run[],updatedAt:number}} SourceState
 * @typedef {{launchId:string,recipe:string,revision:number,target:string,context:string,workMode:string,roles:{id:string,model:string,thinking:string}[],sourceModel:string,sourceThinking:string,sourceCwd:string}} LaunchRequest
 * @typedef {{recipe:Recipe,source:Source,models:ModelChoice[],target:string,context:string,workMode:string,roles:{id:string,model:string,thinking:string}[],attempt:LaunchRequest|null,launchId?:string,rejected?:boolean}} RunForm
 * @typedef {{tab:string,screen:string,draft:Recipe|null,base:Recipe|null,role:string,filter:string,runForm:RunForm|null,selectedRun:string}} Workspace
 */

const thinkingOrder = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const modeName = (mode) => (mode === "local-edits" ? "Local edits" : "Read-only");
const failureMessage = (failure) =>
    failure instanceof Error ? failure.message : "The request could not be completed.";
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const httpStatus = (failure) =>
    failure && typeof failure === "object" && "status" in failure ? Number(failure.status) : 0;
const isConflict = (failure) => httpStatus(failure) === 409;
const time = (value) => (value ? new Date(value).toLocaleString() : "");
const cleanText = (value, max, singleLine = false, required = true) =>
    typeof value === "string" &&
    value.length <= max &&
    (!required || value.trim().length > 0) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u.test(
        value,
    ) &&
    (!singleLine || !/[\r\n\t]/.test(value));

/** @returns {Recipe} */
function normalize(recipe) {
    return {
        ...recipe,
        workMode: recipe.workMode || "read-only",
        roles: recipe.roles.map((role) => ({
            ...role,
            model: role.model || "",
            thinking: role.thinking || "",
        })),
    };
}

function validRecipe(recipe) {
    return (
        recipe &&
        cleanText(recipe.title, 60, true) &&
        recipe.roles.length >= 1 &&
        recipe.roles.length <= 4 &&
        recipe.roles.every((role) => cleanText(role.name, 40, true) && cleanText(role.prompt, 5000))
    );
}

function modelName(id, models) {
    const model = models.find((item) => item.id === id);
    const provider = id?.includes("/") ? id.slice(0, id.indexOf("/")) : "";

    return model ? `${model.name}${provider ? ` · ${provider}` : ""}` : id;
}

function thinkingChoices(model, models, source) {
    const selected = model || source?.model;
    const levels = selected
        ? models.find((item) => item.id === selected)?.thinkingLevels || []
        : thinkingOrder;
    const cap = source ? thinkingOrder.indexOf(source.thinking) : thinkingOrder.length - 1;

    return levels.filter((level) => {
        const rank = thinkingOrder.indexOf(level);

        return rank >= 0 && rank <= cap;
    });
}

function validChoice(role, models, source) {
    return (
        models.some((model) => model.id === (role.model || source.model)) &&
        thinkingChoices(role.model, models, source).includes(role.thinking || source.thinking)
    );
}

function runState(run) {
    return (
        {
            ready: "Approved",
            starting: "Starting sessions",
            partial: "Partly started",
            started: "Sessions created",
            canceled: "Pending starts canceled",
            "needs-attention": "Needs attention",
        }[run.state] || "Status unavailable"
    );
}

function roleState(role) {
    if (role.state === "started") {
        return role.archived === true
            ? "Session archived"
            : role.busy === true
              ? "Working"
              : role.busy === false
                ? "Idle"
                : "Session created";
    }

    return (
        {
            ready: "Not started",
            starting: "Starting",
            unconfirmed: "Start unconfirmed",
            "needs-retry": "Needs retry",
        }[role.state] || "Status unavailable"
    );
}

/** @param {import('../_pocket.d.ts').Pocket} pocket */
export default function setup(pocket) {
    const { html, useState, useEffect, useLayoutEffect, useRef } = pocket;
    /** @type {Workspace} */
    let retained = {
        tab: "recipes",
        screen: "library",
        draft: null,
        base: null,
        role: "",
        filter: "",
        runForm: null,
        selectedRun: "",
    };
    const scroll = {};
    const owner = pocket.me()?.id;
    const storageKey = `x.agent-recipes.${owner || "signed-out"}.workspace`;

    // Session-only and owner-specific: native page Close/Back cannot be intercepted.
    try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");

        if (owner && saved && (saved.draft || saved.runForm)) {
            retained = {
                ...retained,
                ...saved,
                draft: saved.draft ? normalize(saved.draft) : null,
                base: saved.base ? normalize(saved.base) : null,
            };
        }
    } catch {
        // A blocked or damaged storage entry must not stop the extension loading.
    }

    function persist(state) {
        try {
            if (state.runForm || (state.draft && !same(state.draft, state.base))) {
                sessionStorage.setItem(storageKey, JSON.stringify(state));
            } else {
                sessionStorage.removeItem(storageKey);
            }
        } catch {
            // The in-memory draft still survives closing and reopening this page.
        }
    }

    pocket.style("style.css");

    function newId() {
        const bytes = new Uint8Array(16);

        // randomUUID is unavailable on ordinary LAN HTTP; getRandomValues is supported.
        globalThis.crypto.getRandomValues(bytes);

        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }

    function secureId() {
        try {
            return newId();
        } catch {
            pocket.notify("error", "This browser cannot create a secure identifier.");

            return null;
        }
    }

    function ModelFields({ role, models, source, onChange, disabled = false, reusable = false }) {
        const unavailable = role.model && !models.some((model) => model.id === role.model);
        const levels = thinkingChoices(role.model, models, reusable ? null : source);
        const inherited = source?.thinking;
        const inheritInvalid = !reusable && inherited && !levels.includes(inherited);
        const thinkingInvalid = role.thinking && !levels.includes(role.thinking);

        return html`<div class="ar-model-fields">
            <label>
                Model
                <select
                    value=${role.model}
                    disabled=${disabled}
                    onChange=${(event) => onChange("model", event.currentTarget.value)}
                >
                    <option value="">
                        ${source ? `Source · ${modelName(source.model, models)}` : "Source model"}
                    </option>
                    ${unavailable && html`<option value=${role.model} disabled>Unavailable · ${role.model}</option>`}
                    ${models.map((model) => html`<option key=${model.id} value=${model.id}>${modelName(model.id, models)}</option>`)}
                </select>
            </label>
            <label>
                Thinking
                <select
                    value=${role.thinking}
                    disabled=${disabled}
                    onChange=${(event) => onChange("thinking", event.currentTarget.value)}
                >
                    <option value="" disabled=${!!inheritInvalid}>
                        ${inherited ? `Source · ${inherited}${inheritInvalid ? " (not supported)" : ""}` : "Source thinking"}
                    </option>
                    ${thinkingInvalid && html`<option value=${role.thinking} disabled>${role.thinking} (unavailable)</option>`}
                    ${levels.map((level) => html`<option key=${level} value=${level}>${level}</option>`)}
                </select>
            </label>
            ${(unavailable || thinkingInvalid || (!role.thinking && inheritInvalid)) && html`<p class="ar-field-error">${unavailable ? "Saved model is unavailable. Choose an available model before running." : "Choose a thinking level supported by this model and source."}</p>`}
        </div>`;
    }

    function RunRoleSettings({ role, choice, models, source, onChange }) {
        const invalid = !validChoice(choice, models, source);
        const [expanded, setExpanded] = useState(invalid);
        const unavailable = choice.model && !models.some((model) => model.id === choice.model);
        const effectiveModel = modelName(choice.model || source.model, models);
        const effectiveThinking = choice.thinking || source.thinking;
        const unsupportedThinking = !thinkingChoices(choice.model, models, source).includes(
            effectiveThinking,
        );

        useEffect(() => {
            if (invalid) {
                setExpanded(true);
            }
        }, [invalid]);

        return html`<details
            class="ar-run-role"
            open=${expanded}
            onToggle=${(event) => setExpanded(event.currentTarget.open)}
        >
            <summary>
                <span class="ar-run-role-summary">
                    <strong>${role.name}</strong>
                    <small
                        >${`${effectiveModel}${unavailable ? " (unavailable)" : ""} · ${effectiveThinking}${unsupportedThinking && !unavailable ? " (not supported)" : ""}`}</small
                    >
                </span>
                ${invalid && html`<span class="ar-needs-setup">Needs setup</span>`}
                <span class="ar-chevron" aria-hidden="true">›</span>
            </summary>
            <${ModelFields} role=${choice} models=${models} source=${source} onChange=${onChange} />
        </details>`;
    }

    function ModeField({ value, change, disabled = false }) {
        return html`<label>
            Work mode
            <select
                value=${value}
                disabled=${disabled}
                onChange=${(event) => change(event.currentTarget.value)}
            >
                <option value="read-only">Read-only</option>
                <option value="local-edits">Local edits</option>
            </select>
        </label>`;
    }

    function ModeNote({ mode }) {
        const policy =
            mode === "local-edits" ? "May edit local files." : "Read-only: no file changes.";

        return html`<p class="ar-mode-note">
            ${`${policy} Modes are instructions, not a sandbox. All roles share one folder, without worktrees. Commits, merges, pushes, publication and deployment require separate authorization.`}
        </p>`;
    }

    function RecipesPage() {
        const [view, setView] = useState(retained);
        /** @type {[Catalog, Function]} */
        const [catalog, setCatalog] = useState(null);
        /** @type {[SourceState, Function]} */
        const [sourceData, setSourceData] = useState(null);
        const [sourceId, setSourceId] = useState(() => pocket.conversationId());
        const [loading, setLoading] = useState(true);
        const [sourceLoading, setSourceLoading] = useState(false);
        const [error, setError] = useState("");
        const [sourceError, setSourceError] = useState("");
        const [notice, setNotice] = useState(() =>
            retained.runForm?.attempt
                ? "Unconfirmed run restored. Refresh to check its status."
                : retained.draft && !same(retained.draft, retained.base)
                  ? "Unsaved draft restored."
                  : "",
        );
        const [conflict, setConflict] = useState(false);
        const [busy, setBusyValue] = useState("");
        const busyRef = useRef("");
        const current = useRef(view);
        const alive = useRef(true);
        const requests = useRef(new Set());
        const catalogEpoch = useRef(0);
        const sourceEpoch = useRef(0);
        const pane = useRef(null);
        const library = useRef(null);
        const sourceRef = useRef(sourceId);
        const dirty = !!view.draft && !same(view.draft, view.base);
        const supported = catalog?.supported === true;
        const models = sourceData?.models || catalog?.models || [];
        const source = sourceData?.source;
        const draft = view.draft;
        const form = view.runForm;
        const run = sourceData?.launches.find((item) => item.launchId === view.selectedRun);

        function setBusy(value) {
            busyRef.current = value;
            setBusyValue(value);
        }

        function update(patch) {
            const next = { ...current.current, ...patch };

            current.current = next;
            retained = next;
            persist(next);
            setView(next);
        }

        /**
         * @template T
         * @param {string} path
         * @param {object} [body]
         * @param {import('../_pocket.d.ts').WebMethod} [method]
         * @returns {Promise<T>}
         */
        async function api(path, body = undefined, method = undefined) {
            const controller = new AbortController();

            requests.current.add(controller);

            try {
                return /** @type {T} */ (
                    await pocket.api(path, body, { signal: controller.signal, method })
                );
            } finally {
                requests.current.delete(controller);
            }
        }

        function showError(failure) {
            if (alive.current) {
                setError(failureMessage(failure));
            }
        }

        function clearMessages() {
            setError("");
            setNotice("");
        }

        async function loadCatalog(replaceDraft = false) {
            const epoch = ++catalogEpoch.current;
            const selected = current.current.draft?.id;

            setLoading(true);

            if (replaceDraft) {
                setBusy("latest");
            }

            try {
                /** @type {Catalog} */
                const result = await api("state");

                if (!alive.current || epoch !== catalogEpoch.current) {
                    return;
                }
                const next = { ...result, recipes: result.recipes.map(normalize) };
                const state = current.current;
                const latest = next.recipes.find((item) => item.id === state.draft?.id);
                const changed = state.draft && !same(state.draft, state.base);

                setCatalog(next);

                if (replaceDraft && state.draft?.id === selected) {
                    update({
                        draft: latest || null,
                        base: latest || null,
                        role: "",
                        screen: latest ? "editor" : "library",
                    });
                    setConflict(false);
                } else if (!state.draft && next.recipes.length) {
                    update({ draft: next.recipes[0], base: next.recipes[0] });
                } else if (!changed && latest) {
                    update({ draft: latest, base: latest });
                } else if (
                    changed &&
                    state.base?.revision &&
                    latest?.revision !== state.base.revision
                ) {
                    setConflict(true);
                }
            } catch (failure) {
                if (epoch === catalogEpoch.current) {
                    showError(failure);
                }
            } finally {
                if (alive.current && epoch === catalogEpoch.current) {
                    setLoading(false);

                    if (replaceDraft) {
                        setBusy("");
                    }
                }
            }
        }

        async function loadSource(id = sourceRef.current) {
            const epoch = ++sourceEpoch.current;

            sourceRef.current = id;
            setSourceId(id);
            setSourceError("");

            if (id === null) {
                setSourceData(null);
                setSourceLoading(false);

                return;
            }
            setSourceLoading(true);

            try {
                /** @type {SourceState} */
                const result = await api(`sources/${encodeURIComponent(id)}/state`);

                if (
                    !alive.current ||
                    epoch !== sourceEpoch.current ||
                    pocket.conversationId() !== id
                ) {
                    return;
                }
                setSourceData(result);
                const pending = current.current.runForm;
                const recovered =
                    pending?.attempt && String(pending.source.id) === String(id)
                        ? result.launches.find((item) => item.launchId === pending.attempt.launchId)
                        : null;

                if (recovered) {
                    update({
                        runForm: null,
                        selectedRun: recovered.launchId,
                        ...(current.current.screen === "run"
                            ? { tab: "runs", screen: "run-detail" }
                            : {}),
                    });
                    setNotice("Run recovered. Check each role’s status.");
                }
            } catch (failure) {
                if (
                    alive.current &&
                    epoch === sourceEpoch.current &&
                    pocket.conversationId() === id
                ) {
                    setSourceError(failureMessage(failure));
                }
            } finally {
                if (alive.current && epoch === sourceEpoch.current) {
                    setSourceLoading(false);
                }
            }
        }

        useEffect(() => {
            alive.current = true;
            loadCatalog();
            loadSource();

            function beforeUnload(event) {
                const state = current.current;

                if ((state.draft && !same(state.draft, state.base)) || state.runForm) {
                    event.preventDefault();
                    event.returnValue = "";
                }
            }

            window.addEventListener("beforeunload", beforeUnload);

            return () => {
                alive.current = false;
                requests.current.forEach((request) => request.abort());
                window.removeEventListener("beforeunload", beforeUnload);
            };
        }, []);

        useLayoutEffect(() => {
            if (pane.current) {
                pane.current.scrollTop = scroll[`${view.tab}:${view.screen}:${view.role}`] || 0;
            }
            if (library.current) {
                library.current.scrollTop = scroll[`list:${view.tab}`] || 0;
            }
        }, [view.tab, view.screen, view.role]);

        function mayReplaceDraft() {
            return !dirty || window.confirm("Discard unsaved recipe changes?");
        }

        function selectRecipe(recipe) {
            if (busyRef.current || (recipe.id !== draft?.id && !mayReplaceDraft())) {
                return;
            }
            clearMessages();
            setConflict(false);
            update({
                draft: recipe.id === draft?.id ? draft : structuredClone(recipe),
                base: recipe.id === draft?.id ? view.base : recipe,
                role: "",
                screen: "editor",
            });
        }

        function newRecipe(duplicate = false) {
            if (busyRef.current || (!duplicate && !mayReplaceDraft())) {
                return;
            }
            const id = secureId();
            const roleIds = Array.from({ length: duplicate ? draft.roles.length : 1 }, secureId);

            if (!id || roleIds.some((roleId) => !roleId)) {
                return;
            }
            const next = duplicate
                ? {
                      ...structuredClone(draft),
                      id,
                      revision: 0,
                      title: `${draft.title} copy`.slice(0, 60),
                      roles: draft.roles.map((role, index) => ({ ...role, id: roleIds[index] })),
                  }
                : {
                      id,
                      title: "",
                      revision: 0,
                      workMode: "read-only",
                      roles: [{ id: roleIds[0], name: "", prompt: "", model: "", thinking: "" }],
                  };

            clearMessages();
            setConflict(false);
            update({ draft: next, base: null, role: "", screen: "editor", tab: "recipes" });
        }

        function changeDraft(key, value) {
            update({ draft: { ...current.current.draft, [key]: value } });
            setNotice("");
        }

        function changeRole(id, key, value) {
            changeDraft(
                "roles",
                current.current.draft.roles.map((role) =>
                    role.id === id ? { ...role, [key]: value } : role,
                ),
            );
        }

        function addRole() {
            const id = secureId();

            if (id && draft.roles.length < 4) {
                changeDraft("roles", [
                    ...draft.roles,
                    { id, name: "", prompt: "", model: "", thinking: "" },
                ]);
                update({ role: id, screen: "role" });
            }
        }

        function removeRole(role) {
            if (draft.roles.length > 1 && window.confirm(`Remove ${role.name || "this role"}?`)) {
                changeDraft(
                    "roles",
                    draft.roles.filter((item) => item.id !== role.id),
                );
                update({ role: "", screen: "editor" });
            }
        }

        function cancelEdit() {
            if (!mayReplaceDraft()) {
                return;
            }
            clearMessages();
            setConflict(false);
            update({
                draft: view.base ? structuredClone(view.base) : null,
                screen: "library",
                role: "",
            });
        }

        async function saveRecipe() {
            if (busyRef.current || !supported || !validRecipe(draft)) {
                return;
            }
            const submitted = structuredClone(draft);

            clearMessages();
            setBusy("save");

            try {
                /** @type {{recipe:Recipe}} */
                const result = await api("recipes", { recipe: submitted });

                if (!alive.current || current.current.draft?.id !== submitted.id) {
                    return;
                }
                const saved = normalize(result.recipe);

                ++catalogEpoch.current;
                setLoading(false);
                setCatalog((previous) => ({
                    ...previous,
                    recipes: [...previous.recipes.filter((item) => item.id !== saved.id), saved],
                }));
                update({ draft: saved, base: saved });
                setConflict(false);
                setNotice("Recipe saved.");
            } catch (failure) {
                if (alive.current && current.current.draft?.id === submitted.id) {
                    if (isConflict(failure)) {
                        setConflict(true);
                    } else {
                        showError(failure);
                    }
                }
            } finally {
                if (alive.current) {
                    setBusy("");
                }
            }
        }

        async function deleteRecipe() {
            if (
                !draft?.revision ||
                busyRef.current ||
                !window.confirm(
                    `Delete “${draft.title}”?${dirty ? " Unsaved changes will be discarded." : ""} Saved runs keep their snapshot.`,
                )
            ) {
                return;
            }
            const selected = draft.id;

            clearMessages();
            setBusy("delete");

            try {
                /** @type {{recipes:Recipe[]}} */
                const result = await api(
                    `recipes/${encodeURIComponent(selected)}?revision=${draft.revision}`,
                    undefined,
                    "DELETE",
                );

                if (!alive.current || current.current.draft?.id !== selected) {
                    return;
                }
                ++catalogEpoch.current;
                setLoading(false);
                setCatalog((previous) => ({ ...previous, recipes: result.recipes.map(normalize) }));
                update({ draft: null, base: null, screen: "library", role: "" });
                setConflict(false);
                setNotice("Recipe deleted.");
            } catch (failure) {
                if (alive.current) {
                    if (isConflict(failure)) {
                        setConflict(true);
                    } else {
                        showError(failure);
                    }
                }
            } finally {
                if (alive.current) {
                    setBusy("");
                }
            }
        }

        function beginRun() {
            if (busyRef.current || dirty || !draft?.revision || !supported) {
                return;
            }
            if (form) {
                if (
                    form.attempt ||
                    (form.recipe.id === draft.id && form.recipe.revision === draft.revision)
                ) {
                    update({ screen: "run" });

                    return;
                }
                if (!window.confirm("Discard the current run form?")) {
                    return;
                }
            }
            if (!source || String(pocket.conversationId()) !== String(source.id)) {
                pocket.notify("warning", "Select a source session, then Refresh.");

                return;
            }
            clearMessages();
            update({
                screen: "run",
                runForm: {
                    recipe: structuredClone(draft),
                    source: structuredClone(source),
                    models: structuredClone(models),
                    target: "",
                    context: "",
                    workMode: draft.workMode,
                    roles: draft.roles.map(({ id, model, thinking }) => ({ id, model, thinking })),
                    attempt: null,
                },
            });
        }

        function changeForm(key, value) {
            if (!current.current.runForm.attempt) {
                update({ runForm: { ...current.current.runForm, [key]: value } });
                clearMessages();
            }
        }

        function cancelRunForm() {
            if (form.attempt) {
                update({ screen: "editor" });

                return;
            }
            if ((form.target || form.context) && !window.confirm("Discard this run form?")) {
                return;
            }
            update({ screen: "editor", runForm: null });
            clearMessages();
        }

        function showLaunch(launch, capturedSource) {
            if (
                String(sourceRef.current) === String(capturedSource) &&
                String(pocket.conversationId()) === String(capturedSource)
            ) {
                ++sourceEpoch.current;
                setSourceLoading(false);
                setSourceData((previous) =>
                    previous
                        ? {
                              ...previous,
                              launches: [
                                  launch,
                                  ...previous.launches.filter(
                                      (item) => item.launchId !== launch.launchId,
                                  ),
                              ],
                              updatedAt: Date.now(),
                          }
                        : previous,
                );
                update({
                    runForm: null,
                    tab: "runs",
                    screen: "run-detail",
                    selectedRun: launch.launchId,
                });
            } else {
                update({ runForm: null, screen: "editor" });
            }
            setNotice(
                launch.state === "started" ? "Sessions created." : "Run saved. Check role status.",
            );
        }

        async function reviewLatestSettings() {
            if (busyRef.current || !form || form.attempt) {
                return;
            }
            const captured = current.current.runForm;

            clearMessages();
            setBusy("review");

            try {
                /** @type {[Catalog, SourceState]} */
                const [latestCatalog, latestSource] = await Promise.all([
                    api("state"),
                    api(`sources/${encodeURIComponent(captured.source.id)}/state`),
                ]);

                if (!alive.current || current.current.runForm !== captured) {
                    return;
                }
                const latest = latestCatalog.recipes.find((item) => item.id === captured.recipe.id);

                if (!latest) {
                    setError(
                        "This recipe was deleted. Cancel this unapproved form and choose another recipe.",
                    );

                    return;
                }
                const recipe = normalize(latest);

                update({
                    runForm: {
                        ...captured,
                        recipe,
                        source: latestSource.source,
                        models: latestSource.models,
                        rejected: false,
                        roles: recipe.roles.map(
                            (role) =>
                                captured.roles.find((choice) => choice.id === role.id) || {
                                    id: role.id,
                                    model: role.model,
                                    thinking: role.thinking,
                                },
                        ),
                    },
                });
                if (
                    current.current.draft?.id === recipe.id &&
                    same(current.current.draft, current.current.base)
                ) {
                    update({ draft: recipe, base: recipe });
                }
                ++catalogEpoch.current;
                setLoading(false);
                setCatalog({ ...latestCatalog, recipes: latestCatalog.recipes.map(normalize) });
                if (
                    String(sourceRef.current) === String(captured.source.id) &&
                    String(pocket.conversationId()) === String(captured.source.id)
                ) {
                    ++sourceEpoch.current;
                    setSourceLoading(false);
                    setSourceData(latestSource);
                }
                setNotice("Latest recipe and source settings loaded. Review before starting.");
            } catch (failure) {
                showError(failure);
            } finally {
                if (alive.current) {
                    setBusy("");
                }
            }
        }

        async function startRun() {
            if (busyRef.current || !supported || !form || form.rejected) {
                return;
            }
            if (!form.attempt && String(pocket.conversationId()) !== String(form.source.id)) {
                setError(
                    "The selected session changed. This run still uses the source shown below.",
                );

                return;
            }
            let request = form.attempt;

            if (!request) {
                if (
                    !cleanText(form.target, 2000) ||
                    !cleanText(form.context, 6000, false, false) ||
                    !form.roles.every((role) => validChoice(role, form.models, form.source))
                ) {
                    return;
                }
                const launchId = form.launchId || secureId();

                if (!launchId) {
                    return;
                }
                request = {
                    launchId,
                    recipe: form.recipe.id,
                    revision: form.recipe.revision,
                    target: form.target,
                    context: form.context,
                    workMode: form.workMode,
                    roles: structuredClone(form.roles),
                    sourceModel: form.source.model,
                    sourceThinking: form.source.thinking,
                    sourceCwd: form.source.cwd,
                };
                // Keep the exact request before sending. An aborted/lost response is not a failed start.
                update({ runForm: { ...form, attempt: request, launchId: request.launchId } });
            }
            const captured = request;
            const capturedSource = form.source.id;

            clearMessages();
            setBusy("start");
            let posted = false;

            try {
                let existing = null;

                if (form.attempt) {
                    /** @type {SourceState} */
                    const snapshot = await api(
                        `sources/${encodeURIComponent(capturedSource)}/state`,
                    );

                    if (
                        !alive.current ||
                        current.current.runForm?.attempt?.launchId !== captured.launchId
                    ) {
                        return;
                    }
                    existing = snapshot.launches.find(
                        (item) => item.launchId === captured.launchId,
                    );
                }
                // Read history first on recovery. An existing approval goes to its safe retry route.
                posted = !existing;
                /** @type {{launch:Run}} */
                const result = existing
                    ? { launch: existing }
                    : await api(`sources/${encodeURIComponent(capturedSource)}/launches`, captured);

                if (
                    !alive.current ||
                    current.current.runForm?.attempt?.launchId !== captured.launchId
                ) {
                    return;
                }
                showLaunch(result.launch, capturedSource);
            } catch (failure) {
                if (
                    alive.current &&
                    current.current.runForm?.attempt?.launchId === captured.launchId
                ) {
                    const status = httpStatus(failure);

                    if (posted && status >= 400 && status < 500) {
                        try {
                            // The original HTTP request has settled. Only a successful history read
                            // can prove that this rejected request did not create an approval.
                            /** @type {SourceState} */
                            const snapshot = await api(
                                `sources/${encodeURIComponent(capturedSource)}/state`,
                            );

                            if (
                                !alive.current ||
                                current.current.runForm?.attempt?.launchId !== captured.launchId
                            ) {
                                return;
                            }
                            const approved = snapshot.launches.find(
                                (item) => item.launchId === captured.launchId,
                            );

                            if (approved) {
                                showLaunch(approved, capturedSource);
                            } else {
                                update({
                                    runForm: {
                                        ...current.current.runForm,
                                        attempt: null,
                                        rejected: true,
                                    },
                                });
                                setError(
                                    `${failureMessage(failure)} This run was not approved; your inputs are kept.`,
                                );
                            }
                            return;
                        } catch {
                            // Failed reconciliation is still uncertain: do not unlock or replace it.
                        }
                    }
                    if (alive.current) {
                        setError(
                            `${failureMessage(failure)} The request is retained; retry this same run.`,
                        );
                    }
                }
            } finally {
                if (alive.current) {
                    setBusy("");
                }
            }
        }

        async function runAction(action) {
            if (!run || busyRef.current || !source) {
                return;
            }
            if (
                action === "cancel" &&
                !window.confirm(
                    "Cancel pending starts? Already started or in-progress sessions are not stopped.",
                )
            ) {
                return;
            }
            const capturedRun = run.launchId;
            const capturedSource = source.id;

            clearMessages();
            setBusy(action);

            try {
                /** @type {{launch:Run}} */
                const result = await api(
                    `sources/${encodeURIComponent(capturedSource)}/launches/${encodeURIComponent(capturedRun)}/${action}`,
                    {},
                );

                if (
                    !alive.current ||
                    String(sourceRef.current) !== String(capturedSource) ||
                    String(pocket.conversationId()) !== String(capturedSource)
                ) {
                    return;
                }
                ++sourceEpoch.current;
                setSourceLoading(false);
                setSourceData((previous) => ({
                    ...previous,
                    launches: previous.launches.map((item) =>
                        item.launchId === capturedRun ? result.launch : item,
                    ),
                    updatedAt: Date.now(),
                }));
                if (current.current.selectedRun === capturedRun) {
                    setNotice(
                        action === "cancel"
                            ? "Pending starts canceled. Started or in-progress sessions are not stopped."
                            : "Retry checked. See each role’s status.",
                    );
                }
            } catch (failure) {
                if (
                    current.current.selectedRun === capturedRun &&
                    String(pocket.conversationId()) === String(capturedSource)
                ) {
                    showError(failure);
                }
            } finally {
                if (alive.current) {
                    setBusy("");
                }
            }
        }

        function refresh() {
            clearMessages();
            loadCatalog();
            const selected = pocket.conversationId();

            if (selected !== sourceRef.current) {
                setSourceData(null);
                update({
                    selectedRun: "",
                    screen: view.screen === "run-detail" ? "library" : view.screen,
                });
            }
            loadSource(selected);
        }

        async function openRole(role) {
            try {
                pocket.openConversation(role.conversationId);
            } catch (failure) {
                showError(failure);
            }
        }

        function roleSummary(role) {
            const selected = role.model ? modelName(role.model, models) : "Source model";

            return `${selected}${role.model && !models.some((model) => model.id === role.model) ? " (unavailable)" : ""} · ${role.thinking || "Source thinking"}`;
        }

        const filtered =
            catalog?.recipes.filter((item) =>
                item.title.toLocaleLowerCase().includes(view.filter.toLocaleLowerCase()),
            ) || [];
        const runValid =
            form &&
            cleanText(form.target, 2000) &&
            cleanText(form.context, 6000, false, false) &&
            form.roles.every((role) => validChoice(role, form.models, form.source));

        return html`<main class=${`ar-root ar-screen-${view.screen}`}>
            <header class="ar-header">
                <nav class="ar-tabs" aria-label="Agent recipes">
                    <button
                        aria-pressed=${view.tab === "recipes"}
                        disabled=${!!busy}
                        onClick=${() => {
                            clearMessages();
                            update({ tab: "recipes", screen: "library" });
                        }}
                    >
                        Recipes
                    </button>
                    <button
                        aria-pressed=${view.tab === "runs"}
                        disabled=${!!busy}
                        onClick=${() => {
                            clearMessages();
                            update({ tab: "runs", screen: "library" });
                        }}
                    >
                        Runs
                    </button>
                </nav>
                <div class="ar-actions">
                    ${form && view.screen !== "run" && html`<button class="button ar-quiet" disabled=${!!busy} onClick=${() => update({ tab: "recipes", screen: "run" })}>Resume run</button>`}
                    <button
                        class="button ar-quiet"
                        disabled=${loading || sourceLoading || !!busy}
                        onClick=${refresh}
                    >
                        ${loading || sourceLoading ? "Refreshing…" : "Refresh"}
                    </button>
                </div>
            </header>
            ${catalog && !supported && html`<p class="ar-alert" role="alert">Update Pi Pocket to use recipe saves and runs.${catalog.pocketVersion ? ` Current: ${catalog.pocketVersion}.` : ""}</p>`}
            ${catalog?.error && supported && html`<p class="ar-alert" role="alert">${catalog.error}</p>`}
            ${error && html`<p class="ar-alert" role="alert">${error}</p>`}
            ${notice && html`<p class="ar-notice" role="status">${notice}</p>`}
            ${loading && !catalog && html`<${pocket.Loader} label="Loading recipes" />`}
            ${
                !catalog &&
                !loading &&
                html`<div class="ar-empty">
                    <p>Recipes could not be loaded.</p>
                    <button class="button" onClick=${refresh}>Try again</button>
                </div>`
            }
            ${
                catalog &&
                view.tab === "recipes" &&
                view.screen !== "run" &&
                html`
                    <div class="ar-workspace">
                        <aside
                            class="ar-library"
                            aria-label="Recipe library"
                            ref=${library}
                            onScroll=${(event) => {
                                scroll["list:recipes"] = event.currentTarget.scrollTop;
                            }}
                        >
                            <div class="ar-library-tools">
                                <label class="ar-search">
                                    <span class="ar-sr-only">Filter recipes</span>
                                    <input
                                        type="search"
                                        placeholder="Filter recipes"
                                        value=${view.filter}
                                        onInput=${(event) => update({ filter: event.currentTarget.value })}
                                    />
                                </label>
                                <button
                                    class="button"
                                    disabled=${!!busy || !supported || catalog.recipes.length >= 20}
                                    onClick=${() => newRecipe()}
                                >
                                    New recipe
                                </button>
                                ${catalog.recipes.length >= 20 && html`<span class="ar-muted">20 recipe limit reached.</span>`}
                            </div>
                            <nav class="ar-items" aria-label="Saved recipes">
                                ${draft && !draft.revision && html`<button class=${`ar-item ${view.draft?.id === draft.id ? "is-selected" : ""}`} disabled=${!!busy} onClick=${() => update({ screen: "editor" })}><strong>${draft.title || "New recipe"}</strong><span>Unsaved · ${draft.roles.length} ${draft.roles.length === 1 ? "role" : "roles"}</span></button>`}
                                ${filtered.map((item) => html`<button key=${item.id} class=${`ar-item ${draft?.id === item.id ? "is-selected" : ""}`} aria-current=${draft?.id === item.id ? "true" : undefined} disabled=${!!busy} onClick=${() => selectRecipe(item)}><strong>${item.title}${dirty && draft?.id === item.id ? " ·" : ""}</strong><span>${item.roles.length} roles · ${modeName(item.workMode)}</span></button>`)}
                                ${!filtered.length && html`<p class="ar-empty">${catalog.recipes.length ? "No matching recipes." : "No recipes yet."}</p>`}
                            </nav>
                        </aside>
                        <section
                            class="ar-editor ar-pane"
                            ref=${pane}
                            onScroll=${(event) => {
                                scroll[`${view.tab}:${view.screen}:${view.role}`] =
                                    event.currentTarget.scrollTop;
                            }}
                            aria-label="Recipe editor"
                        >
                            ${
                                draft
                                    ? html`
                                          <div class="ar-editor-summary">
                                              <div class="ar-section-head">
                                                  <button
                                                      class="button ar-quiet ar-mobile-back"
                                                      disabled=${!!busy}
                                                      onClick=${cancelEdit}
                                                  >
                                                      ‹ Recipes
                                                  </button>
                                                  <h2>
                                                      ${draft.revision ? "Recipe" : "New recipe"}
                                                  </h2>
                                                  <span class="ar-save-state"
                                                      >${dirty ? "Unsaved" : "Saved"}</span
                                                  >
                                                  <div class="ar-actions ar-recipe-tools">
                                                      <button
                                                          class="button ar-quiet"
                                                          disabled=${!!busy || !supported || catalog.recipes.length >= 20}
                                                          onClick=${() => newRecipe(true)}
                                                      >
                                                          Duplicate
                                                      </button>
                                                      ${draft.revision > 0 && html`<button class="button ar-quiet ar-danger" disabled=${!!busy || !supported} onClick=${deleteRecipe}>Delete</button>`}
                                                  </div>
                                              </div>
                                              ${
                                                  conflict &&
                                                  html`<div class="ar-conflict" role="alert">
                                                      <span
                                                          >This recipe changed elsewhere. Your draft
                                                          is kept.</span
                                                      ><button
                                                          class="button"
                                                          disabled=${!!busy || loading}
                                                          onClick=${() => {
                                                              if (
                                                                  window.confirm(
                                                                      "Discard this draft and load the latest recipe?",
                                                                  )
                                                              ) {
                                                                  loadCatalog(true);
                                                              }
                                                          }}
                                                      >
                                                          Load latest
                                                      </button>
                                                  </div>`
                                              }
                                              <fieldset class="ar-fields" disabled=${!!busy}>
                                                  <div class="ar-recipe-fields">
                                                      <label
                                                          >Name<input
                                                              value=${draft.title}
                                                              maxlength="60"
                                                              required
                                                              onInput=${(event) => changeDraft("title", event.currentTarget.value)}
                                                      /></label>
                                                      <${ModeField}
                                                          value=${draft.workMode}
                                                          change=${(value) => changeDraft("workMode", value)}
                                                      />
                                                  </div>
                                              </fieldset>
                                              <${ModeNote} mode=${draft.workMode} />
                                              <div class="ar-section-head ar-roles-head">
                                                  <h3>
                                                      Roles
                                                      <span class="ar-muted"
                                                          >${draft.roles.length}/4</span
                                                      >
                                                  </h3>
                                                  <button
                                                      class="button ar-quiet"
                                                      disabled=${!!busy || draft.roles.length >= 4}
                                                      onClick=${addRole}
                                                  >
                                                      Add role
                                                  </button>
                                              </div>
                                          </div>
                                          <div class="ar-roles">
                                              ${draft.roles.map(
                                                  (role, index) => html`
                                                      <section
                                                          key=${role.id}
                                                          class=${`ar-role ${view.role === role.id ? "is-open" : ""}`}
                                                      >
                                                          <button
                                                              class="ar-role-head"
                                                              disabled=${!!busy}
                                                              aria-expanded=${view.role === role.id}
                                                              onClick=${() => update({ role: view.role === role.id ? "" : role.id, screen: view.role === role.id ? "editor" : "role" })}
                                                          >
                                                              <span class="ar-role-number"
                                                                  >${index + 1}</span
                                                              >
                                                              <span
                                                                  ><strong
                                                                      >${role.name || `Role ${index + 1}`}</strong
                                                                  ><small
                                                                      >${roleSummary(role)}</small
                                                                  ></span
                                                              >
                                                              <span
                                                                  class="ar-chevron"
                                                                  aria-hidden="true"
                                                                  >${view.role === role.id ? "−" : "›"}</span
                                                              >
                                                          </button>
                                                          ${
                                                              view.role === role.id &&
                                                              html`
                                                                  <div class="ar-role-body">
                                                                      <div
                                                                          class="ar-mobile-role-head"
                                                                      >
                                                                          <button
                                                                              class="button ar-quiet"
                                                                              disabled=${!!busy}
                                                                              onClick=${() => update({ screen: "editor", role: "" })}
                                                                          >
                                                                              ‹ Roles
                                                                          </button>
                                                                          <h2>Role ${index + 1}</h2>
                                                                      </div>
                                                                      <fieldset
                                                                          class="ar-fields"
                                                                          disabled=${!!busy}
                                                                      >
                                                                          <label
                                                                              >Name<input
                                                                                  value=${role.name}
                                                                                  maxlength="40"
                                                                                  required
                                                                                  onInput=${(event) => changeRole(role.id, "name", event.currentTarget.value)}
                                                                          /></label>
                                                                          <${ModelFields}
                                                                              role=${role}
                                                                              models=${models}
                                                                              source=${source}
                                                                              reusable=${true}
                                                                              onChange=${(key, value) => changeRole(role.id, key, value)}
                                                                          />
                                                                          <label
                                                                              >Prompt<textarea
                                                                                  value=${role.prompt}
                                                                                  maxlength="5000"
                                                                                  rows="7"
                                                                                  required
                                                                                  onInput=${(event) => changeRole(role.id, "prompt", event.currentTarget.value)}
                                                                              />
                                                                          </label>
                                                                          <div class="ar-role-foot">
                                                                              <span class="ar-muted"
                                                                                  >${role.prompt.length.toLocaleString()}/5,000</span
                                                                              ><button
                                                                                  class="button ar-quiet ar-danger"
                                                                                  disabled=${draft.roles.length <= 1}
                                                                                  onClick=${() => removeRole(role)}
                                                                              >
                                                                                  Remove role
                                                                              </button>
                                                                          </div>
                                                                      </fieldset>
                                                                  </div>
                                                              `
                                                          }
                                                      </section>
                                                  `,
                                              )}
                                          </div>
                                          <footer class="ar-editor-footer">
                                              <span class="ar-muted"
                                                  >${dirty ? "Save changes to run." : `${draft.roles.length} roles · ${modeName(draft.workMode)}`}</span
                                              >
                                              <div class="ar-actions">
                                                  <button
                                                      class="button ar-quiet"
                                                      disabled=${!!busy}
                                                      onClick=${cancelEdit}
                                                  >
                                                      Cancel
                                                  </button>
                                                  <button
                                                      class="button primary"
                                                      disabled=${!!busy || !supported || !dirty || !validRecipe(draft) || conflict}
                                                      onClick=${saveRecipe}
                                                  >
                                                      ${busy === "save" ? "Saving…" : "Save recipe"}
                                                  </button>
                                                  <button
                                                      class=${`button ${!dirty ? "primary" : ""}`}
                                                      disabled=${!!busy || !supported || dirty || !draft.revision || !source || !!sourceError}
                                                      onClick=${beginRun}
                                                  >
                                                      Run…
                                                  </button>
                                              </div>
                                          </footer>
                                          <div class="ar-mobile-role-done">
                                              <button
                                                  class="button primary"
                                                  disabled=${!!busy}
                                                  onClick=${() => update({ screen: "editor", role: "" })}
                                              >
                                                  Done
                                              </button>
                                          </div>
                                          ${!source && !sourceLoading && html`<p class="ar-muted ar-source-hint">Select a source session to run this recipe.</p>`}
                                          ${supported && sourceError && html`<p class="ar-field-error">${sourceError}</p>`}
                                      `
                                    : html`<div class="ar-empty">
                                          <p>Select a recipe to edit, or create one.</p>
                                      </div>`
                            }
                        </section>
                    </div>
                `
            }
            ${
                view.tab === "recipes" &&
                view.screen === "run" &&
                form &&
                html`
                    <section
                        class="ar-run-form ar-pane"
                        ref=${pane}
                        onScroll=${(event) => {
                            scroll[`${view.tab}:${view.screen}:${view.role}`] =
                                event.currentTarget.scrollTop;
                        }}
                    >
                        <div class="ar-section-head">
                            <button
                                class="button ar-quiet"
                                disabled=${!!busy}
                                onClick=${() => update({ screen: "editor" })}
                            >
                                ‹ Recipe
                            </button>
                            <h2>Run ${form.recipe.title}</h2>
                        </div>
                        <div class="ar-source">
                            <span class="ar-label">Source session</span
                            ><strong>${form.source.title}</strong
                            ><span class="ar-path">${form.source.cwd}</span
                            ><small
                                >${`${modelName(form.source.model, form.models)} · ${form.source.thinking}`}</small
                            >
                        </div>
                        ${form.attempt && html`<p class="ar-pending-note">A start was requested. Its source and settings are fixed. Retry keeps the same run and does not create a replacement.</p>`}
                        ${form.rejected && html`<div class="ar-conflict"><span>Review the latest recipe and source settings before starting.</span><button class="button" disabled=${!!busy} onClick=${reviewLatestSettings}>${busy === "review" ? "Loading…" : "Review latest settings"}</button></div>`}
                        <fieldset class="ar-fields" disabled=${!!busy || !!form.attempt}>
                            <label
                                >Task <span class="ar-muted">required</span
                                ><textarea
                                    value=${form.target}
                                    maxlength="2000"
                                    rows="3"
                                    required
                                    placeholder="Review the diff between main and this branch."
                                    onInput=${(event) => changeForm("target", event.currentTarget.value)}
                                />
                            </label>
                            <label
                                >Context <span class="ar-muted">optional</span
                                ><textarea
                                    value=${form.context}
                                    maxlength="6000"
                                    rows="3"
                                    onInput=${(event) => changeForm("context", event.currentTarget.value)}
                                />
                            </label>
                            <${ModeField}
                                value=${form.workMode}
                                change=${(value) => changeForm("workMode", value)}
                            />
                            <${ModeNote} mode=${form.workMode} />
                            <h3 class="ar-run-roles-title">Run settings</h3>
                            ${form.recipe.roles.map(
                                (role, index) =>
                                    html`<${RunRoleSettings}
                                        key=${role.id}
                                        role=${role}
                                        choice=${form.roles[index]}
                                        models=${form.models}
                                        source=${form.source}
                                        onChange=${(key, value) =>
                                            changeForm(
                                                "roles",
                                                form.roles.map((item) =>
                                                    item.id === role.id
                                                        ? { ...item, [key]: value }
                                                        : item,
                                                ),
                                            )}
                                    />`,
                            )}
                        </fieldset>
                        <footer class="ar-run-footer">
                            <button class="button" disabled=${!!busy} onClick=${cancelRunForm}>
                                ${form.attempt ? "Back to recipe" : "Cancel"}</button
                            ><button
                                class="button primary"
                                disabled=${!!busy || !supported || !!form.rejected || (!form.attempt && !runValid)}
                                onClick=${startRun}
                            >
                                ${busy === "start" ? "Starting…" : form.attempt ? "Retry same run" : `Start run — ${form.roles.length} ${form.roles.length === 1 ? "role" : "roles"}`}
                            </button>
                        </footer>
                        <p class="ar-muted ar-approval-note">
                            Start run approves these roles in the source session. No source history
                            is copied.
                        </p>
                    </section>
                `
            }
            ${
                catalog &&
                view.tab === "runs" &&
                html`
                    <section class="ar-runs">
                        <div class="ar-runs-source">
                            <div>
                                <span class="ar-label">Source session</span
                                ><strong
                                    >${source?.title || (sourceLoading ? "Loading…" : "No source session selected")}</strong
                                >${source && html`<span class="ar-path">${source.cwd}</span>`}
                            </div>
                            <span class="ar-muted"
                                >${sourceData ? `Snapshot · ${time(sourceData.updatedAt)}` : ""}</span
                            >
                        </div>
                        ${supported && sourceError && html`<p class="ar-alert" role="alert">${sourceError}</p>`}
                        <div class="ar-workspace ar-runs-workspace">
                            <nav
                                class="ar-library ar-items"
                                aria-label="Runs in this source session"
                                ref=${library}
                                onScroll=${(event) => {
                                    scroll["list:runs"] = event.currentTarget.scrollTop;
                                }}
                            >
                                ${sourceData?.launches.map(
                                    (item) =>
                                        html`<button
                                            key=${item.launchId}
                                            class=${`ar-item ${run?.launchId === item.launchId ? "is-selected" : ""}`}
                                            aria-current=${run?.launchId === item.launchId ? "true" : undefined}
                                            disabled=${!!busy}
                                            onClick=${() => {
                                                clearMessages();
                                                update({
                                                    selectedRun: item.launchId,
                                                    screen: "run-detail",
                                                });
                                            }}
                                        >
                                            <strong>${item.title}</strong
                                            ><span
                                                >${runState(item)} · ${item.roles.length}
                                                roles</span
                                            ><small>${time(item.approvedAt)}</small>
                                        </button>`,
                                )}
                                ${sourceData && !sourceData.launches.length && html`<p class="ar-empty">No runs in this session.</p>`}
                                ${!sourceData && !sourceLoading && !sourceError && html`<p class="ar-empty">Select a session, then Refresh to see its runs.</p>`}
                            </nav>
                            <section
                                class="ar-run-detail ar-pane"
                                ref=${pane}
                                onScroll=${(event) => {
                                    scroll[`${view.tab}:${view.screen}:${view.role}`] =
                                        event.currentTarget.scrollTop;
                                }}
                            >
                                ${
                                    run
                                        ? html`
                                              <div class="ar-section-head">
                                                  <button
                                                      class="button ar-quiet ar-mobile-back"
                                                      disabled=${!!busy}
                                                      onClick=${() => update({ screen: "library" })}
                                                  >
                                                      ‹ Runs
                                                  </button>
                                                  <h2>${run.title}</h2>
                                                  <span class="ar-status">${runState(run)}</span>
                                              </div>
                                              <p class="ar-run-target">${run.target}</p>
                                              ${
                                                  run.context &&
                                                  html`<details class="ar-context">
                                                      <summary>Context</summary>
                                                      <p>${run.context}</p>
                                                  </details>`
                                              }
                                              <p class="ar-muted">
                                                  ${`${modeName(run.workMode)} · Approved ${time(run.approvedAt)}`}
                                              </p>
                                              <div class="ar-run-role-list">
                                                  ${run.roles.map(
                                                      (role) =>
                                                          html`<article
                                                              key=${role.id}
                                                              class="ar-status-role"
                                                          >
                                                              <div class="ar-status-role-head">
                                                                  <strong>${role.name}</strong
                                                                  ><span class="ar-status"
                                                                      >${roleState(role)}</span
                                                                  >
                                                              </div>
                                                              <p class="ar-muted">
                                                                  ${`${modelName(role.model, sourceData.models)} · ${role.thinking || "Thinking unavailable"}`}
                                                              </p>
                                                              ${role.error && html`<p class="ar-field-error">${role.error}</p>`}${role.conversationId && html`<button class="button" onClick=${() => openRole(role)}>Open session</button>`}
                                                          </article>`,
                                                  )}
                                              </div>
                                              <div class="ar-run-actions">
                                                  ${run.retryable && !run.canceled && html`<button class="button primary" disabled=${!!busy || !supported} onClick=${() => runAction("retry")}>${busy === "retry" ? "Retrying…" : "Retry remaining"}</button>`}
                                                  ${!run.canceled && run.state !== "started" && html`<button class="button" disabled=${!!busy || !supported} onClick=${() => runAction("cancel")}>${busy === "cancel" ? "Canceling…" : "Cancel pending starts"}</button>`}
                                              </div>
                                              <p class="ar-muted">
                                                  A created or idle session is not a completed
                                                  task.${!run.canceled && run.state !== "started" ? " Cancel prevents pending starts; already started or in-progress sessions are not stopped." : ""}
                                              </p>
                                          `
                                        : html`<p class="ar-empty">
                                              ${sourceData?.launches.length ? "Select a run to see its roles." : ""}
                                          </p>`
                                }
                            </section>
                        </div>
                    </section>
                `
            }
        </main>`;
    }

    pocket.page({ id: "recipes", title: "Agent recipes", component: RecipesPage });
    pocket.menu({ id: "recipes", label: "Agent recipes", page: "recipes" });
    pocket.rail({ id: "recipes", title: "Agent recipes", icon: "grid", page: "recipes" });
    pocket.launcher({
        id: "recipes",
        label: "Agent recipes",
        detail: "Save team briefs and start linked sessions",
        keywords: ["review", "release", "team"],
        page: "recipes",
    });
    pocket.toolCall({ tool: "agent_recipes_status", label: () => "read linked team status" });
}
