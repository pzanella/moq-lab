#!/usr/bin/env node
// Network profiles for stream.sh --netem: Linux netem on what the relay sends to
// its viewers (players, the dashboard page, the host-side SGAI scripts). Only the
// relay -> viewer direction is shaped, so a delay is one way.
//
// Where that traffic flows depends on Podman. With rootful Podman (or a real
// network) it leaves through eth0. With rootless Podman, the port forwarder hands
// it to the relay on the container's own IP, so it never leaves the container: it
// goes over lo. lo also carries the ingest pipeline (`moq import` to the relay on
// localhost), which must stay clean. So both interfaces get the same setup: a prio
// qdisc whose third band is netem, and a u32 filter that sends only packets from
// the relay port there -- on lo, only those to the container's own IP.
//
// The profiles live only here. run-stream.sh applies one at startup, and the
// dashboard server switches between them at runtime. Callers pass a profile name,
// never a raw tc command, and tc runs without a shell.
//
// Usage: MOQ_LAB_NETEM_PORT=4443 node lib/netem.mjs <profile>
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// netem arguments for each profile. `off` removes the shaping.
export const PROFILES = {
    off: { label: "Off", args: null },
    mobile: { label: "Mobile (60 ms ± 20 ms, 0.5% loss, 8 Mbit/s)", args: ["delay", "60ms", "20ms", "loss", "0.5%", "rate", "8mbit"] },
    lossy: { label: "Lossy (3% loss)", args: ["loss", "3%"] },
    congested: { label: "Congested (40 ms ± 10 ms, 1% loss, 3 Mbit/s)", args: ["delay", "40ms", "10ms", "loss", "1%", "rate", "3mbit"] },
    satellite: { label: "Satellite (300 ms ± 20 ms, 10 Mbit/s)", args: ["delay", "300ms", "20ms", "rate", "10mbit"] },
};

// Every packet goes to band 1 unless a filter picks it; band 3 holds netem.
const PRIOMAP = Array(16).fill("0");

function relayPort() {
    const port = Number(process.env.MOQ_LAB_NETEM_PORT);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("MOQ_LAB_NETEM_PORT is not set to the relay port");
    return port;
}

// The interface of the default route (eth0 in a Podman container) and its IPv4 address.
async function defaultInterface() {
    const { stdout: route } = await run("ip", ["route", "show", "default"]);
    const dev = route.match(/\bdev (\S+)/)?.[1] ?? "eth0";
    const { stdout: addr } = await run("ip", ["-4", "-o", "addr", "show", "dev", dev]);
    const ip = addr.match(/\binet (\d+\.\d+\.\d+\.\d+)/)?.[1];
    return { dev, ip };
}

async function shape(dev, args, match) {
    // Nothing to delete is fine: the result is the same.
    await run("tc", ["qdisc", "del", "dev", dev, "root"]).catch(() => {});
    if (!args) return;
    await run("tc", ["qdisc", "add", "dev", dev, "root", "handle", "1:", "prio", "bands", "3", "priomap", ...PRIOMAP]);
    await run("tc", ["qdisc", "add", "dev", dev, "parent", "1:3", "handle", "30:", "netem", ...args]);
    await run("tc", ["filter", "add", "dev", dev, "parent", "1:", "protocol", "ip", "prio", "1", "u32", ...match, "flowid", "1:3"]);
}

export async function applyProfile(name) {
    const profile = PROFILES[name];
    if (!profile) throw new Error(`unknown network profile '${name}' (one of: ${Object.keys(PROFILES).join(", ")})`);
    const port = String(relayPort());
    const { dev, ip } = await defaultInterface();
    await shape(dev, profile.args, ["match", "ip", "sport", port, "0xffff"]);
    if (ip) await shape("lo", profile.args, ["match", "ip", "sport", port, "0xffff", "match", "ip", "dst", `${ip}/32`]);
    return currentShaping();
}

// The netem qdisc tc reports, e.g. "qdisc netem 30: parent 1:3 ... delay 60ms 20ms loss 0.5%".
export async function currentShaping() {
    const { stdout } = await run("tc", ["qdisc", "show", "dev", "lo"]);
    return stdout.split("\n").find((line) => line.includes("netem"))?.trim() ?? "";
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        console.log(await applyProfile(process.argv[2]));
    } catch (err) {
        console.error(`--netem: ${err.stderr?.trim() || err.message}`);
        process.exit(1);
    }
}
