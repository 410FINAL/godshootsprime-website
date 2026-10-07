/* Client portal API (Vercel serverless function).

   Everything private lives in the PORTAL Backblaze bucket:
     data/settings.json                         site text and options
     data/clients/<folder>.json                 one record per client or event
     data/contracts/<folder>/<id>.json          contracts (+ <id>.signed marker once signed)
     data/messages/<folder>/<time>-<from>-<id>.json
     photos/<folder>/<proofs|finals|downloads>/<file>      originals
     photos/<folder>/<section>/_t/<file>.jpg    900px preview, _v/ 2000px view (made at upload)

   The browser never sees Backblaze keys. It gets short-lived signed links,
   and every rule (passwords, Google sign-in, download limits, the download
   timer, who can see what) is checked here. */
import { PutBucketCorsCommand } from "@aws-sdk/client-s3";
import {
  portalBucket, makeBucket, signToken, readToken, sameSecret, uid, HttpError, send, readBody
} from "./_lib.js";

const env = process.env;
const SECTIONS = ["proofs", "finals", "downloads"];
const DAY = 864e5;
const IMAGE = /\.(jpe?g|png|webp|gif|heic|tiff?)$/i;

/* Fields the photographer edits; everything else on a client record is managed here. */
const ADMIN_FIELDS = ["name", "password", "shoot", "location", "date", "pick", "downloadLimit", "downloadDays",
  "timer", "shareToken", "text", "emails", "firstLogin", "downloaded", "selection", "picks"];

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST");
    const b = portalBucket();
    const body = await readBody(req);
    if (body.action === "ping") return send(res, 200, { ok: true, ready: !!b, google: env.GOOGLE_CLIENT_ID || "" });
    if (!b) throw new HttpError(503, "Storage isn't connected yet. Add the Backblaze settings in Vercel.");
    const who = readToken(req.headers.authorization);
    const fn = ACTIONS[body.action];
    if (!fn) throw new HttpError(400, "Unknown action");
    const out = await fn({ b, body, who, req });
    send(res, 200, out === undefined ? { ok: true } : out);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send(res, e.status || 500, { error: e instanceof HttpError ? e.message : "Something went wrong. Try again." });
  }
}

/* ---------- Access checks ---------- */
function admin(who) { if (!who || who.role !== "admin") throw new HttpError(401, "Please sign in again."); }
/* The signed-in client (or guest on a share link) may only touch their own folder; the admin may touch any. */
function access(who, folder) {
  if (!who) throw new HttpError(401, "Please sign in again.");
  if (who.role === "admin") return "admin";
  if ((who.role === "client" || who.role === "guest") && who.id === folder) return who.role;
  throw new HttpError(403, "This gallery belongs to someone else.");
}
function folderOk(id) { if (!/^[a-z0-9-]{1,80}$/.test(id || "")) throw new HttpError(400, "Bad folder"); return id; }

/* ---------- Records ---------- */
const clientKey = id => `data/clients/${id}.json`;
async function getClient(b, id) {
  const c = await b.getJSON(clientKey(folderOk(id)));
  if (!c) throw new HttpError(404, "That gallery no longer exists.");
  return c;
}
async function allClients(b) {
  const { keys } = await b.list("data/clients/");
  const out = await Promise.all(keys.filter(k => k.key.endsWith(".json")).map(k => b.getJSON(k.key)));
  return out.filter(Boolean);
}
/* What a client or guest is allowed to see about their own folder. */
function forClient(c, role) {
  const keep = ["id", "name", "shoot", "location", "date", "pick", "downloadLimit", "timer", "downloadDays",
    "text", "firstLogin", "createdAt"];
  const o = {};
  keep.forEach(k => { o[k] = c[k]; });
  if (role === "client") {
    o.picks = c.picks || []; o.selection = c.selection || null; o.downloaded = c.downloaded || [];
    o.password = c.password; // they signed in with it, or need it as a backup
  } else { o.picks = []; o.selection = null; o.downloaded = []; }
  return o;
}
function windowOf(c, settings) {
  const days = c.downloadDays || settings.downloadDays || 14;
  if (c.timer === false || !c.firstLogin) return { open: true };
  return { open: Date.now() < c.firstLogin + days * DAY };
}
async function settingsOf(b) { return (await b.getJSON("data/settings.json")) || {}; }
function slug(s) { return String(s || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "client"; }

async function startSession(b, c, role) {
  if (role === "client" && !c.firstLogin) { c.firstLogin = Date.now(); await b.putJSON(clientKey(c.id), c); }
  return { token: signToken({ role, id: c.id }, 12), client: forClient(c, role) };
}
const pause = () => new Promise(r => setTimeout(r, 500));

/* ---------- Google sign-in: check the ID token with Google, then match the email to folders ---------- */
async function googleEmail(credential) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(400, "Google sign-in isn't set up yet.");
  const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential || ""));
  const t = r.ok ? await r.json() : null;
  if (!t || t.aud !== env.GOOGLE_CLIENT_ID || String(t.email_verified) !== "true" || +t.exp * 1000 < Date.now()) {
    throw new HttpError(401, "Google sign-in didn't go through. Try again.");
  }
  return String(t.email).toLowerCase();
}

