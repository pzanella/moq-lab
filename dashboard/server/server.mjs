#!/usr/bin/env node
// Dashboard backend: serves the built web UI (dashboard/dist) and the small
// API it reads alongside its own MoQ subscription. Runs inside the Podman
// container next to the relay, started by run-stream.sh when stream.sh gets
// --dashboard. Plain Node, no dependencies -- same as ssai/ and csai/.
//
//   GET /api/config   what the browser needs to subscribe (relay port, broadcast, mode, viewer JWT)
//   GET /api/time     this container's clock, so the browser can correct for host/VM clock skew
//   GET /api/events   Server-Sent Events: `log` (container stdout/stderr lines) and
//                     `ingest` (lib/ingest-clock.mjs samples, for end-to-end latency)
//   GET /api/netem    the active network profile (stream.sh --netem)
//   POST /api/netem   switch to another profile: {"profile": "<name>"}
//
// Usage: node server.mjs --port 8080 --relay-port 4443 --broadcast bbb.hang --mode base
//                        --abr-ladder false --log-file /tmp/moq-lab.log --ingest-file /tmp/moq-lab-ingest.json
import { createReadStream, existsSync, openSync, readFileSync, readSync, statSync, closeSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../lib/cli.mjs";
import { createLogger } from "../../lib/log.mjs";
import { applyProfile, currentShaping, PROFILES } from "../../lib/netem.mjs";

const log = createLogger("dashboard");

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port ?? 8080);
const LOG_FILE = args["log-file"];
const INGEST_FILE = args["ingest-file"];
const DIST = fileURLToPath(new URL(args.dist ?? "../dist/", import.meta.url));

const CONFIG = {
    broadcast: args.broadcast,
    relayPort: Number(args["relay-port"] ?? 4443),
    mode: args.mode ?? "base",
    abrLadder: args["abr-ladder"] === "true",
    // SGAI's Event Timeline broadcast. stream.sh names it <name>-events, where the
    // content broadcast is <name>.hang or <name>.multi.hang.
    eventsBroadcast: args.mode === "sgai" ? `${args.broadcast.replace(/(\.multi)?\.hang$/, "")}-events` : null,
    // Subscribe-only token from stream.sh --auth/--auth-key. Handing it to anyone who
    // can reach the dashboard is fine for this sandbox: they could already reach the
    // terminal it was printed in.
    jwt: process.env.MOQ_LAB_VIEWER_JWT || null,
    // Network profiles can only be switched when stream.sh --netem gave the
    // container NET_ADMIN, so the dashboard only offers them then.
    netem: process.env.MOQ_LAB_NETEM
        ? Object.fromEntries(Object.entries(PROFILES).map(([name, p]) => [name, p.label]))
        : null,
};

let netemProfile = process.env.MOQ_LAB_NETEM || null;
// A profile name is a few bytes; refuse anything bigger before parsing it.
const MAX_BODY_BYTES = 1024;

// How much log history a newly opened tab gets.
const LOG_BACKLOG = 1000;

const clients = new Set();
const backlog = [];
let logSeq = 0;
let latestIngest = null;

function broadcastEvent(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
}

// Rust binaries usually drop colors when not on a TTY, but a tee'd stream can
// still carry some -- the browser renders plain text.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function pushLogLine(text) {
    const entry = { seq: logSeq++, t: Date.now(), text: text.replace(ANSI, "") };
    backlog.push(entry);
    if (backlog.length > LOG_BACKLOG) backlog.shift();
    broadcastEvent("log", entry);
}

// Tails run-stream.sh's tee'd output. Polling rather than fs.watch: inotify
// events are unreliable on the overlay/bind filesystems a container may sit on,
// and a 250ms delay is invisible in a log view.
function tailLogFile(file) {
    let offset = 0;
    let partial = "";
    const buf = Buffer.alloc(64 * 1024);
    setInterval(() => {
        let size;
        try {
            size = statSync(file).size;
        } catch {
            return; // not created yet
        }
        if (size < offset) offset = 0; // truncated
        if (size === offset) return;
        const fd = openSync(file, "r");
        try {
            while (offset < size) {
                const n = readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
                if (n <= 0) break;
                offset += n;
                const lines = (partial + buf.toString("utf8", 0, n)).split(/\r?\n/);
                partial = lines.pop();
                for (const line of lines) if (line.trim()) pushLogLine(line);
            }
        } finally {
            closeSync(fd);
        }
    }, 250);
}

