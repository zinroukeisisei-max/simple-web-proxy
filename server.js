// ===== imports（必ず一番上）=====
import express from "express";
import cors from "cors";
import dns from "dns/promises";
import ipaddr from "ipaddr.js";
import crypto from "crypto";
import { LRUCache } from "lru-cache"; // 修正: LRUCacheをインポート
import tough from "tough-cookie";
import expressWs from "express-ws";
import WebSocket from "ws";
// import fetch from "node-fetch"; // Node 18+ なら不要なので削除

// ===== app 基本設定 =====
const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "https://simple-web-proxy-5kvu.onrender.com"
];

expressWs(app);

app.use(cors({
  origin: ALLOWED_ORIGINS,
  credentials: true
}));

// ===== トップページ（入力フォーム）=====
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
  <form onsubmit="event.preventDefault(); location.href='/p/'+encodeURIComponent(url.value)">
    <input id="url" placeholder="https://example.com" required />
    <button>Go</button>
  </form>
</body>
</html>
`);
});

// ===== path型 proxy =====
app.all("/p/*", (req, res, next) => {
  req.url = "/proxy"; // 明示的に/proxyに転送
  req.query = { url: decodeURIComponent(req.params[0]) };
  next();
});

// ===== Cookie 管理 =====
const cookieJar = new LRUCache({ // 修正: LRUCacheを使用
  max: 100,
  ttl: 1000 * 60 * 30
});

function getOrCreateProxySid(req, res) {
  const m = (req.headers.cookie || "").match(/proxy_sid=([a-f0-9]+)/);
  if (m) return m[1];

  const sid = crypto.randomBytes(16).toString("hex");
  res.setHeader(
    "Set-Cookie",
    `proxy_sid=${sid}; HttpOnly; Path=/; SameSite=None; Secure`
  );
  return sid;
}

// ===== IP ブロック系 =====
const isPrivate172 = (addr) => {
  const p = addr.split(".").map(Number);
  return p[0] === 172 && p[1] >= 16 && p[1] <= 31;
};

const isPrivateIPv6 = (addr) => {
  try {
    const ip = ipaddr.parse(addr);
    return ["loopback", "linkLocal", "uniqueLocal", "unspecified"].includes(ip.range());
  } catch {
    return true;
  }
};

function isBlockedIP(address) {
  return (
    address.startsWith("127.") ||
    address.startsWith("10.") ||
    address.startsWith("192.168.") ||
    isPrivate172(address) ||
    isPrivateIPv6(address)
  );
}

// ===== raw body =====
app.use((req, res, next) => {
  const data = [];
  req.on("data", c => data.push(c));
  req.on("end", () => {
    req.rawBody = Buffer.concat(data);
    next();
  });
});

// ===== URL 検証 =====
async function validateTarget(raw) {
  if (!raw) throw new Error("Invalid URL");
  if (/^(javascript:|data:|#)/i.test(raw)) {
    throw new Error("Blocked URL");
  }
  return new URL(raw);
}

async function resolveRedirect(url) {
  const results = await dns.lookup(url.hostname, { all: true });
  const record = results.find(r => !isBlockedIP(r.address));
  if (!record) throw new Error("Blocked IP");
  return record.address;
}

// ===== proxy 本体 =====
app.all("/proxy", async (req, res, next) => {
  next();
}, async (req, res) => {
  try {
    const target = req.query.url;
    const proxySid = getOrCreateProxySid(req, res);

    const url = await validateTarget(target);
    await resolveRedirect(url);

    let fetchUrl = url.href;
    const jarKey = `${proxySid}:${url.hostname}`;

    const options = {
      method: req.method,
      headers: {}
    };

    for (const [k, v] of Object.entries(req.headers)) {
      if (!["host", "content-length"].includes(k)) {
        options.headers[k] = v;
      }
    }

    const jar = cookieJar.get(jarKey);
    if (jar) {
      options.headers.cookie = await jar.getCookieString(fetchUrl);
    }

    if (!["GET", "HEAD"].includes(req.method)) {
      options.body = req.rawBody;
    }

    let response;
    let redirects = 0;

    do {
      response = await fetch(fetchUrl, {
        ...options,
        redirect: "manual"
      });

      if (response.status >= 300 && response.status < 400) {
        const loc = response.headers.get("location");
        if (!loc) break;
        const nextUrl = new URL(loc, fetchUrl);
        await resolveRedirect(nextUrl);
        fetchUrl = nextUrl.href;
        redirects++;
      }
    } while (redirects < 5 && response.status >= 300 && response.status < 400);

    const cookies = response.headers.getSetCookie?.() || [];
    if (cookies.length) {
      const prev = cookieJar.get(jarKey) || new tough.CookieJar();
      await Promise.all(
        cookies.map(c => prev.setCookie(c, `${url.protocol}//${url.host}/`))
      );
      cookieJar.set(jarKey, prev);
    }

    const ct = response.headers.get("content-type") || "";

    // ===== HTML 書き換え =====
    if (ct.includes("text/html")) {
      let html = await response.text();

      // <base>タグの追加（Pixiv/Pinterestでは条件付き）
      if (!/pixiv\.net|pinterest\.com/.test(url.hostname)) {
        html = html.replace(/<head>/, `<head><base href="${url.origin}/">`);
      }

      // 書き換え対象の要素を追加
      html = html.replace(
        /(href|src|action|srcset)="([^"]*)"/gi,
        (m, a, v) => {
          try {
            const abs = new URL(v, url).href;
            return `${a}="/p/${encodeURIComponent(abs)}"`; // URLの渡し方を変更
          } catch {
            return m;
          }
        }
      );

      // JavaScript内のfetchやWebSocketの書き換え
      html = html.replace(/fetch\("([^"]*)"/g, (m, v) => {
        const abs = new URL(v, url).href;
        return `fetch("/p/${encodeURIComponent(abs)}")`; // URLの渡し方を変更
      });
      
      html = html.replace(/new WebSocket\("([^"]*)"/g, (m, v) => {
        const abs = new URL(v, url).href;
        return `new WebSocket("/ws?url=${encodeURIComponent(abs)}")`;
      });

      // meta refreshの書き換え
      html = html.replace(/<meta http-equiv="refresh" content="([^"]*)"/gi, (m, v) => {
        const parts = v.split(";");
        const urlMatch = parts[1]?.match(/url=(.*)/);
        if (urlMatch) {
          const abs = new URL(urlMatch[1], url).href;
          return `<meta http-equiv="refresh" content="${parts[0]};url=/p/${encodeURIComponent(abs)}"`;
        }
        return m;
      });

      res.setHeader("content-type", ct);
      return res.send(html);
    }

    res.status(response.status);
    
    // ===== ヘッダーの設定 =====
    const BLOCK_HEADERS = [
      "content-security-policy",
      "content-security-policy-report-only",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy"
    ];

    response.headers.forEach((v, k) => {
      if (BLOCK_HEADERS.includes(k.toLowerCase())) return;
      res.setHeader(k, v);
    });

    res.send(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.status(500).send("fetch error");
  }
});

// ===== WebSocket proxy =====
app.ws("/ws", async (ws, req) => {
  try {
    const targetUrl = req.query.url;
    if (!targetUrl || !/^wss?:\/\//.test(targetUrl)) {
      ws.close(1008);
      return;
    }

    const u = new URL(targetUrl);
    const results = await dns.lookup(u.hostname, { all: true });
    if (results.some(r => isBlockedIP(r.address))) {
      ws.close(1008);
      return;
    }

    const m = (req.headers.cookie || "").match(/proxy_sid=([a-f0-9]+)/);
    const sid = m?.[1];
    const jar = sid ? cookieJar.get(`${sid}:${u.hostname}`) : null;
    const cookie = jar ? await jar.getCookieString(targetUrl) : "";

    const targetWs = new WebSocket(targetUrl, {
      headers: {
        Origin: req.headers.origin,
        Cookie: cookie
      }
    });

    targetWs.on("message", d => ws.send(d));
    ws.on("message", d => targetWs.send(d));

    targetWs.on("close", () => ws.close());
    ws.on("close", () => targetWs.close());
  } catch {
    ws.close(1011);
  }
});

// ===== listen =====
app.listen(PORT, () => {
  console.log("Proxy running on port " + PORT);
});

