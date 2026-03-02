/**
 * Edge TTS wrapper - free unlimited TTS via edge-tts CLI
 */
import { execFile } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { randomUUID } from 'crypto';

const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

interface TTSOptions {
  voice?: string;
  rate?: string;
  pitch?: string;
}

export async function synthesize(text: string, options: TTSOptions = {}): Promise<Buffer> {
  const { voice = DEFAULT_VOICE, rate = '+0%', pitch = '+0Hz' } = options;
  const tmpFile = `/tmp/tiedan-tts-${randomUUID()}.mp3`;

  return new Promise((resolve, reject) => {
    execFile(
      'edge-tts',
      ['--voice', voice, '--rate', rate, '--pitch', pitch, '--text', text, '--write-media', tmpFile],
      { timeout: 15000 },
      async (err) => {
        if (err) return reject(err);
        try {
          const buf = await readFile(tmpFile);
          await unlink(tmpFile).catch(() => {});
          resolve(buf);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}
