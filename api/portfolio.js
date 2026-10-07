/* Portfolio API (Vercel serverless function).

   Reads the WEBSITE Backblaze bucket, which is sorted into folders named after
   the site's categories (events, couples, fashion, boudoir; capitals are fine).
   Drop photos into a folder in Backblaze and they appear on the site within the
   hour. An optional "hero" folder, or a file named hero.jpg at the top, sets
   the big front-page photo. Works whether the bucket is public or private; photos are
   served web-sized through /api/img. */
import { siteBucket, send } from "./_lib.js";

const CATEGORIES = ["events", "couples", "fashion", "boudoir"];
/* The front-page photo. Set to a file in the bucket (e.g. "fashion/IMG_4821.jpg", or just the
   file name) to choose it; capitals don't matter. Empty means hero.jpg or the hero folder below. */
const HERO_FILE = "fashion/DF8A2626.jpg";
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
/* Camera-style names (IMG_1234, DSC_0412) make poor captions, so those get none. */
const CAMERA = /^((img|dsc|dscf|dscn|_mg|_dsc|gsp|pxl|photo)?[-_ ]?\d+|[a-z0-9_]{4}\d{4})$/i;

function caption(file) {
  const base = file.replace(/\.[^.]+$/, "");
  if (CAMERA.test(base)) return "";
  return base.replace(/^\d+[-_ ]+/, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^./, ch => ch.toUpperCase());
}

export default async function handler(req, res) {
  try {
    const b = siteBucket();
    if (!b) return send(res, 200, { connected: false });
    const top = await b.list("", "/");
    const folders = {};
    top.prefixes.forEach(p => { folders[p.replace(/\/$/, "").toLowerCase()] = p; });
    const lists = {}, version = {};
    const stamp = keys => keys.forEach(k => { version[k.key] = new Date(k.modified).getTime().toString(36); });
    stamp(top.keys);

    for (const cat of CATEGORIES) {
      if (!folders[cat]) continue;
      const { keys } = await b.list(folders[cat]);
      stamp(keys);
      lists[cat] = keys.map(k => k.key).filter(k => IMAGE.test(k) && !/\/_/.test(k.slice(folders[cat].length)))
        .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
    }

    let heroKey = null;
    const want = (process.env.HERO_FILE || HERO_FILE).trim().toLowerCase().replace(/^\/+/, "");
    if (want) {
      const listed = (await b.list("")).keys;
      stamp(listed);
      const all = listed.map(k => k.key);
      heroKey = all.find(k => k.toLowerCase() === want) || all.find(k => k.toLowerCase().endsWith("/" + want)) || null;
    }
    if (!heroKey) heroKey = (top.keys.find(k => /^hero\.(jpe?g|png|webp)$/i.test(k.key)) || {}).key || null;
    if (!heroKey && folders.hero) {
      const { keys } = await b.list(folders.hero);
      stamp(keys);
      heroKey = keys.map(k => k.key).filter(k => IMAGE.test(k)).sort()[0] || null;
    }

    /* Photos are served through /api/img, which shrinks the full-size originals to web size. */
    const link = (k, w) => `/api/img?k=${encodeURIComponent(k)}&w=${w}&v=${version[k] || "0"}`;
    const item = k => ({ src: link(k, 1200), full: link(k, 2400), caption: caption(k.split("/").pop()) });
    const galleries = {};
    for (const cat of Object.keys(lists)) galleries[cat] = lists[cat].map(item);
    const hero = heroKey ? { ...item(heroKey), src: link(heroKey, 2400) } : null;

    /* Cached at Vercel's edge for an hour, so Backblaze is asked at most about once an hour. */
    send(res, 200, { connected: true, hero, galleries }, {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400"
    });
  } catch (e) {
    console.error(e);
    send(res, 200, { connected: false, error: "Couldn't read the website bucket." });
  }
}
