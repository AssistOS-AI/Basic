import test from 'node:test';
import assert from 'node:assert/strict';

import { renderNginxConfig } from '../../web-publishing/lib/nginx-config.mjs';
import { normalizeRouteModel } from '../../web-publishing/lib/routes.mjs';

test('renderNginxConfig includes WebSocket upgrade headers and no secrets', () => {
    const { routes } = normalizeRouteModel({
        baseDomain: 'example.com',
        exposures: [
            { hostname: 'meet.example.com', originId: 'livekit-http' },
        ],
    });

    const rendered = renderNginxConfig(routes, {
        token: 'secret-token',
        apiToken: 'api-secret',
    });

    assert.match(rendered, /proxy_set_header Upgrade \$http_upgrade;/);
    assert.match(rendered, /proxy_set_header Connection "upgrade";/);
    assert.match(rendered, /proxy_pass http:\/\/host\.containers\.internal:7880;/);
    assert.match(rendered, /pid \/tmp\/web-publishing-nginx\.pid;/);
    assert.match(rendered, /proxy_temp_path \/tmp\/web-publishing-proxy;/);
    assert.doesNotMatch(rendered, /secret-token|api-secret/);
});

test('renderNginxConfig refuses raw AgentServer port routes', () => {
    assert.throws(
        () => renderNginxConfig([
            {
                hostname: 'agent.example.com',
                path: '',
                service: 'http://host.containers.internal:7000',
                enabled: true,
            },
        ]),
        /AgentServer\/MCP port 7000/,
    );
});
