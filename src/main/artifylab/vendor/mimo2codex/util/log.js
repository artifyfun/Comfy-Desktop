let verbose = false;
export function setVerbose(v) {
    verbose = v;
}
function emit(level, msg, extra) {
    if (level === "debug" && !verbose)
        return;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] ${level.toUpperCase()}`;
    if (extra !== undefined) {
        // eslint-disable-next-line no-console
        console.error(prefix, msg, extra);
    }
    else {
        // eslint-disable-next-line no-console
        console.error(prefix, msg);
    }
}
export const log = {
    debug: (msg, extra) => emit("debug", msg, extra),
    info: (msg, extra) => emit("info", msg, extra),
    warn: (msg, extra) => emit("warn", msg, extra),
    error: (msg, extra) => emit("error", msg, extra),
};
export function redactKey(k) {
    if (!k)
        return "<empty>";
    if (k.length <= 8)
        return "***";
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
}
//# sourceMappingURL=log.js.map