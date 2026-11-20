export function makeServerResponseSink(res) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
    }
    let isClosed = false;
    res.on("close", () => {
        isClosed = true;
    });
    return {
        write(event, data) {
            if (isClosed)
                return;
            const payload = typeof data === "string" ? data : JSON.stringify(data);
            res.write(`event: ${event}\ndata: ${payload}\n\n`);
        },
        comment(text) {
            if (isClosed)
                return;
            res.write(`: ${text}\n\n`);
        },
        end() {
            if (isClosed)
                return;
            isClosed = true;
            res.end();
        },
        closed() {
            return isClosed;
        },
    };
}
export function makeMemorySink() {
    const events = [];
    const comments = [];
    let isClosed = false;
    return {
        events,
        comments,
        write(event, data) {
            if (isClosed)
                return;
            events.push({ event, data });
        },
        comment(text) {
            if (isClosed)
                return;
            comments.push(text);
        },
        end() {
            isClosed = true;
        },
        closed() {
            return isClosed;
        },
    };
}
//# sourceMappingURL=sse.js.map