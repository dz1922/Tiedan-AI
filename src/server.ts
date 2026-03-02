/**
 * Tiedan Backend API (Web PWA)
 *
 * WS   /ws/realtime   - Real-time voice dialogue (Volcano VAD+ASR → OpenClaw AI → Volcano TTS)
 * POST /api/chat/text - Text chat
 * GET  /api/health    - Health check
 */
import dotenv from 'dotenv';
dotenv.config({ path: new URL('../.env', import.meta.url).pathname });

process.on('unhandledRejection', (e: any) => console.error('[UNHANDLED]', e?.message || e));
process.on('uncaughtException', (e: Error) => console.error('[UNCAUGHT]', e?.message || e));

import express, { Request, Response, NextFunction } from 'express';
import https from 'https';
import multer from 'multer';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebSocketServer, WebSocket as WsWebSocket } from 'ws';
import { IncomingMessage } from 'http';
import type { Server } from 'http';

import { recognize } from './volc-asr.js';
import { synthesize as edgeSynthesize } from './edge-tts.js';
import { synthesize as volcSynthesize } from './volc-tts.js';
import { getRecipeSuggestion, saveRecipe, listRecipes, deleteRecipe } from './recipes.js';
import { getTodayReminders, createFamilyReminder } from './reminders.js';
import { notifyAll, notifyChannel, availableChannels } from './notify.js';
import { bridge } from './openclaw-bridge.js';
import RealtimeSession from './volc-realtime.js';
import { identify, registerVoice, listMembers } from './voiceprint-local.js';

// TTS with fallback
async function synthesize(text: string): Promise<Buffer> {
  try { return await volcSynthesize(text); }
  catch { return await edgeSynthesize(text); }
}

const FAMILY_MEMBERS: Record<string, string> = JSON.parse(
  process.env.FAMILY_MEMBERS || '{"dad":"Dad","mom":"Mom","kid1":"Kid1","kid2":"Kid2","grandpa":"Grandpa"}'
);

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.TIEDAN_PORT || 3100;
const API_TOKEN = process.env.TIEDAN_TOKEN || 'change-me';

// CORS
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Auth
app.use((req: Request, res: Response, next: NextFunction) => {
  if (['/api/health', '/', '/manifest.json'].includes(req.path)) return next();
  const token = req.headers['authorization']?.replace('Bearer ', '')
    || (req.headers['x-api-token'] as string)
    || (req.query.token as string);
  if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
});

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// Health
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', name: 'Tiedan AI', version: '0.2.0' });
});

