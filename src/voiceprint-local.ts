/**
 * Lightweight voiceprint recognition - pure Node.js
 *
 * PCM 16kHz → FFT spectral features → cosine similarity
 * Suitable for family scenarios (≤5 members), no GPU/PyTorch needed
 */
import fs from 'fs';
import path from 'path';

const VOICEPRINT_DIR = process.env.VOICEPRINT_DIR || path.join(process.cwd(), 'voiceprints');
const STATE_FILE = path.join(VOICEPRINT_DIR, 'profiles.json');
const SAMPLE_RATE = 16000;
const FFT_SIZE = 512;
const NUM_BANDS = 26;
const THRESHOLD = 0.75;

interface VoiceprintProfile {
  name: string;
  features: number[][];
}

interface Profiles {
  [memberId: string]: VoiceprintProfile;
}

export interface SpeakerResult {
  memberId: string;
  name: string;
  score: number;
}

// ===== DSP =====

function pcmToFloat(pcmBuf: Buffer): Float64Array {
  const samples = new Float64Array(pcmBuf.length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = pcmBuf.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len *= 2) {
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = i + j + len / 2;
        const tRe = curRe * re[b] - curIm * im[b];
        const tIm = curRe * im[b] + curIm * re[b];
        re[b] = re[a] - tRe; im[b] = im[a] - tIm;
        re[a] += tRe; im[a] += tIm;
        const newRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newRe;
      }
    }
  }
}

function hzToMel(hz: number): number { return 2595 * Math.log10(1 + hz / 700); }
function melToHz(mel: number): number { return 700 * (Math.pow(10, mel / 2595) - 1); }

function melFilterbank(fftSize: number, sampleRate: number, numBands: number): Float64Array[] {
  const numBins = fftSize / 2 + 1;
  const lowMel = hzToMel(300);
  const highMel = hzToMel(sampleRate / 2);
  const mels: number[] = [];
  for (let i = 0; i <= numBands + 1; i++) {
    mels.push(melToHz(lowMel + (highMel - lowMel) * i / (numBands + 1)));
  }
  const bins = mels.map(f => Math.round(f * fftSize / sampleRate));

  const filters: Float64Array[] = [];
  for (let i = 0; i < numBands; i++) {
    const filter = new Float64Array(numBins);
    for (let j = bins[i]; j < bins[i + 1]; j++) {
      filter[j] = (j - bins[i]) / (bins[i + 1] - bins[i]);
    }
    for (let j = bins[i + 1]; j < bins[i + 2] && j < numBins; j++) {
      filter[j] = (bins[i + 2] - j) / (bins[i + 2] - bins[i + 1]);
    }
    filters.push(filter);
  }
  return filters;
}

const melFilters = melFilterbank(FFT_SIZE, SAMPLE_RATE, NUM_BANDS);

export function extractFeature(pcmBuf: Buffer): number[] | null {
  const samples = pcmToFloat(pcmBuf);
  const maxSamples = SAMPLE_RATE * 3;
  const useSamples = samples.length > maxSamples ? samples.slice(0, maxSamples) : samples;

  const hopSize = FFT_SIZE / 2;
  const numFrames = Math.floor((useSamples.length - FFT_SIZE) / hopSize);
  if (numFrames < 1) return null;

  const avgBands = new Float64Array(NUM_BANDS);

  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hopSize;
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);

    for (let i = 0; i < FFT_SIZE; i++) {
      const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1));
      re[i] = (useSamples[start + i] || 0) * w;
    }

    fft(re, im);

    const power = new Float64Array(FFT_SIZE / 2 + 1);
    for (let i = 0; i <= FFT_SIZE / 2; i++) {
      power[i] = re[i] * re[i] + im[i] * im[i];
    }

    for (let b = 0; b < NUM_BANDS; b++) {
      let sum = 0;
      for (let i = 0; i < power.length; i++) {
        sum += power[i] * melFilters[b][i];
      }
      avgBands[b] += Math.log(sum + 1e-10);
    }
  }

  for (let b = 0; b < NUM_BANDS; b++) avgBands[b] /= numFrames;
  const norm = Math.sqrt(avgBands.reduce((s, v) => s + v * v, 0)) || 1;
  return Array.from(avgBands.map(v => v / norm));
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// ===== Public API =====

function loadProfiles(): Profiles {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
}

function saveProfiles(profiles: Profiles): void {
  if (!fs.existsSync(VOICEPRINT_DIR)) fs.mkdirSync(VOICEPRINT_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(profiles, null, 2));
}

export function registerVoice(memberId: string, name: string, pcmBuf: Buffer) {
  const feature = extractFeature(pcmBuf);
  if (!feature) return { ok: false, error: 'Audio too short' };

  const profiles = loadProfiles();
  if (!profiles[memberId]) {
    profiles[memberId] = { name, features: [] };
  }
  profiles[memberId].features.push(feature);
  profiles[memberId].name = name;
  saveProfiles(profiles);

  return { ok: true, samples: profiles[memberId].features.length };
}

export function identify(pcmBuf: Buffer): SpeakerResult | null {
  const feature = extractFeature(pcmBuf);
  if (!feature) return null;

  const profiles = loadProfiles();
  let best: SpeakerResult | null = null;

  for (const [id, profile] of Object.entries(profiles)) {
    const sims = profile.features.map(f => cosineSim(feature, f));
    const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;

    if (avgSim > THRESHOLD && (!best || avgSim > best.score)) {
      best = { memberId: id, name: profile.name, score: avgSim };
    }
  }

  return best;
}

export function listMembers() {
  const profiles = loadProfiles();
  return Object.entries(profiles).map(([id, p]) => ({
    id, name: p.name, samples: p.features.length
  }));
}

export function deleteMember(memberId: string): void {
  const profiles = loadProfiles();
  delete profiles[memberId];
  saveProfiles(profiles);
}
