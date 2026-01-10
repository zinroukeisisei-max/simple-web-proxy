const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;
const PROXY_KEY = process.env.PROXY_KEY || "local";

app.get("/", (req, res) => {
  res.send(`
    <h2>Simple Web Proxy</h2>
    <form action="/proxy">
      <input name="url" placeholder="https://example.com" size="50" required />
      <input name="key" placeholder="key" required />
      <button>Open</button>
    </form>
  `);
});

app.get("/proxy", async (req, res) => {
  const { url: target, key } = req.query;

  if (!target) return res.send("url required");
  if (key !== PROXY_KEY) return res.status(403).send("forbidden");

  let url;
  try {
    url = new URL(target);
  } catch {
    return res.send("invalid url");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    return res.send("invalid protocol");
  }

  try {
    const r = await fetch(url, {
      headers: {
        "user-agent": "simple-web-proxy",
        "accept": "*/*"
      }
    });

    const contentType = r.headers.get("content-type") || "";

    // ---- HTMLの場合：書き換え ----
    if (contentType.includes("text/html")) {
      let html = await r.text();
      const base = url.origin;

      // href / src / action を全部プロキシ経由に
      html = html.replace(
        /(href|src|action)="(.*?)"/gi,
        (match, attr, value) => {
          if (
            value.startsWith("http") ||
            value.startsWith("/") ||
            value.startsWith("./")
          ) {
            try {
              const absolute = new URL(value, url).href;
              return `${attr}="/proxy?url=${encodeURIComponent(
                absolute
              )}&key=${key}"`;
            } catch {
              return match;
            }
          }
          return match;
        }
      );

      // <base> タグ破壊対策
      html = html.replace(/<base[^>]*>/gi, "");

      res.setHeader("content-type", contentType);
      return res.send(html);
    }

    // ---- HTML以外（画像・CSS・JS） ----
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
