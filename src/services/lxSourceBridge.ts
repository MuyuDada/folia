import type { SongResult } from '../types';
import type { AudioQualityPreference, ProviderAudioSource } from '../types/onlineMusic';

// src/services/lxSourceBridge.ts
// 把在线歌曲的播放地址交给部署在 Vercel 的 LX 音源桥（api-ts/lx-source.ts）解析。
//
// 桌面端的同一件事由 folia-lx-source-bridge 模组做（主进程跑脚本 + 本地回环代理）；网页版没有模组
// 系统，所以这里只做「换个地址」：把地址换成 /api/lx-source?op=resolve&p=…，真正的脚本解析发生在
// 播放器来取流时，由那个函数 302 到真实地址（或它自己的中转地址）。
//
// 什么时候接管由服务端说了算：/api/lx-source?op=status 报出这份部署配了脚本、以及脚本声明了哪些平台。
// 没配脚本时这里一次网络请求都不会发到解码路径上，所有判断都在一次 5 分钟内有效的状态缓存里。

const ENDPOINT = '/api/lx-source';
const STATUS_TIMEOUT_MS = 2500;
const STATUS_TTL_MS = 5 * 60_000;

export interface LxSourceStatus {
    configured: boolean;
    disabled: boolean;
    /** 这份部署能接管的平台 id，由服务端按脚本声明的音源算出来。 */
    providers: string[];
    sources: Record<string, { name: string; qualitys: string[]; musicUrl: boolean }>;
    script: { name: string; version: string; author: string; description: string; homepage: string } | null;
    mode: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);

// status 的返回是网络来的，按 unknown 收再逐项认，不假设服务端一定给对了形状。
const toStatus = (body: unknown): LxSourceStatus | null => {
    if (!isRecord(body)) return null;
    const sources: LxSourceStatus['sources'] = {};
    if (isRecord(body.sources)) {
        for (const [id, conf] of Object.entries(body.sources)) {
            if (!isRecord(conf)) continue;
            sources[id] = {
                name: typeof conf.name === 'string' ? conf.name : id,
                qualitys: stringList(conf.qualitys),
                musicUrl: conf.musicUrl === true,
            };
        }
    }
    const script = isRecord(body.script)
        ? {
            name: typeof body.script.name === 'string' ? body.script.name : '',
            version: typeof body.script.version === 'string' ? body.script.version : '',
            author: typeof body.script.author === 'string' ? body.script.author : '',
            description: typeof body.script.description === 'string' ? body.script.description : '',
            homepage: typeof body.script.homepage === 'string' ? body.script.homepage : '',
        }
        : null;
    return {
        configured: body.configured === true,
        disabled: body.disabled === true,
        providers: stringList(body.providers),
        sources,
        script,
        mode: typeof body.mode === 'string' ? body.mode : 'auto',
    };
};

// 桌面端走模组，这里整个不参与：判定与模组相同，同一台机器上两边同时接管会把地址改两次。
const isWebBuild = () => typeof window !== 'undefined' && !window.electron;

let statusCache: { at: number; status: LxSourceStatus | null } | null = null;
let statusPending: Promise<LxSourceStatus | null> | null = null;

const readStatus = async (): Promise<LxSourceStatus | null> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
    try {
        const response = await fetch(`${ENDPOINT}?op=status`, { signal: controller.signal });
        if (!response.ok) return null;
        return toStatus(await response.json());
    } catch (error) {
        // 部署里没有这个函数（404）、断网、函数超时都在这里：当作没配，播放照旧走平台自己的地址。
        console.warn('[lx-source] 读取音源桥状态失败，本次不接管播放地址', error);
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/** 音源桥的状态，5 分钟内复用上一次的结果；并发调用共用同一个请求。 */
export const lxSourceStatus = (): Promise<LxSourceStatus | null> => {
    if (!isWebBuild()) return Promise.resolve(null);
    if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.status);
    if (statusPending) return statusPending;
    statusPending = readStatus().then(status => {
        statusCache = { at: Date.now(), status };
        statusPending = null;
        return status;
    });
    return statusPending;
};

/** 丢掉状态缓存，下一次取播放地址时重新问一次服务端（换脚本、改环境变量后不必刷新页面）。 */
export const forgetLxSourceStatus = () => {
    statusCache = null;
};

const mediaIdOf = (song: SongResult): string => {
    const ref = song.sourceRef;
    if (ref?.kind === 'online' && ref.mediaId !== '') return ref.mediaId;
    return String(song.id);
};

const toBase64Url = (text: string) => {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// 解析地址。歌名/歌手/专辑一起带上：脚本做元数据兜底时要用，歌曲 id 之外的字段它拿不到别的来源。
const resolveEndpointUrl = (providerId: string, song: SongResult, quality: AudioQualityPreference, mediaId: string) => {
    const ref = song.sourceRef;
    const providerData = ref?.kind === 'online' ? ref.providerData : undefined;
    const mediaMid = providerData?.mediaMid;
    const payload = {
        provider: providerId,
        quality,
        song: {
            id: mediaId,
            title: song.name,
            artist: song.artists.map(artist => artist.name).join(' / '),
            album: song.album.name,
            mediaMid: typeof mediaMid === 'string' ? mediaMid : '',
        },
    };
    const base = typeof window !== 'undefined' ? window.location.origin : '';
    return `${base}${ENDPOINT}?op=resolve&p=${toBase64Url(JSON.stringify(payload))}`;
};

/**
 * 给一首歌换上音源桥的地址；这份部署没配脚本、平台不在脚本声明里、或不是网页版时，原样返回。
 *
 * `source` 是平台自己解析出来的地址（可能为 null，例如平台拒绝了这首歌），返回值的其余字段沿用它的，
 * 只换 url：ReplayGain、试听标记这些仍然来自平台。
 */
export const applyLxSourceBridge = async (
    providerId: string,
    song: SongResult,
    quality: AudioQualityPreference,
    source: ProviderAudioSource | null,
): Promise<ProviderAudioSource | null> => {
    const status = await lxSourceStatus();
    if (!status || !status.configured || status.disabled) return source;
    if (!status.providers.includes(providerId)) return source;

    const mediaId = mediaIdOf(song);
    if (mediaId === '') return source;

    const url = resolveEndpointUrl(providerId, song, quality, mediaId);
    return { ...(source ?? { quality, fetchedAt: Date.now() }), url, fetchedAt: Date.now(), preview: false };
};
