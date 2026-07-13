#!/usr/bin/env node
import {
    buildCloudflaredIngress,
    mergePublishingConfig,
    normalizePublishingConfig,
    buildTurnDnsRecord,
} from '../lib/routes.mjs';
import {
    readRuntimeDnsResolvers,
    renderNginxConfig,
} from '../lib/nginx-config.mjs';
import {
    createTunnel,
    describeCloudflareConfig,
    planTunnelChanges,
    preflightDnsRecordAccess,
    putTunnelIngress,
    upsertDnsRecords,
} from '../lib/cloudflare-api.mjs';
import {
    readSecretState,
    readConfig,
    readStatus,
    redactConfig,
    redactSecretState,
    writeConfig,
    writeSecretState,
    writeStatus,
    withOperationLock,
} from '../runtime/status-store.mjs';
import { runtimeConfigFingerprint } from '../runtime/config-fingerprint.mjs';

async function readStdin() {
    if (process.stdin.isTTY) return '';
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    return data;
}

function parsePayload(raw) {
    try {
        const parsed = raw ? JSON.parse(raw) : {};
        return {
            tool: String(parsed?.tool || process.env.TOOL_NAME || '').trim(),
            input: parsed?.input && typeof parsed.input === 'object' ? parsed.input : {},
        };
    } catch {
        return {
            tool: String(process.env.TOOL_NAME || '').trim(),
            input: {},
        };
    }
}

async function currentConfig(inputConfig = null) {
    if (inputConfig) {
        return normalizePublishingConfig(inputConfig, process.env);
    }
    const [saved, secretState] = await Promise.all([readConfig(), readSecretState()]);
    return normalizePublishingConfig(
        mergePublishingConfig(saved, process.env, secretState),
        process.env,
    );
}

function requireCloudflarePublishingConfig(config) {
    if (!String(config?.mode || '').includes('cloudflare') || config?.tlsEdge !== 'cloudflare') {
        throw new Error('Cloudflare tunnel operations require a Cloudflare publishing mode and WEB_PUBLISHING_TLS_EDGE=cloudflare.');
    }
}

async function status() {
    const config = await currentConfig();
    const secretState = await readSecretState();
    return {
        ok: true,
        config: redactConfig(config),
        status: await readStatus(),
        secrets: redactSecretState(secretState),
        cloudflare: describeCloudflareConfig(),
        ingress: buildCloudflaredIngress(config.exposures),
        turnDnsRecord: buildTurnDnsRecord(config),
    };
}

async function configGet() {
    const config = await currentConfig();
    return {
        ok: true,
        config: redactConfig(config),
    };
}

async function configValidate(input) {
    const config = await currentConfig(input.config || {});
    const dnsResolvers = await readRuntimeDnsResolvers();
    return {
        ok: true,
        config: redactConfig(config),
        ingress: buildCloudflaredIngress(config.exposures),
        nginxConfig: renderNginxConfig(config.exposures, {
            dnsResolvers,
            tlsEdge: config.tlsEdge,
            externalProxyCidrs: config.externalProxyCidrs,
        }),
        turnDnsRecord: buildTurnDnsRecord(config),
    };
}

async function configApplyUnlocked(input) {
    const config = await currentConfig(input.config || {});
    const activeStatus = await readStatus();
    const configFingerprint = runtimeConfigFingerprint(config);
    const saved = await writeConfig(config);
    const applied = (activeStatus.state === 'running' || activeStatus.state === 'awaiting-provision')
        && activeStatus.activeConfigFingerprint === configFingerprint;
    if (!applied) {
        await writeStatus({
            state: 'restart-required',
            mode: config.mode,
            requestedConfigFingerprint: configFingerprint,
        });
    }
    return {
        ok: true,
        persisted: true,
        applied,
        restartRequired: !applied,
        config: redactConfig(saved),
        ingress: buildCloudflaredIngress(config.exposures),
    };
}

async function tunnelPlan(input) {
    const config = await currentConfig(input.config || null);
    requireCloudflarePublishingConfig(config);
    const turnDnsRecord = buildTurnDnsRecord(config);
    return {
        ok: true,
        plan: planTunnelChanges({
            tunnelId: config.tunnel?.tunnelId,
            tunnelName: config.tunnel?.tunnelName,
            ingress: buildCloudflaredIngress(config.exposures),
            createDnsRecords: input.createDnsRecords === true,
            turnDnsRecord,
        }),
    };
}

