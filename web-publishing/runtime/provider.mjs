#!/usr/bin/env node
import {
    buildProviderValues,
    buildProviderWarnings,
    mergePublishingConfig,
    normalizePublishingConfig,
} from '../lib/routes.mjs';
import {
    readConfig as readSavedConfig,
} from './status-store.mjs';

export async function buildProviderResponse(env = process.env, {
    readConfig = () => readSavedConfig({ env }),
} = {}) {
    const saved = await readConfig();
    // This command runs on the host before containers start. Container-owned
    // secret-state remains mode 0600 and must never be a provider dependency;
    // only an explicitly resolved provider env value may be republished.
    const merged = mergePublishingConfig(saved, env);
    const scopedToken = env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN
        || env.TUNNEL_TOKEN;
    const outputEnv = scopedToken
        ? { ...env, WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN: scopedToken }
        : env;
    const config = normalizePublishingConfig(merged, outputEnv);
    return {
        version: 1,
        values: buildProviderValues(config, outputEnv),
        warnings: buildProviderWarnings(config),
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
