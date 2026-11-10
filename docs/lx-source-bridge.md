# 网页版接通 LX 自定义源脚本（Vercel）

桌面版的这条路走模组（[folia-lx-source-bridge](https://github.com/MuyuDada/folia-lx-source-bridge)：主进程跑脚本 +
本地回环代理）。网页版没有模组系统，于是同一件事拆成两半：

- `api/lx-source.js`（源文件 `api-ts/lx-source.ts`）：Vercel 函数。在 `node:vm` 里跑脚本、解析播放地址，
  必要时中转音频。
- `src/services/lxSourceBridge.ts`：客户端。把所有在线歌曲的取址入口（`omni.getAudioSource`）换成本函数的地址。

歌单、搜索、歌词仍然来自 Folia 内置音源；只有「播放地址」换脚本给的，这与洛雪里自定义源的语义一致。

## 打开它

脚本不进仓库（本项目不分发任何音源脚本），只从环境变量来。在 Vercel 项目里配**任意一个**：

| 变量 | 说明 |
| --- | --- |
| `LX_SOURCE_SCRIPT` | 脚本正文。多行文本，环境变量里直接粘贴 |
| `LX_SOURCE_SCRIPT_B64` | 脚本正文的 base64，优先于上面那个（适合换行被吃掉的场合） |
| `LX_SOURCE_SCRIPT_URL` | 一个 http(s) 地址，函数启动时拉取；实例内存里缓存 |

配好后重新部署即可生效（Vercel 的环境变量改动需要一次新的部署）。**没有配任何一个时，这个功能是关闭的**：客户端问一次状态，拿到 `configured: false`
就再也不会碰播放地址，也不会多发请求。

可选：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LX_SOURCE_SIGNING_KEY` | 由脚本内容派生 | 中转地址的 HMAC 密钥。公开仓库建议显式设一个随机串 |
| `LX_SOURCE_FORCE_PROXY` | 关 | `1` = 所有音频都走本站中转，不走 302 直连 |
| `LX_SOURCE_QUALITY` | `high` | 客户端没指定时的音质：`standard` / `high` / `lossless` / `hires` |
| `LX_SOURCE_ALLOW_PRIVATE` | 关 | `1` = 允许中转 127.0.0.1 等内网地址，仅供 `vercel dev` 本机调试 |
| `LX_SOURCE_DISABLED` | 关 | `1` = 临时关掉，不必删脚本 |

## 三个操作

```
GET /api/lx-source?op=status
GET /api/lx-source?op=resolve&p=<base64url 的 {provider, quality, song}>
GET /api/lx-source?op=stream&u=<base64url 目标>&sig=<HMAC>
```

- `status`：这份部署配好没有、脚本叫什么/什么版本、声明了哪些平台（客户端据此决定接管哪些歌）。
- `resolve`：跑脚本拿地址，然后 **302**。播放器跟过去，这一段不经过本站，也不吃流量。
- `stream`：带 `Range` 的音频中转，支持拖进度条，回 CORS 头。

### 直连还是中转

Folia 的播放器是 `crossOrigin="anonymous"` 的（歌词动画要读音频数据），所以目标地址必须带 CORS 头，
否则浏览器直接拒绝播放。`resolve` 因此先探一下终点（`Range: bytes=0-1`，不给正文）：

| 探测结果 | 302 到 |
| --- | --- |
| https 且带 CORS 头 | 上游地址本身（不占本站带宽） |
| https 但没有 CORS 头 | `/api/lx-source?op=stream&…`（本站中转） |
| http（混合内容，浏览器会拦） | 同上，中转 |
| 探不通或上游 4xx/5xx | 同上，中转一次试试 |

中转的目标由 HMAC 保护，签名不对直接 403，所以它不会被当成开放代理用；目标也不许是内网地址
（`LX_SOURCE_ALLOW_PRIVATE` 只为本机调试）。

## 开销与限制

- **解析缓存 10 分钟**（含探测结果），同一首歌在 10 分钟内重播不会再跑脚本，也不会再探上游。冷启动要
  重新拉脚本并执行一次，通常几百毫秒。
- **起播慢几秒**：第一次播一首歌要先跑脚本（多链路脚本更慢）。这与桌面版一致。
- **中转受函数时限与响应大小约束**：`maxDuration` 写的是 60 秒（Hobby 的上限；Pro 可调更高）；函数响应体
  还有平台的大小上限（流式响应按增量发出，但超长音频仍可能在中途被切断）。一首歌长于这个时限时，走中转的
  地址会断流；能直连的地址不受影响。长期跑中转请把 `LX_SOURCE_FORCE_PROXY` 关掉，或换成自带 CORS 头的源。
- **解析失败就是播放失败**：脚本解析不出来时 `resolve` 回 502，播放器报错，不会悄悄退回平台原来的地址
  （把平台地址塞进查询串会把它带着会话的签名地址写进日志）。要回退就关掉音源桥。
- **只有音源声明了 `musicUrl` 的平台会被接管**（网易云 / 酷狗 / QQ 三个对应 `wy` / `kg` / `tx`）。其他平台
  原样走内置音源。
- **不做独立音源**：网页版的音源切换器不属于这条链路，LX 只换地址。歌词仍来自内置音源（LX 脚本不给歌词）。
- 音质会自动降档到脚本声明里不高于请求档位的最近一档；脚本不支持的档位不会硬要。

## 自己验一下

```bash
curl -s "https://<你的域名>/api/lx-source?op=status" | jq
# {"configured":true,"providers":["netease","kugou","qq"], ... "script":{"name":"...","version":"..."}}
```

`configured: false` 就是环境变量没配到（或 `LX_SOURCE_DISABLED=1`）。`providers` 为空说明脚本跑起来了但
没声明这几个平台，看函数日志里的 `[lx-source]` 行。

## 免责

本项目不含、不分发任何音源脚本；导入脚本的内容与用途由使用者自行负责。这里只做播放地址解析，不下载、
不存储、不分发音频文件。平台条款与法律风险自担。
