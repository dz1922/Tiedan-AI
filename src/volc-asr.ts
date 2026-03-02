/**
 * Volcano Engine streaming ASR
 * Protocol: wss://openspeech.bytedance.com/api/v2/asr
 */
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';

const getAppId = () => process.env.VOLC_APP_ID || '';
const getToken = () => process.env.VOLC_API_KEY || '';
const CLUSTER = 'volcengine_streaming_common';
const WS_URL = 'wss://openspeech.bytedance.com/api/v2/asr';

function buildMsg(msgType: number, msgFlags: number, serialization: number, compression: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header[0] = 0x11;
  header[1] = (msgType << 4) | msgFlags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32BE(payload.length);
  return Buffer.concat([header, sizeBuf, payload]);
}

export function recognize(pcmData: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    let finalText = '';

    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('ASR timeout'));
    }, 15000);

    const ws = new WebSocket(WS_URL, {
      headers: { 'X-Api-Key': getToken() }
    });

    ws.on('open', () => {
      const payload = Buffer.from(JSON.stringify({
        app: { appid: getAppId(), token: getToken(), cluster: CLUSTER },
        user: { uid: 'tiedan-device' },
        audio: { format: 'raw', rate: 16000, bits: 16, channel: 1, language: 'zh-CN' },
        request: { reqid: uuidv4(), workflow: 'audio_in,resample,partition,vad,fe,decode', sequence: 1, nbest: 1 }
      }));
      ws.send(buildMsg(0x1, 0x0, 0x1, 0x0, payload));

      const chunkSize = 3200;
      let offset = 0;
      const sendNext = () => {
        if (offset >= pcmData.length) {
          ws.send(buildMsg(0x2, 0x2, 0x0, 0x0, Buffer.alloc(0)));
          return;
        }
        const end = Math.min(offset + chunkSize, pcmData.length);
        const chunk = pcmData.slice(offset, end);
        const isLast = end >= pcmData.length;
        ws.send(buildMsg(0x2, isLast ? 0x2 : 0x0, 0x0, 0x0, chunk));
        offset = end;
        if (!isLast) setTimeout(sendNext, 20);
      };
      sendNext();
    });

    ws.on('message', (data: Buffer) => {
      const buf = Buffer.from(data);
      if (buf.length < 8) return;
      const msgType = (buf[1] >> 4) & 0xf;

      if (msgType === 0xf) {
        const code = buf.readUInt32BE(4);
        const mLen = buf.readUInt32BE(8);
        const msg = buf.slice(12, 12 + mLen).toString('utf-8');
        if (code === 1013 || msg.includes('1013')) {
          clearTimeout(timeout); ws.close(); resolve(''); return;
        }
        clearTimeout(timeout); ws.close(); reject(new Error(`ASR error ${code}: ${msg}`)); return;
      }

      if (msgType === 0x9) {
        const pLen = buf.readUInt32BE(4);
        try {
          const resp = JSON.parse(buf.slice(8, 8 + pLen).toString('utf-8'));
          if (resp.result) {
            if (Array.isArray(resp.result) && resp.result[0]?.text) finalText = resp.result[0].text;
            else if (resp.result.text) finalText = resp.result.text;
          }
          if (resp.code === 1013) { clearTimeout(timeout); ws.close(); resolve(''); return; }
          if (resp.sequence < 0) { clearTimeout(timeout); ws.close(); resolve(finalText); }
        } catch (_) {}
      }
    });

    ws.on('error', (err: Error) => { clearTimeout(timeout); reject(new Error('ASR websocket error: ' + err.message)); });
    ws.on('close', () => { clearTimeout(timeout); resolve(finalText); });
  });
}
