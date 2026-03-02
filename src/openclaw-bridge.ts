/**
 * OpenClaw Gateway Bridge
 * WebSocket connection to Gateway using chat.send / chat.history
 */
import WebSocket from 'ws';
import { randomUUID } from 'crypto';
import fs from 'fs';

const TOKEN = (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync('/root/.openclaw/openclaw.json', 'utf-8'));
    return cfg.gateway?.auth?.token || '';
  } catch { return ''; }
})();

const GW_URL = process.env.GATEWAY_URL || 'ws://127.0.0.1:18789/ws';

type Resolver = (msg: any) => void;

class OpenClawBridge {
  ws: WebSocket | null = null;
  connected = false;
  pending = new Map<string, Resolver>();
  chatDoneResolvers = new Map<string, () => void>();

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GW_URL);

      this.ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());

        if (msg.type === 'res' && msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
          return;
        }

        if (msg.event === 'connect.challenge' && !this.connected) {
          this.connected = true;
          this._req('connect', {
            minProtocol: 3, maxProtocol: 3,
            client: { id: 'gateway-client', version: '0.1.0', platform: 'linux', mode: 'backend' },
            auth: { token: TOKEN },
            role: 'operator', scopes: ['operator.admin']
          }).then((hello: any) => {
            if (hello.ok) { console.log('[bridge] Gateway connected'); resolve(); }
            else reject(new Error('Gateway auth failed: ' + JSON.stringify(hello.error)));
          });
          return;
        }

        if (msg.event === 'chat' && msg.payload?.state === 'final') {
          const runId = msg.payload.runId;
          if (this.chatDoneResolvers.has(runId)) {
            this.chatDoneResolvers.get(runId)!();
            this.chatDoneResolvers.delete(runId);
          }
        }
      });

      this.ws.on('error', (err: Error) => {
        console.error('[bridge] Gateway error:', err.message);
        reject(err);
      });

      this.ws.on('close', () => {
        console.log('[bridge] Gateway disconnected, reconnecting in 3s...');
        this.connected = false;
        setTimeout(() => this.connect().catch(console.error), 3000);
      });
    });
  }

  _req(method: string, params: any): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  async chat(message: string, sessionKey = 'agent:main:tiedan'): Promise<string> {
    const sendResp = await this._req('chat.send', {
      sessionKey, idempotencyKey: randomUUID(), message,
    });
    if (!sendResp.ok) throw new Error('chat.send failed: ' + JSON.stringify(sendResp.error));

    const runId = sendResp.payload?.runId;
    await new Promise<void>((resolve) => {
      if (runId) this.chatDoneResolvers.set(runId, resolve);
      setTimeout(() => { this.chatDoneResolvers.delete(runId); resolve(); }, 30000);
    });

    const histResp = await this._req('chat.history', { sessionKey, limit: 3 });
    const messages = histResp.payload?.messages || [];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        const content = messages[i].content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('');
      }
    }
    return 'Sorry, no response received.';
  }
}

export const bridge = new OpenClawBridge();
