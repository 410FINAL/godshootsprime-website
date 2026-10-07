/* Portfolio API (Vercel serverless function).

   Reads the WEBSITE Backblaze bucket, which is sorted into folders named after
   the site's categories (events, couples, fashion, boudoir; capitals are fine).
   Drop photos into a folder in Backblaze and they appear on the site within the
   hour. An optional "hero" folder, or a file named hero.jpg at the top, sets
   the big front-page photo. Works whether the bucket is public or private. */
import { siteBucket, send } from "./_lib.js";

const CATEGORIES = ["events", "couples", "fashion", "boudoir"];
const IMAGE = /\.(jpe?g|png|webp|gif)$/i;
/* Camera-style names (IMG_1234, DSC_0412) make poor captions, so those get none. */
const CAMERA = /^(img|dsc|dscf|dscn|_mg|_dsc|gsp|pxl|photo)?[-_ ]?\d+$/i;

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

    const galleries = {};
    for (const cat of CATEGORIES) {
      if (!folders[cat]) continue;
      const { keys } = await b.list(folders[cat]);
      const files = keys.map(k => k.key).filter(k => IMAGE.test(k) && !/\/_/.test(k.slice(folders[cat].length)))
        .sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
      galleries[cat] = await Promise.all(files.map(async key => ({
        src: await b.signGet(key, 24 * 3600),
        caption: caption(key.split("/").pop())
      })));
    }

    let hero = null;
    const heroFile = top.keys.find(k => /^hero\.(jpe?g|png|webp)$/i.test(k.key));
    if (heroFile) hero = { src: await b.signGet(heroFile.key, 24 * 3600) };
    else if (folders.hero) {
      const { keys } = await b.list(folders.hero);
      const first = keys.map(k => k.key).filter(k => IMAGE.test(k)).sort()[0];
      if (first) hero = { src: await b.signGet(first, 24 * 3600) };
    }

    /* Cached at Vercel's edge for an hour, so Backblaze is asked at most about once an hour. */
    send(res, 200, { connected: true, hero, galleries }, {
      "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=82800"
    });
  } catch (e) {
    console.error(e);
    send(res, 200, { connected: false, error: "Couldn't read the website bucket." });
  }
}
