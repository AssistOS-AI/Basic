import { createHash } from 'node:crypto';

export function runtimeConfigFingerprint(config = {}) {
    const tunnel = config?.tunnel || {};
    const runtimeConfig = {
        version: config?.version,
        mode: config?.mode,
        tlsEdge: config?.tlsEdge,
        baseDomain: config?.baseDomain,
        publicUrl: config?.publicUrl,
        livekitMediaIp: config?.livekitMediaIp,
        turnExternalIp: config?.turnExternalIp,
        externalProxyCidrs: config?.externalProxyCidrs,
        exposures: config?.exposures,
        // Only normalized, non-secret connector identity belongs in the runtime
        // fingerprint. Whitelisting these fields keeps a future credential field
        // out of the digest while ensuring a different active tunnel cannot satisfy
        // the desired-state gate.
        tunnel: {
            source: String(tunnel.source || ''),
            tokenSet: Boolean(tunnel.tokenSet),
            tunnelId: String(tunnel.tunnelId || ''),
            tunnelName: String(tunnel.tunnelName || ''),
        },
    };
    return createHash('sha256')
        .update(JSON.stringify(runtimeConfig))
        .digest('hex');
}
