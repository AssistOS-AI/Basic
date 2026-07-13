#!/usr/bin/env node
import net from 'node:net';

const NGINX_HOST = '127.0.0.1';
const NGINX_PORT = 8081;

function probeTcpPort({ host, port, timeoutMs }) {
    return new Promise((resolve) => {
        const socket = net.createConnection({ host, port });
        let settled = false;
        const finish = (ready) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(ready);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
    });
}

export async function waitForTcpPort({
    host = NGINX_HOST,
    port = NGINX_PORT,
    retryMs = 100,
    timeoutMs = 1_000,
} = {}) {
    while (!await probeTcpPort({ host, port, timeoutMs })) {
        await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    await waitForTcpPort();
}
