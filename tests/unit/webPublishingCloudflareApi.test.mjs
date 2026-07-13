import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    createTunnel,
    planTunnelChanges,
    putTunnelIngress,
    upsertDnsRecords,
} from '../../web-publishing/lib/cloudflare-api.mjs';
import { normalizePublishingConfig } from '../../web-publishing/lib/routes.mjs';
import { runtimeConfigFingerprint } from '../../web-publishing/runtime/config-fingerprint.mjs';
import {
    configApply,
    tunnelApply,
    tunnelPlan,
} from '../../web-publishing/tools/web-publishing-tool.mjs';

test('createTunnel uses Cloudflare remote tunnel API shape and returns token to internal caller', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    success: true,
                    result: {
                        id: 'tunnel-id',
                        name: 'workspace',
                        token: 'created-token',
                    },
                });
            },
        };
    };

    try {
        const result = await createTunnel('workspace', {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
            },
        });

        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel$/);
        assert.deepEqual(JSON.parse(calls[0].options.body), {
            name: 'workspace',
            config_src: 'cloudflare',
        });
        assert.deepEqual(result, {
            tunnelId: 'tunnel-id',
            tunnelName: 'workspace',
            tokenSet: true,
            token: 'created-token',
        });
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('putTunnelIngress does not require DNS zone when DNS mutation is skipped', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { ok: true } });
            },
        };
    };

    try {
        await putTunnelIngress([{ service: 'http_status:404' }], {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        });

        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel\/tunnel-id\/configurations$/);
        assert.doesNotMatch(String(calls[0].url), /\/zones\//);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('DNS creation requires explicit opt-in and zone configuration', async () => {
    await assert.rejects(
        () => upsertDnsRecords([
            { enabled: true, hostname: 'app.example.com' },
        ], {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
        }),
        /WEB_PUBLISHING_CLOUDFLARE_ZONE_ID/,
    );
});

test('TURN DNS mutation rejects non-IPv4 and unusable records before any API request', async () => {
    for (const content of ['not-an-ip', '0.0.0.0', '127.0.0.1', '224.0.0.1']) {
        await assert.rejects(
            () => upsertDnsRecords([], {
                env: {
                    WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                    WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                    WEB_PUBLISHING_CLOUDFLARE_ZONE_ID: 'zone-id',
                },
                turnDnsRecord: {
                    type: 'A',
                    name: 'turn.example.com',
                    content,
                    ttl: 1,
                    proxied: false,
                },
            }),
            /bare IPv4 address/,
        );
    }
});

test('planTunnelChanges is redacted and marks DNS as opt-in', () => {
    const plan = planTunnelChanges({
        tunnelId: 'draft-tunnel-id',
        tunnelName: 'workspace',
        ingress: [{ hostname: 'app.example.com', service: 'http://origin' }],
        createDnsRecords: false,
    }, {
        env: {
            WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
            WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
            WEB_PUBLISHING_CLOUDFLARE_ZONE_ID: 'zone-id',
        },
    });

    assert.equal(plan.apiTokenConfigured, true);
    assert.equal(plan.createDnsRecords, false);
    assert.equal(plan.tunnelId, 'draft-tunnel-id');
    assert.equal(JSON.stringify(plan).includes('api-token'), false);
});

test('tunnelPlan reports the normalized draft tunnel id when env has no tunnel id', async () => {
    const originalEnv = { ...process.env };
    try {
        delete process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID;
        const result = await tunnelPlan({
            config: {
                mode: 'cloudflare-api',
                tlsEdge: 'cloudflare',
                baseDomain: 'example.com',
                livekitMediaIp: '203.0.113.10',
                turnExternalIp: '198.51.100.20',
                tunnel: { tunnelId: 'draft-tunnel-id', tunnelName: 'workspace' },
            },
        });
        assert.equal(result.plan.tunnelId, 'draft-tunnel-id');
        assert.equal(result.plan.tunnelName, 'workspace');
    } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
    }
});

