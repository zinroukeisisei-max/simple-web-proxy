const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const INTERNAL_KEY = process.env.PROXY_KEY;

app.get("/", (req, res) => {
  res.send(`
    <h2>Simple Web Proxy</h2>
    <form action="/proxy">
      <input name="url" placeholder="https://example.com" size="50" required />
      <button>Open</button>
    </form>
  `);
});

function proxifyUrl(raw, baseUrl) {
  if (!raw) return null;
  if (
    raw.startsWith("javascript:") ||
    raw.startsWith("data:") ||
    raw.startsWith("#")
  ) return null;

  try {
    if (raw.startsWith("//")) {
      return new URL(baseUrl.protocol + raw).href;
    }
    return new URL(raw, baseUrl).href;
  } catch {
    return null;
  }
}

app.get("/proxy", async (req, res) => {
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
    const r = await fetch(url, {
      headers: {
        "user-agent": "simple-web-proxy",
        "accept": "*/*"
      }
    });

    const contentType = r.headers.get("content-type") || "";

    // ===== HTML =====
    if (contentType.includes("text/html")) {
      let html = await r.text();

      // 属性系（href/src/action/data-src など）
      html = html.replace(
        /(href|src|action|data-src|data-original)="([^"]*)"/gi,
        (m, attr, value) => {
          const abs = proxifyUrl(value, url);
          if (!abs) return m;
          return `${attr}="/proxy?url=${encodeURIComponent(abs)}"`;
        }
      );

      // srcset 対応
      html = html.replace(/srcset="([^"]*)"/gi, (m, value) => {
        const items = value.split(",").map(part => {
          const [u, size] = part.trim().split(/\s+/);
          const abs = proxifyUrl(u, url);
          return abs ? `/proxy?url=${encodeURIComponent(abs)}${size ? " " + size : ""}` : part;
        });
        return `srcset="${items.join(", ")}"`;
      });

      // baseタグ削除
      html = html.replace(/<base[^>]*>/gi, "");

      res.setHeader("content-type", contentType);
      return res.send(html);
    }

    // ===== 画像・CSS・JS =====
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (
        k !== "content-encoding" &&
        k !== "content-security-policy" &&
        k !== "x-frame-options"
      ) {
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
