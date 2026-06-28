/**
 * AWS Signature Version 4 request signing.
 *
 * The Bedrock Runtime endpoints authenticate every call with a SigV4 signature
 * rather than a bearer token, so each request must be signed from its method,
 * path, headers and body. {@link signRequest} performs the three-stage SigV4
 * computation — assemble the canonical request, fold it into the string to sign,
 * then derive the date/region/service signing key and HMAC it — and returns the
 * `x-amz-date`, `authorization` and (when a session token is configured)
 * `x-amz-security-token` headers to attach to the outgoing `fetch`.
 *
 * The `host` header is signed but deliberately left out of the returned set:
 * `fetch` populates it automatically from the URL, and its value matches the one
 * folded into the signature here.
 */

import { createHash, createHmac } from "node:crypto";

/** Fixed signing algorithm identifier that prefixes the `Authorization` header. */
const ALGORITHM = "AWS4-HMAC-SHA256";
/** Terminating string that closes the credential scope and the key-derivation chain. */
const TERMINATOR = "aws4_request";

/** AWS credentials plus the inputs needed to scope a signature. */
export interface SignArgs {
  /** Uppercase HTTP method, e.g. `"POST"`. */
  method: string;
  /** Absolute request URL; its path must already be percent-encoded for transport. */
  url: string;
  /** Signing service name, e.g. `"bedrock"`. */
  service: string;
  /** AWS region the request targets, e.g. `"us-east-1"`. */
  region: string;
  /** Long-term or temporary AWS credentials. */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Value of the `content-type` header, which participates in the signature. */
  contentType: string;
  /** Request body, hashed verbatim into the canonical request. */
  body: string;
  /** Clock reading used for the `x-amz-date` stamp; defaults to the current time. */
  now?: Date;
}

/**
 * Percent-encode a string per RFC 3986, encoding the few characters that
 * `encodeURIComponent` leaves untouched but SigV4 still requires escaped.
 *
 * @param value - The raw value to encode (a path segment or model identifier).
 * @returns The fully escaped value.
 */
export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Hex-encoded SHA-256 digest of a UTF-8 string. */
function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** One HMAC-SHA256 round, accepting a string or raw-byte key. */
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Derive the SigV4 signing key by chaining HMACs over the date, region, service
 * and terminator, starting from the secret access key.
 */
function signingKey(secret: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, TERMINATOR);
}

/**
 * Split a timestamp into the two forms SigV4 needs: the full `x-amz-date`
 * (`YYYYMMDDTHHMMSSZ`) and the `YYYYMMDD` date stamp used in the credential scope.
 */
function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Canonicalize a request path. Bedrock is not S3, so SigV4 encodes the path a
 * second time: the supplied `pathname` is already transport-encoded, and each
 * segment is escaped once more (slashes between segments are preserved).
 */
function canonicalUri(pathname: string): string {
  return pathname.split("/").map((seg) => encodeRfc3986(seg)).join("/");
}

/**
 * Sign a request with AWS Signature Version 4.
 *
 * Builds the canonical request from the method, doubly-encoded path, sorted
 * canonical headers (`content-type`, `host`, `x-amz-date`, and the security
 * token when present) and the payload hash; hashes it into the string to sign
 * under the date/region/service scope; then signs that with the derived key.
 *
 * @param args - The request and credentials to sign.
 * @returns The headers to add to the request: `content-type`, `x-amz-date`,
 *   `authorization`, and `x-amz-security-token` when a session token is set.
 */
export function signRequest(args: SignArgs): Record<string, string> {
  const now = args.now ?? new Date();
  const { amzDate, dateStamp } = amzDates(now);
  const parsed = new URL(args.url);

  // Headers folded into the signature. `host` is included here for the
  // canonical request but is not returned (fetch sets it from the URL).
  const signed: Record<string, string> = {
    "content-type": args.contentType,
    host: parsed.host,
    "x-amz-date": amzDate,
  };
  if (args.credentials.sessionToken) signed["x-amz-security-token"] = args.credentials.sessionToken;

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");

  // The Converse endpoints carry no query string; the canonical query is empty.
  const canonicalRequest = [
    args.method,
    canonicalUri(parsed.pathname),
    parsed.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(args.body),
  ].join("\n");

  const scope = `${dateStamp}/${args.region}/${args.service}/${TERMINATOR}`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const key = signingKey(args.credentials.secretAccessKey, dateStamp, args.region, args.service);
  const signature = createHmac("sha256", key).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `${ALGORITHM} Credential=${args.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const out: Record<string, string> = {
    "content-type": args.contentType,
    "x-amz-date": amzDate,
    authorization,
  };
  if (args.credentials.sessionToken) out["x-amz-security-token"] = args.credentials.sessionToken;
  return out;
}
