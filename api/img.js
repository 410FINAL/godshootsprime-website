/* Web-sized photos for the portfolio (Vercel serverless function).

   The originals in the website bucket are full camera files (often 20 MB+), far too heavy
   for a page. This reads one original from Backblaze with the server's key, shrinks it,
   and returns a light JPEG. Vercel's edge keeps each result, so a photo is resized once
   and then served from cache. Usage: /api/img?k=Fashion/DF8A2626.jpg&w=1200&v=<version> */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { siteBucket } from "./_lib.js";

const WIDTHS = [480, 1200, 2400];

/* Backblaze's own download API, used if the S3-style read is refused. Sign-in is reused for 20 hours. */
let native = null;
async function nativeRead(b, key) {
  const { keyId, key: secret } = b.s3.presignCreds;
  if (!native || native.until < Date.now()) {
    const r = await fetch("https://api.backblazeb2.com/b2api/v3/b2_authorize_account", {
      headers: { Authorization: "Basic " + Buffer.from(keyId + ":" + secret).toString("base64") }
    });
    const a = await r.json();
    if (!r.ok) throw new Error("Backblaze sign-in: " + (a.code || r.status) + " " + (a.message || ""));
    native = { token: a.authorizationToken, url: a.apiInfo.storageApi.downloadUrl, until: Date.now() + 20 * 36e5 };
  }
  const path = key.split("/").map(encodeURIComponent).join("/");
  const r = await fetch(`${native.url}/file/${encodeURIComponent(b.name)}/${path}`, { headers: { Authorization: native.token } });
  if (!r.ok) {
    const t = await r.text();
    if (r.status === 401) native = null;
    throw new Error("Backblaze download: " + r.status + " " + t.slice(0, 200));
  }
  return Buffer.from(await r.arrayBuffer());
}
const IMAGE = /\.(jpe?g|png|webp|gif|tiff?)$/i;

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const key = url.searchParams.get("k") || "";
  const asked = parseInt(url.searchParams.get("w"), 10) || 1200;
  const width = WIDTHS.find(w => w >= asked) || WIDTHS[WIDTHS.length - 1];
  const b = siteBucket();
  if (!b || !IMAGE.test(key) || key.includes("..") || key.startsWith("/")) {
    res.statusCode = 404; return res.end();
  }
  let step = "loading the resizer";
  try {
    const sharp = (await import("sharp")).default;
    step = "reading the photo from Backblaze";
    let original;
    try {
      const obj = await b.s3.send(new GetObjectCommand({ Bucket: b.name, Key: key }));
      original = Buffer.from(await obj.Body.transformToByteArray());
    } catch (e) {
      if (e.name === "NoSuchKey") throw e;
      console.error("S3 read refused, trying Backblaze's own API:", e.name, e.message);
      try { original = await nativeRead(b, key); }
      catch (e2) { e2.message = `${e2.message} (S3 read: ${e.name} ${e.message})`; throw e2; }
    }
    step = "resizing the photo";
    const out = await sharp(original, { failOn: "none" })
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .jpeg({ quality: width <= 480 ? 70 : 78, mozjpeg: true, progressive: true })
      .toBuffer();
    res.statusCode = 200;
    res.setHeader("Content-Type", "image/jpeg");
    /* The link carries a version from the file's upload time, so a replaced photo gets a new link. */
    res.setHeader("Cache-Control", "public, max-age=604800, s-maxage=31536000, immutable");
    res.end(out);
  } catch (e) {
    console.error(key, step, e.name, e.message);
    res.statusCode = e.name === "NoSuchKey" ? 404 : 502;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    /* Plain-language reason, so opening the link in a browser shows what went wrong. */
    res.end(`Couldn't show ${key}: failed while ${step}. ${e.name || "Error"}: ${String(e.message || "").slice(0, 300)}`);
  }
}
