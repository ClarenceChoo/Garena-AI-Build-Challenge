export class RequestBodyTooLargeError extends Error {
  constructor(maximumBytes: number) {
    super(`Request body must be ${maximumBytes} bytes or smaller.`);
    this.name = "RequestBodyTooLargeError";
  }
}

async function readRequestBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      throw new RequestBodyTooLargeError(maximumBytes);
    }
  }

  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RequestBodyTooLargeError(maximumBytes);
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readJsonRequest(request: Request, maximumBytes: number): Promise<unknown> {
  const body = await readRequestBytes(request, maximumBytes);
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}

export async function readTextRequest(request: Request, maximumBytes: number): Promise<string> {
  return new TextDecoder().decode(await readRequestBytes(request, maximumBytes));
}

export async function readFormDataRequest(request: Request, maximumBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLocaleLowerCase().startsWith("multipart/form-data")) {
    throw new TypeError("Request body must use multipart form data.");
  }
  const body = await readRequestBytes(request, maximumBytes);
  return new Response(body, { headers: { "Content-Type": contentType } }).formData();
}
