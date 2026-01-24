import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: "*" }));
app.use(express.urlencoded({ extended: true }));

// ===== トップ =====
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
    if (raw.startsWith("//")) return base.protocol + raw;
    return new URL(raw, base).href;
  } catch {
    return null;
  }
}

// ===== User-Agent =====
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"
];

// ===== Proxy =====
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
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ja,en-US;q=0.9,en;q=0.8",
        "accept-encoding": "identity",
        "referer": url.href,
        "origin": url.origin,
        "host": url.host
      },
      credentials: "include" // ★重要
    };

    if (req.method === "POST") {
      options.headers["content-type"] = "application/x-www-form-urlencoded";
      options.body = new URLSearchParams(req.body).toString(); // ★重要
    }

    const r = await fetch(url.href, options);
    const contentType = r.headers.get("content-type") || "";

    // ===== リダイレクト処理（超重要） =====
    const location = r.headers.get("location");
    if (location) {
      const abs = resolveUrl(location, url);
      if (abs) {
        res.setHeader("location", "/proxy?url=" + encodeURIComponent(abs));
      }
    }

    // ===== Set-Cookie =====
    const cookies = r.headers.raw()["set-cookie"];
    if (cookies) {
      res.setHeader(
        "set-cookie",
        cookies.map(c =>
          c
            .replace(/Domain=[^;]+;/i, "")
            .replace(/Secure;/i, "")
            .replace(/SameSite=None;/i, "")
        )
      );
    }

    // ===== HTML =====
    if (contentType.includes("text/html")) {
      let html = await r.text();

      html = html.replace(/<base[^>]*>/gi, "");
      html = html.replace(/loading="lazy"/gi, "");
      html = html.replace(/<noscript>([\s\S]*?)<\/noscript>/gi, "$1");

      html = html.replace(
        /(href|src|action|data-src|data-original)="([^"]*)"/gi,
        (m, attr, value) => {
          const abs = resolveUrl(value, url);
          return abs
            ? `${attr}="/proxy?url=${encodeURIComponent(abs)}"`
            : m;
        }
      );

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

      html = html.replace(
        /url\((['"]?)(.*?)\1\)/gi,
        (m, q, value) => {
          const abs = resolveUrl(value, url);
          return abs
            ? `url("/proxy?url=${encodeURIComponent(abs)}")`
            : m;
        }
      );

      // Cookie Clicker 保険
      html = html.replace(
        /https:\/\/orteil\.dashnet\.org/gi,
        "/proxy?url=https://orteil.dashnet.org"
      );

      res.removeHeader("content-security-policy");
      res.setHeader(
        "content-security-policy",
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;"
      );

      res.setHeader("content-type", contentType);
      return res.send(html);
    }

    // ===== その他 =====
    res.status(r.status);
    r.headers.forEach((v, k) => {
      if (!["content-encoding", "content-security-policy", "x-frame-options"].includes(k)) {
        res.setHeader(k, v);
      }
    });

    res.send(Buffer.from(await r.arrayBuffer()));

  } catch (err) {
    console.error("FETCH ERROR:", err);
    res.status(500).send("fetch error");
  }
});

app.listen(PORT, () => {
  console.log("proxy running on port " + PORT);
});
