import fs from 'node:fs/promises';
import path from 'node:path';

export const defaultConfigFile = '/data/config.json';
export const defaultStatusFile = '/data/status.json';
export const defaultSecretStateFile = '/data/secret-state.json';

function dataFileFromEnv(env, key, defaultFile, fileName) {
    const configured = env[key] || '';
    if (env.PLOINKY_PROVIDER_DATA_DIR && (!configured || configured === defaultFile)) {
        return path.join(env.PLOINKY_PROVIDER_DATA_DIR, fileName);
    }
    return configured || defaultFile;
}

export function configFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_CONFIG_FILE', defaultConfigFile, 'config.json');
}

export function statusFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_STATUS_FILE', defaultStatusFile, 'status.json');
}

export function secretStateFileFromEnv(env = process.env) {
    return dataFileFromEnv(env, 'WEB_PUBLISHING_SECRET_STATE_FILE', defaultSecretStateFile, 'secret-state.json');
}

export async function readJsonFile(filePath, fallback) {
    try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
        if (error?.code === 'ENOENT') return fallback;
        throw error;
    }
}

export async function writeJsonFile(filePath, payload, { mode } = {}) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        ...(mode ? { mode } : {}),
    });
    if (mode) await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, filePath);
    if (mode) await fs.chmod(filePath, mode);
    return payload;
}

export async function readConfig({ env = process.env } = {}) {
    return readJsonFile(configFileFromEnv(env), {
        version: 1,
        mode: 'nginx',
        baseDomain: '',
        lanHost: '127.0.0.1',
        certEmail: '',
        tunnel: {
            source: 'none',
            tokenSet: false,
            tunnelId: '',
            tunnelName: '',
        },
        exposures: [],
    });
}

export async function writeConfig(config, { env = process.env } = {}) {
    return writeJsonFile(configFileFromEnv(env), {
        version: 1,
        updatedAt: new Date().toISOString(),
        ...config,
    });
}

export async function readStatus({ env = process.env } = {}) {
    return readJsonFile(statusFileFromEnv(env), {
        state: 'unknown',
        updatedAt: '',
        nginx: { state: 'unknown' },
        cloudflared: { state: 'unknown', tokenSet: false },
    });
}

export async function writeStatus(update, { env = process.env } = {}) {
    const previous = await readStatus({ env }).catch(() => ({}));
    return writeJsonFile(statusFileFromEnv(env), {
        ...previous,
        ...update,
        updatedAt: new Date().toISOString(),
    });
}

export async function readSecretState({ env = process.env } = {}) {
    return readJsonFile(secretStateFileFromEnv(env), {
        tunnelToken: '',
        tunnelId: '',
        tunnelName: '',
        updatedAt: '',
    });
}

export async function writeSecretState(update, { env = process.env } = {}) {
    const previous = await readSecretState({ env }).catch(() => ({}));
    return writeJsonFile(secretStateFileFromEnv(env), {
        ...previous,
        ...update,
        updatedAt: new Date().toISOString(),
    }, { mode: 0o600 });
}

export function redactSecretState(secretState = {}) {
    return {
        tunnelTokenSet: Boolean(secretState?.tunnelToken),
        tunnelIdSet: Boolean(secretState?.tunnelId),
        tunnelName: secretState?.tunnelName || '',
        updatedAt: secretState?.updatedAt || '',
    };
}

export function redactConfig(config, env = process.env) {
    return {
        ...config,
        cloudflare: {
            apiTokenConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_API_TOKEN),
            accountIdConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_ACCOUNT_ID),
            zoneIdConfigured: Boolean(env.WEB_PUBLISHING_CLOUDFLARE_ZONE_ID),
        },
        tunnel: {
            ...(config?.tunnel || {}),
            tokenSet: Boolean(config?.tunnel?.tokenSet || env.WEB_PUBLISHING_CLOUDFLARED_TUNNEL_TOKEN || env.TUNNEL_TOKEN),
        },
    };
}
