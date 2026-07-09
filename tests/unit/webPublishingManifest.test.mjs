import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const outputNames = [
    'ONLYOFFICE_PUBLIC_URL',
    'ONLYOFFICE_INTERNAL_URL',
    'ONLYOFFICE_CALLBACK_BASE_URL',
    'WEBMEET_PUBLIC_LIVEKIT_URL',
    'WEBMEET_LIVEKIT_URL',
    'WEBMEET_TLS_HOSTNAME',
    'WEBMEET_TURN_HOST',
    'WEBMEET_TURN_EXTERNAL_IP',
    'WEBMEET_TURN_REALM',
    'WEBMEET_CERT_EMAIL',
    'WEBMEET_LIVEKIT_UPSTREAM',
    'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN',
    'WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID',
    'WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME',
];

const forbiddenFields = [
    'routerAccess',
    'httpServices',
    'guest',
    'ssoProvider',
    'ports',
];

function readManifest() {
    const manifestPath = path.join(repoRoot, 'web-publishing', 'manifest.json');
    assert.equal(fs.existsSync(manifestPath), true, 'web-publishing/manifest.json must exist');
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('web-publishing manifest declares the custom nginx and cloudflared image', () => {
    const manifest = readManifest();

    assert.equal(manifest.container, 'docker.io/assistos/web-publishing-agent:node24-nginx-cloudflared');
    assert.equal(manifest.start, 'node /code/runtime/supervisor.mjs');
    assert.equal(manifest.agent, 'sh /Agent/server/AgentServer.sh');
    assert.equal(manifest.readiness?.protocol, 'mcp');
    assert.equal(manifest.containerSecurity?.privileged, false);
});

test('web-publishing manifest exposes only admin settings and loopback data-plane ports by default', () => {
    const manifest = readManifest();

    for (const field of forbiddenFields) {
        assert.equal(Object.hasOwn(manifest, field), false, `${field} must be absent`);
    }

    assert.deepEqual(manifest.ideSettings, [
        {
            key: 'web-publishing-settings',
            label: 'Web Publishing',
            scope: 'workspace',
            pluginKey: 'web-publishing/web-publishing-settings',
            settingsComponent: 'web-publishing-settings',
            adminOnly: true,
        },
    ]);

    assert.deepEqual(manifest.profiles.default.openPorts, ['127.0.0.1:8081:8081']);
    assert.deepEqual(manifest.profiles.lan.openPorts, ['0.0.0.0:8081:8081']);
    for (const profile of Object.values(manifest.profiles)) {
        for (const field of forbiddenFields) {
            assert.equal(Object.hasOwn(profile, field), false, `profile ${field} must be absent`);
        }
    }
});

test('web-publishing manifest uses the scoped tunnel token only', () => {
    const manifest = readManifest();
    const defaultEnv = manifest.profiles.default.env || {};

    assert.deepEqual(defaultEnv.TUNNEL_TOKEN, {
        varName: 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN',
        required: false,
    });

    const serialized = JSON.stringify(manifest);
    assert.doesNotMatch(serialized, /"CLOUDFLARED_TUNNEL_TOKEN"/);
    assert.equal(Object.hasOwn(defaultEnv, 'WEB_PUBLISHING_CERT_EMAIL'), true);
    assert.equal(Object.hasOwn(defaultEnv, 'WEBMEET_CERT_EMAIL'), false);
    assert.equal(defaultEnv.WEB_PUBLISHING_SECRET_STATE_FILE?.default, '/data/secret-state.json');
    assert.match(serialized, /WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN/);
});

test('web-publishing provider output allowlist is exact and excludes generated secrets', () => {
    const manifest = readManifest();
    const outputs = manifest.providesConfig?.outputs || [];

    assert.equal(manifest.providesConfig.command, 'node runtime/provider.mjs');
    assert.deepEqual(outputs.map((entry) => entry.name), outputNames);
    assert.equal(outputs.find((entry) => entry.name === 'WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN')?.sensitive, true);

    const forbidden = [
        'CLOUDFLARED_TUNNEL_TOKEN',
        'WEBMEET_LIVEKIT_API_KEY',
        'WEBMEET_LIVEKIT_API_SECRET',
        'WEBMEET_TURN_PASSWORD',
        'PLOINKY_WEBMEET_MASTER_KEY',
        'ONLYOFFICE_JWT_SECRET',
        'JWT_SECRET',
        'PLOINKY_MASTER_KEY',
    ];
    for (const name of forbidden) {
        assert.equal(outputs.some((entry) => entry.name === name), false, `${name} must not be a provider output`);
    }
});

test('web-publishing MCP tools are admin-only', () => {
    const configPath = path.join(repoRoot, 'web-publishing', 'mcp-config.json');
    assert.equal(fs.existsSync(configPath), true, 'web-publishing/mcp-config.json must exist');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const tools = config.tools || [];

    assert.deepEqual(tools.map((tool) => tool.name), [
        'web_publishing_status',
        'web_publishing_config_get',
        'web_publishing_config_validate',
        'web_publishing_config_apply',
        'web_publishing_cloudflare_tunnel_plan',
        'web_publishing_cloudflare_tunnel_apply',
    ]);

    for (const tool of tools) {
        assert.deepEqual(tool.tags, ['admin'], `${tool.name} must be admin-only`);
        assert.equal(tool.command, 'node');
        assert.deepEqual(tool.args, ['tools/web-publishing-tool.mjs']);
        assert.equal(tool.cwd, '/code');
        assert.equal(tool.tags.includes('internal'), false);
    }
});