test('tunnelApply provisions an API-created token without changing remote ingress', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-cloudflare-'));
    const originalFetch = globalThis.fetch;
    const originalEnv = { ...process.env };
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (String(url).endsWith('/cfd_tunnel')) {
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({
                        success: true,
                        result: {
                            id: 'created-tunnel-id',
                            name: 'created-tunnel',
                            token: 'created-secret-token',
                        },
                    });
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { applied: true } });
            },
        };
    };

    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        delete process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID;

        const draft = {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            tunnel: { tunnelName: 'created-tunnel' },
        };
        const normalized = normalizePublishingConfig(draft, process.env);
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'awaiting-provision',
            activeConfigFingerprint: runtimeConfigFingerprint(normalized),
            nginx: { state: 'running' },
            cloudflared: { state: 'awaiting-provision' },
        }));

        const savedDraft = await configApply({ config: draft });
        assert.equal(savedDraft.applied, true);
        assert.equal(savedDraft.restartRequired, false);
        assert.equal(
            JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_STATUS_FILE, 'utf8')).state,
            'awaiting-provision',
        );

        const result = await tunnelApply({
            config: draft,
            createDnsRecords: false,
        });

        assert.equal(result.ok, true);
        assert.equal(result.applied, false);
        assert.equal(result.remoteApplied, false);
        assert.equal(result.restartRequired, true);
        assert.equal(result.tunnel.tokenSet, true);
        assert.equal(JSON.stringify(result).includes('created-secret-token'), false);
        assert.equal(calls.length, 1);
        assert.match(String(calls[0].url), /\/accounts\/account-id\/cfd_tunnel$/);

        const config = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'));
        assert.equal(config.tunnel.tunnelId, 'created-tunnel-id');
        assert.equal(config.tunnel.tokenSet, true);
        assert.equal(JSON.stringify(config).includes('created-secret-token'), false);

        const secretStateText = await fs.readFile(path.join(tempDir, 'secret-state.json'), 'utf8');
        assert.match(secretStateText, /created-secret-token/);
        const stat = await fs.stat(path.join(tempDir, 'secret-state.json'));
        assert.equal(stat.mode & 0o077, 0);
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('configApply reports restart-required unless the supervisor fingerprint already matches', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-config-apply-'));
    const originalEnv = { ...process.env };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        const draft = { mode: 'nginx', tlsEdge: 'none' };
        const normalized = normalizePublishingConfig(draft, process.env);
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'running',
            activeConfigFingerprint: runtimeConfigFingerprint(normalized),
            nginx: { state: 'running' },
            cloudflared: { state: 'disabled' },
        }));

        const alreadyActive = await configApply({ config: draft });
        assert.equal(alreadyActive.applied, true);
        assert.equal(alreadyActive.restartRequired, false);
        assert.equal(JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_STATUS_FILE, 'utf8')).state, 'running');

        const changed = await configApply({
            config: { ...draft, publicUrl: 'https://changed.example.test' },
        });
        assert.equal(changed.applied, false);
        assert.equal(changed.restartRequired, true);
        assert.equal(JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_STATUS_FILE, 'utf8')).state, 'restart-required');
    } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('tunnelApply makes zero Cloudflare calls, including tunnel creation, while the local topology is stale', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-stale-ingress-'));
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('remote mutation must not be reached');
    };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'restart-required',
            activeConfigFingerprint: 'old-topology',
            nginx: { state: 'running' },
            cloudflared: { state: 'running' },
        }));

        const result = await tunnelApply({
            config: {
                mode: 'cloudflare-api',
                tlsEdge: 'cloudflare',
                baseDomain: 'example.com',
                livekitMediaIp: '203.0.113.10',
                turnExternalIp: '198.51.100.20',
                tunnel: { tunnelName: 'would-create-if-unguarded' },
            },
        });

        assert.equal(result.ok, false);
        assert.equal(result.remoteApplied, false);
        assert.equal(result.restartRequired, true);
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('connector identity changes invalidate the active runtime fingerprint', () => {
    const base = normalizePublishingConfig({
        mode: 'cloudflare-api',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
        tunnel: {
            source: 'cloudflare-api',
            tokenSet: true,
            tunnelId: 'active-tunnel-id',
            tunnelName: 'active-tunnel',
        },
    });
    const active = runtimeConfigFingerprint(base);
    for (const tunnel of [
        { ...base.tunnel, tunnelId: 'requested-tunnel-id' },
        { ...base.tunnel, tunnelName: 'requested-tunnel' },
        { ...base.tunnel, source: 'token' },
        { ...base.tunnel, tokenSet: false },
    ]) {
        assert.notEqual(runtimeConfigFingerprint({ ...base, tunnel }), active);
    }
});

