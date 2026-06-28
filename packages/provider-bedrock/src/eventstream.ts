/**
 * Decoder for the binary `application/vnd.amazon.eventstream` framing used by
 * the Bedrock Runtime streaming endpoint.
 *
 * Each message is a self-describing frame: an 8-byte prelude (total length and
 * headers length, big-endian), a 4-byte prelude CRC, a block of typed headers, a
 * JSON payload, and a trailing 4-byte message CRC. {@link decodeEventStream}
 * buffers the arbitrarily-chunked response body, slices out whole frames as they
 * complete, and yields each frame's headers and raw payload. The CRC fields are
 * read past but not verified — structural framing is all the consumer needs to
 * locate and parse the JSON events.
 */

/** A single decoded event-stream frame: its string headers and raw JSON payload. */
export interface EventStreamMessage {
  /** Frame headers, e.g. `:event-type`, `:message-type`, `:content-type`. */
  headers: Record<string, string>;
  /** Raw payload bytes; for Bedrock events this is a UTF-8 JSON document. */
  payload: Uint8Array;
}

/** Header value type tag for a UTF-8 string, the only type Bedrock uses for the headers we read. */
const HEADER_TYPE_STRING = 7;

/** Read a big-endian unsigned 32-bit integer at `off`. */
function readUint32(b: Uint8Array, off: number): number {
  return ((b[off]! << 24) | (b[off + 1]! << 16) | (b[off + 2]! << 8) | b[off + 3]!) >>> 0;
}

/** Append two byte spans, short-circuiting when either side is empty. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Advance past a header value whose type is not a string, returning the new
 * offset. The wire format assigns a fixed or length-prefixed size to every type;
 * handling them all keeps the parser robust against headers we don't consume.
 */
function skipHeaderValue(b: Uint8Array, off: number, valueType: number): number {
  switch (valueType) {
    case 0: // boolean true
    case 1: // boolean false
      return off;
    case 2: // byte
      return off + 1;
    case 3: // short
      return off + 2;
    case 4: // integer
      return off + 4;
    case 5: // long
      return off + 8;
    case 6: // byte array (2-byte length prefix)
    case HEADER_TYPE_STRING: {
      const len = (b[off]! << 8) | b[off + 1]!;
      return off + 2 + len;
    }
    case 8: // timestamp
      return off + 8;
    case 9: // uuid
      return off + 16;
    default:
      // Unknown type: nothing safe to skip, stop consuming this header block.
      return b.length;
  }
}

/** Parse the header block of a frame into a name→value map of its string headers. */
function parseHeaders(b: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const dec = new TextDecoder();
  let i = 0;
  while (i < b.length) {
    const nameLen = b[i]!;
    i += 1;
    const name = dec.decode(b.subarray(i, i + nameLen));
    i += nameLen;
    const valueType = b[i]!;
    i += 1;
    if (valueType === HEADER_TYPE_STRING) {
      const valLen = (b[i]! << 8) | b[i + 1]!;
      i += 2;
      out[name] = dec.decode(b.subarray(i, i + valLen));
      i += valLen;
    } else {
      i = skipHeaderValue(b, i, valueType);
    }
  }
  return out;
}

/** Split one complete frame into its headers and payload, discarding the CRC fields. */
function decodeFrame(frame: Uint8Array): EventStreamMessage {
  const totalLen = readUint32(frame, 0);
  const headersLen = readUint32(frame, 4);
  // Bytes 8..12 hold the prelude CRC, which we read past without verifying.
  const headersStart = 12;
  const headersEnd = headersStart + headersLen;
  const headers = parseHeaders(frame.subarray(headersStart, headersEnd));
  // The final 4 bytes are the message CRC; the payload is everything before it.
  const payload = frame.subarray(headersEnd, totalLen - 4);
  return { headers, payload };
}

/**
 * Decode a chunked event-stream body into a sequence of framed messages.
 *
 * Bytes arrive in arbitrary chunks, so the reader accumulates them and emits a
 * frame only once its declared total length is fully buffered; any trailing
 * partial frame is carried forward to the next chunk.
 *
 * @param body - The streaming response body as an async iterable of byte chunks.
 * @returns An async generator of decoded {@link EventStreamMessage}s.
 */
export async function* decodeEventStream(body: AsyncIterable<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  let buf: Uint8Array = new Uint8Array(0);
  for await (const chunk of body) {
    buf = concat(buf, chunk);
    while (buf.length >= 4) {
      const totalLen = readUint32(buf, 0);
      // A valid frame is at least its 16 bytes of framing overhead.
      if (totalLen < 16 || buf.length < totalLen) break;
      yield decodeFrame(buf.subarray(0, totalLen));
      buf = buf.subarray(totalLen);
    }
  }
}
