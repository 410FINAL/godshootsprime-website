/* Shared helpers for the Vercel functions: Backblaze B2 (S3-compatible) clients,
   signed session tokens, and JSON responses. Secrets come from environment
   variables set in Vercel and never reach the browser. */
import crypto from "node:crypto";
import {
  S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command
} from "@aws-sdk/client-s3";

const env = process.env;

/* B2's S3 endpoint looks like https://s3.us-west-004.backblazeb2.com; the region is the middle part. */
function regionOf(endpoint) {
  const m = /s3\.([a-z0-9-]+)\.backblazeb2\.com/.exec(endpoint || "");
  return m ? m[1] : "us-east-1";
}
function endpointUrl(e) { return e && !/^https?:\/\//.test(e) ? "https://" + e : e; }

function makeClient(endpoint, keyId, key) {
  if (!endpoint || !keyId || !key) return null;
  const s3 = new S3Client({
    endpoint: endpointUrl(endpoint),
    region: regionOf(endpoint),
    forcePathStyle: true,
    credentials: { accessKeyId: keyId, secretAccessKey: key },
    /* B2 doesn't need the newer default checksums; keeping them off avoids mismatches on presigned uploads. */
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED"
  });
  s3.presignCreds = { endpoint: endpointUrl(endpoint), region: regionOf(endpoint), keyId, key };
  return s3;
}

/* Presigned links, signed by hand (SigV4 query string, host header only). The AWS SDK's presigner
   adds extra query parameters that Backblaze rejects with SignatureDoesNotMatch. */
const enc = v => encodeURIComponent(v).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (k, v) => crypto.createHmac("sha256", k).update(v).digest();
export function presign({ endpoint, region, keyId, key }, method, bucketName, objectKey, seconds, extra, now) {
  const u = new URL(endpoint);
  const t = (now || new Date()).toISOString().replace(/[-:]|\.\d{3}/g, "");
  const day = t.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const path = (bucketName ? "/" + enc(bucketName) : "") + "/" + objectKey.split("/").map(enc).join("/");
  const q = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${keyId}/${scope}`, "X-Amz-Date": t,
    "X-Amz-Expires": String(seconds), "X-Amz-SignedHeaders": "host", ...(extra || {})
  };
  const query = Object.keys(q).sort().map(k => enc(k) + "=" + enc(q[k])).join("&");
  const canonical = [method, path, query, "host:" + u.host + "\n", "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", t, scope, crypto.createHash("sha256").update(canonical).digest("hex")].join("\n");
  const kSign = hmac(hmac(hmac(hmac("AWS4" + key, day), region), "s3"), "aws4_request");
  return `${u.protocol}//${u.host}${path}?${query}&X-Amz-Signature=${hmac(kSign, toSign).toString("hex")}`;
}

export function portalBucket() {
  const s3 = makeClient(env.B2_ENDPOINT, env.PORTAL_KEY_ID, env.PORTAL_KEY);
  return s3 && env.PORTAL_BUCKET ? bucket(s3, env.PORTAL_BUCKET) : null;
}
export function siteBucket() {
  const s3 = makeClient(env.SITE_ENDPOINT || env.B2_ENDPOINT, env.SITE_KEY_ID || env.PORTAL_KEY_ID, env.SITE_KEY || env.PORTAL_KEY);
  return s3 && env.SITE_BUCKET ? bucket(s3, env.SITE_BUCKET) : null;
}
export function makeBucket(endpoint, keyId, key, name) {
  const s3 = makeClient(endpoint, keyId, key);
  return s3 ? bucket(s3, name) : null;
}

function bucket(s3, name) {
  return {
    s3, name,
    async getJSON(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: name, Key: key }));
        return JSON.parse(await r.Body.transformToString());
      } catch (e) {
        if (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) return null;
        throw e;
      }
    },
    putJSON(key, value) {
      return s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: JSON.stringify(value), ContentType: "application/json" }));
    },
    put(key, body, type) {
      return s3.send(new PutObjectCommand({ Bucket: name, Key: key, Body: body, ContentType: type || "application/octet-stream" }));
    },
    del(key) { return s3.send(new DeleteObjectCommand({ Bucket: name, Key: key })); },
    /* Every key under a prefix (follows pagination). */
    async list(prefix, delimiter) {
      const keys = [], prefixes = [];
      let token;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket: name, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token }));
        (r.Contents || []).forEach(o => keys.push({ key: o.Key, size: o.Size, modified: o.LastModified }));
        (r.CommonPrefixes || []).forEach(p => prefixes.push(p.Prefix));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return { keys, prefixes };
    },
    signGet(key, seconds, download) {
      return Promise.resolve(presign(s3.presignCreds, "GET", name, key, seconds || 3600,
        download ? { "response-content-disposition": `attachment; filename="${download.replace(/["\\]/g, "")}"` } : null));
    },
    signPut(key, type, seconds) {
      return Promise.resolve(presign(s3.presignCreds, "PUT", name, key, seconds || 900));
    }
  };
}

/* ---------- Session tokens: base64url(JSON).HMAC ---------- */
function secret() {
  return crypto.createHash("sha256").update("gsp|" + (env.SESSION_SECRET || "") + "|" + (env.ADMIN_PASSWORD || "") + "|" + (env.PORTAL_KEY || "")).digest();
}
export function signToken(payload, hours) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + (hours || 12) * 36e5 })).toString("base64url");
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return body + "." + sig;
}
export function readToken(header) {
  const t = String(header || "").replace(/^Bearer\s+/i, "");
  const [body, sig] = t.split(".");
  if (!body || !sig) return null;
  const want = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
export function sameSecret(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
export function uid() { return Date.now().toString(36) + crypto.randomBytes(4).toString("hex"); }

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function send(res, status, data, headers) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  Object.entries(headers || {}).forEach(([k, v]) => res.setHeader(k, v));
  res.end(JSON.stringify(data));
}
export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString();
  return raw ? JSON.parse(raw) : {};
}
