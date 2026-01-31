// ===== imports（必ず一番上）=====
import express from "express";
import cors from "cors";
import dns from "dns/promises";
import ipaddr from "ipaddr.js";
import crypto from "crypto";
import LRU from "lru-cache";
import tough from "tough-cookie";
import expressWs from "express-ws";
import WebSocket from "ws";

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

// ===== Cookie 管理 =====
const cookieJar = new LRU({
  max: 100,
  ttl: 1000 * 60 * 30
});

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
  if (req.headers.origin && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    return res.status(403).send("forbidden");
  }
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

    if (ct.includes("text/html")) {
      let html = await response.text();
      html = html.replace(
        /(href|src|action)="([^"]*)"/gi,
        (m, a, v) => {
          try {
            const abs = new URL(v, url).href;
            return `${a}="/proxy?url=${encodeURIComponent(abs)}"`;
          } catch {
            return m;
          }
        }
      );
      res.setHeader("content-type", ct);
      return res.send(html);
    }

    res.status(response.status);
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() === "content-security-policy") return;
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

