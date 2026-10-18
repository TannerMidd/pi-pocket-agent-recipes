// Editor/test compatibility only. The production entry has no local runtime dependency.
export {
    Catalog,
    Launches,
    RETRY_WINDOW,
    identifier,
    parseLaunch,
    parseRecipe,
    revision,
    roleMessage,
    seeds,
} from "../agent-recipes.ts";
export type {
    Launch,
    LaunchRequest,
    LaunchRole,
    NormalizedRecipe,
    Recipe,
    Role,
    RoleChoice,
    WorkMode,
} from "../agent-recipes.ts";
