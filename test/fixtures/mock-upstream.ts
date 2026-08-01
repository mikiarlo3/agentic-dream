// A fake Anthropic Messages API for keyless testing. Supports JSON and SSE
// responses, records requests for assertions, and can be scripted to demand
// a tool_use via the x-mock-script header:
//   x-mock-script: tool_use:dream_recall:{"query":"volume name"}
// After a tool_result arrives in the request, it answers with text that
// embeds the tool_result content, so tests can assert the loop closed.
import { createServer, type Server } from 'node:http';

export interface MockRequest {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export class MockUpstream {
  server: Server;
  requests: MockRequest[] = [];
  port = 0;
  /** Override the reply text per test. */
  replyText = (body: Record<string, unknown>) => {
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    return `mock reply to ${msgs.length} messages`;
  };

  constructor() {
    this.server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/v1/messages') {
        res.writeHead(404).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (!req.headers['x-api-key'] && !req.headers['authorization']) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing key' } }));
          return;
        }
        const body = JSON.parse(raw) as Record<string, unknown>;
        this.requests.push({ headers: req.headers, body });

        const script = String(req.headers['x-mock-script'] ?? '');
        const msgs = body.messages as Array<{ role: string; content: unknown }>;
        const hasToolResult = msgs.some(
          (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === 'tool_result'),
        );

        let content: Array<Record<string, unknown>>;
        let stopReason = 'end_turn';
        if (script.startsWith('tool_use:') && !hasToolResult) {
          const [, name, inputJson] = script.split(/:(.+?):(.+)/s).filter(Boolean) as [string, string, string];
          content = [
            { type: 'text', text: 'Let me check my memory.' },
            { type: 'tool_use', id: 'toolu_mock_1', name, input: JSON.parse(inputJson) },
          ];
          stopReason = 'tool_use';
        } else if (hasToolResult) {
          const trs = msgs
            .flatMap((m) => (Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
            .filter((b) => b.type === 'tool_result')
            .map((b) => (typeof b.content === 'string' ? b.content : JSON.stringify(b.content)));
          content = [{ type: 'text', text: `Based on my memory: ${trs.join(' | ')}` }];
        } else {
          content = [{ type: 'text', text: this.replyText(body) }];
        }

        const message = {
          id: `msg_mock_${this.requests.length}`,
          type: 'message',
          role: 'assistant',
          model: String(body.model ?? 'mock-model'),
          content,
          stop_reason: stopReason,
          stop_sequence: null,
          usage: { input_tokens: Math.ceil(raw.length / 4), output_tokens: 25 },
        };

        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          send('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
          message.content.forEach((block, index) => {
            if (block.type === 'text') {
              send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
              const text = String(block.text);
              const mid = Math.ceil(text.length / 2);
              send('ping', { type: 'ping' });
              send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(0, mid) } });
              send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(mid) } });
              send('content_block_stop', { type: 'content_block_stop', index });
            } else if (block.type === 'tool_use') {
              send('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
              send('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
              send('content_block_stop', { type: 'content_block_stop', index });
            }
          });
          send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 25 } });
          send('message_stop', { type: 'message_stop' });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(message));
        }
      });
    });
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.port = (this.server.address() as { port: number }).port;
        resolve(this.port);
      });
    });
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  lastRequest(): MockRequest | undefined {
    return this.requests[this.requests.length - 1];
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
