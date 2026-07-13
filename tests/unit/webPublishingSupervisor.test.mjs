import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    createPrivateTokenFile,
    superviseRuntime,
} from '../../web-publishing/runtime/supervisor.mjs';

let nextPid = 40_000;

class FakeChild extends EventEmitter {
    constructor({ exitOnKill = true } = {}) {
        super();
        this.pid = nextPid += 1;
        this.exitCode = null;
        this.signalCode = null;
        this.kills = [];
        this.exitOnKill = exitOnKill;
    }

    kill(signal) {
        this.kills.push(signal);
        if (this.exitOnKill) {
            queueMicrotask(() => this.exit(null, signal));
        }
        return true;
    }

    exit(code, signal = null) {
        if (this.exitCode != null || this.signalCode != null) return;
        this.exitCode = code;
        this.signalCode = signal;
        this.emit('exit', code, signal);
    }
}

function baseConfig(mode = 'nginx') {
    return {
        mode,
        tlsEdge: mode === 'nginx' ? 'none' : 'cloudflare',
        exposures: [],
    };
}

function createHarness({
    mode = 'nginx',
    token = '',
    env = {},
    children = [new FakeChild()],
    spawnSyncResult = { status: 0, stdout: '', stderr: '' },
    shutdownTimeoutMs = 20,
    killTimeoutMs = 20,
} = {}) {
    const statuses = [];
    const spawned = [];
    const tokenFiles = [];
    const signalSource = new EventEmitter();
    const secretState = { tunnelToken: token };
    let childIndex = 0;
    const promise = superviseRuntime(baseConfig(mode), secretState, {
        env,
        signalSource,
        spawnSyncProcess: () => spawnSyncResult,
        spawnProcess(command, args, options) {
            spawned.push({ command, args, options });
            const child = children[childIndex];
            childIndex += 1;
            if (!child) throw new Error(`Unexpected spawn: ${command}`);
            return child;
        },
        validateNginxConfig: async () => {},
        createTokenFile: async (value) => {
            const tokenFile = {
                token: value,
                path: '/tmp/private-cloudflared-token/token',
                removed: 0,
                async remove() {
                    tokenFile.removed += 1;
                },
            };
            tokenFiles.push(tokenFile);
            return tokenFile;
        },
        writeStatusFn: async (status) => {
            statuses.push(structuredClone(status));
        },
        shutdownTimeoutMs,
        killTimeoutMs,
    });
    return { children, env, promise, secretState, signalSource, spawned, statuses, tokenFiles };
}

