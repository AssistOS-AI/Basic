import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildIngress,
    loadOriginPresets,
    normalizeRoutes,
} from '../../cloudflared/lib/routes.mjs';

test('normalizeRoutes accepts hostnames under the configured base domain', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'explorer.example.com', originId: 'router' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(routes, [
        {
            id: 'route_1',
            enabled: true,
            hostname: 'explorer.example.com',
            path: '',
            originId: 'router',
            service: 'http://host.containers.internal:8080',
            description: '',
        },
    ]);
});

test('buildIngress appends a catch-all 404 rule', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'office.example.com', path: '/office', originId: 'onlyoffice' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(buildIngress(routes), [
        {
            hostname: 'office.example.com',
            path: '/office',
            service: 'http://host.containers.internal:8082',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildIngress places path-specific routes before host catch-all routes', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'app.example.com', originId: 'router' },
        { hostname: 'app.example.com', path: '/office', originId: 'onlyoffice' },
        { hostname: 'app.example.com', path: '/office/admin', originId: 'onlyoffice' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    assert.deepEqual(buildIngress(routes), [
        {
            hostname: 'app.example.com',
            path: '/office/admin',
            service: 'http://host.containers.internal:8082',
        },
        {
            hostname: 'app.example.com',
            path: '/office',
            service: 'http://host.containers.internal:8082',
        },
        {
            hostname: 'app.example.com',
            service: 'http://host.containers.internal:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('buildIngress groups same-host path routes before host catch-all routes when hostnames are interleaved', () => {
    const { routes } = normalizeRoutes([
        { hostname: 'app.example.com', originId: 'router' },
        { hostname: 'other.example.com', originId: 'router' },
        { hostname: 'app.example.com', path: '/office', originId: 'onlyoffice' },
        { hostname: 'app.example.com', path: '/office/admin', originId: 'onlyoffice' },
    ], {
        env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
    });

    const ingress = buildIngress(routes);
    const appRootIndex = ingress.findIndex((entry) => entry.hostname === 'app.example.com' && !entry.path);
    const appPathIndexes = ingress
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => entry.hostname === 'app.example.com' && entry.path)
        .map(({ index }) => index);

    assert.ok(appRootIndex > -1);
    assert.ok(appPathIndexes.length > 0);
    assert.equal(
        appPathIndexes.every((index) => index < appRootIndex),
        true,
        'same-host path rules must precede the host catch-all',
    );
    assert.deepEqual(ingress, [
        {
            hostname: 'app.example.com',
            path: '/office/admin',
            service: 'http://host.containers.internal:8082',
        },
        {
            hostname: 'app.example.com',
            path: '/office',
            service: 'http://host.containers.internal:8082',
        },
        {
            hostname: 'app.example.com',
            service: 'http://host.containers.internal:8080',
        },
        {
            hostname: 'other.example.com',
            service: 'http://host.containers.internal:8080',
        },
        { service: 'http_status:404' },
    ]);
});

test('normalizeRoutes rejects hostnames outside the base domain', () => {
    assert.throws(
        () => normalizeRoutes([
            { hostname: 'explorer.bad.test', originId: 'router' },
        ], {
            env: { CLOUDFLARE_BASE_DOMAIN: 'example.com' },
        }),
        /must be under example\.com/,
    );
});

test('normalizeRoutes rejects raw AgentServer port exposure', () => {
    assert.throws(
        () => normalizeRoutes([
            {
                hostname: 'agent.example.com',
                originId: 'custom',
                service: 'http://host.containers.internal:7000',
            },
        ], {
            env: {
                CLOUDFLARE_BASE_DOMAIN: 'example.com',
                CLOUDFLARED_ALLOWED_ORIGINS_JSON: JSON.stringify([
                    {
                        id: 'custom',
                        label: 'Unsafe raw agent port',
                        service: 'http://host.containers.internal:7000',
                    },
                ]),
            },
        }),
        /AgentServer\/MCP port 7000/,
    );
});

test('loadOriginPresets accepts explicit published host origins', () => {
    const origins = loadOriginPresets({
        CLOUDFLARED_ALLOWED_ORIGINS_JSON: JSON.stringify([
            {
                id: 'livekit-http',
                label: 'LiveKit HTTP signaling',
                service: 'http://host.containers.internal:7880',
            },
        ]),
    });

    assert.equal(origins.length, 1);
    assert.equal(origins[0].service, 'http://host.containers.internal:7880');
});
