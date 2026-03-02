/**
 * Volcano Engine Realtime Dialogue API - Hybrid architecture module
 *
 * Flow: User audio → Volcano(VAD+ASR) → text → OpenClaw AI → Edge/Volcano TTS → audio
 * Key: Discard built-in Doubao AI default TTS, only use our ChatTTSText output
 */
import WebSocket from 'ws';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

const REALTIME_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
// Read at call time, not import time (ESM hoists imports before dotenv.config)
const getApiKey = () => process.env.VOLC_API_KEY || '';
const getAppKey = () => process.env.VOLC_APP_KEY || '';

export const CLIENT_EVT = {
  StartConnection: 1, FinishConnection: 2,
  StartSession: 100, FinishSession: 102, TaskRequest: 200,
  SayHello: 300, ChatTTSText: 500, ChatTextQuery: 501,
  ChatRAGText: 502, ConversationCreate: 510,
  ConversationUpdate: 511, ConversationRetrieve: 512, ConversationDelete: 514,
} as const;

export const SERVER_EVT = {
  ConnectionStarted: 50, ConnectionFailed: 51, ConnectionFinished: 52,
  SessionStarted: 150, SessionFinished: 152, SessionFailed: 153, UsageResponse: 154,
  TTSSentenceStart: 350, TTSSentenceEnd: 351, TTSResponse: 352, TTSEnded: 359,
  ASRInfo: 450, ASRResponse: 451, ASREnded: 459,
  ChatResponse: 550, ChatTextQueryConfirmed: 553, ChatEnded: 559,
  ConversationCreated: 567, DialogCommonError: 599,
} as const;

interface RealtimeOptions {
  botName?: string;
  systemRole?: string;
  speakingStyle?: string;
  model?: string;
  endSilenceMs?: number;
  dialogId?: string;
}

interface ParsedMessage {
  msgType: number;
  eventId?: number;
  sessionId?: string;
  payload?: any;
  audio?: Buffer;
  raw?: string;
}

function buildTextFrame(eventId: number, payload: string | object, sessionId?: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x11, 0x14, 0x10, 0x00]));
  const ev = Buffer.alloc(4); ev.writeUInt32BE(eventId); parts.push(ev);
  if (sessionId) {
    const sid = Buffer.from(sessionId, 'utf-8');
    const sl = Buffer.alloc(4); sl.writeUInt32BE(sid.length);
    parts.push(sl, sid);
  }
  const p = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const pl = Buffer.alloc(4); pl.writeUInt32BE(p.length);
  parts.push(pl, p);
  return Buffer.concat(parts);
}

function buildAudioFrame(pcmChunk: Buffer, sessionId: string): Buffer {
  const parts: Buffer[] = [];
  parts.push(Buffer.from([0x11, 0x24, 0x00, 0x00]));
  const ev = Buffer.alloc(4); ev.writeUInt32BE(CLIENT_EVT.TaskRequest); parts.push(ev);
  const sid = Buffer.from(sessionId, 'utf-8');
  const sl = Buffer.alloc(4); sl.writeUInt32BE(sid.length);
  parts.push(sl, sid);
  const pl = Buffer.alloc(4); pl.writeUInt32BE(pcmChunk.length);
  parts.push(pl, pcmChunk);
  return Buffer.concat(parts);
}

function parseResponse(buf: Buffer): ParsedMessage | null {
  if (buf.length < 4) return null;
  const msgType = (buf[1] >> 4) & 0xf;
  const flags = buf[1] & 0xf;
  const serial = (buf[2] >> 4) & 0xf;

  let offset = 4;
  let eventId = 0;
  let sessionId = '';

  if (flags & 0x4) {
    if (offset + 4 > buf.length) return { msgType };
    eventId = buf.readUInt32BE(offset); offset += 4;
  }

  if (eventId >= 150 || (msgType === 0xb && eventId >= 100)) {
    if (offset + 4 <= buf.length) {
      const sidLen = buf.readUInt32BE(offset); offset += 4;
      if (sidLen > 0 && sidLen < 256 && offset + sidLen <= buf.length) {
        sessionId = buf.slice(offset, offset + sidLen).toString('utf-8');
        offset += sidLen;
      }
    }
  }

  if (offset + 4 > buf.length) return { msgType, eventId, sessionId };
  const payloadSize = buf.readUInt32BE(offset); offset += 4;

  const result: ParsedMessage = { msgType, eventId, sessionId };

  if (serial === 0x1 && msgType !== 0xb) {
    try { result.payload = JSON.parse(buf.slice(offset, offset + payloadSize).toString('utf-8')); }
    catch { result.raw = buf.slice(offset, offset + payloadSize).toString('utf-8'); }
  } else {
    result.audio = buf.slice(offset, offset + payloadSize);
  }
  return result;
}

export class RealtimeSession extends EventEmitter {
  sessionId = uuidv4();
  connectId = uuidv4();
  ws: WebSocket | null = null;
  state = 'init';
  dialogId = '';
  private _asrText = '';
  private _currentTTSType = '';
  private _resolveConnect: ((v: any) => void) | null = null;
  private _passthrough = false;
  private options: Required<RealtimeOptions>;

  constructor(options: RealtimeOptions = {}) {
    super();
    this.options = {
      botName: options.botName || 'Tiedan',
      systemRole: options.systemRole || '',
      speakingStyle: options.speakingStyle || '',
      model: options.model || 'O',
      endSilenceMs: options.endSilenceMs || 1200,
      dialogId: options.dialogId || '',
    };
  }

