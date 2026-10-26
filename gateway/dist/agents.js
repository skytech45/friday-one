const ADAPTER_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const MAX_AGENTS = 20;
const MAX_PROJECTS = 50;
export function sanitizeAgents(input) {
    if (!Array.isArray(input))
        return [];
    const out = new Map();
    for (const raw of input.slice(0, MAX_AGENTS)) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const adapter = typeof r.adapter === "string" ? r.adapter : "";
        if (!ADAPTER_RE.test(adapter) || out.has(adapter))
            continue;
        const version = typeof r.version === "string" && r.version.length > 0
            ? r.version.slice(0, 40)
            : null;
        out.set(adapter, {
            adapter,
            version,
            health: r.health === "healthy" ? "healthy" : "unknown",
        });
    }
    return [...out.values()];
}
export function sanitizeProjects(input) {
    if (!Array.isArray(input))
        return [];
    const out = new Map();
    for (const raw of input.slice(0, MAX_PROJECTS)) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const root = typeof r.root === "string" ? r.root.trim() : "";
        // Absolute, NUL-free, bounded. The connector's allowedRoots check is the
        // actual execution boundary; this only keeps garbage out of the UI.
        if (!root.startsWith("/") || root.includes("\0") || root.length > 512)
            continue;
        if (out.has(root))
            continue;
        const label = typeof r.label === "string" && r.label.trim()
            ? r.label.trim().slice(0, 120)
            : root.split("/").filter(Boolean).pop() ?? root;
        out.set(root, { root, label });
    }
    return [...out.values()];
}
