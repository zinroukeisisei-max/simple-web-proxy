const express = require("express");
const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h2>Simple Web Proxy</h2>
    <form action="/proxy">
      <input name="url" placeholder="https://example.com" required />
      <button>Open</button>
    </form>
  `);
});

app.get("/proxy", async (req, res) => {
  const target = req.query.url;
  if (!target) return res.send("url required");

  try {
    const r = await fetch(target);
    const body = await r.text();
    res.send(body);
  } catch {
    res.send("fetch error");
  }
});

app.listen(PORT, () => {
  console.log("proxy running");
});