function watchIngestFile(file) {
    let lastRaw = "";
    setInterval(() => {
        let raw;
        try {
            raw = readFileSync(file, "utf8");
        } catch {
            return;
        }
        if (raw === lastRaw) return;
        lastRaw = raw;
        try {
            latestIngest = JSON.parse(raw);
            broadcastEvent("ingest", latestIngest);
        } catch {
            // lib/ingest-clock.mjs writes atomically; a parse error means a foreign file.
        }
    }, 250);
}

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".woff2": "font/woff2",
    ".ico": "image/x-icon",
};

function sendJson(res, body) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
}

async function sendNetem(res) {
    sendJson(res, { profile: netemProfile, shaping: await currentShaping() });
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
            if (body.length > MAX_BODY_BYTES) {
                reject(new Error("body too large"));
                req.destroy();
            }
        });
        req.on("end", () => {
            try {
                resolve(JSON.parse(body));
            } catch {
                reject(new Error("body is not JSON"));
            }
        });
        req.on("error", reject);
    });
}

async function handleNetem(req, res) {
    if (!CONFIG.netem) {
        res.writeHead(404).end();
        return;
    }
    if (req.method !== "GET" && req.method !== "POST") {
        res.writeHead(405).end();
        return;
    }
    if (req.method === "POST") {
        // A cross-site page can't send this content type without a CORS preflight,
        // which this server never answers, so only the dashboard itself can switch.
        if (req.headers["content-type"] !== "application/json") throw new Error("expected application/json");
        const { profile } = await readJsonBody(req);
        // applyProfile() only accepts a name from PROFILES; it never builds a command
        // from the request.
        await applyProfile(profile);
        netemProfile = profile;
        log(`network profile: ${profile}`);
    }
    await sendNetem(res);
}

function serveStatic(req, res, pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        res.writeHead(400).end();
        return;
    }
    // normalize() collapses any "..", and the prefix check below rejects whatever escapes DIST.
    let file = normalize(join(DIST, decoded));
    if (!file.startsWith(DIST) && file + sep !== DIST) {
        res.writeHead(403).end();
        return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    if (!existsSync(file)) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("Dashboard UI not built. Run `pnpm --dir dashboard build` (or rebuild the image).\n");
        return;
    }
    // Vite fingerprints everything under assets/, so it can be cached forever;
    // index.html must always be revalidated to pick up a rebuilt image.
    const immutable = file.startsWith(join(DIST, "assets") + sep);
    res.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    });
    createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/api/netem") {
        handleNetem(req, res).catch((err) => {
            res.writeHead(400, { "content-type": "text/plain" });
            res.end(`${err.message}\n`);
        });
        return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
    }

    if (pathname === "/api/config") return sendJson(res, CONFIG);
    if (pathname === "/api/time") return sendJson(res, { now: Date.now() });

    if (pathname === "/api/events") {
        res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        for (const entry of backlog) res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
        if (latestIngest) res.write(`event: ingest\ndata: ${JSON.stringify(latestIngest)}\n\n`);
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
    }

    if (pathname.startsWith("/api/")) {
        res.writeHead(404).end();
        return;
    }

    serveStatic(req, res, pathname);
});

// Proxies and some browsers drop an SSE connection that stays silent too long.
setInterval(() => {
    for (const res of clients) res.write(": keepalive\n\n");
}, 15000);

if (LOG_FILE) tailLogFile(LOG_FILE);
if (INGEST_FILE) watchIngestFile(INGEST_FILE);

server.listen(PORT, "0.0.0.0", () => {
    log(`serving on port ${PORT} (broadcast=${CONFIG.broadcast}, relay port ${CONFIG.relayPort})`);
});
