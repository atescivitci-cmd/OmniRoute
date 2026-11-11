import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { isLiteralLoopbackOllamaUrl } from './localOllamaAdmission.ts';
import { ZeroCostAdmissionError } from './zeroCostAdmission.ts';

/** Native-local admitted inference only. Explicit direct node:http socket avoids
 * global fetch/dispatcher/proxy mutation and never follows HTTP redirects.
 * Existing request headers/body and streaming/cancellation semantics are retained.
 * No routing setting is changed and no cloud provider uses this transport. */
export function directLocalFetch(url: string, options: RequestInit): Promise<Response> {
  if (!isLiteralLoopbackOllamaUrl(url) || options.method !== 'POST' || typeof options.body !== 'string') {
    return Promise.reject(new ZeroCostAdmissionError());
  }
  const headers = Object.fromEntries(new Headers(options.headers));
  // node:http does not transparently decompress; explicitly request plain bytes.
  headers['accept-encoding'] = 'identity';
  return new Promise((resolve,reject) => {
    const req = httpRequest(url, {method:'POST',agent:false,signal:options.signal ?? undefined,headers}, res => {
      const status = res.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        res.destroy(); reject(new ZeroCostAdmissionError()); return;
      }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.destroy(); reject(new Error('local_response_encoding_unsupported')); return;
      }
      const responseHeaders = new Headers();
      for (const [key,value] of Object.entries(res.headers)) {
        if (Array.isArray(value)) for (const part of value) responseHeaders.append(key,part);
        else if (typeof value === 'string') responseHeaders.set(key,value);
      }
      try {
        // Readable.toWeb cancellation destroys the native incoming stream.
        const body = [204,205,304].includes(status) ? null : Readable.toWeb(res);
        resolve(new Response(body as ReadableStream<Uint8Array> | null,{status,headers:responseHeaders}));
        if (body === null) res.resume();
      } catch (error) { res.destroy(); reject(error); }
    });
    req.on('error',reject); req.end(options.body);
  });
}
