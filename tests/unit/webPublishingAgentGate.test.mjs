import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import { waitForTcpPort } from '../../web-publishing/runtime/wait-for-nginx.mjs';

test('web-publishing AgentServer gate waits until the nginx listener accepts TCP', async (t) => {
    const reservation = net.createServer();
    await new Promise((resolve, reject) => {
        reservation.once('error', reject);
        reservation.listen(0, '127.0.0.1', resolve);
    });
    const { port } = reservation.address();
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));

    let resolved = false;
    const waiting = waitForTcpPort({ host: '127.0.0.1', port, retryMs: 10, timeoutMs: 20 })
        .then(() => { resolved = true; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(resolved, false, 'gate must not resolve while nginx is unavailable');

    const listener = net.createServer((socket) => socket.end());
    t.after(() => listener.close());
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(port, '127.0.0.1', resolve);
    });

    await waiting;
    assert.equal(resolved, true, 'gate must resolve after nginx accepts TCP');
});
