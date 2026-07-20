import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function allowedArtifact(pathname) {
  if (pathname === '/manifest.json') return 'manifest.json';
  const match = /^\/packs\/([A-Za-z0-9._-]+\.pack\.json)$/.exec(pathname);
  return match === null ? null : join('packs', match[1]);
}

function hasFreshValidator(request, etag, modifiedAt) {
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch !== undefined) return ifNoneMatch === etag;

  const ifModifiedSince = request.headers['if-modified-since'];
  if (ifModifiedSince === undefined) return false;
  const validatorTime = Date.parse(ifModifiedSince);
  return (
    Number.isFinite(validatorTime) &&
    Math.floor(modifiedAt.getTime() / 1_000) <=
      Math.floor(validatorTime / 1_000)
  );
}

export async function createSignedPackTestDeployment({
  directory,
  host = '127.0.0.1',
  port = 0,
}) {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
      const relativePath = allowedArtifact(pathname);
      if (relativePath === null) {
        response.writeHead(404);
        response.end();
        return;
      }

      const artifactPath = join(root, relativePath);
      const [bytes, metadata] = await Promise.all([
        readFile(artifactPath),
        stat(artifactPath),
      ]);
      const etag = `"${createHash('sha256').update(bytes).digest('hex')}"`;
      const headers = {
        'Cache-Control':
          relativePath === 'manifest.json'
            ? 'no-cache'
            : 'public, max-age=31536000, immutable',
        'Content-Length': bytes.byteLength,
        'Content-Type': 'application/json; charset=utf-8',
        ETag: etag,
        'Last-Modified': metadata.mtime.toUTCString(),
      };
      if (hasFreshValidator(request, etag, metadata.mtime)) {
        response.writeHead(304, headers);
        response.end();
        return;
      }

      response.writeHead(200, headers);
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        response.writeHead(404);
      } else {
        response.writeHead(500);
      }
      response.end();
    }
  });

  await new Promise((resolveListening, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test deployment did not bind a TCP port');
  }
  return {
    close: () => new Promise((resolveClose) => server.close(resolveClose)),
    url: `http://${host}:${address.port}`,
  };
}

async function main() {
  const directoryIndex = process.argv.indexOf('--directory');
  const portIndex = process.argv.indexOf('--port');
  const directory =
    directoryIndex === -1 ? undefined : process.argv[directoryIndex + 1];
  if (directory === undefined) {
    throw new Error('--directory is required');
  }
  const port = portIndex === -1 ? 8088 : Number(process.argv[portIndex + 1]);
  const deployment = await createSignedPackTestDeployment({ directory, port });
  process.stdout.write(`Signed-pack test deployment: ${deployment.url}\n`);
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
