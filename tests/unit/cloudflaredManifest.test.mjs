import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');

const forbiddenExposureFields = [
    'routerAccess',
    'httpServices',
    'guest',
    'ssoProvider',
    'ports',
    'openPorts',
];

function readCloudflaredManifest() {
    const manifestPath = path.join(repoRoot, 'cloudflared', 'manifest.json');

    assert.equal(
        fs.existsSync(manifestPath),
        true,
        'cloudflared/manifest.json must exist',
    );

    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

test('cloudflared manifest runs the custom Cloudflare Tunnel MCP agent image', () => {
    const manifest = readCloudflaredManifest();

    assert.equal(manifest.container, 'docker.io/assistos/cloudflared-agent:node24-cloudflared');
    assert.match(manifest.about, /Cloudflare Tunnel connector and admin control plane/);
    assert.equal(manifest.start, 'node /code/runtime/cloudflared-supervisor.mjs');
    assert.equal(manifest.agent, 'sh /Agent/server/AgentServer.sh');
    assert.equal(manifest.readiness?.protocol, 'mcp');
});

test('cloudflared start plus AgentServer sidecar prepares core MCP dependencies', () => {
    const packagePath = path.join(repoRoot, 'cloudflared', 'package.json');

    assert.equal(
        fs.existsSync(packagePath),
        true,
        'cloudflared/package.json must exist so Ploinky prepares mcp-sdk for the AgentServer sidecar',
    );

    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    assert.equal(packageJson.private, true);
    assert.equal(packageJson.type, 'module');
});

test('cloudflared manifest maps the required tunnel token from a workspace variable', () => {
    const manifest = readCloudflaredManifest();
    const tunnelToken = manifest.profiles?.default?.env?.TUNNEL_TOKEN;

    assert.deepEqual(tunnelToken, {
        varName: 'CLOUDFLARED_TUNNEL_TOKEN',
        required: true,
    });
});

test('cloudflared manifest uses its isolated default network without sibling coupling', () => {
    const manifest = readCloudflaredManifest();
    const serialized = JSON.stringify(manifest);

    assert.deepEqual(manifest.network, { mode: 'default' });
    assert.equal(Object.hasOwn(manifest.network, 'aliases'), false);
    assert.equal(Object.hasOwn(manifest, 'enable'), false);
    assert.equal(Object.hasOwn(manifest.profiles.default.env, 'CLOUDFLARED_ALLOWED_ORIGINS_JSON'), false);
    assert.doesNotMatch(serialized, /office-publishing|webmeet-signaling|host\.containers\.internal/i);
});

test('cloudflared manifest exposes an admin-only Explorer settings dashboard', () => {
    const manifest = readCloudflaredManifest();

    assert.deepEqual(manifest.ideSettings, [
        {
            key: 'cloudflared-settings',
            label: 'Cloudflare Tunnel',
            scope: 'workspace',
            pluginKey: 'cloudflared/cloudflared-settings',
            settingsComponent: 'cloudflared-settings',
            adminOnly: true,
        },
    ]);

    const pluginDir = path.join(repoRoot, 'cloudflared', 'IDE-plugins', 'cloudflared-settings');
    for (const fileName of [
        'config.json',
        'cloudflared-settings.html',
        'cloudflared-settings.css',
        'cloudflared-settings.js',
    ]) {
        assert.equal(
            fs.existsSync(path.join(pluginDir, fileName)),
            true,
            `cloudflared settings plugin must include ${fileName}`,
        );
    }
});

test('cloudflared manifest does not declare direct public or router exposure fields', () => {
    const manifest = readCloudflaredManifest();
    const profiles = manifest.profiles || {};

    for (const field of forbiddenExposureFields) {
        assert.equal(
            Object.hasOwn(manifest, field),
            false,
            `top-level ${field} must be absent`,
        );
    }

    for (const [profileName, profile] of Object.entries(profiles)) {
        for (const field of forbiddenExposureFields) {
            assert.equal(
                Object.hasOwn(profile, field),
                false,
                `profile ${profileName} ${field} must be absent`,
            );
        }
    }
});

test('cloudflared manifest keeps the documented about string stable', () => {
    const manifest = readCloudflaredManifest();

    assert.equal(
        manifest.about,
        'Cloudflare Tunnel connector and admin control plane for exposing selected Ploinky box HTTP and WebSocket surfaces through Cloudflare Tunnel.',
    );
});

test('cloudflared manifest keeps production strict and provides local-test dashboard mode', () => {
    const manifest = readCloudflaredManifest();

    assert.deepEqual(Object.keys(manifest.profiles || {}), ['default', 'local-test']);
    assert.deepEqual(manifest.profiles['local-test'].env.TUNNEL_TOKEN, {
        required: false,
        default: '',
    });
    for (const field of forbiddenExposureFields) {
        assert.equal(
            Object.hasOwn(manifest.profiles.default, field),
            false,
            `default profile ${field} must be absent`,
        );
        assert.equal(
            Object.hasOwn(manifest.profiles['local-test'], field),
            false,
            `local-test profile ${field} must be absent`,
        );
    }
});

test('cloudflared manifest does not contain raw tunnel, API, JWT, or master-key secrets', () => {
    const manifest = readCloudflaredManifest();
    const serialized = JSON.stringify(manifest);
    const rawSecretPatterns = [
        /eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/,
        /\b[a-f0-9]{64}\b/i,
        /\b(?:cf|cloudflare)[_-]?api[_-]?token\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/i,
        /\bPLOINKY_MASTER_KEY\b/,
        /\bCLOUDFLARED_TUNNEL_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{20,}/,
    ];

    for (const pattern of rawSecretPatterns) {
        assert.equal(
            pattern.test(serialized),
            false,
            `manifest must not match raw secret pattern ${pattern}`,
        );
    }
});

test('cloudflared MCP tools are admin-only and use strict input schemas', () => {
    const mcpConfigPath = path.join(repoRoot, 'cloudflared', 'mcp-config.json');

    assert.equal(fs.existsSync(mcpConfigPath), true, 'cloudflared/mcp-config.json must exist');

    const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
    const tools = mcpConfig.tools || [];

    assert.deepEqual(
        tools.map((tool) => tool.name),
        [
            'cloudflared_status',
            'cloudflared_routes_validate',
            'cloudflared_routes_apply',
        ],
    );

    for (const tool of tools) {
        assert.deepEqual(tool.tags, ['admin'], `${tool.name} must be admin-only`);
        assert.equal(tool.command, 'node');
        assert.deepEqual(tool.args, ['tools/cloudflared-tool.mjs']);
        assert.equal(tool.cwd, '/code');
        assert.equal(
            Object.hasOwn(tool.inputSchema || {}, 'type'),
            false,
            `${tool.name} must use Ploinky AgentServer shorthand inputSchema, not a JSON Schema root`,
        );
    }

    for (const tool of tools.filter((entry) => entry.name !== 'cloudflared_status')) {
        const routeSchema = tool.inputSchema.routes?.items;
        assert.equal(tool.inputSchema.routes?.type, 'array');
        assert.equal(routeSchema?.type, 'object');
        assert.equal(
            routeSchema?.additionalProperties,
            false,
            `${tool.name} route entries must reject unknown fields`,
        );
        assert.notEqual(tool.inputSchema.routes?.optional, true);
        assert.notEqual(routeSchema.properties?.hostname?.optional, true);
        assert.notEqual(routeSchema.properties?.originId?.optional, true);
        assert.equal(routeSchema.properties?.id?.optional, true);
        assert.equal(routeSchema.properties?.path?.optional, true);
    }
});
