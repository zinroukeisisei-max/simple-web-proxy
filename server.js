app.get("/", (req, res) => {
    res.type("html").send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Simple Web Proxy</title>
</head>
<body>
  <h1>Simple Web Proxy</h1>
  <form action="/proxy" method="get">
    <input
      name="url"
      placeholder="https://example.com"
      style="width:300px"
      required
    />
    <button type="submit">Go</button>
  </form>
</body>
</html>
`);
});

import express from "express";
import cors from "cors";
import dns from "dns/promises";
import ipaddr from "ipaddr.js";
import crypto from "crypto"; // cryptoをインポート
import LRU from "lru-cache"; // LRUキャッシュをインポート
import tough from "tough-cookie"; // tough-cookieをインポート
import expressWs from "express-ws"; // WebSocket用
import WebSocket from "ws"; // WebSocketをインポート

const app = express();
const PORT = process.env.PORT || 3000;

// ALLOWED_ORIGINSの定義
const ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://simple-web-proxy-5kvu.onrender.com"
];

// CORS設定の統一
app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true
}));

expressWs(app);

// Cookie管理用のLRUキャッシュ
const cookieJar = new LRU({
    max: 100, // 最大数
    ttl: 1000 * 60 * 30 // 30分のTTL
});

// proxy_sidを発行または取得する関数
function getOrCreateProxySid(req, res) {
    const m = (req.headers.cookie || "").match(/proxy_sid=([a-f0-9]+)/);
    if (m) return m[1];

    const sid = crypto.randomBytes(16).toString("hex");
    res.setHeader(
        "Set-Cookie",
        `proxy_sid=${sid}; HttpOnly; Path=/; SameSite=Lax`
    );
    return sid;
}

// プライベートIPチェック関数
const isPrivate172 = (addr) => {
    const parts = addr.split(".").map(Number);
    return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
};

// IPv6プライベートアドレスチェック関数
const isPrivateIPv6 = (addr) => {
    try {
        const ip = ipaddr.parse(addr);
        return ["loopback", "linkLocal", "uniqueLocal", "unspecified"].includes(ip.range());
    } catch {
        return true; // DoS対策としてOK
    }
};

// IPブロックチェック関数
function isBlockedIP(address) {
    return (
        address.startsWith("127.") ||
        address.startsWith("10.") ||
        address.startsWith("192.168.") ||
        isPrivate172(address) ||
        isPrivateIPv6(address)
    );
}

// raw bodyを取得するミドルウェア
app.use((req, res, next) => {
    let data = [];
    req.on("data", chunk => data.push(chunk));
    req.on("end", () => {
        req.rawBody = Buffer.concat(data);
        next();
    });
});

// URL検証関数
async function validateTarget(raw) {
    if (!raw) throw new Error("Invalid URL");
    if (raw.startsWith("javascript:") || raw.startsWith("data:") || raw.startsWith("#")) {
        throw new Error("Blocked URL");
    }
    return new URL(raw);
}

// URL解決関数
async function resolveRedirect(url) {
    const results = await dns.lookup(url.hostname, { all: true });

    // ブロックされていないIPを見つける
    const record = results.find(r => !isBlockedIP(r.address));
    if (!record) throw new Error("Blocked IP");

    return {
        ip: record.address,
        protocol: url.protocol,
        host: url.hostname,
        path: url.pathname + url.search
    };
}

// プロキシ処理
app.all("/proxy", async (req, res, next) => {
    // Originチェック
    if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
        return res.status(403).send("forbidden");
    }
    next();
}, async (req, res) => {
    const target = req.query.url;
    const proxySid = getOrCreateProxySid(req, res); // proxy_sidを取得または発行
    try {
        const url = await validateTarget(target);
        const { host } = await resolveRedirect(url); // IPはSSRFチェック目的で呼ぶだけ

        let fetchUrl = url.href; // fetchはhostnameのままにする

        const jarKey = proxySid + ":" + host; // 統一されたキーを使用
        const options = {
            method: req.method,
            headers: (() => {
                const h = {};
                for (const [k, v] of Object.entries(req.headers)) { 
                    if (!["host", "content-length"].includes(k)) {
                        h[k] = v;
                    }
                }
                return h;
            })(), // ヘッダーを安全に取得
        };

        // 本物のCookieのみを送信
        const jar = cookieJar.get(jarKey);
        if (jar) {
            options.headers.cookie = await jar.getCookieString(url.href); // Cookie文字列を取得
        }

        // 修正: req.bodyをそのまま突っ込むのは壊れる
        if (req.method !== "GET" && req.method !== "HEAD") {
            options.body = req.rawBody; // rawBodyを使用
        }

        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 15000); // 15秒タイムアウト

        let response;
        let redirectCount = 0;
        do {
            response = await globalThis.fetch(fetchUrl, {
                ...options,
                signal: controller.signal,
                redirect: "manual" // 手動リダイレクト
            });

            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get("location");
                if (!location) break;

                const nextUrl = new URL(location, url);
                await resolveRedirect(nextUrl); // SSRFチェック目的で呼ぶだけ
                fetchUrl = nextUrl.href; // fetchはhostnameのままにする
                options.headers.host = nextUrl.hostname; // Hostを更新
            }
            redirectCount++;
            if (redirectCount > 5) {
                throw new Error("Too many redirects");
            }
        } while (response.status >= 300 && response.status < 400);

        clearTimeout(t); // タイムアウトをクリアする

        const contentType = response.headers.get("content-type") || "";
        const cookies = response.headers.getSetCookie?.() || []; // 修正: response.headers.raw() -> response.headers.getSetCookie

        if (cookies.length) {
            const prev = cookieJar.get(jarKey) || new tough.CookieJar(); // tough-cookieインスタンスを取得
            await Promise.all(
                cookies.map(c => prev.setCookie(c, `${url.protocol}//${host}/`)) // 修正: pathを含めない
            );
            cookieJar.set(jarKey, prev); // tough-cookieインスタンスを保存
        }

        if (contentType.includes("text/html")) {
            let html = await response.text();

            // HTMLの書き換え処理を追加
            html = html.replace(
                /(href|src|action)="([^"]*)"/gi,
                (m, attr, value) => {
                    try {
                        const abs = new URL(value, url).href;
                        return `${attr}="/proxy?url=${encodeURIComponent(abs)}"`;
                    } catch {
                        return m;
                    }
                }
            );

            res.setHeader("content-type", contentType);
            return res.send(html);
        } else if (/javascript|ecmascript/i.test(contentType)) {
            let js = await response.text();
            res.setHeader("content-type", contentType);
            return res.send(js); // transformJSを削除
        }

        res.status(response.status);
        response.headers.forEach((v, k) => {
            if (k.toLowerCase() === "content-security-policy") return; // CSPは無視
            res.setHeader(k, v);
        });

        res.send(Buffer.from(await response.arrayBuffer()));

    } catch (err) {
        console.error("FETCH ERROR:", err);
        res.status(500).send("fetch error");
    }
});

