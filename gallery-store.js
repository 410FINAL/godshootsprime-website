/* Gallery store: everything the admin portal and client gallery save.

   Two modes, picked automatically when the page loads:
   - LIVE: on Vercel with the Backblaze settings in place, everything goes
     through /api/portal (see api/portal.js). Photos, contracts and messages
     live in the portal bucket, and the server checks every rule.
   - PREVIEW: anywhere else (like the Claude preview), data and photos are
     saved in this browser only (IndexedDB) with a demo client, so the pages
     work end to end on one device.
   The two pages only talk to the GS object below. */
(function () {
  var DAY = 864e5;

  /* Starting point only. Have a lawyer review your contract before using it. */
  var CONTRACT_TEMPLATE = [
    "This agreement is between GODSHOOTSPRIME (the Photographer) and {name} (the Client) for {shoot} photography on {date} in {location}.",
    "",
    "1. Booking and retainer. A non-refundable retainer of [amount] reserves the date. The balance of [amount] is due [when].",
    "",
    "2. Coverage. The Photographer will provide [hours] of coverage and deliver [number] edited images through the private client gallery.",
    "",
    "3. Delivery. Proofs are delivered within [number] days. Final edits are delivered within [number] days of the Client's selection, and stay downloadable for the period shown in the gallery.",
    "",
    "4. Cancellation and rescheduling. [Your policy.]",
    "",
    "5. Image use. The Photographer keeps copyright. The Client receives a personal-use licence to print and share the images. The Photographer may use selected images in a portfolio [unless the Client opts out].",
    "",
    "6. Liability. If the Photographer cannot perform because of illness or events beyond their control, liability is limited to a refund of payments made.",
    "",
    "By signing below, the Client agrees to these terms."
  ].join("\n");

  var DEFAULT_SETTINGS = {
    id: "settings",
    adminHash: "",
    downloadDays: 14,
    contactEmail: "godshootsprime@gmail.com",
    selectionEndpoint: "",
    contractTemplate: CONTRACT_TEMPLATE,
    text: {
      gateLabel: "Client gallery",
      gateTitle: "Your *images,* privately.",
      gateLine: "Enter the password from your gallery email to view, select and download your photographs.",
      welcome: "Welcome, *{name}.*",
      line: "Everything from your shoot lives here. Choose the frames you'd like edited, then come back for your finished images.",
      selectTitle: "Choose your *favourites*",
      selectLine: "Tap the corner of any frame to select it, then send your selection when you're happy. You can change it any time before you send.",
      finalsTitle: "Your *final* edits",
      finalsLine: "Retouched and ready. Save every image you want to keep while the download window is open.",
      filesTitle: "Your *downloads*",
      filesLine: "Full-resolution JPEGs, yours to keep."
    }
  };

  var TEXT_FIELDS = [
    { key: "gateLabel", label: "Sign-in label", global: true },
    { key: "gateTitle", label: "Sign-in heading", global: true },
    { key: "gateLine", label: "Sign-in message", global: true, long: true },
    { key: "welcome", label: "Welcome heading" },
    { key: "line", label: "Welcome message", long: true },
    { key: "selectTitle", label: "Select: heading" },
    { key: "selectLine", label: "Select: message", long: true },
    { key: "finalsTitle", label: "Finals: heading" },
    { key: "finalsLine", label: "Finals: message", long: true },
    { key: "filesTitle", label: "Downloads: heading" },
    { key: "filesLine", label: "Downloads: message", long: true }
  ];

  var SECTIONS = [
    { key: "proofs", title: "Select", tab: "select" },
    { key: "finals", title: "Finals", tab: "finals" },
    { key: "downloads", title: "Downloads", tab: "files" }
  ];

  /* ---------- Storage (swap this section for a real backend) ---------- */
  var dbp = new Promise(function (res, rej) {
    var rq = indexedDB.open("gsp-gallery", 2);
    rq.onupgradeneeded = function () {
      var db = rq.result, has = function (n) { return db.objectStoreNames.contains(n); };
      if (!has("kv")) db.createObjectStore("kv", { keyPath: "id" });
      if (!has("clients")) db.createObjectStore("clients", { keyPath: "id" });
      if (!has("photos")) db.createObjectStore("photos", { keyPath: "id" }).createIndex("client", "clientId");
      if (!has("contracts")) db.createObjectStore("contracts", { keyPath: "id" }).createIndex("client", "clientId");
      if (!has("messages")) db.createObjectStore("messages", { keyPath: "id" }).createIndex("client", "clientId");
    };
    rq.onsuccess = function () { res(rq.result); };
    rq.onerror = function () { rej(rq.error); };
  });
  function tx(store, mode, fn) {
    return dbp.then(function (db) {
      return new Promise(function (res, rej) {
        var t = db.transaction(store, mode), s = t.objectStore(store), out;
        var r = fn(s);
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    });
  }
  function getAll(store) { return tx(store, "readonly", function (s) { return s.getAll(); }); }
  function put(store, v) { return tx(store, "readwrite", function (s) { s.put(v); }); }
  function del(store, id) { return tx(store, "readwrite", function (s) { s.delete(id); }); }
  function get(store, id) { return tx(store, "readonly", function (s) { return s.get(id); }); }
  function byClient(store, clientId) { return tx(store, "readonly", function (s) { return s.index("client").getAll(clientId); }); }
  function photosOf(clientId) { return byClient("photos", clientId); }

  /* ---------- Helpers ---------- */
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]; }); }
  /* Escapes text and turns *word* into italics. */
  function rich(s, vars) {
    var t = esc(s);
    if (vars) t = t.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? esc(vars[k]) : m; });
    return t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  }
  function hash(text) {
    var data = new TextEncoder().encode("gsp:" + text);
    return crypto.subtle.digest("SHA-256", data).then(function (b) {
      return Array.from(new Uint8Array(b)).map(function (x) { return x.toString(16).padStart(2, "0"); }).join("");
    });
  }
  function byName(a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); }
  function numbered(prefix, start, count) {
    var out = [];
    for (var i = 0; i < count; i++) out.push(prefix + String(start + i).padStart(4, "0") + ".jpg");
    return out;
  }

  /* Placeholder study in black and grey, shown when a photo has no file yet. */
  function rng(seed) { return function () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }; }
  function seedOf(name) { var h = 7; for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 99991; return h + 1; }
  var RATIOS = [[4, 5], [2, 3], [4, 5], [3, 4]];
  function placeholder(name, size) {
    var rt = RATIOS[seedOf(name) % RATIOS.length];
    var c = document.createElement("canvas"), k = (size || 480) / Math.max(rt[0], rt[1]);
    c.width = Math.round(rt[0] * k); c.height = Math.round(rt[1] * k);
    var x = c.getContext("2d"), W = c.width, H = c.height, r = rng(seedOf(name) * 104729 % 2147483646 + 1);
    function pool(px, py, rad, level, alpha) {
      var g = x.createRadialGradient(px, py, 0, px, py, rad);
      g.addColorStop(0, "rgba(" + level + "," + level + "," + level + "," + alpha + ")");
      g.addColorStop(1, "rgba(" + level + "," + level + "," + level + ",0)");
      x.fillStyle = g; x.fillRect(0, 0, W, H);
    }
    x.fillStyle = "#050505"; x.fillRect(0, 0, W, H);
    var cx = W * (0.3 + r() * 0.4), cy = H * (0.3 + r() * 0.25);
    pool(cx - W * 0.12, cy, W * (0.5 + r() * 0.3), 170 + r() * 70, 0.55);
    pool(cx + W * 0.14, cy + H * 0.08, W * (0.4 + r() * 0.3), 200 + r() * 50, 0.45);
    pool(W * r(), H * 1.05, W * 0.9, 60, 0.6);
    var v = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
    v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(0,0,0,.55)");
    x.fillStyle = v; x.fillRect(0, 0, W, H);
    var d = x.getImageData(0, 0, W, H), p = d.data;
    for (var n = 0; n < p.length; n += 4) { var e = (r() - 0.5) * 16; p[n] += e; p[n + 1] += e; p[n + 2] += e; }
    x.putImageData(d, 0, 0);
    c.setAttribute("role", "img");
    c.setAttribute("aria-label", name + " (placeholder)");
    return c;
  }

  /* A 900px preview so grids stay fast; the original is kept for downloads. */
  function makeThumb(file) {
    return createImageBitmap(file).then(function (bmp) {
      var k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      var size = { w: bmp.width, h: bmp.height };
      bmp.close && bmp.close();
      return new Promise(function (res) { c.toBlob(function (b) { res({ thumb: b, w: size.w, h: size.h }); }, "image/jpeg", 0.82); });
    });
  }

  var urls = {};
  function photoUrl(p, full) {
    if (p.thumbUrl) return full ? p.viewUrl : p.thumbUrl;
    var b = full ? p.blob : (p.thumb || p.blob);
    if (!b) return null;
    var k = p.id + (full ? ":f" : ":t");
    return urls[k] || (urls[k] = URL.createObjectURL(b));
  }
  function photoBlob(p) {
    if (p.blob) return Promise.resolve(p.blob);
    var c = placeholder(p.name, 1600);
    return new Promise(function (res) { c.toBlob(res, "image/jpeg", 0.85); });
  }

  /* ---------- First run: default settings and a demo client ---------- */
  var API = "/api/portal";
  /* LIVE when the portal function answers and has storage connected. */
  var modeP = (location.protocol.indexOf("http") === 0
    ? fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"ping"}' })
        .then(function (r) { return r.ok ? r.json() : {}; })
        .then(function (j) { return j && j.ok && j.ready ? "remote" : "local"; })
        .catch(function () { return "local"; })
    : Promise.resolve("local"));

  var ready = modeP.then(function (m) { if (m !== "local") return "skip"; return dbp.then(function () { return get("kv", "settings"); }); }).then(function (s) {
    if (s === "skip") return "skip";
    if (s) return;
    var demo = {
      id: "demo", name: "Amara & Jon", password: "demo", shoot: "Engagement", location: "Malibu",
      date: "2026-09-21", pick: 20, downloadLimit: 5, downloaded: [], timer: true, shareToken: "", downloadDays: null, text: {}, picks: [], selection: null,
      firstLogin: null, createdAt: Date.now()
    };
    var jobs = [put("kv", DEFAULT_SETTINGS), put("clients", demo)];
    [["proofs", numbered("GSP_", 412, 36)], ["finals", numbered("Amara-Jon_", 1, 12)], ["downloads", numbered("GSP_", 412, 8)]].forEach(function (pair) {
      pair[1].forEach(function (n) { jobs.push(put("photos", { id: uid(), clientId: "demo", section: pair[0], name: n, blob: null, thumb: null })); });
    });
    return Promise.all(jobs);
  }).then(function (r) {
    if (r === "skip") return;
    /* One-time: give the demo client a contract to sign and a first message. */
    return get("kv", "seed-contracts").then(function (done) {
      if (done) return;
      return get("clients", "demo").then(function (demo) {
        var jobs = [put("kv", { id: "seed-contracts" })];
        if (demo) {
          var body = CONTRACT_TEMPLATE.replace("{name}", demo.name).replace("{shoot}", "engagement")
            .replace("{date}", "September 21, 2026").replace("{location}", "Malibu");
          var t = Date.now() - 36e5;
          jobs.push(put("contracts", { id: uid(), clientId: "demo", title: "Engagement session agreement", body: body, status: "sent", sentAt: t, signedAt: null, signature: null }));
          jobs.push(put("messages", { id: uid(), clientId: "demo", from: "admin", text: "Hi Amara and Jon, your agreement is ready to sign under Contract. Any questions at all, just message me here.", at: t + 1000, read: false }));
        }
        return Promise.all(jobs);
      });
    });
  });

  function withDefaults(s) {
    s = Object.assign({}, DEFAULT_SETTINGS, s);
    s.text = Object.assign({}, DEFAULT_SETTINGS.text, s.text);
    if (s.contactEmail === "hello@godshootsprime.com") s.contactEmail = DEFAULT_SETTINGS.contactEmail;
    return s;
  }
  function saveAs(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------- Preview mode (this browser only) ---------- */
  var local = {
    DAY: DAY,
    SECTIONS: SECTIONS,
    TEXT_FIELDS: TEXT_FIELDS,
    DEFAULT_TEXT: DEFAULT_SETTINGS.text,
    ready: ready,
    esc: esc,
    rich: rich,
    hash: hash,
    uid: uid,
    placeholder: placeholder,
    photoUrl: photoUrl,
    photoBlob: photoBlob,

    getSettings: function () {
      return ready.then(function () { return get("kv", "settings"); }).then(withDefaults);
    },
    saveSettings: function (s) { return put("kv", s); },

    listClients: function () {
      return ready.then(function () { return getAll("clients"); }).then(function (l) {
        return l.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      });
    },
    getClient: function (id) { return ready.then(function () { return get("clients", id); }); },
    saveClient: function (c) { return put("clients", c); },
    deleteClient: function (id) {
      return Promise.all(["photos", "contracts", "messages"].map(function (store) {
        return byClient(store, id).then(function (rows) {
          return Promise.all(rows.map(function (r) { return del(store, r.id); }));
        });
      })).then(function () { return del("clients", id); });
    },
    findClient: function (password) {
      return this.listClients().then(function (l) {
        return l.filter(function (c) { return c.password && c.password === password; })[0] || null;
      });
    },
    /* Event galleries: anyone with the share link gets in without a password. */
    findShared: function (token) {
      return this.listClients().then(function (l) {
        return l.filter(function (c) { return token && c.shareToken === token; })[0] || null;
      });
    },
    newClient: function (name) {
      var c = {
        id: uid(), name: name, password: "", shoot: "", location: "", date: "", pick: 0, downloadLimit: 0, downloaded: [], timer: true, shareToken: "", downloadDays: null,
        text: {}, picks: [], selection: null, firstLogin: null, createdAt: Date.now()
      };
      return put("clients", c).then(function () { return c; });
    },

    listPhotos: function (clientId, section) {
      return ready.then(function () { return photosOf(clientId); }).then(function (ps) {
        return ps.filter(function (p) { return !section || p.section === section; }).sort(byName);
      });
    },
    addPhoto: function (clientId, section, file) {
      return makeThumb(file).catch(function () { return { thumb: null }; }).then(function (t) {
        var p = { id: uid(), clientId: clientId, section: section, name: file.name, blob: file, thumb: t.thumb, w: t.w, h: t.h };
        return put("photos", p).then(function () { return p; });
      });
    },
    deletePhoto: function (id) { return del("photos", id); },
    download: function (p) { return photoBlob(p).then(function (b) { saveAs(b, p.name); }); },
    adminLogin: function (pw) {
      return Promise.all([hash(pw), this.getSettings()]).then(function (r) {
        if (r[0] !== r[1].adminHash) throw new Error("That isn't the admin password.");
      });
    },
    /* Stands in for Google sign-in in the preview: matches the email you type to folders. */
    googleLogin: function (email) {
      email = String(email || "").trim().toLowerCase();
      return this.listClients().then(function (l) {
        var mine = l.filter(function (c) { return (c.emails || []).indexOf(email) > -1; });
        if (!mine.length) throw new Error("No gallery is set up for " + email + " yet. Use your gallery password, or ask your photographer.");
        if (mine.length > 1) return { choose: mine, ticket: "local" };
        return { client: mine[0] };
      });
    },
    chooseGallery: function (ticket, id) { return get("clients", id).then(function (c) { return { client: c }; }); },
    setupStorage: function () { return Promise.resolve({ ok: true }); },

    /* ---------- Contracts ---------- */
    listContracts: function (clientId) {
      return ready.then(function () { return byClient("contracts", clientId); }).then(function (l) {
        return l.sort(function (a, b) { return a.sentAt - b.sentAt; });
      });
    },
    saveContract: function (k) { return put("contracts", k); },
    deleteContract: function (id) { return del("contracts", id); },
    allContracts: function () { return ready.then(function () { return getAll("contracts"); }); },
    /* Fills {name}, {shoot}, {date}, {location} from the client's details. */
    fillTemplate: function (text, c) {
      var date = c.date ? new Date(c.date + "T12:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "[date]";
      var v = { name: c.name || "[client]", shoot: c.shoot || "[shoot type]", date: date, location: c.location || "[location]" };
      return text.replace(/\{(name|shoot|date|location)\}/g, function (m, k) { return v[k]; });
    },

    /* ---------- Messages ---------- */
    listMessages: function (clientId) {
      return ready.then(function () { return byClient("messages", clientId); }).then(function (l) {
        return l.sort(function (a, b) { return a.at - b.at; });
      });
    },
    addMessage: function (clientId, from, text) {
      var m = { id: uid(), clientId: clientId, from: from, text: text, at: Date.now(), read: false };
      return put("messages", m).then(function () { return m; });
    },
    /* Marks the other side's messages as read by `reader` ("admin" or "client"). */
    markRead: function (clientId, reader) {
      return this.listMessages(clientId).then(function (l) {
        return Promise.all(l.filter(function (m) { return m.from !== reader && !m.read; }).map(function (m) {
          m.read = true; return put("messages", m);
        }));
      });
    },
    allMessages: function () { return ready.then(function () { return getAll("messages"); }); },

    /* Emails the photographer through the form endpoint in Settings, if one is set. */
    notify: function (settings, subject, fields) {
      if (!settings.selectionEndpoint) return Promise.resolve(false);
      return fetch(settings.selectionEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(Object.assign({ _subject: subject }, fields))
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    },

    /* The download window for final edits, counted from the client's first sign-in. */
    window: function (c, settings) {
      var days = c.downloadDays || settings.downloadDays || 14;
      if (c.timer === false) return { days: days, off: true, started: !!c.firstLogin, open: true, left: days, until: null };
      if (!c.firstLogin) return { days: days, started: false, open: true, left: days, until: null };
      var until = c.firstLogin + days * DAY;
      return { days: days, started: true, until: until, left: Math.max(0, Math.ceil((until - Date.now()) / DAY)), open: Date.now() < until };
    },
    text: function (c, settings, key) {
      var v = c && c.text && c.text[key];
      return v && v.trim() ? v : settings.text[key];
    }
  };

  /* ---------- Live mode: Backblaze through /api/portal ---------- */
  var role = "client";
  function tokKey() { return "gsp-tok-" + role; }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch (e) {} }
  function api(action, data) {
    var tok = ssGet(tokKey()), h = { "Content-Type": "application/json" };
    if (tok) h.Authorization = "Bearer " + tok;
    return fetch(API, { method: "POST", headers: h, body: JSON.stringify(Object.assign({ action: action }, data || {})) })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) {
            var e = new Error(j.error || "Something went wrong. Try again."); e.status = r.status;
            if (r.status === 401 && GS.onSignedOut) GS.onSignedOut();
            throw e;
          }
          return j;
        });
      });
  }
  /* Last copy of each client the server sent, so saves send only what changed. */
  var snap = {};
  function remember(c) { if (c && c.id) snap[c.id] = JSON.parse(JSON.stringify(c)); return c; }
  function signedIn(r) { ssSet(tokKey(), r.token); return remember(r.client); }
  var contractOwner = {};
  var act = null, actAt = 0;
  function activity() {
    if (act && Date.now() - actAt < 3000) return act;
    actAt = Date.now();
    return (act = api("activity"));
  }
  /* Resized copy for fast grids (900px) and the full-screen viewer (2000px). */
  function resized(file, max) {
    return createImageBitmap(file).then(function (bmp) {
      var k = Math.min(1, max / Math.max(bmp.width, bmp.height));
      var c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close && bmp.close();
      return new Promise(function (res) { c.toBlob(res, "image/jpeg", 0.84); });
    });
  }
  function putTo(url, blob, type) {
    return fetch(url, { method: "PUT", headers: { "Content-Type": type }, body: blob }).then(function (r) {
      if (!r.ok) throw new Error("Upload failed (" + r.status + ")");
    });
  }

  var remote = {
    getSettings: function () { return api("settings").then(withDefaults); },
    saveSettings: function (s) { return api("saveSettings", { settings: s }); },
    adminLogin: function (pw) { return api("adminLogin", { password: pw }).then(function (r) { ssSet(tokKey(), r.token); }); },

    listClients: function () {
      return api("listClients").then(function (l) {
        l.forEach(remember);
        return l.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
      });
    },
    getClient: function (id) { return api("getClient", { id: id }).then(remember).catch(function (e) { if (e.status === 404 || e.status === 403) return null; throw e; }); },
    saveClient: function (c) {
      var before = snap[c.id] || {}, changes = {}, n = 0;
      Object.keys(c).forEach(function (k) {
        if (JSON.stringify(c[k]) !== JSON.stringify(before[k])) { changes[k] = c[k]; n++; }
      });
      if (!n) return Promise.resolve(c);
      return api("saveClient", { id: c.id, changes: changes }).then(function (saved) {
        /* Keep the page's own copy; just record what the server now has. */
        remember(saved);
        return c;
      });
    },
    deleteClient: function (id) { return api("deleteClient", { id: id }); },
    findClient: function (password) {
      return api("clientLogin", { password: password }).then(signedIn).catch(function (e) { if (e.status === 401) return null; throw e; });
    },
    findShared: function (token) {
      return api("shareLogin", { token: token }).then(signedIn).catch(function (e) { if (e.status === 404) return null; throw e; });
    },
    googleLogin: function (credential) {
      return api("googleLogin", { credential: credential }).then(function (r) {
        return r.choose ? r : { client: signedIn(r) };
      });
    },
    chooseGallery: function (ticket, id) { return api("chooseGallery", { ticket: ticket, id: id }).then(function (r) { return { client: signedIn(r) }; }); },
    newClient: function (name) { return api("newClient", { name: name }).then(remember); },

    listPhotos: function (clientId, section) { return api("listPhotos", { clientId: clientId, section: section }); },
    addPhoto: function (clientId, section, file) {
      var type = file.type || "image/jpeg";
      return Promise.all([
        resized(file, 900).catch(function () { return null; }),
        resized(file, 2000).catch(function () { return null; }),
        api("uploadUrls", { clientId: clientId, section: section, name: file.name, type: type })
      ]).then(function (r) {
        var u = r[2], jobs = [putTo(u.original, file, type)];
        if (r[0]) jobs.push(putTo(u.thumb, r[0], "image/jpeg"));
        if (r[1]) jobs.push(putTo(u.view, r[1], "image/jpeg"));
        return Promise.all(jobs).then(function () {
          return { id: u.id, clientId: clientId, section: section, name: u.name,
            thumbUrl: URL.createObjectURL(r[0] || file), viewUrl: URL.createObjectURL(r[1] || file) };
        });
      });
    },
    deletePhoto: function (id) { return api("deletePhoto", { id: id }); },
    photoBlob: function (p) {
      return api("download", { clientId: p.clientId, id: p.id }).then(function (r) {
        return fetch(r.url).then(function (x) { if (!x.ok) throw new Error("Download failed"); return x.blob(); });
      });
    },
    /* Single downloads go straight to Backblaze with a short-lived link. */
    download: function (p) {
      return api("download", { clientId: p.clientId, id: p.id }).then(function (r) {
        var a = document.createElement("a"); a.href = r.url; a.rel = "noopener";
        document.body.appendChild(a); a.click(); a.remove();
      });
    },

    listContracts: function (clientId) {
      return api("listContracts", { clientId: clientId }).then(function (l) {
        l.forEach(function (k) { contractOwner[k.id] = k.clientId; });
        return l;
      });
    },
    saveContract: function (k) {
      if (k.status === "signed" && k.signature) {
        return api("signContract", { clientId: k.clientId, id: k.id, name: k.signature.name, image: k.signature.image })
          .then(function (saved) { Object.assign(k, saved); return k; });
      }
      return api("sendContract", { clientId: k.clientId, title: k.title, body: k.body });
    },
    deleteContract: function (id) { return api("withdrawContract", { clientId: contractOwner[id], id: id }); },
    allContracts: function () { return activity().then(function (a) { return a.contracts; }); },

    listMessages: function (clientId) { return api("listMessages", { clientId: clientId }); },
    addMessage: function (clientId, from, text) { return api("addMessage", { clientId: clientId, text: text }); },
    markRead: function (clientId) { return api("markRead", { clientId: clientId }); },
    allMessages: function () { return activity().then(function (a) { return a.messages; }); },
    setupStorage: function (keyId, key) { return api("setupStorage", { masterKeyId: keyId, masterKey: key }); }
  };

  /* ---------- Public API: same calls in both modes ---------- */
  var GS = window.GS = {
    DAY: DAY, SECTIONS: SECTIONS, TEXT_FIELDS: TEXT_FIELDS, DEFAULT_TEXT: DEFAULT_SETTINGS.text,
    ready: ready, esc: esc, rich: rich, hash: hash, uid: uid, placeholder: placeholder, photoUrl: photoUrl,
    notify: local.notify, window: local.window, text: local.text, fillTemplate: local.fillTemplate,
    mode: "local",
    modeReady: modeP.then(function (m) { GS.mode = m; GS.pollMs = m === "remote" ? 20000 : 5000; return m; }),
    pollMs: 5000,
    /* Which saved sign-in to use on this page: "admin" or "client". */
    useRole: function (r) { role = r; },
    signOut: function () { ssSet(tokKey(), null); },
    hasSession: function () { return !!ssGet(tokKey()); }
  };
  ["getSettings", "saveSettings", "adminLogin", "listClients", "getClient", "saveClient", "deleteClient",
   "findClient", "findShared", "googleLogin", "chooseGallery", "newClient", "listPhotos", "addPhoto",
   "deletePhoto", "photoBlob", "download", "listContracts", "saveContract", "deleteContract", "allContracts",
   "listMessages", "addMessage", "markRead", "allMessages", "setupStorage"].forEach(function (name) {
    GS[name] = function () {
      var args = arguments;
      return modeP.then(function (m) {
        var impl = m === "remote" ? remote : local;
        if (!impl[name]) return Promise.reject(new Error(name + " isn't available"));
        return impl[name].apply(impl, args);
      });
    };
  });
})();