/* ---------- Photos ---------- */
function photoKeyOk(folder, key) {
  const m = new RegExp(`^photos/${folder}/(proofs|finals|downloads)/([^/]+)$`).exec(key || "");
  if (!m) throw new HttpError(400, "Bad photo");
  return { section: m[1], name: m[2] };
}
async function listPhotos(b, folder, sections) {
  const { keys } = await b.list(`photos/${folder}/`);
  const have = new Set(keys.map(k => k.key));
  const out = [];
  for (const k of keys) {
    const m = /^photos\/[^/]+\/(proofs|finals|downloads)\/([^/]+)$/.exec(k.key);
    if (!m || !sections.includes(m[1]) || !IMAGE.test(m[2])) continue;
    const t = `photos/${folder}/${m[1]}/_t/${m[2]}.jpg`, v = `photos/${folder}/${m[1]}/_v/${m[2]}.jpg`;
    out.push({
      id: k.key, clientId: folder, section: m[1], name: m[2], size: k.size,
      thumbUrl: await b.signGet(have.has(t) ? t : k.key, 6 * 3600),
      viewUrl: await b.signGet(have.has(v) ? v : k.key, 6 * 3600)
    });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true }));
}

/* ---------- Messages ---------- */
function parseMsgKey(key) {
  const m = /^data\/messages\/([^/]+)\/(\d{13})-(client|admin)-([^/.]+)\.json$/.exec(key);
  return m && { clientId: m[1], at: +m[2], from: m[3], id: m[4], key };
}
function readFor(c, m) { return m.from === "client" ? m.at <= (c.adminReadAt || 0) : m.at <= (c.clientReadAt || 0); }