  async connect(): Promise<this> {
    return new Promise((resolve, reject) => {
      this._resolveConnect = resolve;

      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          'X-Api-Key': getApiKey(),
          'X-Api-App-Key': getAppKey(),
          'X-Api-Resource-Id': 'volc.speech.dialog',
          'X-Api-Connect-Id': this.connectId,
        }
      });

      this.ws.on('open', () => {
        this.state = 'connecting';
        this.ws!.send(buildTextFrame(CLIENT_EVT.StartConnection, {}));
      });

      this.ws.on('message', (data: Buffer) => this._onMessage(Buffer.from(data)));
      this.ws.on('unexpected-response', (_req: any, res: any) => {
        let body = '';
        res.on('data', (chunk: Buffer) => body += chunk.toString());
        res.on('end', () => {
          const msg = `Volcano WS rejected: ${res.statusCode} ${body}`;
          console.error('[volc-realtime]', msg);
          this.emit('error', msg);
          reject(new Error(msg));
        });
      });
      this.ws.on('error', (e: Error) => { this.emit('error', e.message); reject(e); });
      this.ws.on('close', (code: number) => { this.state = 'closed'; this.emit('closed', code); });

      setTimeout(() => {
        if (this.state === 'connecting') { reject(new Error('Connection timeout')); this.close(); }
      }, 10000);
    });
  }

  private _onMessage(buf: Buffer): void {
    const msg = parseResponse(buf);
    if (!msg) return;
    const { msgType, eventId, payload, audio, raw } = msg;

    if (msgType === 0x9) {
      switch (eventId) {
        case SERVER_EVT.ConnectionStarted:
          this.state = 'connected';
          this._sendStartSession();
          break;
        case SERVER_EVT.SessionStarted:
          this.state = 'session';
          this.dialogId = payload?.dialog_id || '';
          this.emit('ready', this.dialogId);
          if (this._resolveConnect) { this._resolveConnect(this); this._resolveConnect = null; }
          break;
        case SERVER_EVT.ASRResponse:
          if (payload?.results?.[0]) {
            const r = payload.results[0];
            this._asrText = r.text || this._asrText;
            this.emit('asr', r.text, r.is_interim);
          }
          if (payload?.extra?.origin_text) {
            this._asrText = payload.extra.origin_text;
            this.emit('asr', this._asrText, true);
          }
          break;
        case SERVER_EVT.ASREnded:
          this.emit('asr_end', this._asrText);
          break;
        case SERVER_EVT.ASRInfo:
          this.emit('asr_info', payload?.question_id);
          break;
        case SERVER_EVT.ChatResponse:
          this.emit('ai_text', payload?.content, payload?.question_id);
          break;
        case SERVER_EVT.TTSSentenceStart:
          this._currentTTSType = payload?.tts_type || 'default';
          this.emit('tts_start', this._currentTTSType, payload?.text);
          break;
        case SERVER_EVT.TTSSentenceEnd:
        case SERVER_EVT.TTSEnded:
          this.emit('tts_end');
          break;
        case SERVER_EVT.UsageResponse:
          this.emit('usage', payload?.usage);
          break;
        case SERVER_EVT.DialogCommonError:
          const errMsg = payload?.message || raw || 'unknown';
          if (!errMsg.includes('AudioIdleTimeout')) this.emit('error', errMsg);
          break;
        case SERVER_EVT.SessionFailed:
          this.emit('error', 'Session failed: ' + (payload?.error || ''));
          break;
        default:
          if (payload?.status_code && payload?.message && payload.status_code !== '52000030') {
            this.emit('error', `${payload.message} (${payload.status_code})`);
          }
          break;
      }
      return;
    }

    if (msgType === 0xb && audio) {
      if (this._passthrough || this._currentTTSType === 'chat_tts_text') {
        this.emit('tts_audio', audio);
      }
      return;
    }

    if (msgType === 0xf) {
      const errText = payload?.error || raw || '';
      if (!errText.includes('AudioIdleTimeout')) this.emit('error', errText);
    }
  }

  private _sendStartSession(): void {
    const config: any = {
      asr: { extra: { end_smooth_window_ms: this.options.endSilenceMs } },
      dialog: {
        bot_name: this.options.botName,
        system_role: this.options.systemRole || undefined,
        speaking_style: this.options.speakingStyle || undefined,
        extra: { model: this.options.model, strict_audit: false },
      }
    };
    if (this.options.dialogId) config.dialog.dialog_id = this.options.dialogId;
    this.ws!.send(buildTextFrame(CLIENT_EVT.StartSession, config, this.sessionId));
  }

  sendAudio(pcm: Buffer): void {
    if (!this.isReady) return;
    this.ws!.send(buildAudioFrame(pcm, this.sessionId));
  }

  sendTTSText(text: string): void {
    if (!this.isReady) return;
    this.ws!.send(buildTextFrame(CLIENT_EVT.ChatTTSText, { start: true, content: text, end: true }, this.sessionId));
  }

  sendTextQuery(text: string): void {
    if (!this.isReady) return;
    this.ws!.send(buildTextFrame(CLIENT_EVT.ChatTextQuery, { content: text }, this.sessionId));
  }

  finishSession(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(buildTextFrame(CLIENT_EVT.FinishSession, {}, this.sessionId));
    }
    this.state = 'finished';
  }

  close(): void {
    try { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buildTextFrame(CLIENT_EVT.FinishConnection, {})); } catch {}
    this.ws?.close();
    this.state = 'closed';
  }

  get isReady(): boolean {
    return this.state === 'session' && this.ws?.readyState === WebSocket.OPEN;
  }

  setPassthrough(on: boolean): void { this._passthrough = on; }
}

export default RealtimeSession;
