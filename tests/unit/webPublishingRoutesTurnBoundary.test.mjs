import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildCloudflaredIngress,
    buildProviderValues,
    buildProviderWarnings,
    isTurnHostname,
    normalizePublishingConfig,
    normalizeRouteModel,
} from '../../web-publishing/lib/routes.mjs';

function publicConfig(overrides = {}) {
    return normalizePublishingConfig({
        mode: 'cloudflare-api',
        tlsEdge: 'cloudflare',
        baseDomain: 'example.com',
        livekitMediaIp: '203.0.113.10',
        turnExternalIp: '198.51.100.20',
        ...overrides,
    });
}

test('WEBMEET_TURN_HOST is derived independently from the signaling URL hostname', () => {
    const config = publicConfig();
    const values = buildProviderValues(config, {});
    const byName = new Map(values.map((entry) => [entry.name, entry]));

    assert.equal(new URL(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value).hostname, 'meet.example.com');
    assert.equal(byName.get('WEBMEET_TURN_HOST')?.value, 'turn.example.com');
    assert.equal(byName.has('WEBMEET_TURN_REALM'), false);
    assert.equal(byName.get('WEBMEET_TURN_EXTERNAL_IP')?.value, '198.51.100.20');
    assert.equal(byName.get('WEBMEET_LIVEKIT_NODE_IP')?.value, '203.0.113.10');
    assert.equal(byName.get('WEBMEET_TURN_ALLOWED_PEER_IPS')?.value, '203.0.113.10/32');
    assert.notEqual(
        byName.get('WEBMEET_TURN_HOST')?.value,
        new URL(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value).hostname,
    );
    for (const name of ['WEBMEET_TLS_HOSTNAME', 'WEBMEET_CERT_EMAIL', 'WEBMEET_LIVEKIT_UPSTREAM']) {
        assert.equal(byName.has(name), false, `${name} must not be emitted`);
    }
});

test('WEBMEET_TURN_HOST explicitly resets to loopback when no base domain is configured', () => {
    const config = normalizePublishingConfig({});
    const values = buildProviderValues(config, {});
    const byName = new Map(values.map((entry) => [entry.name, entry]));

    assert.equal(byName.get('WEBMEET_TURN_HOST')?.value, '127.0.0.1');
    assert.equal(byName.has('WEBMEET_TURN_EXTERNAL_IP'), false);
    assert.equal(byName.has('WEBMEET_TURN_ALLOWED_PEER_IPS'), false);
});

test('WEBMEET_PUBLIC_LIVEKIT_URL uses the configured local loopback nginx route with no public topology', () => {
    const config = normalizePublishingConfig({});
    const values = buildProviderValues(config, {});
    const byName = new Map(values.map((entry) => [entry.name, entry]));

    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'ws://127.0.0.1:8081');
});

test('WEBMEET_PUBLIC_LIVEKIT_URL resolves to wss://meet.<baseDomain> only with a trusted TLS contract', () => {
    const config = publicConfig();
    const values = buildProviderValues(config, {});
    const byName = new Map(values.map((entry) => [entry.name, entry]));

    assert.equal(byName.get('WEBMEET_PUBLIC_LIVEKIT_URL')?.value, 'wss://meet.example.com');
});

test('buildProviderValues never emits WEBMEET_TURN_AUTH_SECRET even if present in env', () => {
    const config = publicConfig();
    const values = buildProviderValues(config, {
        WEBMEET_TURN_AUTH_SECRET: 'must-not-copy',
    });

    assert.equal(values.some((entry) => entry.name === 'WEBMEET_TURN_AUTH_SECRET'), false);
});

test('isTurnHostname recognizes only the turn. label', () => {
    assert.equal(isTurnHostname('turn.example.com'), true);
    assert.equal(isTurnHostname('TURN.example.com'), true);
    assert.equal(isTurnHostname('meet.example.com'), false);
    assert.equal(isTurnHostname('turnstile.example.com'), false);
    assert.equal(isTurnHostname(''), false);
});

test('buildCloudflaredIngress refuses to publish a turn.* hostname through the HTTP tunnel', () => {
    assert.throws(
        () => normalizeRouteModel({
            baseDomain: 'example.com',
            exposures: [{ hostname: 'turn.example.com', originId: 'router' }],
        }),
        /DNS-only L4 endpoint/,
    );
    assert.throws(
        () => buildCloudflaredIngress([{
            enabled: true,
            hostname: 'turn.example.com',
            originId: 'router',
            service: 'http://ploinky-router:8080',
        }]),
        /must not be published through the Cloudflare HTTP tunnel/,
    );
});

test('buildProviderWarnings flags a turn.* hostname present in exposures', () => {
    const warnings = buildProviderWarnings({
        baseDomain: 'example.com',
        turnExternalIp: '198.51.100.20',
        exposures: [
            { id: 'turn', enabled: true, hostname: 'turn.example.com', path: '', originId: 'router' },
        ],
    });
    assert.equal(warnings.some((warning) => /TURN hostnames must never be published/.test(warning)), true);
});

test('buildProviderWarnings states the external TLS connector client-IP contract', () => {
    const warnings = buildProviderWarnings({
        baseDomain: 'example.com',
        tlsEdge: 'external',
        turnExternalIp: '198.51.100.20',
        exposures: [],
    });

    assert.equal(warnings.some((warning) => /127\.0\.0\.1:18083/.test(warning)), true);
    assert.equal(warnings.some((warning) => /overwrite X-Real-IP/.test(warning)), true);
    assert.equal(warnings.some((warning) => /raw port 8081 does not serve public LiveKit/.test(warning)), true);
});