// Text chat
app.post('/api/chat/text', async (req: Request, res: Response) => {
  try {
    const { text, user_id } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const reply = await getReply(text, user_id);
    let audio: string | null = null;
    try { const mp3 = await synthesize(reply); audio = mp3.toString('base64'); } catch {}
    res.json({ reply, audio });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Voiceprint register
app.post('/api/voiceprint/register', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const userId = req.body.user_id;
    if (!userId) return res.status(400).json({ error: 'user_id required' });
    if (!FAMILY_MEMBERS[userId] && !req.body.allow_custom) {
      return res.status(400).json({ error: 'unknown user_id', valid: Object.keys(FAMILY_MEMBERS) });
    }
    if (!req.file) return res.status(400).json({ error: 'audio file required' });

    const tmpIn = `/tmp/vp-${Date.now()}.webm`;
    const tmpOut = `/tmp/vp-${Date.now()}.pcm`;
    writeFileSync(tmpIn, req.file.buffer);
    try {
      execSync(`ffmpeg -y -i ${tmpIn} -f s16le -ar 16000 -ac 1 ${tmpOut} 2>/dev/null`);
      const pcm = readFileSync(tmpOut);
      const name = FAMILY_MEMBERS[userId] || req.body.name || userId;
      res.json(registerVoice(userId, name, pcm));
    } finally {
      try { unlinkSync(tmpIn); unlinkSync(tmpOut); } catch {}
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/voiceprint/members', (_req: Request, res: Response) => {
  res.json({ available: FAMILY_MEMBERS, registered: listMembers() });
});

// OpenClaw bridge
bridge.connect().catch((err: Error) => {
  console.error('[tiedan] Gateway connection failed:', err.message);
});

async function getReply(text: string, userId?: string): Promise<string> {
  try {
    const memberName = FAMILY_MEMBERS[userId || ''] || userId || 'family';
    const message = `🤖 [${memberName}] ${text}\n\n(Voice message from family assistant. Reply briefly in 1-3 sentences, no markdown.)`;
    const reply = await bridge.chat(message);
    let clean = reply.replace(/\*\*/g, '').replace(/\*/g, '').replace(/#{1,6}\s/g, '').replace(/`/g, '').trim();
    if (clean.length > 300) clean = clean.substring(0, 300) + '...';
    return clean;
  } catch (err: any) {
    console.error('[tiedan] AI error:', err.message);
    return 'Sorry, I had trouble processing that. Try again.';
  }
}

// Static
app.get('/', (_req: Request, res: Response) => res.sendFile(join(__dirname, 'pwa.html')));
app.get('/manifest.json', (_req: Request, res: Response) => res.sendFile(join(__dirname, 'manifest.json')));

// Recipes
app.get('/api/recipes', (req: Request, res: Response) => res.json(listRecipes(req.query.category as string)));
app.get('/api/recipes/suggest', (req: Request, res: Response) => {
  const people = parseInt(req.query.people as string) || 5;
  const prefs = req.query.preferences ? (req.query.preferences as string).split(',') : [];
  res.json(getRecipeSuggestion(people, prefs));
});
app.post('/api/recipes', (req: Request, res: Response) => {
  const { name, ingredients, steps, category, tags } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  res.json(saveRecipe(name, ingredients || [], steps || [], category, tags));
});
app.delete('/api/recipes/:name', (req: Request, res: Response) => {
  deleteRecipe(req.params.name) ? res.json({ ok: true }) : res.status(404).json({ error: 'not found' });
});

// Reminders
app.get('/api/reminders', async (_req: Request, res: Response) => {
  try { res.json(await getTodayReminders()); } catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.post('/api/reminders', async (req: Request, res: Response) => {
  const { title, dueDate, reminderTime } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try { res.json(await createFamilyReminder(title, dueDate || new Date().toISOString().slice(0, 10), reminderTime)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Notify
app.post('/api/notify', async (req: Request, res: Response) => {
  const { message, channel } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  try { res.json(channel ? await notifyChannel(channel, message) : await notifyAll(message)); }
  catch (err: any) { res.status(500).json({ error: err.message }); }
});
app.get('/api/notify/channels', (_req: Request, res: Response) => res.json({ channels: availableChannels }));

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(`[ERROR]`, err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== WebSocket Realtime =====

function setupRealtimeWS(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws/realtime' });

  wss.on('connection', (clientWs: WsWebSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '', 'http://localhost');
    if (url.searchParams.get('token') !== API_TOKEN) { clientWs.close(4001, 'unauthorized'); return; }

    console.log('[realtime] Client connected');
    let session: RealtimeSession | null = null;
    let aiPending = false;
    let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
    let audioChunks: Buffer[] = [];
    let reconnectAttempts = 0;

    const send = (obj: object) => { if (clientWs.readyState === 1) clientWs.send(JSON.stringify(obj)); };

    const startKeepAlive = () => {
      stopKeepAlive();
      keepAliveInterval = setInterval(() => { if (session?.isReady) session.sendAudio(Buffer.alloc(640)); }, 100);
    };
    const stopKeepAlive = () => { if (keepAliveInterval) { clearInterval(keepAliveInterval); keepAliveInterval = null; } };

    const startSession = async () => {
      session = new RealtimeSession({
        botName: process.env.BOT_NAME || 'Tiedan',
        systemRole: process.env.SYSTEM_ROLE || 'You are a smart family assistant.',
        speakingStyle: process.env.SPEAKING_STYLE || '',
        endSilenceMs: 1200,
      });

      let lastASRSend = 0;
      session.on('asr', (text: string, isInterim: boolean) => {
        const now = Date.now();
        if (now - lastASRSend > 200 || !isInterim) { send({ type: 'asr', text }); lastASRSend = now; }
      });

      const WAKE_WORDS: string[] = JSON.parse(process.env.WAKE_WORDS || '["hey"]');
      const BYE_WORDS: string[] = JSON.parse(process.env.BYE_WORDS || '["bye","goodbye"]');
      let awake = false;
      let awakeTimer: ReturnType<typeof setTimeout> | null = null;

      const resetAwake = () => { awake = false; send({ type: 'sleep' }); };

      session.on('asr_end', async (finalText: string) => {
        if (aiPending || !finalText) return;

        const hasWake = WAKE_WORDS.some(w => finalText.includes(w));
        if (!awake && !hasWake) {
          console.log(`[realtime] ASR: "${finalText}" (no wake word, ignored)`);
          send({ type: 'ignored', text: finalText });
          return;
        }

        let query = finalText;
        if (hasWake) { for (const w of WAKE_WORDS) query = query.replace(w, '').trim(); awake = true; }

        const isBye = BYE_WORDS.some(w => query.includes(w));
        if (awakeTimer) clearTimeout(awakeTimer);
        awakeTimer = setTimeout(resetAwake, isBye ? 500 : 30000);

        if (!query) {
          send({ type: 'asr_final', text: 'wake' });
          const greet = process.env.WAKE_GREETING || 'Hey! I\'m here, go ahead~';
          send({ type: 'ai_reply', text: greet });
          const mp3 = await synthesize(greet);
          if (clientWs.readyState === 1) { send({ type: 'tts_start', text: greet }); clientWs.send(mp3); send({ type: 'tts_end' }); }
          return;
        }

        aiPending = true;

        // Voiceprint
        let speaker: { memberId: string; name: string; score: number } | null = null;
        if (audioChunks.length > 0) {
          const pcm = Buffer.concat(audioChunks);
          speaker = identify(pcm);
          if (speaker) {
            console.log(`[realtime] Speaker: ${speaker.name} (${(speaker.score * 100).toFixed(0)}%)`);
            send({ type: 'speaker', name: speaker.name, score: speaker.score });
          }
        }
        audioChunks = [];

        const contextQuery = speaker ? `[Speaker: ${speaker.name}] ${query}` : query;
        console.log(`[realtime] ASR: "${query}" → OpenClaw`);
        send({ type: 'asr_final', text: query });
        send({ type: 'thinking' });
        startKeepAlive();

        try {
          const reply = await getReply(contextQuery);
          console.log(`[realtime] AI: "${reply}"`);
          send({ type: 'ai_reply', text: reply });

          const mp3Buf = await synthesize(reply);
          if (clientWs.readyState === 1) {
            send({ type: 'tts_start', text: reply });
            clientWs.send(mp3Buf);
            send({ type: 'tts_end' });
          }
        } catch (err: any) {
          console.error('[realtime] AI error:', err.message);
          send({ type: 'error', message: 'AI processing failed' });
        }

        aiPending = false;
      });

      session.on('ai_text', (text: string) => { if (text) console.log(`[realtime] Doubao (ignored): "${text}"`); });
      session.on('usage', (data: any) => {
        console.log(`[realtime] Usage: in=${data?.input_audio_tokens}a+${data?.input_text_tokens}t out=${data?.output_audio_tokens}a+${data?.output_text_tokens}t`);
      });
      session.on('error', (e: string) => console.log('[realtime] Volcano error:', e));
      session.on('closed', (code: number) => {
        console.log('[realtime] Volcano session closed:', code);
        stopKeepAlive();
        if (clientWs.readyState !== 1) return; // client already gone
        reconnectAttempts++;
        if (reconnectAttempts > 3) {
          console.log('[realtime] Max reconnects reached, giving up');
          send({ type: 'error', message: 'Voice service disconnected, please refresh' });
          return;
        }
        const delay = reconnectAttempts * 3000;
        console.log(`[realtime] Auto-reconnecting (${reconnectAttempts}/3) in ${delay}ms...`);
        setTimeout(() => {
          if (clientWs.readyState !== 1) return;
          startSession().then(() => { reconnectAttempts = 0; }).catch((err: Error) => {
            console.error('[realtime] Reconnect failed:', err.message);
          });
        }, delay);
      });

      await session.connect();
      console.log('[realtime] Session ready, dialog_id=' + session.dialogId);
      send({ type: 'ready', dialogId: session.dialogId });
      startKeepAlive();
    };

    startSession().catch((err: Error) => {
      console.error('[realtime] Failed to start:', err.message);
      send({ type: 'error', message: 'Voice service connection failed' });
    });

    clientWs.on('message', (data: Buffer | string) => {
      if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
        const buf = Buffer.from(data);
        audioChunks.push(buf);
        while (audioChunks.reduce((s, c) => s + c.length, 0) > 96000) audioChunks.shift();
        if (session?.isReady) session.sendAudio(buf);
      } else {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'text_query' && session?.isReady) session.sendTextQuery(msg.text);
        } catch {}
      }
    });

    clientWs.on('close', () => {
      console.log('[realtime] Client disconnected');
      stopKeepAlive();
      if (session) session.close();
    });
  });

  return wss;
}

// Start servers
const httpServer = app.listen(PORT, () => {
  console.log(`🤖 Tiedan → http://0.0.0.0:${PORT}`);
  console.log(`   WS  /ws/realtime  - Real-time voice`);
  console.log(`   POST /api/chat/text - Text chat`);
  console.log(`   GET  /api/health    - Health check`);
});
setupRealtimeWS(httpServer);

try {
  const sslOpts = { key: readFileSync(join(__dirname, 'key.pem')), cert: readFileSync(join(__dirname, 'cert.pem')) };
  const httpsServer = https.createServer(sslOpts, app);
  httpsServer.listen(3443, () => console.log(`🔒 Tiedan HTTPS → https://0.0.0.0:3443`));
  setupRealtimeWS(httpsServer);
} catch (e: any) { console.log('HTTPS disabled:', e.message); }
