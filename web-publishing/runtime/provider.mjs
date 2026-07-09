#!/usr/bin/env node
import {
    buildProviderValues,
    buildProviderWarnings,
    normalizePublishingConfig,
} from '../lib/routes.mjs';
import {
    readConfig as readSavedConfig,
    readSecretState as readSavedSecretState,
} from './status-store.mjs';

function providerEnvConfig(env = process.env, secretState = {}) {
    const scopedToken = env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || env.TUNNEL_TOKEN
        || secretState.tunnelToken;
    return {
        mode: env.WEB_PUBLISHING_MODE,
        baseDomain: env.WEB_PUBLISHING_BASE_DOMAIN,
        publicUrl: env.WEB_PUBLISHING_PUBLIC_URL,
        publicHost: env.WEB_PUBLISHING_PUBLIC_HOST,
        certEmail: env.WEB_PUBLISHING_CERT_EMAIL,
        tunnel: {
            source: scopedToken ? 'token' : undefined,
            tokenSet: scopedToken ? true : undefined,
            tunnelId: env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_ID || secretState.tunnelId,
            tunnelName: env.WEB_PUBLISHING_CLOUDFLARE_TUNNEL_NAME || secretState.tunnelName,
        },
    };
}

function definedEntries(object = {}) {
    return Object.fromEntries(
        Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
    );
}

function mergeConfig(saved, envConfig) {
    return {
        ...saved,
        ...definedEntries(envConfig),
        tunnel: {
            ...(saved?.tunnel || {}),
            ...definedEntries(envConfig.tunnel || {}),
        },
    };
}

export async function buildProviderResponse(env = process.env, {
    readConfig = () => readSavedConfig({ env }),
    readSecretState = () => readSavedSecretState({ env }),
} = {}) {
    const saved = await readConfig();
    const secretState = await readSecretState();
    const merged = mergeConfig(saved, providerEnvConfig(env, secretState));
    const scopedToken = env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || env.TUNNEL_TOKEN
        || secretState.tunnelToken;
    const outputEnv = scopedToken
        ? { ...env, WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: scopedToken }
        : env;
    let config;
    const warnings = [];
    try {
        config = normalizePublishingConfig(merged, outputEnv);
    } catch (error) {
        config = normalizePublishingConfig({}, {});
        warnings.push(error?.message || String(error));
    }
    warnings.push(...buildProviderWarnings(config));
    return {
        version: 1,
        values: buildProviderValues(config, outputEnv),
        warnings,
    };
}

async function main() {
    const response = await buildProviderResponse();
    process.stdout.write(JSON.stringify(response));
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((error) => {
        process.stderr.write(`${error?.message || String(error)}\n`);
        process.exitCode = 1;
    });
}
