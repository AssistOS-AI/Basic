#!/usr/bin/env node
import {
    buildCloudflaredIngress,
    normalizePublishingConfig,
} from '../lib/routes.mjs';
import { renderNginxConfig } from '../lib/nginx-config.mjs';
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
} from '../runtime/status-store.mjs';

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
    const saved = inputConfig || await readConfig();
    return normalizePublishingConfig(saved, process.env);
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
    return {
        ok: true,
        config: redactConfig(config),
        ingress: buildCloudflaredIngress(config.exposures),
        nginxConfig: renderNginxConfig(config.exposures),
    };
}

async function configApply(input) {
    const config = await currentConfig(input.config || {});
    const saved = await writeConfig(config);
    await writeStatus({ state: 'config-applied', mode: config.mode });
    return {
        ok: true,
        config: redactConfig(saved),
        ingress: buildCloudflaredIngress(config.exposures),
    };
}

async function tunnelPlan(input) {
    const config = await currentConfig(input.config || null);
    return {
        ok: true,
        plan: planTunnelChanges({
            tunnelName: config.tunnel?.tunnelName,
            ingress: buildCloudflaredIngress(config.exposures),
            createDnsRecords: input.createDnsRecords === true,
        }),
    };
}

async function tunnelApply(input) {
    const config = await currentConfig(input.config || null);
    const ingress = buildCloudflaredIngress(config.exposures);
    const createDnsRecords = input.createDnsRecords === true;
    if (createDnsRecords) {
        await preflightDnsRecordAccess(config.exposures);
    }
    let tunnelId = config.tunnel?.tunnelId || process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID || '';
    let tunnelName = config.tunnel?.tunnelName || process.env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME || '';
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
            tokenSet: Boolean(config.tunnel?.tokenSet || tunnel?.tokenSet),
            tunnelId,
            tunnelName,
        },
    });
    const cloudflareResult = await putTunnelIngress(ingress, { env: cloudflareEnv });
    const dns = createDnsRecords ? await upsertDnsRecords(config.exposures, { env: cloudflareEnv }) : [];
    await writeStatus({
        state: 'cloudflare-applied',
        cloudflare: {
            tunnelId,
            tunnelName,
            tokenCreated: Boolean(tunnel?.tokenSet),
        },
    });
    return {
        ok: true,
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