async function tunnelApplyUnlocked(input) {
    const config = await currentConfig(input.config || null);
    requireCloudflarePublishingConfig(config);
    const ingress = buildCloudflaredIngress(config.exposures);
    const turnDnsRecord = buildTurnDnsRecord(config);
    const createDnsRecords = input.createDnsRecords === true;
    const activeStatus = await readStatus();
    const configFingerprint = runtimeConfigFingerprint(config);
    const cloudflaredState = activeStatus.cloudflared?.state;
    const activeFingerprintMatches = activeStatus.activeConfigFingerprint === configFingerprint
        && activeStatus.nginx?.state === 'running'
        && ((activeStatus.state === 'running' && cloudflaredState === 'running')
            || (activeStatus.state === 'awaiting-provision' && cloudflaredState === 'awaiting-provision'));
    if (!activeFingerprintMatches) {
        return {
            ok: false,
            applied: false,
            remoteApplied: false,
            restartRequired: true,
            error: 'Restart Web Publishing and verify its active configuration and required child processes before any Cloudflare operation.',
            config: redactConfig(config),
            ingress,
        };
    }

    const secretState = await readSecretState();
    let tunnelId = config.tunnel?.tunnelId
        || process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID
        || secretState.tunnelId
        || '';
    let tunnelName = config.tunnel?.tunnelName
        || process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME
        || secretState.tunnelName
        || '';
    const requestedTunnelId = config.tunnel?.tunnelId || '';
    const requestedTunnelName = config.tunnel?.tunnelName || '';
    if (
        (tunnelId && tunnelId !== requestedTunnelId)
        || (tunnelName && tunnelName !== requestedTunnelName)
    ) {
        await writeStatus({
            state: 'restart-required',
            mode: config.mode,
            requestedConfigFingerprint: configFingerprint,
        });
        return {
            ok: false,
            applied: false,
            remoteApplied: false,
            restartRequired: true,
            error: 'Resolved Cloudflare tunnel identity differs from the supervised connector; restart Web Publishing before any remote operation.',
            config: redactConfig(config),
            ingress,
        };
    }
    let tunnel = null;
    if (!tunnelId) {
        tunnel = await createTunnel(config.tunnel?.tunnelName || 'ploinky-web-publishing');
        tunnelId = tunnel.tunnelId;
        tunnelName = tunnel.tunnelName;
        await writeSecretState({
            tunnelToken: tunnel.token || '',
            tunnelId,
            tunnelName,
        });
    }
    const tokenSet = Boolean(
        config.tunnel?.tokenSet
        || process.env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || process.env.TUNNEL_TOKEN
        || secretState.tunnelToken
        || tunnel?.tokenSet
    );
    const cloudflareEnv = {
        ...process.env,
        WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID: tunnelId,
        WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME: tunnelName,
    };
    const savedConfig = await writeConfig({
        ...config,
        tunnel: {
            ...(config.tunnel || {}),
            source: tunnel ? 'cloudflare-api' : (config.tunnel?.source || 'cloudflare-api'),
            tokenSet,
            tunnelId,
            tunnelName,
        },
    });
    if (tunnel) {
        await writeStatus({
            state: 'restart-required',
            mode: config.mode,
            requestedConfigFingerprint: configFingerprint,
            cloudflare: {
                tunnelId,
                tunnelName,
                tokenCreated: Boolean(tunnel?.tokenSet),
                ingressApplied: false,
            },
        });
        return {
            ok: true,
            persisted: true,
            applied: false,
            remoteApplied: false,
            restartRequired: true,
            tunnelProvisioned: Boolean(tunnel),
            config: redactConfig(savedConfig, cloudflareEnv),
            ingress,
            dns: [],
            cloudflareResult: null,
            tunnel: tunnel ? {
                tunnelId: tunnel.tunnelId,
                tunnelName: tunnel.tunnelName,
                tokenSet: tunnel.tokenSet,
            } : null,
        };
    }

    if (activeStatus.state !== 'running' || cloudflaredState !== 'running') {
        await writeStatus({
            state: 'restart-required',
            mode: config.mode,
            requestedConfigFingerprint: configFingerprint,
        });
        return {
            ok: false,
            persisted: true,
            applied: false,
            remoteApplied: false,
            restartRequired: true,
            error: 'Restart Web Publishing so its required Cloudflared connector is running before applying remote ingress.',
            config: redactConfig(savedConfig, cloudflareEnv),
            ingress,
        };
    }
    if (createDnsRecords) {
        await preflightDnsRecordAccess(config.exposures, { turnDnsRecord });
    }
    const cloudflareResult = await putTunnelIngress(ingress, { env: cloudflareEnv });
    const dns = createDnsRecords
        ? await upsertDnsRecords(config.exposures, { env: cloudflareEnv, turnDnsRecord })
        : [];
    await writeStatus({
        lastOperation: 'cloudflare-applied',
        cloudflare: {
            tunnelId,
            tunnelName,
            tokenCreated: Boolean(tunnel?.tokenSet),
            ingressApplied: true,
        },
    });
    return {
        ok: true,
        persisted: true,
        applied: true,
        remoteApplied: true,
        restartRequired: false,
        config: redactConfig(savedConfig, cloudflareEnv),
        ingress,
        dns,
        cloudflareResult,
        tunnel: tunnel ? {
            tunnelId: tunnel.tunnelId,
            tunnelName: tunnel.tunnelName,
            tokenSet: tunnel.tokenSet,
        } : null,
    };
}

async function configApply(input) {
    return withOperationLock(() => configApplyUnlocked(input));
}

async function tunnelApply(input) {
    return withOperationLock(() => tunnelApplyUnlocked(input));
}

export async function main() {
    const { tool, input } = parsePayload(await readStdin());
    let result;
    if (tool === 'web_publishing_status') result = await status();
    else if (tool === 'web_publishing_config_get') result = await configGet();
    else if (tool === 'web_publishing_config_validate') result = await configValidate(input);
    else if (tool === 'web_publishing_config_apply') result = await configApply(input);
    else if (tool === 'web_publishing_cloudflare_tunnel_plan') result = await tunnelPlan(input);
    else if (tool === 'web_publishing_cloudflare_tunnel_apply') result = await tunnelApply(input);
    else throw new Error(`Unknown Web Publishing tool: ${tool}`);
    process.stdout.write(JSON.stringify(result));
}

export {
    configApply,
    configGet,
    configValidate,
    status,
    tunnelApply,
    tunnelPlan,
};

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        process.stderr.write(`${error?.message || String(error)}\n`);
        process.exitCode = 1;
    });
}
