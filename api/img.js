/* Web-sized photos for the portfolio (Vercel serverless function).

   The originals in the website bucket are full camera files (often 20 MB+), far too heavy
   for a page. This reads one original from Backblaze with the server's key, shrinks it,
   and returns a light JPEG. Vercel's edge keeps each result, so a photo is resized once
   and then served from cache. Usage: /api/img?k=Fashion/DF8A2626.jpg&w=1200&v=<version> */
import sharp from "sharp";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { siteBucket } from "./_lib.js";

const WIDTHS = [480, 1200, 2400];
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
  try {
    const obj = await b.s3.send(new GetObjectCommand({ Bucket: b.name, Key: key }));
    const original = Buffer.from(await obj.Body.transformToByteArray());
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
    console.error(key, e.name, e.message);
    res.statusCode = e.name === "NoSuchKey" ? 404 : 502;
    res.setHeader("Cache-Control", "no-store");
    res.end();
  }
}
