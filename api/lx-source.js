import { constants as cryptoConstants, createCipheriv, createHash, createHmac, publicEncrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { Readable } from 'node:stream';
import { deflate, inflate } from 'node:zlib';
// 当前文件：Vercel 上运行 LX Music 自定义源脚本的音源桥函数（TypeScript 源文件，由
// `npm run build:vercel-api` 编出 api/lx-source.js）。
//
// 桌面版由 folia-lx-source-bridge 模组在主进程里做同一件事：把内置音源解析出的播放地址换成脚本给的地址。
// 网页版没有模组系统，也没有常驻的本地 http 服务，于是这里把「跑脚本」搬到 Serverless：
//
//   op=status   这份部署有没有配脚本、脚本声明了哪些音源（客户端据此决定要不要接管）
//   op=resolve  解析一首歌的播放地址，直接 302 到真实地址；地址缺 CORS 头时 302 到本站的 op=stream
//   op=stream   带 Range 的音频中转（给缺 CORS 头、或只给 http 地址的上游用），签名校验，不是开放代理
//
// 脚本从环境变量来（LX_SOURCE_SCRIPT / LX_SOURCE_SCRIPT_B64 / LX_SOURCE_SCRIPT_URL），不进仓库：
// 本项目不分发任何音源脚本。协议对齐参照 lx-music-desktop 的自定义源规范。
const RESOLVE_TIMEOUT_MS = 20_000;
const SCRIPT_FETCH_TIMEOUT_MS = 10_000;
const PROBE_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const CACHE_TTL_MS = 10 * 60_000;
const INITED_WAIT_MS = 3_000;
const RUNTIME_RETRY_MS = 30_000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
// folia 的音质档位 → LX 脚本的 qualitys 值
const QUALITY_MAP = { standard: '128k', high: '320k', lossless: 'flac', hires: 'flac24bit' };
const QUALITY_ORDER = ['128k', '320k', 'flac', 'flac24bit'];
// Folia 的平台 id → LX 脚本音源 id（脚本的 sources 键）。桌面模组里是同一张表。
const LX_SOURCE_OF_PROVIDER = { netease: 'wy', kugou: 'kg', qq: 'tx' };
const EVENT_NAMES = { request: 'request', inited: 'inited', updateAlert: 'updateAlert' };
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type',
    'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
};
// ---------------------------------------------------------------- 小工具
const isDict = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const readString = (value, fallback = '') => (typeof value === 'string' ? value : fallback);
const safeText = (value) => {
    if (typeof value === 'string')
        return value;
    if (value && typeof value === 'object') {
        const message = value.message;
        if (typeof message === 'string' && message)
            return message;
    }
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
};
// 脚本在 vm 里抛的错不是宿主 realm 的 Error 实例（instanceof Error 为假），直接 String() 只会得到
// "{}"。message 属性跨 realm 仍然读得到，所以要按形状取，别按类型判断。
const describeError = (error) => {
    if (error instanceof Error)
        return error;
    if (error && typeof error === 'object') {
        const message = error.message;
        if (typeof message === 'string' && message)
            return new Error(message);
    }
    return new Error(typeof error === 'string' ? error : safeText(error ?? '脚本返回被拒绝'));
};
const b64url = (text) => Buffer.from(text, 'utf8').toString('base64url');
const fromB64url = (text) => Buffer.from(text, 'base64url').toString('utf8');
const withTimeout = (work, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}（超过 ${ms}ms）`)), ms);
    work.then(value => {
        clearTimeout(timer);
        resolve(value);
    }, (error) => {
        clearTimeout(timer);
        reject(describeError(error));
    });
});
// 脚本声明的 qualitys 里挑一档：精确 → 不高于请求的最近一档 → 最低一档
const pickQuality = (supported, want) => {
    const list = Array.isArray(supported) ? supported.filter((item) => typeof item === 'string') : [];
    if (list.length === 0)
        return want;
    if (list.includes(want))
        return want;
    const rank = new Map(QUALITY_ORDER.map((quality, index) => [quality, index]));
    const known = list.filter(quality => rank.has(quality)).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
    if (known.length === 0)
        return want;
    const wantRank = rank.get(want) ?? 1;
    const atOrBelow = known.filter(quality => (rank.get(quality) ?? 0) <= wantRank);
    return atOrBelow.length > 0 ? atOrBelow[atOrBelow.length - 1] : known[0];
};
// 客户端给的歌曲（sourceRef.mediaId 与标题信息）→ LX 脚本认识的 musicInfo。
// 字段按各脚本的惯用写法给；这张表之外的平台本项目不接管。
const toMusicInfo = (source, song) => {
    const id = song.id == null ? '' : String(song.id);
    const common = { name: readString(song.title), singer: readString(song.artist), albumName: readString(song.album) };
    switch (source) {
        case 'wy':
            return { ...common, songmid: id, songId: /^\d+$/.test(id) ? Number(id) : id };
        case 'kg':
            return { ...common, hash: id, hash128: id, albumId: readString(song.albumId) };
        case 'tx':
            return { ...common, songmid: id, mediaMid: readString(song.mediaMid, id), songId: id };
        default:
            return { ...common, songmid: id };
    }
};
// ---------------------------------------------------------------- 脚本来源
//
// 三种给法，任选其一（B64 优先）：LX_SOURCE_SCRIPT 直接写脚本正文、LX_SOURCE_SCRIPT_B64 写它的
// base64、LX_SOURCE_SCRIPT_URL 给一个 http(s) 地址由本函数拉取（结果在实例内存里缓存）。
const readEnvScript = async () => {
    const raw = process.env.LX_SOURCE_SCRIPT;
    if (typeof raw === 'string' && raw.trim())
        return raw;
    const encoded = process.env.LX_SOURCE_SCRIPT_B64;
    if (typeof encoded === 'string' && encoded.trim()) {
        return Buffer.from(encoded.trim(), 'base64').toString('utf8');
    }
    const url = process.env.LX_SOURCE_SCRIPT_URL;
    if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) {
        const response = await fetch(url.trim(), {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(SCRIPT_FETCH_TIMEOUT_MS),
        });
        if (!response.ok)
            throw new Error(`下载脚本失败：HTTP ${response.status}`);
        return await response.text();
    }
    return null;
};
// ---------------------------------------------------------------- 宿主 API（globalThis.lx）
//
// 与洛雪桌面版 preload 的 needle 语义逐项对齐：回调 (err, resp, body)、body 是 utf8 文本再尝试
// JSON.parse、resp.raw 保留 Buffer、不跟随重定向、GET/HEAD 的 form 拼进查询串、60s 超时上限。
const httpRequest = (target, optionsArg, callbackArg) => {
    const options = typeof optionsArg === 'function' ? {} : optionsArg;
    const callback = typeof optionsArg === 'function' ? optionsArg : (callbackArg ?? (() => { }));
    const method = (options.method ?? 'get').toUpperCase();
    const headers = { ...options.headers };
    let body = options.body;
    let queryData = null;
    if (options.form != null) {
        if (method === 'GET' || method === 'HEAD') {
            queryData = options.form;
        }
        else {
            body = typeof options.form === 'string' ? options.form : new URLSearchParams(options.form).toString();
            if (!('Content-Type' in headers) && !('content-type' in headers)) {
                headers['Content-Type'] = 'application/x-www-form-urlencoded';
            }
        }
    }
    else if (options.formData != null && method !== 'GET' && method !== 'HEAD') {
        const boundary = `----lxbridge${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
        const parts = [];
        for (const [key, field] of Object.entries(options.formData)) {
            if (field == null)
                continue;
            if (isDict(field)) {
                const value = field.value;
                const filename = readString(field.filename);
                const type = readString(field.type);
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"`
                    + (filename ? `; filename="${filename}"` : '') + '\r\n'));
                if (type)
                    parts.push(Buffer.from(`Content-Type: ${type}\r\n`));
                parts.push(Buffer.from('\r\n'));
                parts.push(toBuffer(value));
            }
            else {
                parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n`));
                parts.push(toBuffer(field));
            }
            parts.push(Buffer.from('\r\n'));
        }
        parts.push(Buffer.from(`--${boundary}--\r\n`));
        body = Buffer.concat(parts);
        headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
    }
    else if (options.formData != null) {
        queryData = options.formData;
    }
    let finalUrl = target;
    if (queryData != null) {
        const search = new URLSearchParams(queryData).toString();
        if (search)
            finalUrl = `${target}${target.includes('?') ? '&' : '?'}${search}`;
    }
    let cancelled = false;
    const controller = new AbortController();
    const timeout = Number(options.timeout) > 0 ? Math.min(Number(options.timeout), 60_000) : 60_000;
    const send = async () => {
        const response = await fetch(finalUrl, {
            method,
            headers,
            body: body == null || method === 'GET' || method === 'HEAD' ? undefined : body,
            redirect: 'manual',
            signal: controller.signal,
        });
        const raw = Buffer.from(await response.arrayBuffer());
        if (cancelled)
            return;
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });
        let text = raw.toString('utf8');
        try {
            text = JSON.parse(raw.toString('utf8'));
        }
        catch {
            // 不是 JSON 就按原文本给，与 needle 的行为一致
        }
        callback(null, {
            statusCode: response.status,
            statusMessage: response.statusText,
            headers: responseHeaders,
            bytes: raw.length,
            raw,
            body: text,
        }, text);
    };
    const fail = (error) => {
        if (cancelled)
            return;
        callback(describeError(error), null, null);
    };
    const timer = setTimeout(() => controller.abort(new Error(`请求超时（${timeout}ms）`)), timeout);
    void send().catch(fail).finally(() => clearTimeout(timer));
    return () => {
        cancelled = true;
        try {
            controller.abort();
        }
        catch {
            cancelled = true;
        }
    };
};
// 脚本传下来的值可能是 Buffer、字符串，也可能是数字之类：统一成 Buffer，别让 String() 把对象写成
// "[object Object]"。
const toBuffer = (value) => {
    if (Buffer.isBuffer(value))
        return value;
    if (value instanceof Uint8Array)
        return Buffer.from(value);
    if (typeof value === 'string')
        return Buffer.from(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
        return Buffer.from(String(value));
    if (value == null)
        return Buffer.alloc(0);
    try {
        const text = JSON.stringify(value);
        return Buffer.from(typeof text === 'string' ? text : '');
    }
    catch {
        return Buffer.alloc(0);
    }
};
const runZlib = (work, input) => new Promise((resolve, reject) => {
    work(toBuffer(input), (error, out) => (error ? reject(error) : resolve(out)));
});
const handlers = new Map();
const createLxApi = (info, onInited, onAlert) => ({
    version: '1.0.0',
    env: 'desktop',
    EVENT_NAMES,
    get currentScriptInfo() {
        return { ...info.current };
    },
    on(name, handler) {
        if (typeof name !== 'string' || typeof handler !== 'function')
            throw new TypeError('lx.on(name, handler) 参数不合法');
        handlers.set(name, handler);
    },
    send(name, datas) {
        if (name === EVENT_NAMES.inited)
            onInited(datas);
        else if (name === EVENT_NAMES.updateAlert)
            onAlert(datas);
    },
    request: (url, options, callback) => httpRequest(url, options, callback),
    utils: {
        buffer: {
            from: (input, encoding) => Buffer.from(input, encoding),
            bufToString: (buffer, format) => {
                const value = toBuffer(buffer);
                return format === 'hex' || format === 'base64' ? value.toString(format) : value.toString('utf8');
            },
        },
        crypto: {
            md5: (data) => createHash('md5').update(Buffer.isBuffer(data) ? data : String(data)).digest('hex'),
            randomBytes: (size) => randomBytes(size),
            aesEncrypt: (buffer, mode, key, iv) => {
                let algorithm = mode.toLowerCase();
                const noPadding = algorithm.includes('nopad');
                algorithm = algorithm.replace(/-?nopad/g, '');
                const cipher = createCipheriv(algorithm, key, /ecb/.test(algorithm) ? null : iv);
                cipher.setAutoPadding(!noPadding);
                return Buffer.concat([cipher.update(buffer), cipher.final()]);
            },
            rsaEncrypt: (buffer, key) => publicEncrypt({ key, padding: cryptoConstants.RSA_PKCS1_PADDING }, buffer),
        },
        zlib: {
            inflate: (input) => runZlib(inflate, input),
            deflate: (input) => runZlib(deflate, input),
        },
    },
});
let runtimePromise = null;
let runtimeFailedAt = 0;
// 脚本头部注释里的 @name / @version 等，与桌面版解析规则一致
const parseHeader = (code) => {
    const meta = { name: '', version: '', author: '', description: '', homepage: '' };
    const block = code.match(/\/\*[\s\S]*?\*\//);
    if (block) {
        for (const line of block[0].split('\n')) {
            const hit = line.match(/^\s*\*?\s*@(\w+)\s+(.+?)\s*$/);
            if (hit && hit[1] in meta)
                meta[hit[1]] = hit[2];
        }
    }
    return meta;
};
const loadRuntime = async () => {
    const code = await readEnvScript();
    if (code == null || !code.trim())
        return null;
    // 换脚本/重载时不能留着上一个脚本注册的处理器：清了再跑。
    handlers.clear();
    const runtime = { info: parseHeader(code), loaded: false, inited: null, initedWaiters: [] };
    const notifyInited = (datas) => {
        runtime.inited = isDict(datas) ? datas : {};
        const waiters = runtime.initedWaiters.splice(0);
        for (const wake of waiters)
            wake();
    };
    const lx = createLxApi({ current: runtime.info }, datas => {
        if (!isDict(datas) || datas.sources == null) {
            console.warn('[lx-source] 脚本发送的 inited 缺少 sources 字段，按空音源处理');
        }
        notifyInited(datas);
    }, datas => console.warn('[lx-source] 脚本 updateAlert', safeText(datas)));
    const sandbox = {
        console: {
            log: (...args) => console.log('[lx-source]', ...args.map(safeText)),
            debug: (...args) => console.debug('[lx-source]', ...args.map(safeText)),
            info: (...args) => console.info('[lx-source]', ...args.map(safeText)),
            warn: (...args) => console.warn('[lx-source]', ...args.map(safeText)),
            error: (...args) => console.error('[lx-source]', ...args.map(safeText)),
        },
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Buffer,
        TextEncoder,
        TextDecoder,
        URL,
        URLSearchParams,
        atob,
        btoa,
        lx,
    };
    const context = createContext(sandbox);
    // 同步部分 10s 上限：脚本在自己顶层死循环时不能把整个函数拖死（上限内还留给编译）
    runInContext(code, context, { filename: 'lx-source.js', timeout: 10_000 });
    runtime.loaded = true;
    return runtime;
};
// 脚本加载失败后 30 秒内不再重试：一个坏脚本不该让每次播放都重新编译一遍。
const getRuntime = () => {
    if (runtimePromise)
        return runtimePromise;
    if (Date.now() - runtimeFailedAt < RUNTIME_RETRY_MS)
        return Promise.resolve(null);
    runtimePromise = loadRuntime().catch((error) => {
        console.error('[lx-source] 脚本加载失败', error);
        runtimePromise = null;
        runtimeFailedAt = Date.now();
        return null;
    });
    return runtimePromise;
};
const waitForInited = async (runtime, ms = INITED_WAIT_MS) => {
    if (runtime.inited)
        return runtime.inited;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, ms);
        runtime.initedWaiters.push(() => {
            clearTimeout(timer);
            resolve();
        });
    });
    return runtime.inited;
};
// ---------------------------------------------------------------- 解析
const resolveCache = new Map();
const locationCache = new Map();
const sweepCaches = () => {
    const now = Date.now();
    for (const store of [resolveCache, locationCache]) {
        for (const [key, entry] of store) {
            if (now - entry.at > CACHE_TTL_MS)
                store.delete(key);
        }
        while (store.size > 256)
            store.delete(store.keys().next().value);
    }
};
// 缓存一条异步结果：同一个键并发来的时候共用同一个 Promise，失败的结果不留在表里。
const memo = (store, key, work) => {
    sweepCaches();
    const existing = store.get(key);
    if (existing)
        return existing.promise;
    const entry = { at: Date.now(), promise: work() };
    entry.promise.catch(() => {
        if (store.get(key) === entry)
            store.delete(key);
    });
    store.set(key, entry);
    return entry.promise;
};
const resolveMusicUrl = async (payload) => {
    const runtime = await getRuntime();
    if (!runtime)
        throw new Error('这份部署还没有配置 LX 源脚本（见 LX_SOURCE_SCRIPT / LX_SOURCE_SCRIPT_URL）');
    const source = LX_SOURCE_OF_PROVIDER[payload.provider];
    if (!source)
        throw new Error(`不接管平台 ${payload.provider}`);
    const inited = await waitForInited(runtime);
    const handler = handlers.get(EVENT_NAMES.request);
    if (!handler)
        throw new Error('脚本没有注册 request 处理器（脚本未运行或初始化失败）');
    const sources = isDict(inited?.sources) ? inited.sources : {};
    const conf = isDict(sources[source]) ? sources[source] : null;
    if (!conf) {
        const known = Object.keys(sources).join('、') || '无';
        throw new Error(`脚本未声明音源 ${source}（可用：${known}）`);
    }
    const actions = Array.isArray(conf.actions) ? conf.actions : [];
    if (actions.length > 0 && !actions.includes('musicUrl'))
        throw new Error(`音源 ${source} 不支持 musicUrl`);
    const want = QUALITY_MAP[payload.quality ?? ''] ?? (payload.quality ?? '320k');
    const level = pickQuality(conf.qualitys, want);
    const result = await withTimeout(Promise.resolve().then(() => handler({ source, action: 'musicUrl', info: { type: level, musicInfo: toMusicInfo(source, payload.song) } })), RESOLVE_TIMEOUT_MS, `脚本解析 ${source} ${level} 播放地址超时`);
    const raw = typeof result === 'string' ? result : (isDict(result) ? result.url : undefined);
    if (typeof raw !== 'string' || !/^https?:\/\//i.test(raw)) {
        throw new Error(`脚本返回的不是有效的 http(s) 地址：${safeText(raw)}`);
    }
    return { url: raw, quality: level };
};
const resolveCacheKey = (payload) => `${payload.provider}|${payload.song.id == null ? '' : String(payload.song.id)}|${payload.quality ?? ''}`;
const cachedResolve = (payload) => memo(resolveCache, resolveCacheKey(payload), () => resolveMusicUrl(payload).then(result => result.url));
// ---------------------------------------------------------------- 中转签名
//
// 中转地址里的目标由 HMAC 保护，签名不对就不转：这样它不会被当成开放代理用。密钥优先取
// LX_SOURCE_SIGNING_KEY；没配时用脚本内容派生（同一个部署的各个实例算出来一样，重启不失配）。
let signingKeyCache = null;
const signingKey = () => {
    if (signingKeyCache)
        return signingKeyCache;
    const configured = process.env.LX_SOURCE_SIGNING_KEY;
    if (typeof configured === 'string' && configured.length >= 8) {
        signingKeyCache = configured;
        return signingKeyCache;
    }
    const script = process.env.LX_SOURCE_SCRIPT ?? process.env.LX_SOURCE_SCRIPT_B64 ?? process.env.LX_SOURCE_SCRIPT_URL ?? '';
    signingKeyCache = createHash('sha256').update(`lx-source-bridge|${script}`).digest('hex');
    return signingKeyCache;
};
const signTarget = (target) => createHmac('sha256', signingKey()).update(target).digest('base64url').slice(0, 32);
const isSignedTarget = (target, signature) => {
    const expected = Buffer.from(signTarget(target));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
};
// 上游地址只认公网 http(s)：这个函数跑在云上，别让它变成打内网的口子。
// 本机调试（vercel dev + 上游在 127.0.0.1）要放行时，显式设 LX_SOURCE_ALLOW_PRIVATE=1。
const isPublicHttpUrl = (value) => {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return false;
    if (process.env.LX_SOURCE_ALLOW_PRIVATE === '1')
        return true;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))
        return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
        const [a, b] = host.split('.').map(Number);
        if (a === 10 || a === 127 || a === 0)
            return false;
        if (a === 169 && b === 254)
            return false;
        if (a === 172 && b >= 16 && b <= 31)
            return false;
        if (a === 192 && b === 168)
            return false;
    }
    if (host.startsWith('['))
        return false;
    return true;
};
// 探测终点地址，并看它给不给 CORS 头。folia 的播放器是 crossOrigin="anonymous" 的（歌词分析要读
// 音频数据），没有 CORS 头的地址在网页版上直接播不了 —— 这种就只能走本站中转。
const probeTarget = async (url, hops = 0) => {
    const response = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': BROWSER_UA, Range: 'bytes=0-1' },
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (hops < MAX_REDIRECTS && response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (location)
            return probeTarget(new URL(location, url).toString(), hops + 1);
    }
    const cors = Boolean(response.headers.get('access-control-allow-origin'));
    await response.body?.cancel();
    return { url: response.url || url, status: response.status, cors };
};
// 解析结果落地：https 且有 CORS 就直接 302 过去（不吃本站带宽），否则转成本站的中转地址。
const toPlayableLocation = async (rawUrl, origin) => {
    let probe = null;
    try {
        probe = await probeTarget(rawUrl);
    }
    catch (error) {
        console.warn('[lx-source] 播放地址探测失败，改走中转', error);
    }
    const reachable = probe !== null && probe.status >= 200 && probe.status < 300;
    const finalUrl = probe !== null && reachable ? probe.url : rawUrl;
    const forceProxy = process.env.LX_SOURCE_FORCE_PROXY === '1';
    if (!forceProxy && /^https:\/\//i.test(finalUrl) && probe !== null && probe.cors)
        return finalUrl;
    return `${origin}/api/lx-source?op=stream&u=${b64url(finalUrl)}&sig=${signTarget(finalUrl)}`;
};
// 落地结果单独缓存：探测过的终点与「直连还是中转」的决定都不必每次播放重算，否则每首歌都要多打
// 一次上游（既慢又容易被当成刷量）。键里带 origin：中转地址是绝对地址，换个接入域名就不能复用。
const cachedLocation = (payload, origin) => memo(locationCache, `${resolveCacheKey(payload)}|${origin}`, async () => toPlayableLocation(await cachedResolve(payload), origin));
// ---------------------------------------------------------------- 三个操作
const respondJson = (res, status, body) => {
    res.statusCode = status;
    for (const [key, value] of Object.entries(CORS_HEADERS))
        res.setHeader(key, value);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
};
const queryString = (req, key) => {
    const value = req.query?.[key];
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value) && typeof value[0] === 'string')
        return value[0];
    return null;
};
const headerString = (req, name) => {
    const value = req.headers[name];
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value) && typeof value[0] === 'string')
        return value[0];
    return null;
};
const handleStatus = async (res) => {
    if (process.env.LX_SOURCE_DISABLED === '1') {
        respondJson(res, 200, { configured: false, disabled: true, providers: [], sources: {} });
        return;
    }
    const runtime = await getRuntime();
    if (!runtime) {
        respondJson(res, 200, { configured: false, providers: [], sources: {} });
        return;
    }
    const inited = await waitForInited(runtime, 1_200);
    const declared = isDict(inited?.sources) ? inited.sources : {};
    const sources = {};
    for (const [id, conf] of Object.entries(declared)) {
        if (!isDict(conf))
            continue;
        const actions = Array.isArray(conf.actions) ? conf.actions : [];
        sources[id] = {
            name: readString(conf.name, id),
            qualitys: Array.isArray(conf.qualitys) ? conf.qualitys : [],
            musicUrl: actions.length === 0 || actions.includes('musicUrl'),
        };
    }
    const providers = Object.entries(LX_SOURCE_OF_PROVIDER)
        .filter(([, id]) => sources[id]?.musicUrl === true)
        .map(([provider]) => provider);
    respondJson(res, 200, {
        configured: true,
        providers,
        sources,
        script: runtime.info,
        loaded: Boolean(runtime.loaded && inited),
        mode: process.env.LX_SOURCE_FORCE_PROXY === '1' ? 'proxy' : 'auto',
        quality: process.env.LX_SOURCE_QUALITY ?? 'high',
    });
};
const parsePayload = (req) => {
    const encoded = queryString(req, 'p');
    if (!encoded)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(fromB64url(encoded));
    }
    catch {
        return null;
    }
    if (!isDict(parsed) || !isDict(parsed.song))
        return null;
    const provider = readString(parsed.provider);
    const id = parsed.song.id;
    if (!provider || (typeof id !== 'string' && typeof id !== 'number'))
        return null;
    return {
        provider,
        quality: typeof parsed.quality === 'string' ? parsed.quality : undefined,
        song: {
            id,
            title: readString(parsed.song.title),
            artist: readString(parsed.song.artist),
            album: readString(parsed.song.album),
            albumId: readString(parsed.song.albumId),
            mediaMid: readString(parsed.song.mediaMid),
        },
    };
};
const handleResolve = async (req, res) => {
    if (process.env.LX_SOURCE_DISABLED === '1') {
        respondJson(res, 503, { error: 'LX 音源桥已关闭' });
        return;
    }
    const payload = parsePayload(req);
    if (!payload) {
        respondJson(res, 400, { error: 'p 参数缺失或不是合法的 base64url JSON（需要 provider 与 song.id）' });
        return;
    }
    const proto = (headerString(req, 'x-forwarded-proto') ?? 'https').split(',')[0];
    const origin = `${proto}://${headerString(req, 'host') ?? 'localhost'}`;
    const resolved = { ...payload, quality: payload.quality ?? process.env.LX_SOURCE_QUALITY ?? 'high' };
    try {
        const location = await cachedLocation(resolved, origin);
        res.statusCode = 302;
        for (const [key, value] of Object.entries(CORS_HEADERS))
            res.setHeader(key, value);
        res.setHeader('Location', location);
        res.setHeader('Cache-Control', 'no-store');
        res.end();
    }
    catch (error) {
        console.error('[lx-source] 解析失败', error);
        respondJson(res, 502, { error: '解析播放地址失败', detail: describeError(error).message });
    }
};
const handleStream = async (req, res) => {
    const encoded = queryString(req, 'u');
    const signature = queryString(req, 'sig');
    if (!encoded || !signature) {
        respondJson(res, 400, { error: '缺少 u 或 sig 参数' });
        return;
    }
    let target;
    try {
        target = fromB64url(encoded);
    }
    catch {
        respondJson(res, 400, { error: 'u 参数不是合法的 base64url' });
        return;
    }
    if (!isSignedTarget(target, signature)) {
        respondJson(res, 403, { error: '签名不符' });
        return;
    }
    if (!isPublicHttpUrl(target)) {
        respondJson(res, 403, { error: '目标地址不合法' });
        return;
    }
    const headers = { 'User-Agent': BROWSER_UA };
    const range = headerString(req, 'range');
    if (range)
        headers.Range = range;
    let upstream;
    try {
        upstream = await fetch(target, { headers, redirect: 'follow' });
    }
    catch (error) {
        respondJson(res, 502, { error: '上游不可达', detail: describeError(error).message });
        return;
    }
    if (!upstream.ok) {
        const status = upstream.status;
        await upstream.body?.cancel();
        respondJson(res, 502, { error: `上游返回 HTTP ${status}` });
        return;
    }
    res.statusCode = upstream.status;
    for (const [key, value] of Object.entries(CORS_HEADERS))
        res.setHeader(key, value);
    for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name);
        if (value)
            res.setHeader(name, value);
    }
    if (!upstream.headers.get('content-type'))
        res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'HEAD' || !upstream.body) {
        res.end();
        return;
    }
    const body = Readable.fromWeb(upstream.body);
    res.on('close', () => body.destroy());
    body.on('error', (error) => {
        console.warn('[lx-source] 中转读取上游失败', error);
        try {
            res.destroy();
        }
        catch {
            res.end();
        }
    });
    body.pipe(res);
};
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        for (const [key, value] of Object.entries(CORS_HEADERS))
            res.setHeader(key, value);
        res.end();
        return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        respondJson(res, 405, { error: '只支持 GET / HEAD' });
        return;
    }
    const op = queryString(req, 'op') ?? 'status';
    try {
        if (op === 'status')
            await handleStatus(res);
        else if (op === 'resolve')
            await handleResolve(req, res);
        else if (op === 'stream')
            await handleStream(req, res);
        else
            respondJson(res, 400, { error: `未知的 op：${op}` });
    }
    catch (error) {
        console.error('[lx-source] 处理失败', error);
        respondJson(res, 500, { error: '内部错误', detail: describeError(error).message });
    }
}
