import { Readable } from 'node:stream';
import { handleHostedMcpRequest } from '../src/mcp/hosted-handler.mjs';

function requestUrl(request) {
  const forwarded = request.headers['x-forwarded-host'];
  const host = Array.isArray(forwarded) ? forwarded[0] : forwarded ?? request.headers.host ?? 'localhost';
  const protocol = request.headers['x-forwarded-proto'] === 'http' ? 'http' : 'https';
  return new URL(request.url ?? '/', `${protocol}://${host}`).href;
}

export function nodeRequestToWeb(request, signal) {
  if (request instanceof Request) return request;
  const method = request.method ?? 'GET';
  return new Request(requestUrl(request), {
    method,
    headers: request.headers,
    signal,
    ...(['GET', 'HEAD'].includes(method) ? {} : { body: request, duplex: 'half' }),
  });
}

export async function writeWebResponse(webResponse, response) {
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (!webResponse.body) {
    response.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(webResponse.body);
    stream.once('error', reject);
    response.once('error', reject);
    response.once('finish', resolve);
    const close = () => {
      if (!response.writableFinished) stream.destroy();
      resolve();
    };
    response.once('close', close);
    if (response.destroyed || response.closed) close();
    else stream.pipe(response);
  });
}

export default async function vercelHandler(request, response) {
  if (request instanceof Request || response === undefined) {
    return handleHostedMcpRequest(nodeRequestToWeb(request));
  }
  const controller = new AbortController();
  const abort = () => controller.abort(new DOMException('Client disconnected.', 'AbortError'));
  request.once('aborted', abort);
  response.once('close', () => {
    if (!response.writableFinished) abort();
  });
  const result = await handleHostedMcpRequest(nodeRequestToWeb(request, controller.signal));
  await writeWebResponse(result, response);
}