const ACTIONS = {
  /* ----- Sign in ----- */
  async adminLogin({ body }) {
    if (!env.ADMIN_PASSWORD) throw new HttpError(503, "Set ADMIN_PASSWORD in Vercel first.");
    if (!sameSecret(body.password || "", env.ADMIN_PASSWORD)) { await pause(); throw new HttpError(401, "That isn't the admin password."); }
    return { token: signToken({ role: "admin" }, 12) };
  },
  async clientLogin({ b, body }) {
    const pw = String(body.password || "").trim();
    const c = pw && (await allClients(b)).find(x => x.password && sameSecret(x.password, pw));
    if (!c) { await pause(); throw new HttpError(401, "That password doesn't match a gallery."); }
    return startSession(b, c, "client");
  },
  async shareLogin({ b, body }) {
    const c = body.token && (await allClients(b)).find(x => x.shareToken && x.shareToken === body.token);
    if (!c) throw new HttpError(404, "That share link has been turned off.");
    return startSession(b, c, "guest");
  },
  async googleLogin({ b, body }) {
    const email = await googleEmail(body.credential);
    const mine = (await allClients(b)).filter(c => (c.emails || []).includes(email))
      .sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    if (!mine.length) throw new HttpError(404, `No gallery is set up for ${email} yet. Check with your photographer, or use your gallery password.`);
    if (mine.length > 1) {
      return { choose: mine.map(c => ({ id: c.id, name: c.name, shoot: c.shoot, date: c.date })),
        ticket: signToken({ role: "chooser", ids: mine.map(c => c.id) }, 0.25) };
    }
    return startSession(b, mine[0], "client");
  },
  /* After Google sign-in matched more than one folder. */
  async chooseGallery({ b, body }) {
    const t = readToken(body.ticket);
    if (!t || t.role !== "chooser" || !t.ids.includes(body.id)) throw new HttpError(401, "Please sign in again.");
    return startSession(b, await getClient(b, body.id), "client");
  },

  /* ----- Settings ----- */
  async settings({ b, who }) {
    const s = await settingsOf(b);
    s.adminHash = "server";
    s.googleClientId = env.GOOGLE_CLIENT_ID || "";
    if (!who || who.role !== "admin") delete s.contractTemplate;
    return s;
  },
  async saveSettings({ b, body, who }) {
    admin(who);
    const s = body.settings || {};
    delete s.adminHash; delete s.googleClientId;
    await b.putJSON("data/settings.json", s);
  },

  /* ----- Clients ----- */
  async listClients({ b, who }) { admin(who); return allClients(b); },
  async getClient({ b, body, who }) {
    const role = access(who, body.id);
    const c = await getClient(b, body.id);
    return role === "admin" ? c : forClient(c, role);
  },
  async newClient({ b, body, who }) {
    admin(who);
    let id = slug(body.name), n = 1;
    while (await b.getJSON(clientKey(id))) id = slug(body.name) + "-" + (++n);
    const c = {
      id, name: String(body.name || "Untitled"), password: body.password || "", shoot: "", location: "", date: "",
      pick: 0, downloadLimit: 0, downloaded: [], timer: true, shareToken: "", downloadDays: null, text: {},
      picks: [], selection: null, firstLogin: null, emails: [], createdAt: Date.now()
    };
    await b.putJSON(clientKey(id), c);
    return c;
  },
  /* Admin sends only the fields it changed, so a client's picks made meanwhile aren't overwritten. */
  async saveClient({ b, body, who }) {
    const role = access(who, body.id);
    const c = await getClient(b, body.id);
    const ch = body.changes || {};
    if (role === "admin") {
      if (ch.password) {
        const clash = (await allClients(b)).some(o => o.id !== c.id && o.password === ch.password);
        if (clash) throw new HttpError(409, "Another folder already uses this password.");
      }
      ADMIN_FIELDS.forEach(k => { if (k in ch) c[k] = ch[k]; });
      if ("emails" in ch) c.emails = [].concat(ch.emails || []).map(e => String(e).trim().toLowerCase()).filter(Boolean);
    } else if (role === "client") {
      if ("picks" in ch) {
        const picks = [].concat(ch.picks || []).map(String);
        if (c.pick && picks.length > c.pick) throw new HttpError(400, `You can choose up to ${c.pick}.`);
        c.picks = picks;
      }
      if ("selection" in ch && ch.selection) {
        c.selection = { frames: [].concat(ch.selection.frames || []).map(String), note: String(ch.selection.note || "").slice(0, 4000), sentAt: Date.now() };
      }
    } else throw new HttpError(403, "Guests can't change this gallery.");
    await b.putJSON(clientKey(c.id), c);
    return role === "admin" ? c : forClient(c, role);
  },
  async deleteClient({ b, body, who }) {
    admin(who);
    const id = folderOk(body.id);
    for (const prefix of [`photos/${id}/`, `data/contracts/${id}/`, `data/messages/${id}/`]) {
      const { keys } = await b.list(prefix);
      for (let i = 0; i < keys.length; i += 20) await Promise.all(keys.slice(i, i + 20).map(k => b.del(k.key)));
    }
    await b.del(clientKey(id));
  },

  /* ----- Photos ----- */
  async listPhotos({ b, body, who }) {
    const role = access(who, body.clientId);
    let sections = body.section ? [body.section] : SECTIONS;
    if (role === "guest") sections = sections.filter(s => s !== "proofs");
    return listPhotos(b, body.clientId, sections.filter(s => SECTIONS.includes(s)));
  },
  /* A short-lived download link, after checking the timer and the download limit. */
  async download({ b, body, who }) {
    const role = access(who, body.clientId);
    const { section, name } = photoKeyOk(body.clientId, body.id);
    if (role !== "admin") {
      const c = await getClient(b, body.clientId);
      if (section === "proofs") throw new HttpError(403, "Proofs are for choosing, not downloading.");
      if (section === "finals" && !windowOf(c, await settingsOf(b)).open) throw new HttpError(403, "The download window has closed.");
      if (section === "downloads" && role === "client" && c.downloadLimit) {
        const got = c.downloaded || [];
        if (!got.includes(name)) {
          if (got.length >= c.downloadLimit) throw new HttpError(403, `You've used all ${c.downloadLimit} downloads.`);
          c.downloaded = got.concat(name);
          await b.putJSON(clientKey(c.id), c);
        }
      }
    }
    return { url: await b.signGet(body.id, 600, name) };
  },
  /* Upload links for the original plus the two preview sizes the browser makes. */
  async uploadUrls({ b, body, who }) {
    admin(who);
    const folder = folderOk(body.clientId);
    if (!SECTIONS.includes(body.section)) throw new HttpError(400, "Bad section");
    const name = String(body.name || "photo.jpg").replace(/[\/\\]/g, "-").replace(/^\.+/, "").slice(0, 180) || "photo.jpg";
    const base = `photos/${folder}/${body.section}/`;
    return {
      id: base + name, name,
      original: await b.signPut(base + name, body.type || "image/jpeg"),
      thumb: await b.signPut(`${base}_t/${name}.jpg`, "image/jpeg"),
      view: await b.signPut(`${base}_v/${name}.jpg`, "image/jpeg")
    };
  },
  async deletePhoto({ b, body, who }) {
    admin(who);
    const folder = String(body.id || "").split("/")[1];
    const { section, name } = photoKeyOk(folder, body.id);
    const base = `photos/${folder}/${section}/`;
    await Promise.all([b.del(body.id), b.del(`${base}_t/${name}.jpg`), b.del(`${base}_v/${name}.jpg`)]);
  },

  /* ----- Contracts ----- */
  async listContracts({ b, body, who }) {
    const role = access(who, body.clientId);
    if (role === "guest") return [];
    const { keys } = await b.list(`data/contracts/${folderOk(body.clientId)}/`);
    const docs = await Promise.all(keys.filter(k => k.key.endsWith(".json")).map(k => b.getJSON(k.key)));
    return docs.filter(Boolean).sort((x, y) => x.sentAt - y.sentAt);
  },
  async sendContract({ b, body, who }) {
    admin(who);
    const k = { id: uid(), clientId: folderOk(body.clientId), title: String(body.title || "Agreement").slice(0, 200),
      body: String(body.body || "").slice(0, 100000), status: "sent", sentAt: Date.now(), signedAt: null, signature: null };
    await b.putJSON(`data/contracts/${k.clientId}/${k.id}.json`, k);
    return k;
  },
  async signContract({ b, body, who, req }) {
    const role = access(who, body.clientId);
    if (role !== "client") throw new HttpError(403, "Only the client can sign.");
    const key = `data/contracts/${folderOk(body.clientId)}/${String(body.id).replace(/[^a-z0-9]/g, "")}.json`;
    const k = await b.getJSON(key);
    if (!k) throw new HttpError(404, "That contract was withdrawn.");
    if (k.status === "signed") return k;
    const name = String(body.name || "").trim().slice(0, 200);
    const image = String(body.image || "");
    if (!name) throw new HttpError(400, "Type your full name.");
    if (!/^data:image\/png;base64,/.test(image) || image.length > 600000) throw new HttpError(400, "Draw your signature again.");
    k.status = "signed"; k.signedAt = Date.now();
    k.signature = { name, image, device: String(req.headers["user-agent"] || "").slice(0, 300),
      ip: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() };
    await b.putJSON(key, k);
    await b.put(key.replace(/\.json$/, ".signed"), "", "text/plain");
    return k;
  },
  async withdrawContract({ b, body, who }) {
    admin(who);
    const base = `data/contracts/${folderOk(body.clientId)}/${String(body.id).replace(/[^a-z0-9]/g, "")}`;
    const k = await b.getJSON(base + ".json");
    if (k && k.status === "signed") throw new HttpError(409, "Signed contracts can't be withdrawn.");
    await b.del(base + ".json");
  },

  /* ----- Messages ----- */
  async listMessages({ b, body, who }) {
    const role = access(who, body.clientId);
    if (role === "guest") return [];
    const c = await getClient(b, body.clientId);
    const { keys } = await b.list(`data/messages/${c.id}/`);
    const metas = keys.map(k => parseMsgKey(k.key)).filter(Boolean).sort((x, y) => x.at - y.at);
    const docs = await Promise.all(metas.map(m => b.getJSON(m.key)));
    return metas.map((m, i) => ({ id: m.id, clientId: c.id, from: m.from, at: m.at, text: (docs[i] || {}).text || "", read: readFor(c, m) }));
  },
  async addMessage({ b, body, who }) {
    const role = access(who, body.clientId);
    if (role === "guest") throw new HttpError(403, "Guests can't send messages.");
    const text = String(body.text || "").trim().slice(0, 8000);
    if (!text) throw new HttpError(400, "Write a message first.");
    const m = { id: uid(), clientId: folderOk(body.clientId), from: role === "admin" ? "admin" : "client", at: Date.now(), text, read: false };
    await b.putJSON(`data/messages/${m.clientId}/${m.at}-${m.from}-${m.id}.json`, { text });
    return m;
  },
  /* Read receipts are one timestamp per side on the client record. */
  async markRead({ b, body, who }) {
    const role = access(who, body.clientId);
    if (role === "guest") return;
    const c = await getClient(b, body.clientId);
    c[role === "admin" ? "adminReadAt" : "clientReadAt"] = Date.now();
    await b.putJSON(clientKey(c.id), c);
  },

  /* ----- Admin overview: unread messages and signatures without opening every file ----- */
  async activity({ b, who }) {
    admin(who);
    const [clients, msgs, ks] = await Promise.all([allClients(b), b.list("data/messages/"), b.list("data/contracts/")]);
    const byId = Object.fromEntries(clients.map(c => [c.id, c]));
    const messages = msgs.keys.map(k => parseMsgKey(k.key)).filter(m => m && byId[m.clientId])
      .map(m => ({ id: m.id, clientId: m.clientId, from: m.from, at: m.at, text: "", read: readFor(byId[m.clientId], m) }));
    const signed = new Set(ks.keys.filter(k => k.key.endsWith(".signed")).map(k => k.key.replace(/\.signed$/, "")));
    const contracts = ks.keys.filter(k => k.key.endsWith(".json")).map(k => {
      const m = /^data\/contracts\/([^/]+)\/([^/]+)\.json$/.exec(k.key);
      return m && { id: m[2], clientId: m[1], title: "", status: signed.has(k.key.replace(/\.json$/, "")) ? "signed" : "sent" };
    }).filter(Boolean);
    return { messages, contracts, clients: clients.map(c => ({ id: c.id, name: c.name })) };
  },

  /* ----- One-time setup: let the site upload to and zip from the portal bucket (CORS) ----- */
  async setupStorage({ b, body, who, req }) {
    admin(who);
    const origins = new Set(["https://godshootsprime.com", "https://www.godshootsprime.com"]);
    if (req.headers.origin) origins.add(req.headers.origin);
    (env.SITE_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean).forEach(o => origins.add(o));
    /* A key limited to one bucket isn't allowed to change bucket settings, so this can use
       the master key once. It's used for this request only and never saved. */
    const target = body.masterKeyId && body.masterKey
      ? makeBucket(env.B2_ENDPOINT, body.masterKeyId, body.masterKey, b.name) : b;
    await target.s3.send(new PutBucketCorsCommand({
      Bucket: b.name,
      CORSConfiguration: { CORSRules: [{
        AllowedOrigins: [...origins], AllowedMethods: ["GET", "HEAD", "PUT"],
        AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600
      }] }
    })).catch(e => {
      const denied = e.name === "AccessDenied" || e.$metadata?.httpStatusCode === 401 || e.$metadata?.httpStatusCode === 403;
      throw new HttpError(denied ? 403 : 502, denied ? "needs-master-key" : "Backblaze said: " + (e.message || e.name));
    });
    return { ok: true, origins: [...origins] };
  }
};
