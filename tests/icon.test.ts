import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Importing src/index.ts would otherwise start a listener.
process.env.VERCEL = '1';

const app = (await import('../src/index.js')).default;
const { ICON_PATH, ICON_PNG } = await import('../src/icon.js');
const { handleMcpRequest } = await import('../src/routes/mcp.js');

const pluginLogo = readFileSync(new URL('../plugin/assets/logo.png', import.meta.url));
const serverJson = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));

describe('icon', () => {
  it('is the plugin package logo, byte for byte', () => {
    expect(ICON_PNG.equals(pluginLogo)).toBe(true);
  });

  it('is served without a token', async () => {
    const res = await request(app).get(ICON_PATH);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Buffer.from(res.body).equals(pluginLogo)).toBe(true);
  });

  it('is what server.json advertises to the registry', () => {
    expect(serverJson.icons).toEqual([
      { src: `https://mcp.codeqr.io${ICON_PATH}`, mimeType: 'image/png', sizes: ['512x512'] },
    ]);
  });

  it('is announced in the MCP handshake, on the URL the client reached', async () => {
    const handshake = express();
    handshake.use(express.json());
    handshake.post('/mcp', (req, res, next) => {
      req.codeqrApiKey = 'cq_test_key';
      next();
    }, handleMcpRequest);

    const res = await request(handshake)
      .post('/mcp')
      .set('x-forwarded-proto', 'https')
      .set('x-forwarded-host', 'mcp.example.test')
      .set('Accept', 'application/json, text/event-stream')
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
        }),
      );

    const message = JSON.parse(res.text.split('\n').find((line) => line.startsWith('data: '))!.slice(6));
    expect(message.result.serverInfo.icons).toEqual([
      { src: `https://mcp.example.test${ICON_PATH}`, mimeType: 'image/png', sizes: ['512x512'] },
    ]);
  });
});