// WebSocketのサポート
app.ws('/ws', async (ws, req) => {
    const targetUrl = req.query.url;
    if (!targetUrl || !/^wss?:\/\//.test(targetUrl)) {
        ws.close(1008, "Policy violation"); // Closeコードと理由を指定
        return;
    }

    // SSRF対策
    const results = await dns.lookup(new URL(targetUrl).hostname, { all: true });
    const addresses = results.map(r => r.address);

    for (const address of addresses) {
        if (isBlockedIP(address)) { // 共通関数を使用
            ws.close(1008, "Policy violation"); // Closeコードと理由を指定
            return;
        }
    }

    // Origin検証
    const origin = req.headers.origin; // 動的に使用
    if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
        ws.close(1008, "Policy violation"); // Closeコードと理由を指定
        return;
    }

    const m = (req.headers.cookie || "").match(/proxy_sid=([a-f0-9]+)/);
    const sid = m?.[1];
    const jarKey = sid ? sid + ":" + new URL(targetUrl).hostname : null; // 統一されたキーを使用
    const jar = jarKey ? cookieJar.get(jarKey) : null;
    const cookie = jar ? await jar.getCookieString(targetUrl) : ""; // Cookieを文字列形式で取得

    // DNS lookupで得たIPを使用してWebSocket接続
    const target = new URL(targetUrl);
    const proto = target.protocol === "wss:" ? "wss" : "ws"; // 修正: プロトコルを保持
    const targetWebSocket = new WebSocket(
        target.href.replace(/^http/, "ws"), // IPではなくホスト名を使用
        {
            headers: {
                Origin: origin, // 必要に応じて固定Originに変更
                Cookie: cookie || "" // Cookieを渡す
            }
        }
    );

    targetWebSocket.on('message', (message) => {
        ws.send(message);
    });

    targetWebSocket.on('error', () => ws.close(1002, "Protocol error")); // エラーハンドリング
    ws.on('error', () => targetWebSocket.close(1002, "Protocol error")); // エラーハンドリング

    ws.on('close', () => {
        targetWebSocket.close(1002, "Protocol error");
    });
});

app.listen(PORT, () => {
    console.log("Proxy running on port " + PORT);
});