test('tunnelApply cannot use an active old connector to mutate a requested new tunnel', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-tunnel-identity-'));
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('mismatched connector must not reach Cloudflare');
    };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        const common = {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
        };
        const active = normalizePublishingConfig({
            ...common,
            tunnel: {
                source: 'cloudflare-api',
                tokenSet: true,
                tunnelId: 'active-tunnel-id',
                tunnelName: 'active-tunnel',
            },
        }, process.env);
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'running',
            activeConfigFingerprint: runtimeConfigFingerprint(active),
            nginx: { state: 'running' },
            cloudflared: { state: 'running' },
        }));

        const result = await tunnelApply({
            config: {
                ...common,
                tunnel: {
                    source: 'cloudflare-api',
                    tokenSet: true,
                    tunnelId: 'requested-tunnel-id',
                    tunnelName: 'requested-tunnel',
                },
            },
        });
        assert.equal(result.ok, false);
        assert.equal(result.remoteApplied, false);
        assert.equal(result.restartRequired, true);
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('tunnelApply rejects a fallback secret-state tunnel that was not in the active identity', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-fallback-identity-'));
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        throw new Error('fallback tunnel must not reach Cloudflare');
    };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        const draft = {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            tunnel: { tokenSet: true },
        };
        await fs.writeFile(process.env.WEB_PUBLISHING_SECRET_STATE_FILE, JSON.stringify({
            tunnelToken: 'private-token',
            tunnelId: 'secret-only-tunnel-id',
            tunnelName: 'secret-only-tunnel',
        }));
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'running',
            activeConfigFingerprint: runtimeConfigFingerprint(
                normalizePublishingConfig(draft, process.env),
            ),
            nginx: { state: 'running' },
            cloudflared: { state: 'running' },
        }));

        const result = await tunnelApply({ config: draft });
        assert.equal(result.ok, false);
        assert.equal(result.remoteApplied, false);
        assert.equal(result.restartRequired, true);
        assert.match(result.error, /tunnel identity differs/);
        assert.equal(fetchCalls, 0);
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('config and tunnel apply are serialized so a config change cannot race a remote mutation', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-operation-lock-'));
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    let releaseFetch;
    let markFetchEntered;
    const fetchEntered = new Promise((resolve) => { markFetchEntered = resolve; });
    const fetchRelease = new Promise((resolve) => { releaseFetch = resolve; });
    let fetchCalls = 0;
    globalThis.fetch = async () => {
        fetchCalls += 1;
        markFetchEntered();
        await fetchRelease;
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { applied: true } });
            },
        };
    };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        const activeDraft = {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            tunnel: { tunnelId: 'tunnel-id', tunnelName: 'workspace', tokenSet: true },
        };
        const normalized = normalizePublishingConfig(activeDraft, process.env);
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'running',
            activeConfigFingerprint: runtimeConfigFingerprint(normalized),
            nginx: { state: 'running' },
            cloudflared: { state: 'running' },
        }));

        const tunnelPromise = tunnelApply({ config: activeDraft });
        await fetchEntered;
        let configSettled = false;
        const configPromise = configApply({
            config: { ...activeDraft, publicUrl: 'https://changed.example.test' },
        }).finally(() => { configSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(configSettled, false, 'config apply must wait for the in-flight remote apply lock');

        releaseFetch();
        const [tunnelResult, configResult] = await Promise.all([tunnelPromise, configPromise]);
        assert.equal(tunnelResult.remoteApplied, true);
        assert.equal(configResult.restartRequired, true);
        assert.equal(fetchCalls, 1);
        const saved = JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_CONFIG_FILE, 'utf8'));
        const status = JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_STATUS_FILE, 'utf8'));
        assert.equal(saved.publicUrl, 'https://changed.example.test');
        assert.equal(Object.hasOwn(saved, 'listenPort'), false);
        assert.equal(Object.hasOwn(saved, 'lanHost'), false);
        assert.equal(status.state, 'restart-required');
        assert.equal(status.requestedConfigFingerprint, runtimeConfigFingerprint(
            normalizePublishingConfig({
                ...activeDraft,
                publicUrl: 'https://changed.example.test',
            }, process.env),
        ));
    } finally {
        releaseFetch?.();
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('tunnelApply mutates remote ingress only after matching supervised children are running', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-active-ingress-'));
    const originalEnv = { ...process.env };
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { applied: true } });
            },
        };
    };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        process.env.WEB_PUBLISHING_STATUS_FILE = path.join(tempDir, 'status.json');
        process.env.WEB_PUBLISHING_SECRET_STATE_FILE = path.join(tempDir, 'secret-state.json');
        process.env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN = 'api-token';
        process.env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID = 'account-id';
        const draft = {
            mode: 'cloudflare-api',
            tlsEdge: 'cloudflare',
            baseDomain: 'example.com',
            livekitMediaIp: '203.0.113.10',
            turnExternalIp: '198.51.100.20',
            tunnel: { tunnelId: 'tunnel-id', tunnelName: 'workspace', tokenSet: true },
        };
        const normalized = normalizePublishingConfig(draft, process.env);
        await fs.writeFile(process.env.WEB_PUBLISHING_STATUS_FILE, JSON.stringify({
            state: 'running',
            activeConfigFingerprint: runtimeConfigFingerprint(normalized),
            nginx: { state: 'running' },
            cloudflared: { state: 'running' },
        }));

        const result = await tunnelApply({ config: draft, createDnsRecords: false });

        assert.equal(result.ok, true);
        assert.equal(result.applied, true);
        assert.equal(result.remoteApplied, true);
        assert.equal(result.restartRequired, false);
        assert.equal(calls.length, 1);
        assert.match(calls[0].url, /\/accounts\/account-id\/cfd_tunnel\/tunnel-id\/configurations$/);
        const status = JSON.parse(await fs.readFile(process.env.WEB_PUBLISHING_STATUS_FILE, 'utf8'));
        assert.equal(status.state, 'running', 'remote apply must preserve supervisor health state');
        assert.equal(status.lastOperation, 'cloudflare-applied');
    } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('tunnelApply refuses local or externally terminated nginx topology', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-publishing-invalid-tunnel-'));
    const originalEnv = { ...process.env };
    try {
        process.env.WEB_PUBLISHING_CONFIG_FILE = path.join(tempDir, 'config.json');
        await assert.rejects(
            () => tunnelApply({ config: { mode: 'nginx', tlsEdge: 'none' } }),
            /Cloudflare tunnel operations require a Cloudflare publishing mode/,
        );
    } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, originalEnv);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('upsertDnsRecords provisions TURN as an unproxied A record alongside proxied tunnel CNAMEs', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if ((options.method || 'GET') === 'GET') {
            return {
                ok: true,
                status: 200,
                async text() {
                    return JSON.stringify({ success: true, result: [] });
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ success: true, result: { id: `record-${calls.length}` } });
            },
        };
    };

    try {
        const results = await upsertDnsRecords([
            { enabled: true, hostname: 'meet.example.com' },
        ], {
            env: {
                WEB_PUBLISHING_CLOUDFLARE_API_TOKEN: 'api-token',
                WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID: 'account-id',
                WEB_PUBLISHING_CLOUDFLARE_ZONE_ID: 'zone-id',
                WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: 'tunnel-id',
            },
            turnDnsRecord: {
                type: 'A',
                name: 'turn.example.com',
                content: '198.51.100.20',
                ttl: 1,
                proxied: false,
            },
        });

        const requestBodies = calls
            .filter((call) => call.options.body)
            .map((call) => JSON.parse(call.options.body));
        assert.deepEqual(requestBodies, [
            {
                type: 'CNAME',
                name: 'meet.example.com',
                content: 'tunnel-id.cfargotunnel.com',
                ttl: 1,
                proxied: true,
            },
            {
                type: 'A',
                name: 'turn.example.com',
                content: '198.51.100.20',
                ttl: 1,
                proxied: false,
            },
        ]);
        assert.deepEqual(results.map(({ hostname, type, proxied }) => ({ hostname, type, proxied })), [
            { hostname: 'meet.example.com', type: 'CNAME', proxied: true },
            { hostname: 'turn.example.com', type: 'A', proxied: false },
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