async function waitForStatus(statuses, state) {
    for (let attempts = 0; attempts < 100; attempts += 1) {
        if (statuses.some((status) => status.state === state)) return;
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail(`Supervisor did not reach ${state}: ${JSON.stringify(statuses)}`);
}

test('required Nginx exit marks the supervisor failed and terminates cloudflared', async () => {
    const nginx = new FakeChild();
    const cloudflared = new FakeChild();
    const harness = createHarness({
        mode: 'cloudflare-token',
        token: 'test-token-not-a-jwt',
        children: [nginx, cloudflared],
    });

    await waitForStatus(harness.statuses, 'running');
    nginx.exit(0);

    assert.equal(await harness.promise, 1);
    assert.deepEqual(cloudflared.kills, ['SIGTERM']);
    const failed = harness.statuses.find((status) => status.state === 'failed');
    assert.match(failed.error, /nginx exited unexpectedly/);
    assert.deepEqual(failed.nginx, {
        state: 'exited',
        pid: nginx.pid,
        code: 0,
        signal: null,
    });
});

test('required Nginx process error is fatal even when cloudflared is healthy', async () => {
    const nginx = new FakeChild();
    const cloudflared = new FakeChild();
    const harness = createHarness({
        mode: 'cloudflare-api',
        token: 'test-token-not-a-jwt',
        children: [nginx, cloudflared],
    });

    await waitForStatus(harness.statuses, 'running');
    nginx.emit('error', new Error('simulated nginx descriptor failure'));

    assert.equal(await harness.promise, 1);
    assert.deepEqual(cloudflared.kills, ['SIGTERM']);
    const failed = harness.statuses.find((status) => status.state === 'failed');
    assert.match(failed.error, /simulated nginx descriptor failure/);
    assert.equal(failed.nginx.state, 'failed');
});

test('cloudflared exit is fatal in a Cloudflare publishing mode', async () => {
    const nginx = new FakeChild();
    const cloudflared = new FakeChild();
    const harness = createHarness({
        mode: 'nginx-cloudflare',
        token: 'test-token-not-a-jwt',
        children: [nginx, cloudflared],
    });

    await waitForStatus(harness.statuses, 'running');
    cloudflared.exit(7);

    assert.equal(await harness.promise, 1);
    assert.deepEqual(nginx.kills, ['SIGTERM']);
    const failed = harness.statuses.find((status) => status.state === 'failed');
    assert.match(failed.error, /cloudflared exited unexpectedly \(code=7/);
    assert.equal(failed.cloudflared.state, 'exited');
});

test('Cloudflare mode without a scoped token fails startup and stops Nginx', async () => {
    const nginx = new FakeChild();
    const harness = createHarness({
        mode: 'cloudflare-token',
        children: [nginx],
    });

    assert.equal(await harness.promise, 1);
    assert.deepEqual(nginx.kills, ['SIGTERM']);
    assert.deepEqual(harness.spawned.map(({ command }) => command), ['nginx']);
    const failed = harness.statuses.find((status) => status.state === 'failed');
    assert.match(failed.error, /scoped Cloudflare tunnel token is required/);
    assert.equal(
        harness.statuses.some((status) => status.state === 'running'),
        false,
        'the supervisor must never advertise healthy state without the required connector',
    );
});

test('unprovisioned Cloudflare API mode is control-ready without claiming a healthy connector', async () => {
    const nginx = new FakeChild();
    const harness = createHarness({
        mode: 'cloudflare-api',
        children: [nginx],
    });

    await waitForStatus(harness.statuses, 'awaiting-provision');
    assert.deepEqual(harness.spawned.map(({ command }) => command), ['nginx']);
    const connector = harness.statuses.find((status) => status.cloudflared)?.cloudflared;
    assert.deepEqual(connector, {
        state: 'awaiting-provision',
        required: false,
        tokenSet: false,
        args: ['tunnel', '--no-autoupdate', 'run'],
    });
    assert.equal(
        harness.statuses.some((status) => status.state === 'running'),
        false,
        'an unprovisioned connector must not be reported as published or healthy',
    );

    harness.signalSource.emit('SIGTERM');
    assert.equal(await harness.promise, 0);
    assert.deepEqual(nginx.kills, ['SIGTERM']);
});

test('plain Nginx mode disables cloudflared and shuts down cleanly on SIGTERM', async () => {
    const nginx = new FakeChild();
    const harness = createHarness({ children: [nginx], token: 'unused-token' });

    await waitForStatus(harness.statuses, 'running');
    assert.deepEqual(harness.spawned.map(({ command }) => command), ['nginx']);
    const cloudflaredStatus = harness.statuses.find((status) => status.cloudflared)?.cloudflared;
    assert.deepEqual(cloudflaredStatus, {
        state: 'disabled',
        required: false,
        tokenSet: true,
        args: ['tunnel', '--no-autoupdate', 'run'],
    });

    harness.signalSource.emit('SIGTERM');
    assert.equal(await harness.promise, 0);
    assert.deepEqual(nginx.kills, ['SIGTERM']);
    assert.equal(harness.statuses.at(-1).state, 'stopped');
});

test('cloudflared receives a private token file while argv, child env, and status remain secret-free', async () => {
    const tunnelToken = 'real-super-secret-tunnel-token';
    const nginx = new FakeChild();
    const cloudflared = new FakeChild();
    const runtimeEnv = {
        PATH: '/safe/bin',
        WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: tunnelToken,
        WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'real-super-secret-api-token',
        WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id-is-not-secret',
    };
    const harness = createHarness({
        mode: 'cloudflare-token',
        token: tunnelToken,
        env: runtimeEnv,
        children: [nginx, cloudflared],
    });

    await waitForStatus(harness.statuses, 'running');
    const [nginxSpawn, cloudflaredSpawn] = harness.spawned;
    assert.deepEqual(nginxSpawn.args.slice(0, 2), ['-g', 'daemon off;']);
    assert.equal(nginxSpawn.options.env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN, undefined);
    assert.equal(nginxSpawn.options.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(nginxSpawn.options.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID, 'account-id-is-not-secret');
    assert.deepEqual(cloudflaredSpawn.args, [
        'tunnel',
        '--no-autoupdate',
        'run',
        '--token-file',
        '/tmp/private-cloudflared-token/token',
    ]);
    assert.deepEqual(cloudflaredSpawn.options.env, { PATH: '/safe/bin' });
    assert.equal(JSON.stringify(harness.spawned).includes(tunnelToken), false);
    assert.equal(JSON.stringify(harness.statuses).includes(tunnelToken), false);
    assert.equal(JSON.stringify(harness.statuses).includes('/tmp/private-cloudflared-token/token'), false);
    assert.equal(harness.tokenFiles[0].token, tunnelToken);
    assert.equal(runtimeEnv.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN, undefined);
    assert.equal(runtimeEnv.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN, undefined);
    assert.equal(runtimeEnv.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID, 'account-id-is-not-secret');
    assert.equal(harness.secretState.tunnelToken, undefined);

    harness.signalSource.emit('SIGTERM');
    assert.equal(await harness.promise, 0);
    assert.equal(harness.tokenFiles[0].removed, 1);
});

test('private Cloudflare token file and parent directory use restrictive permissions', async (t) => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-token-test-'));
    t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
    const privateTokenFile = await createPrivateTokenFile('test-token-value', {
        tmpdir: temporaryRoot,
    });

    assert.equal((await fs.stat(path.dirname(privateTokenFile.path))).mode & 0o777, 0o700);
    assert.equal((await fs.stat(privateTokenFile.path)).mode & 0o777, 0o600);
    assert.equal(await fs.readFile(privateTokenFile.path, 'utf8'), 'test-token-value\n');

    await privateTokenFile.remove();
    await assert.rejects(fs.access(privateTokenFile.path), { code: 'ENOENT' });
});

test('signal shutdown is bounded and escalates a stubborn child to SIGKILL', async () => {
    const nginx = new FakeChild({ exitOnKill: false });
    const harness = createHarness({
        children: [nginx],
        shutdownTimeoutMs: 5,
        killTimeoutMs: 5,
    });

    await waitForStatus(harness.statuses, 'running');
    const startedAt = Date.now();
    harness.signalSource.emit('SIGINT');

    assert.equal(await harness.promise, 1);
    assert.ok(Date.now() - startedAt < 250, 'shutdown must not wait indefinitely');
    assert.deepEqual(nginx.kills, ['SIGINT', 'SIGKILL']);
    const failed = harness.statuses.at(-1);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error, /Timed out terminating required child processes: nginx/);
});

test('missing Nginx executable fails before any child is spawned', async () => {
    const harness = createHarness({
        children: [],
        spawnSyncResult: {
            status: null,
            error: Object.assign(new Error('spawnSync nginx ENOENT'), { code: 'ENOENT' }),
        },
    });

    assert.equal(await harness.promise, 1);
    assert.deepEqual(harness.spawned, []);
    assert.equal(harness.statuses.some((status) => status.state === 'running'), false);
    assert.match(
        harness.statuses.find((status) => status.state === 'failed').error,
        /Required Nginx executable is unavailable/,
    );
});
