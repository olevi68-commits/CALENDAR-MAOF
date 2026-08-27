// Serverless API route for the מעוף calendar.
// Reads/writes the whole calendar state (events + quotes) as one JSON blob
// in a Redis store (Upstash for Redis, connected via Vercel Storage).
//
// It auto-detects whichever REST URL/TOKEN env vars the Vercel <-> Upstash
// integration created (names vary depending on the store's prefix), so no
// manual env var renaming is needed after connecting the store.
//
// Optional: set EDIT_API_KEY in Vercel Project Settings -> Environment
// Variables to require a specific key for writes. If not set, it falls
// back to "MAOF" (the same password already used for admin login in the app).

const REDIS_KEY = "maof-calendar-state";

function findRedisConfig() {
  const env = process.env;
  const urlKey = Object.keys(env).find(function (k) {
    return /_URL$/i.test(k) && /redis|kv/i.test(k) && /^https?:\/\//i.test(env[k] || "");
  });
  if (!urlKey) return null;
  const tokenKey = urlKey.replace(/_URL$/i, "_TOKEN");
  const token = env[tokenKey];
  if (!token) return null;
  return { url: env[urlKey].replace(/\/+$/, ""), token: token };
}

async function redisGet(cfg, key) {
  const resp = await fetch(cfg.url + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + cfg.token },
  });
  if (!resp.ok) throw new Error("redis GET failed: " + resp.status);
  const json = await resp.json();
  return json.result;
}

async function redisSet(cfg, key, value) {
  const resp = await fetch(cfg.url + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + cfg.token,
      "Content-Type": "text/plain",
    },
    body: value,
  });
  if (!resp.ok) throw new Error("redis SET failed: " + resp.status);
  const json = await resp.json();
  return json.result;
}

module.exports = async function handler(req, res) {
  const cfg = findRedisConfig();
  if (!cfg) {
    res.status(500).json({
      ok: false,
      error:
        "לא נמצאו משתני סביבה של Redis. ודא שחיברת Upstash for Redis לפרויקט הזה ב-Vercel Storage (עם סביבת Production).",
    });
    return;
  }

  try {
    if (req.method === "GET") {
      const raw = await redisGet(cfg, REDIS_KEY);
      const data = raw ? JSON.parse(raw) : null;
      res.status(200).json({ ok: true, data: data });
      return;
    }

    if (req.method === "POST") {
      const editKey = process.env.EDIT_API_KEY || "MAOF";
      const provided = req.headers["x-edit-key"];
      if (provided !== editKey) {
        res.status(401).json({ ok: false, error: "מפתח עריכה שגוי" });
        return;
      }

      let body = req.body;
      if (typeof body === "string") {
        body = JSON.parse(body);
      } else if (!body) {
        // some runtimes don't auto-parse; read the raw stream as a fallback
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }

      if (!body || typeof body !== "object" || !body.events) {
        res.status(400).json({ ok: false, error: "מבנה נתונים לא תקין" });
        return;
      }

      await redisSet(cfg, REDIS_KEY, JSON.stringify(body));
      res.status(200).json({ ok: true });
      return;
    }

    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err && err.message) || "שגיאה לא צפויה" });
  }
};
