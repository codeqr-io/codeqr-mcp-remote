import { describe, expect, it, vi } from 'vitest';
import { handleToolCall, TOOLS, type ToolOutcome } from '../src/routes/mcp.js';

// Any property access on this client is a call that should never have happened.
const untouchable = new Proxy({}, {
  get: () => {
    throw new Error('the API was called');
  },
});

async function call(name: string, args: Record<string, unknown> | undefined) {
  let outcome: ToolOutcome | undefined;
  const result = await handleToolCall(untouchable as never, 'key', name, args as Record<string, unknown>, (ended) => {
    outcome = ended;
  });
  return { result, outcome, text: result.content.map((c) => c.text).join('\n') };
}

describe('a call without a required argument', () => {
  it.each([
    ['update_link', {}, 'linkId'],
    ['delete_qrcode', { qrcodeId: '' }, 'qrcodeId'],
    ['get_analytics', { event: 'scans' }, 'groupBy'],
    ['create_tag', undefined, 'name'],
  ])('%s is refused naming the argument, before any API call', async (name, args, argument) => {
    const { result, outcome, text } = await call(name, args);

    expect(result.isError).toBe(true);
    expect(outcome).toBe('invalid_arguments');
    expect(text).toContain(`${name} needs ${argument}`);
  });

  it('repeats what the argument is, so the model knows what to ask the person', async () => {
    const { text } = await call('create_link', {});
    const urlDescription = (TOOLS.find((t) => t.name === 'create_link')!.inputSchema.properties as Record<string, { description: string }>).url.description;

    expect(text).toContain(urlDescription);
  });

  it('lets a call with every required argument through to the API', async () => {
    const client = { links: { delete: vi.fn().mockResolvedValue({ id: 'link_1' }) } };

    const result = await handleToolCall(client as never, 'key', 'delete_link', { linkId: 'link_1' });

    expect(result.isError).toBeUndefined();
    expect(client.links.delete).toHaveBeenCalledWith('link_1');
  });
});
