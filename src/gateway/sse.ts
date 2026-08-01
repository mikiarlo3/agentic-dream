// SSE utilities for the Anthropic Messages streaming format.

export interface SseEvent {
  event: string;
  data: unknown;
  raw: string; // original wire framing, byte-faithful for passthrough
}

/** Incremental SSE parser. Feed chunks, get complete events. */
export class SseParser {
  private buf = '';

  feed(chunk: string): SseEvent[] {
    this.buf += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const rawBlock = this.buf.slice(0, idx + 2);
      this.buf = this.buf.slice(idx + 2);
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of rawBlock.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (dataLines.length === 0) continue;
      let data: unknown = dataLines.join('\n');
      try {
        data = JSON.parse(dataLines.join('\n'));
      } catch {
        /* keep as string */
      }
      events.push({ event, data, raw: rawBlock });
    }
    return events;
  }
}

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface AccumulatedMessage {
  id: string;
  model: string;
  role: 'assistant';
  content: Array<Record<string, unknown>>;
  stop_reason: string | null;
  usage: { input_tokens?: number; output_tokens?: number };
}

/**
 * Rebuilds the final assistant message from a stream of Anthropic SSE events.
 * Used to capture streamed responses into the store while bytes pass through
 * to the client untouched.
 */
export class MessageAccumulator {
  message: AccumulatedMessage = { id: '', model: '', role: 'assistant', content: [], stop_reason: null, usage: {} };
  done = false;
  private toolJson: Map<number, string> = new Map();

  feedEvent(ev: SseEvent): void {
    const d = ev.data as Record<string, unknown> | undefined;
    if (!d || typeof d !== 'object') return;
    switch (ev.event) {
      case 'message_start': {
        const m = d.message as Record<string, unknown> | undefined;
        if (m) {
          this.message.id = String(m.id ?? '');
          this.message.model = String(m.model ?? '');
          const u = m.usage as AccumulatedMessage['usage'] | undefined;
          if (u) this.message.usage = { ...u };
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(d.index ?? this.message.content.length);
        const block = { ...(d.content_block as Record<string, unknown>) };
        if (block.type === 'tool_use') {
          block.input = block.input ?? {};
          this.toolJson.set(index, '');
        }
        this.message.content[index] = block;
        break;
      }
      case 'content_block_delta': {
        const index = Number(d.index ?? 0);
        const delta = d.delta as Record<string, unknown> | undefined;
        const block = this.message.content[index];
        if (!delta || !block) break;
        if (delta.type === 'text_delta') block.text = String(block.text ?? '') + String(delta.text ?? '');
        else if (delta.type === 'input_json_delta') this.toolJson.set(index, (this.toolJson.get(index) ?? '') + String(delta.partial_json ?? ''));
        else if (delta.type === 'thinking_delta') block.thinking = String(block.thinking ?? '') + String(delta.thinking ?? '');
        break;
      }
      case 'content_block_stop': {
        const index = Number(d.index ?? 0);
        const block = this.message.content[index];
        const json = this.toolJson.get(index);
        if (block && block.type === 'tool_use' && json !== undefined) {
          try {
            block.input = json.trim() === '' ? {} : JSON.parse(json);
          } catch {
            block.input = {};
          }
        }
        break;
      }
      case 'message_delta': {
        const delta = d.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) this.message.stop_reason = String(delta.stop_reason);
        const u = d.usage as AccumulatedMessage['usage'] | undefined;
        if (u) this.message.usage = { ...this.message.usage, ...u };
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
    }
  }
}
