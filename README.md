# Tiedan AI 🤖 Smart Family Voice Assistant

A real-time voice-interactive PWA family assistant powered by [OpenClaw](https://github.com/openclaw/openclaw) + Volcano Engine.

## Features

- 🎙️ **Real-time Voice Chat** — Volcano Engine VAD + streaming ASR + Doubao TTS 2.0
- 🧠 **AI-Powered** — OpenClaw Gateway for LLM routing (reminders, recipes, calendar, etc.)
- 👤 **Speaker ID** — Local MFCC-based voiceprint recognition for family members
- 😊 **Pixel Face** — Animated 8-bit expressions (sleep / listen / think / talk / happy)
- 🔐 **Wake Word** — Custom wake word activation with auto-sleep

## Architecture

```
Phone/Browser ──WSS──→ Node.js Server ──WS──→ OpenClaw Gateway (AI)
                            │
                            ├──WS──→ Volcano Realtime API (VAD + ASR)
                            └──WS──→ Volcano TTS V3 (Speech Synthesis)
```

## Quick Start

```bash
npm install
cp .env.example .env   # Fill in your API keys
cd src && openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost'
cd .. && node src/server.js
```

Open `https://your-server:3443` and say the wake word to start.

## API

| Endpoint | Description |
|----------|-------------|
| `GET /` | PWA page |
| `WS /ws/realtime?token=xxx` | Real-time voice chat |
| `POST /api/chat/text` | Text chat |
| `POST /api/voiceprint/register` | Register voiceprint |
| `GET /api/voiceprint/members` | List registered members |
| `GET /api/health` | Health check |

## Tech Stack

- **Backend**: Node.js + Express + WebSocket
- **ASR**: Volcano Engine Realtime API V3 (VAD + streaming recognition)
- **TTS**: Volcano Engine TTS V3 (Doubao 2.0), Edge TTS fallback
- **AI**: OpenClaw Gateway
- **Frontend**: PWA with animated pixel face
- **Speaker ID**: Local MFCC + cosine similarity

## Project Structure

```
src/
├── server.js           # Main server (HTTP:3100 + HTTPS:3443)
├── openclaw-bridge.js  # OpenClaw Gateway bridge
├── volc-realtime.js    # Volcano Realtime (VAD + ASR)
├── volc-tts.js         # Volcano TTS V3
├── volc-asr.js         # Volcano ASR V2 (fallback)
├── edge-tts.js         # Edge TTS (fallback)
├── voiceprint-local.js # Local speaker identification
├── recipes.js          # Recipe management
├── reminders.js        # Reminders
├── notify.js           # Notifications
├── pwa.html            # PWA frontend
└── manifest.json       # PWA manifest
```

## Disclaimer

This project is for **personal development and entertainment purposes only**.

- Not intended for production or commercial use
- No warranty of any kind — use at your own risk
- The authors are not responsible for any damages or losses arising from the use of this software
- Third-party APIs (Volcano Engine, OpenClaw, etc.) are subject to their own terms of service
- Voice data is processed in real-time and not stored permanently; users are responsible for compliance with local privacy laws

## License

MIT
