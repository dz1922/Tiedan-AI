/**
 * Volcano Engine TTS V3 (Doubao Speech Synthesis 2.0)
 * WebSocket bidirectional streaming
 */
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { synthesize as edgeSynthesize } from './edge-tts.js';

const getApiKey = () => process.env.VOLC_API_KEY || '';
const TTS_URL = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';
const RESOURCE = 'seed-tts-2.0';

export const VOICES: Record<string, string> = {
  vivi: 'zh_female_vv_uranus_bigtts',
  xiaohe: 'zh_female_xiaohe_uranus_bigtts',
  yunzhou: 'zh_male_m191_uranus_bigtts',
  xiaotian: 'zh_male_taocheng_uranus_bigtts',
};

let currentVoice = 'zh_female_vv_uranus_bigtts';

function buildFrame(eventId: number, payload: string | object, sessionId?: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x11, 0x14, 0x10, 0x00]));
  const ev = Buffer.alloc(4); ev.writeUInt32BE(eventId); parts.push(ev);
  if (sessionId) {
    const s = Buffer.from(sessionId);
    const l = Buffer.alloc(4); l.writeUInt32BE(s.length);
    parts.push(l, s);
  }
  const p = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const pl = Buffer.alloc(4); pl.writeUInt32BE(p.length);
  parts.push(pl, p);
  return Buffer.concat(parts);
}

export async function synthesize(text: string, voiceId?: string): Promise<Buffer> {
  const voice = voiceId || currentVoice;

  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const sessionId = uuidv4();
      const audioBufs: Buffer[] = [];
      let resolved = false;

      const ws = new WebSocket(TTS_URL, {
        headers: {
          'X-Api-Key': getApiKey(),
          'X-Api-Resource-Id': RESOURCE,
          'X-Api-Connect-Id': uuidv4(),
        }
      });

      const timeout = setTimeout(() => {
        if (!resolved) { resolved = true; ws.close(); reject(new Error('TTS timeout')); }
      }, 10000);

      ws.on('open', () => ws.send(buildFrame(1, '{}')));

      ws.on('message', (d: Buffer) => {
        const buf = Buffer.from(d);
        const msgType = (buf[1] >> 4) & 0xf;
        const flags = buf[1] & 0xf;
        let off = 4, evtId = 0;
        if (flags & 0x4) { evtId = buf.readUInt32BE(off); off += 4; }

        if (msgType === 0xb) {
          if (evtId >= 100 && off + 4 <= buf.length) {
            const sl = buf.readUInt32BE(off); off += 4 + sl;
          }
          if (off + 4 <= buf.length) {
            const pl = buf.readUInt32BE(off); off += 4;
            audioBufs.push(buf.slice(off, off + pl));
          }
          return;
        }

        if (msgType === 0xf) {
          const str = buf.toString('utf-8');
          const j = str.indexOf('{');
          const err = j >= 0 ? str.substring(j) : 'unknown';
          if (!resolved) { resolved = true; clearTimeout(timeout); ws.close(); reject(new Error(err)); }
          return;
        }

        if (evtId === 50) {
          ws.send(buildFrame(100, {
            event: 1,
            namespace: 'BidirectionalTTS',
            req_params: { speaker: voice, audio_params: { format: 'mp3', sample_rate: 24000 } }
          }, sessionId));
          setTimeout(() => {
            ws.send(buildFrame(200, {
              event: 1,
              namespace: 'BidirectionalTTS',
              req_params: { text }
            }, sessionId));
            setTimeout(() => ws.send(buildFrame(102, '{}', sessionId)), 50);
          }, 50);
        }

        if (evtId === 152) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            audioBufs.length > 0 ? resolve(Buffer.concat(audioBufs)) : reject(new Error('No audio received'));
          }
        }
      });

      ws.on('error', (e: Error) => {
        if (!resolved) { resolved = true; clearTimeout(timeout); reject(e); }
      });
    });
  } catch (e: any) {
    console.log(`[TTS] Volcano TTS failed (${e.message}), falling back to Edge TTS`);
    return edgeSynthesize(text);
  }
}

export function setVoice(v: string): void { currentVoice = v; }
