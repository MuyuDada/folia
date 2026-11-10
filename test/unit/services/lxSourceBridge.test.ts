import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLxSourceBridge, forgetLxSourceStatus } from '../../../src/services/lxSourceBridge';
import type { SongResult } from '../../../src/types';

// test/unit/services/lxSourceBridge.test.ts
// 网页版把播放地址交给 Vercel 上的音源桥：这里钉住「什么时候换地址、换成什么、什么时候不换」。

const song = {
    id: 'netease:123456',
    name: '测试歌',
    artists: [{ id: 'a1', name: '甲' }, { id: 'a2', name: '乙' }],
    album: { id: 'al1', name: '测试专辑' },
    durationMs: 200_000,
    sourceRef: { kind: 'online', providerId: 'netease', mediaId: '123456', providerData: { mediaMid: 'mid-1' } },
} as unknown as SongResult;

const statusOf = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const stubWeb = (electron = false) => {
    vi.stubGlobal('window', {
        location: { origin: 'https://folia.example' },
        ...(electron ? { electron: { mods: {} } } : {}),
    });
};

const stubStatus = (body: unknown) => {
    const fetchMock = vi.fn(async () => statusOf(body));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
};

const source = { url: 'https://cdn.example/a.mp3', quality: 'high' as const, fetchedAt: 1, replayGain: { trackGain: -3 } };

beforeEach(() => {
    forgetLxSourceStatus();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('applyLxSourceBridge', () => {
    it('hands back the source it was given when no deployment is configured', async () => {
        stubWeb();
        stubStatus({ configured: false, providers: [], sources: {} });
        await expect(applyLxSourceBridge('netease', song, 'high', source)).resolves.toBe(source);
    });

    it('leaves the address alone when the script cannot take this platform over', async () => {
        stubWeb();
        stubStatus({ configured: true, providers: ['qq'], sources: { tx: { name: 'QQ', qualitys: ['320k'], musicUrl: true } } });
        await expect(applyLxSourceBridge('netease', song, 'high', source)).resolves.toBe(source);
    });

    it('swaps in the bridge address and keeps the rest of the source', async () => {
        stubWeb();
        stubStatus({ configured: true, providers: ['netease'], sources: { wy: { name: '网易', qualitys: ['320k'], musicUrl: true } } });

        const result = await applyLxSourceBridge('netease', song, 'lossless', source);
        expect(result?.replayGain).toEqual({ trackGain: -3 });
        expect(result?.quality).toBe('high');
        expect(result?.preview).toBe(false);

        const url = new URL(result!.url);
        expect(url.origin).toBe('https://folia.example');
        expect(url.pathname).toBe('/api/lx-source');
        expect(url.searchParams.get('op')).toBe('resolve');

        const payload = JSON.parse(Buffer.from(url.searchParams.get('p')!, 'base64url').toString('utf8'));
        expect(payload).toEqual({
            provider: 'netease',
            quality: 'lossless',
            song: { id: '123456', title: '测试歌', artist: '甲 / 乙', album: '测试专辑', mediaMid: 'mid-1' },
        });
    });

    it('still answers where the platform itself gave no address', async () => {
        stubWeb();
        stubStatus({ configured: true, providers: ['netease'], sources: { wy: { name: '网易', qualitys: ['320k'], musicUrl: true } } });

        const result = await applyLxSourceBridge('netease', song, 'standard', null);
        expect(result?.url).toContain('op=resolve');
        expect(result?.quality).toBe('standard');
    });

    it('asks the deployment once and remembers the answer', async () => {
        stubWeb();
        const fetchMock = stubStatus({ configured: true, providers: ['netease'], sources: { wy: { name: '网易', qualitys: ['320k'], musicUrl: true } } });
        await applyLxSourceBridge('netease', song, 'high', source);
        await applyLxSourceBridge('netease', song, 'high', source);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps the platform address when the deployment cannot be reached', async () => {
        stubWeb();
        vi.stubGlobal('fetch', vi.fn(async () => {
            throw new Error('offline');
        }));
        await expect(applyLxSourceBridge('netease', song, 'high', source)).resolves.toBe(source);
    });

    it('stays out of the desktop build, where the mod does this job', async () => {
        stubWeb(true);
        const fetchMock = stubStatus({ configured: true, providers: ['netease'], sources: { wy: { name: '网易', qualitys: ['320k'], musicUrl: true } } });
        await expect(applyLxSourceBridge('netease', song, 'high', source)).resolves.toBe(source);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
