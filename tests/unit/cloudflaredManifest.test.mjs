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

test('cloudflared manifest runs the official Cloudflare Tunnel connector', () => {
    const manifest = readCloudflaredManifest();

    assert.equal(manifest.container, 'docker.io/cloudflare/cloudflared:latest');
    assert.match(manifest.about, /Cloudflare Tunnel/);
    assert.match(manifest.about, /Ploinky router-hosted HTTP and WebSocket/);
    assert.match(manifest.about, /Ploinky box/);
    assert.equal(manifest.start, 'tunnel --no-autoupdate run');
    assert.equal(manifest.readiness?.protocol, 'none');
});

test('cloudflared manifest maps the required tunnel token from a workspace variable', () => {
    const manifest = readCloudflaredManifest();
    const tunnelToken = manifest.profiles?.default?.env?.TUNNEL_TOKEN;

    assert.deepEqual(tunnelToken, {
        varName: 'CLOUDFLARED_TUNNEL_TOKEN',
        required: true,
    });
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
        'Cloudflare Tunnel connector for exposing Ploinky router-hosted HTTP and WebSocket surfaces from inside Ploinky box.',
    );
});

test('cloudflared manifest defines only the default profile', () => {
    const manifest = readCloudflaredManifest();

    assert.deepEqual(Object.keys(manifest.profiles || {}), ['default']);
    for (const field of forbiddenExposureFields) {
        assert.equal(
            Object.hasOwn(manifest.profiles.default, field),
            false,
            `default profile ${field} must be absent`,
        );
    }
});

test('cloudflared manifest does not contain raw tunnel, API, JWT, or master-key secrets', () => {
    const manifest = readCloudflaredManifest();
    const serialized = JSON.stringify(manifest);
    const rawSecretPatterns = [
        /eyJ[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+?\.[A-Za-z0-9_-]+/,
        /\b[a-f0-9]{64}\b/i,
        /\b(?:cf|cloudflare)[_-]?api[_-]?token\b/i,
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
