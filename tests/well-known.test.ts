import request from 'supertest';
import { describe, expect, it } from 'vitest';

// Importing src/index.ts would otherwise start a listener.
process.env.VERCEL = '1';

const app = (await import('../src/index.js')).default;

const ORIGIN = 'https://mcp.example.test';

function asPublicHost(req: request.Test) {
  return req.set('x-forwarded-proto', 'https').set('x-forwarded-host', 'mcp.example.test');
}

function resourceMetadataOf(header: string | undefined): string | undefined {
  return header?.match(/resource_metadata="([^"]+)"/)?.[1];
}

describe('protected resource metadata', () => {
  it('names /mcp as the resource at the path-suffixed location', async () => {
    const res = await asPublicHost(request(app).get('/.well-known/oauth-protected-resource/mcp'));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });

  it('keeps the root document for clients that connect to the bare origin', async () => {
    const res = await asPublicHost(request(app).get('/.well-known/oauth-protected-resource'));

    expect(res.body).toMatchObject({ resource: ORIGIN, authorization_servers: [ORIGIN] });
  });
});

describe('401 discovery pointer', () => {
  it('sends a client of /mcp to the document whose resource is /mcp', async () => {
    const res = await asPublicHost(request(app).post('/mcp').send({}));
    const pointer = resourceMetadataOf(res.headers['www-authenticate']);

    expect(res.status).toBe(401);
    expect(pointer).toBe(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);

    const metadata = await asPublicHost(request(app).get(new URL(pointer!).pathname));
    expect(metadata.body.resource).toBe(`${ORIGIN}/mcp`);
  });

  it('treats /mcp/ and /MCP, which Express routes to the same handler, as /mcp', async () => {
    for (const path of ['/mcp/', '/MCP']) {
      const res = await asPublicHost(request(app).post(path).send({}));

      expect(res.status, path).toBe(401);
      expect(resourceMetadataOf(res.headers['www-authenticate']), path).toBe(
        `${ORIGIN}/.well-known/oauth-protected-resource/mcp`,
      );
    }
  });

  it('sends a client of the bare origin to the root document', async () => {
    const res = await asPublicHost(request(app).post('/').send({}));

    expect(res.status).toBe(401);
    expect(resourceMetadataOf(res.headers['www-authenticate'])).toBe(`${ORIGIN}/.well-known/oauth-protected-resource`);
  });
});
