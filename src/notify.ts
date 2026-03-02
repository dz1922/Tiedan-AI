/**
 * Multi-channel notification module
 */
import { bridge } from './openclaw-bridge.js';

type ChannelResult = { ok: boolean; channel: string; error?: string };
type ChannelFn = (message: string) => Promise<ChannelResult>;

const channels: Record<string, ChannelFn> = {
  async telegram(message: string): Promise<ChannelResult> {
    try {
      await bridge.chat(`📢 [Notification] ${message}`);
      return { ok: true, channel: 'telegram' };
    } catch (err: any) {
      console.error('[notify] Telegram failed:', err.message);
      return { ok: false, channel: 'telegram', error: err.message };
    }
  },
};

export async function notifyAll(message: string): Promise<ChannelResult[]> {
  const results = await Promise.allSettled(
    Object.values(channels).map(fn => fn(message))
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false, channel: 'unknown', error: (r.reason as Error)?.message });
}

export async function notifyChannel(channel: string, message: string): Promise<ChannelResult> {
  const fn = channels[channel];
  if (!fn) throw new Error(`Unknown channel: ${channel}`);
  return fn(message);
}

export const availableChannels = Object.keys(channels);
