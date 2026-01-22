import express from 'express';
import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';
import cors from 'cors';

const app = express();
const fetchWithCookie = fetchCookie(fetch); // fetch-cookieを使用

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

// ===== トップページ =====
app.get("/", (req, res) => {
  res.send(`
    <h2>Simple Web Proxy</h2>
    <form action="/proxy" method="GET">
      <input name="url" placeholder="https://example.com" size="60" required />
      <button>Open</button>
    </form>
  `);
});

// ===== URL解決 =====
function resolveUrl(raw, base) {
  if (!raw) return null;
  if (
    raw.startsWith("javascript:") ||
    raw.startsWith("data:") ||
    raw.startsWith("#")
  ) return null;

  try {
    if (raw.startsWith("//")) {
      return base.protocol + raw;
    }
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

// User-Agentのリスト
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/89.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0.3 Safari/605.1.15"
];

// ===== GET / POST 両対応 =====
app.all("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.send("url required");

  let url;
  try {
    url = new URL(target);
  } catch {
    return res.send("invalid url");
  }

  try {
    const options = {
      method: req.method,
      headers: {
        "user-agent": userAgents[Math.floor(Math.random() * userAgents.length)],
        "accept": "*/*",
        "referer": url.origin,
        "x-requested-with": "XMLHttpRequest"
      },
      credentials: 'include' // クッキーを含める
    };

    if (req.method === "POST") {
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      options.body = new URLSearchParams(req.body);
    }

    // fetchを直接使用
    const r = await fetchWithCookie(url, options); // fetchWithCookieを使用
    const contentType = r.headers.get("content-type") || "";

    // ===== HTML =====
    if (contentType.includes("text/html")) {
      let html = await r.text();

      // base タグ除去
      html = html.replace(/<base[^>]*>/gi, "");

      // lazy 読み込み対策
      html = html.replace(/loading="lazy"/gi, "");
      html = html.replace(/<noscript>([\s\S]*?)<\/noscript>/gi, "$1");

      // href / src / action / data-src 等
      html = html.replace(
        /(href|src|action|data-src|data-original)="([^"]*)"/gi,
        (m, attr, value) => {
          const abs = resolveUrl(value, url);
          return abs
            ? `${attr}="/proxy?url=${encodeURIComponent(abs)}"`
            : m;
        }
      );

      // srcset
      html = html.replace(/srcset="([^"]*)"/gi, (m, value) => {
        const items = value.split(",").map(part => {
          const [u, size] = part.trim().split(/\s+/);
          const abs = resolveUrl(u, url);
          return abs
            ? `/proxy?url=${encodeURIComponent(abs)}${size ? " " + size : ""}`
            : part;
        });
        return `srcset="${items.join(", ")}"`;
      });

      // CSS url()
      html = html.replace(
        /url\((['"]?)(.*?)\1\)/gi,
        (m, q, value) => {
          const abs = resolveUrl(value, url);
          return abs
            ? `url("/proxy?url=${encodeURIComponent(abs)}")`
            : m;
        }
      );

      // CSP（JS許可）
      res.setHeader(
        "content-security-policy",
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
      );

      res.setHeader("content-type", contentType);
      return res.send(html);
    }

    // ===== 画像・CSS・JS =====
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (!["content-encoding", "content-security-policy", "x-frame-options"].includes(k)) {
        res.setHeader(k, v);
      }
    });

    const buffer = Buffer.from(await r.arrayBuffer());
    res.send(buffer);

  } catch (err) {
    console.error("Error occurred during fetch:", err); // 詳細なエラーをログに出力
    res.status(500).send("fetch error: " + (err.message || JSON.stringify(err))); // エラー内容をJSON形式で返す
  }
});

app.listen(PORT, () => {
  console.log("proxy running on port " + PORT);
});
