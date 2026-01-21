const express = require("express");
const app = express();

app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const INTERNAL_KEY = process.env.PROXY_KEY;

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

// ===== GET / POST 両対応 =====
app.all("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.send("url required");
  if (!INTERNAL_KEY) return res.status(500).send("proxy not configured");

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
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "accept": "*/*",
        "referer": url.origin
      }
    };

    if (req.method === "POST") {
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      options.body = new URLSearchParams(req.body);
    }

    const r = await fetch(url, options);
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
    console.error(err);
    res.status(500).send("fetch error");
  }
});

app.listen(PORT, () => {
  console.log("proxy running");
});
