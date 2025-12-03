import { SceneContext, ParsedSegment } from "../types";

let audioCtx: AudioContext | null = null;
const SAMPLE_RATE = 24000; // Native 24kHz to match Gemini Output (Optimization)

// --- Caches ---
const sfxCache = new Map<string, AudioBuffer>();
const sfxPending = new Map<string, Promise<AudioBuffer>>(); // Dedup in-flight requests
let cachedImpulse: AudioBuffer | null = null;

// OPTIMIZATION: Shared Noise Buffer (10 seconds)
const NOISE_BUFFER_SIZE = SAMPLE_RATE * 10;
let SHARED_NOISE: Float32Array | null = null;

const getSharedNoise = () => {
  if (!SHARED_NOISE) {
    SHARED_NOISE = new Float32Array(NOISE_BUFFER_SIZE);
    let lastOut = 0;
    for (let i = 0; i < NOISE_BUFFER_SIZE; i++) {
      const white = Math.random() * 2 - 1;
      // Brown noise approx (smoother for ambience)
      SHARED_NOISE[i] = (lastOut + (0.02 * white)) / 1.02;
      lastOut = SHARED_NOISE[i];
      SHARED_NOISE[i] *= 3.5; 
    }
  }
  return SHARED_NOISE;
};

export const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
};

export const base64ToInt16 = (base64: string): Int16Array => {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
};

export const createSilenceBuffer = (duration: number): AudioBuffer => {
  const ctx = getAudioContext();
  const safeDuration = Math.max(0.1, duration); 
  return ctx.createBuffer(1, Math.floor(SAMPLE_RATE * safeDuration), SAMPLE_RATE);
};

export const trimSilenceRaw = (data: Int16Array): Int16Array => {
  let start = 0;
  let end = data.length;
  const threshold = 327; // approx 1% of 32768

  while (start < end && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;

  if (end - start < SAMPLE_RATE * 0.05) return data; 

  return data.subarray(start, end);
};

// --- Reverb ---

const getImpulseResponse = (ctx: BaseAudioContext, duration: number, decay: number) => {
  if (cachedImpulse) return cachedImpulse;

  const length = ctx.sampleRate * duration;
  const impulse = ctx.createBuffer(1, length, ctx.sampleRate);
  const channel = impulse.getChannelData(0);

  for (let i = 0; i < length; i++) {
    const n = i / length;
    const val = Math.pow(1 - n, decay) * (Math.random() * 2 - 1);
    channel[i] = val;
  }
  
  cachedImpulse = impulse;
  return impulse;
};

// --- Procedural Generation helpers ---

const createNoiseBuffer = (ctx: BaseAudioContext, duration: number = 4) => {
  const len = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const channel = buffer.getChannelData(0);
  const noise = getSharedNoise();
  
  let offset = 0;
  while(offset < len) {
      const remaining = len - offset;
      const copyLen = Math.min(remaining, noise.length);
      channel.set(noise.subarray(0, copyLen), offset);
      offset += copyLen;
  }
  return buffer;
};

const synthesizeAmbientLayer = (ctx: BaseAudioContext, keyword: string, duration: number, destination: AudioNode) => {
  const t = keyword.toLowerCase();
  const safeDuration = duration + 2; 

  // 1. Weather & Nature
  if (t.includes('wind') || t.includes('breeze') || t.includes('air')) {
    const noise = createNoiseBuffer(ctx, safeDuration);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(300, 0);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.2; 
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 200;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    src.connect(filter).connect(gain).connect(destination);
    src.start();
  } 
  else if (t.includes('bird') || t.includes('chirp') || t.includes('forest')) {
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    gain.connect(destination);
    const count = Math.floor(safeDuration / 2); 
    for(let i=0; i<count; i++) {
      const time = Math.random() * safeDuration;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(2000 + Math.random()*1000, time);
      osc.frequency.linearRampToValueAtTime(1500, time + 0.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(0.1, time+0.02);
      g.gain.linearRampToValueAtTime(0, time+0.1);
      osc.connect(g).connect(gain);
      osc.start(time);
      osc.stop(time + 0.15);
    }
  }
  else if (t.includes('cricket') || t.includes('insect') || t.includes('night')) {
    const gain = ctx.createGain();
    gain.gain.value = 0.03;
    gain.connect(destination);
    const count = Math.floor(safeDuration * 3);
    for(let i=0; i<count; i++) {
       const time = i * 0.3 + (Math.random() * 0.1);
       const osc = ctx.createOscillator();
       osc.frequency.value = 4000;
       const g = ctx.createGain();
       g.gain.setValueAtTime(0, time);
       g.gain.linearRampToValueAtTime(0.1, time + 0.01);
       g.gain.linearRampToValueAtTime(0.05, time + 0.05);
       osc.connect(g).connect(gain);
       osc.start(time);
       osc.stop(time+0.1);
    }
  }
  else if (t.includes('water') || t.includes('stream') || t.includes('river') || t.includes('wave')) {
    const noise = createNoiseBuffer(ctx, safeDuration);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    const gain = ctx.createGain();
    gain.gain.value = 0.2;
    src.connect(filter).connect(gain).connect(destination);
    src.start();
  }
  
  // 2. Urban & Human
  else if (t.includes('traffic') || t.includes('car') || t.includes('city') || t.includes('distant')) {
    const noise = createNoiseBuffer(ctx, safeDuration);
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 200;
    const gain = ctx.createGain();
    gain.gain.value = 0.25;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.1;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.1;
    lfo.connect(lfoGain).connect(gain.gain);
    lfo.start();
    src.connect(filter).connect(gain).connect(destination);
    src.start();
  }
  else if (t.includes('crowd') || t.includes('talk') || t.includes('chat') || t.includes('murmur')) {
     const noise = createNoiseBuffer(ctx, safeDuration);
     const src = ctx.createBufferSource();
     src.buffer = noise;
     src.loop = true;
     const filter = ctx.createBiquadFilter();
     filter.type = 'bandpass';
     filter.frequency.value = 700;
     filter.Q.value = 2;
     const mod = createNoiseBuffer(ctx, safeDuration);
     const modSrc = ctx.createBufferSource();
     modSrc.buffer = mod;
     modSrc.loop = true;
     const modFilter = ctx.createBiquadFilter();
     modFilter.type = 'lowpass';
     modFilter.frequency.value = 5; 
     const modGain = ctx.createGain();
     modGain.gain.value = 1000; 
     modSrc.connect(modFilter).connect(modGain).connect(filter.frequency);
     modSrc.start();
     const gain = ctx.createGain();
     gain.gain.value = 0.15;
     src.connect(filter).connect(gain).connect(destination);
     src.start();
  }
  else if (t.includes('siren') || t.includes('alarm')) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(600, 0);
      osc.frequency.linearRampToValueAtTime(800, 2); 
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      osc.connect(gain).connect(destination);
      osc.start();
  }

  // 3. Machinery & Indoor
  else if (t.includes('hum') || t.includes('machine') || t.includes('fan') || t.includes('server')) {
     const osc = ctx.createOscillator();
     osc.frequency.value = 60; 
     const gain = ctx.createGain();
     gain.gain.value = 0.05;
     osc.connect(gain).connect(destination);
     osc.start();
     const noise = createNoiseBuffer(ctx, safeDuration);
     const nSrc = ctx.createBufferSource();
     nSrc.buffer = noise;
     nSrc.loop = true;
     const nFilt = ctx.createBiquadFilter();
     nFilt.type = 'lowpass';
     nFilt.frequency.value = 200;
     const nGain = ctx.createGain();
     nGain.gain.value = 0.08;
     nSrc.connect(nFilt).connect(nGain).connect(destination);
     nSrc.start();
  }
  else if (t.includes('announcement') || t.includes('speaker') || t.includes('pa')) {
     const count = Math.floor(safeDuration / 15); 
     const gain = ctx.createGain();
     gain.gain.value = 0.08;
     gain.connect(destination);
     for(let i=0; i<count; i++) {
        const time = 5 + (Math.random() * (safeDuration-10));
        const noise = createNoiseBuffer(ctx, 3);
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const filter = ctx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 1500;
        filter.Q.value = 8; 
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, time);
        g.gain.linearRampToValueAtTime(1, time+0.5);
        g.gain.linearRampToValueAtTime(0, time+3);
        src.connect(filter).connect(g).connect(gain);
        src.start(time);
        src.stop(time+3.5);
     }
  } 
  else if (t.includes('clock') || t.includes('tick')) {
      const gain = ctx.createGain();
      gain.gain.value = 0.05;
      gain.connect(destination);
      const count = Math.floor(safeDuration);
      for(let i=0; i<count; i++) {
         const osc = ctx.createOscillator();
         osc.frequency.value = 1000;
         osc.type = 'square';
         const g = ctx.createGain();
         g.gain.setValueAtTime(0.05, i);
         g.gain.exponentialRampToValueAtTime(0.001, i+0.05);
         osc.connect(g).connect(gain);
         osc.start(i);
         osc.stop(i+0.1);
      }
  }
};

export const generateAmbience = async (
  duration: number, 
  ambientSounds: string[] = [] 
): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  const loopDuration = Math.min(duration, 32); 
  const ctx = new OfflineAudioContext(1, Math.floor(sampleRate * loopDuration), sampleRate);

  const baseNoise = createNoiseBuffer(ctx, loopDuration);
  const srcBase = ctx.createBufferSource();
  srcBase.buffer = baseNoise;
  srcBase.loop = true;
  const filterBase = ctx.createBiquadFilter();
  filterBase.type = 'lowpass';
  filterBase.frequency.value = 150; 
  const gainBase = ctx.createGain();
  gainBase.gain.value = 0.12; 
  srcBase.connect(filterBase).connect(gainBase).connect(ctx.destination);
  srcBase.start(0);

  const soundsToGen = ambientSounds.slice(0, 4);
  soundsToGen.forEach(sound => {
     synthesizeAmbientLayer(ctx, sound, loopDuration, ctx.destination);
  });
  
  const buffer = await ctx.startRendering();

  const data = buffer.getChannelData(0);
  const fadeLen = Math.floor(0.1 * sampleRate); 
  const len = data.length;
  for(let i=0; i<fadeLen; i++) {
     const gain = i / fadeLen;
     data[i] *= gain; 
     data[len - 1 - i] *= gain; 
  }

  return buffer;
};

const random = (min: number, max: number) => Math.random() * (max - min) + min;

export const generateSFX = async (type: string): Promise<AudioBuffer> => {
   const cacheKey = type.toLowerCase();
   if (sfxCache.has(cacheKey)) return sfxCache.get(cacheKey)!;
   if (sfxPending.has(cacheKey)) return sfxPending.get(cacheKey)!;

   const task = (async () => {
       const sampleRate = SAMPLE_RATE;
       const ctx = new OfflineAudioContext(1, sampleRate * 4, sampleRate);
       const t = type.toLowerCase();
       
       const compressor = ctx.createDynamicsCompressor();
       compressor.threshold.value = -20;
       compressor.ratio.value = 4;
       compressor.connect(ctx.destination);

       if (t.includes('thunder') || t.includes('explosion') || t.includes('boom')) {
          const noise1 = createNoiseBuffer(ctx);
          const src1 = ctx.createBufferSource();
          src1.buffer = noise1;
          const filter1 = ctx.createBiquadFilter();
          filter1.type = 'lowpass';
          filter1.frequency.setValueAtTime(400, 0);
          filter1.frequency.exponentialRampToValueAtTime(50, 2.5);
          const gain1 = ctx.createGain();
          gain1.gain.setValueAtTime(0, 0);
          gain1.gain.linearRampToValueAtTime(0.8, 0.1); 
          gain1.gain.exponentialRampToValueAtTime(0.01, 3.5); 
          src1.connect(filter1).connect(gain1).connect(compressor);
          src1.start(0);
       } else if (t.includes('wind') || t.includes('howl')) {
          const noise = createNoiseBuffer(ctx);
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.Q.value = 4;
          const startFreq = random(250, 350);
          filter.frequency.setValueAtTime(startFreq, 0);
          filter.frequency.linearRampToValueAtTime(startFreq * 2, 1.5); 
          filter.frequency.linearRampToValueAtTime(startFreq * 0.8, 3.5); 
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, 0);
          gain.gain.linearRampToValueAtTime(0.6, 1.5);
          gain.gain.linearRampToValueAtTime(0, 3.5);
          src.connect(filter).connect(gain).connect(compressor);
          src.start(0);
       } else if (t.includes('creak') || t.includes('door') || t.includes('squeak')) {
          const osc = ctx.createOscillator();
          osc.type = 'sawtooth';
          const startFreq = random(130, 170);
          osc.frequency.setValueAtTime(startFreq, 0);
          osc.frequency.linearRampToValueAtTime(startFreq - 20, 0.5);
          osc.frequency.linearRampToValueAtTime(startFreq - 10, 1.0);
          osc.frequency.linearRampToValueAtTime(startFreq - 40, 1.5);
          const filter = ctx.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.value = 800;
          filter.Q.value = 3;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, 0);
          gain.gain.linearRampToValueAtTime(0.3, 0.2);
          gain.gain.linearRampToValueAtTime(0.2, 1.0);
          gain.gain.linearRampToValueAtTime(0, 1.5);
          osc.connect(filter).connect(gain).connect(compressor);
          osc.start(0);
       } else if (t.includes('footstep') || t.includes('step') || t.includes('walk')) {
          for(let i=0; i<3; i++) {
            const time = i * random(0.5, 0.65); 
            const noise = createNoiseBuffer(ctx);
            const src = ctx.createBufferSource();
            src.buffer = noise;
            const filter = ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.value = random(100, 180); 
            const gain = ctx.createGain();
            gain.gain.setValueAtTime(0, time);
            gain.gain.linearRampToValueAtTime(0.5, time + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
            src.connect(filter).connect(gain).connect(compressor);
            src.start(time);
            src.stop(time + 0.3);
          }
       } else if (t.includes('shatter') || t.includes('glass') || t.includes('crash')) {
           const noise = createNoiseBuffer(ctx);
           const src = ctx.createBufferSource();
           src.buffer = noise;
           const gain = ctx.createGain();
           gain.gain.setValueAtTime(0.8, 0);
           gain.gain.exponentialRampToValueAtTime(0.01, 0.3);
           src.connect(gain).connect(compressor);
           src.start(0);
       } else if (t.includes('breath') || t.includes('sigh') || t.includes('gasp')) {
          const noise = createNoiseBuffer(ctx);
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 800;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, 0);
          gain.gain.linearRampToValueAtTime(0.2, 0.2);
          gain.gain.exponentialRampToValueAtTime(0.001, 0.8);
          src.connect(filter).connect(gain).connect(compressor);
          src.start(0);
       } else if (t.includes('rustle') || t.includes('cloth') || t.includes('shift')) {
          const noise = createNoiseBuffer(ctx);
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const filter = ctx.createBiquadFilter();
          filter.type = 'highpass';
          filter.frequency.value = 1200;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, 0);
          gain.gain.linearRampToValueAtTime(0.15, 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, 0.4);
          src.connect(filter).connect(gain).connect(compressor);
          src.start(0);
       } else {
          const noise = createNoiseBuffer(ctx);
          const src = ctx.createBufferSource();
          src.buffer = noise;
          const filter = ctx.createBiquadFilter();
          filter.type = 'lowpass';
          filter.frequency.value = 300;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0.5, 0);
          gain.gain.exponentialRampToValueAtTime(0.001, 0.5);
          src.connect(filter).connect(gain).connect(compressor);
          src.start(0);
       }

       const buffer = await ctx.startRendering();
       sfxCache.set(cacheKey, buffer);
       sfxPending.delete(cacheKey);
       return buffer;
   })();
   
   sfxPending.set(cacheKey, task);
   return task;
}

// --- Music Generation ---

const NOTES = {
  'C2': 65.41, 'D2': 73.42, 'E2': 82.41, 'F2': 87.31, 'G2': 98.00, 'A2': 110.00, 'B2': 123.47,
  'C3': 130.81, 'D3': 146.83, 'E3': 164.81, 'F3': 174.61, 'G3': 196.00, 'A3': 220.00, 'Bb3': 233.08, 'B3': 246.94,
  'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.00, 'A4': 440.00, 'B4': 493.88,
  'C5': 523.25
};

const SCALES = {
  sad: [NOTES.A2, NOTES.C3, NOTES.E3, NOTES.A3, NOTES.B3, NOTES.C4],
  tense: [NOTES.C2, NOTES.C3, NOTES.F2, NOTES.F3, NOTES.G2],
  happy: [NOTES.C3, NOTES.E3, NOTES.G3, NOTES.C4, NOTES.D4, NOTES.E4], 
  mysterious: [NOTES.D3, NOTES.F3, NOTES.A3, NOTES.Bb3, NOTES.C4], 
  romantic: [NOTES.F3, NOTES.A3, NOTES.C4, NOTES.E4, NOTES.G4], 
  neutral: [NOTES.C3, NOTES.G3]
};

const PROGRESSIONS = {
  happy: [[0, 2, 4], [3, 5, 0], [4, 6, 1], [0, 2, 4]], 
  sad: [[0, 2, 4], [5, 0, 2], [3, 5, 0], [4, 6, 1]], 
  tense: [[0, 1, 3], [0, 2, 4], [0, 1, 3], [0, 1, 4]], 
  mysterious: [[0, 3], [1, 4], [2, 5], [0, 3]],
  romantic: [[0, 2, 4], [3, 5, 0], [1, 3, 5], [4, 6, 1]],
  neutral: [[0, 2], [1, 3], [0, 2], [1, 3]]
};

export const generateAdvancedScore = async (duration: number, style: SceneContext['scoreStyle']): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  
  if (style === 'neutral') return createSilenceBuffer(1);

  const cappedDuration = Math.min(duration, 64);
  const tempo = (style === 'tense' || style === 'happy') ? 120 : 70;
  const beatTime = 60 / tempo;
  const measureTime = beatTime * 4;
  const measures = Math.ceil(cappedDuration / measureTime);
  const safeDuration = measures * measureTime;
  
  const ctx = new OfflineAudioContext(1, Math.floor(sampleRate * safeDuration), sampleRate);
  
  const musicMaster = ctx.createGain();
  musicMaster.gain.value = 0.8;
  musicMaster.connect(ctx.destination);

  const percussionBuffer = createNoiseBuffer(ctx, 0.2); 
  
  const scale = SCALES[style] || SCALES.neutral;
  const progression = PROGRESSIONS[style] || PROGRESSIONS.neutral;
  
  for (let m = 0; m < measures; m++) {
    const measureStart = m * beatTime * 4;
    const chordIndices = progression[m % progression.length];
    const chordNotes = chordIndices.map(i => scale[i % scale.length]);
    const root = chordNotes[0];

    chordNotes.forEach((freq, i) => {
       const osc = ctx.createOscillator();
       osc.type = style === 'tense' ? 'sawtooth' : 'triangle';
       osc.frequency.value = freq;
       osc.detune.value = (Math.random() * 8) - 4; 
       const gain = ctx.createGain();
       gain.gain.setValueAtTime(0, measureStart);
       gain.gain.linearRampToValueAtTime(0.08, measureStart + beatTime);
       gain.gain.setValueAtTime(0.08, measureStart + (beatTime * 3));
       gain.gain.linearRampToValueAtTime(0, measureStart + (beatTime * 4));
       osc.connect(gain).connect(musicMaster);
       osc.start(measureStart);
       osc.stop(measureStart + (beatTime * 4));
    });

    const bassOsc = ctx.createOscillator();
    bassOsc.type = 'square';
    bassOsc.frequency.value = root / 2;
    const bassFilter = ctx.createBiquadFilter();
    bassFilter.type = 'lowpass';
    bassFilter.frequency.value = 400;
    const bassGain = ctx.createGain();
    const bassPattern = style === 'tense' ? [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5] : [0, 2];
    bassPattern.forEach(offset => {
       const t = measureStart + (offset * beatTime);
       if (t < safeDuration) {
          bassGain.gain.setValueAtTime(0.12, t);
          bassGain.gain.exponentialRampToValueAtTime(0.001, t + (beatTime * 0.4));
       }
    });
    bassOsc.connect(bassFilter).connect(bassGain).connect(musicMaster);
    bassOsc.start(measureStart);
    bassOsc.stop(measureStart + (beatTime * 4));

    if (style !== 'mysterious') {
        const melGain = ctx.createGain();
        melGain.gain.value = 0.55; 
        const delay = ctx.createDelay();
        delay.delayTime.value = beatTime * 0.75;
        const fbk = ctx.createGain();
        fbk.gain.value = 0.2;
        delay.connect(fbk).connect(delay);
        melGain.connect(delay).connect(musicMaster);
        melGain.connect(musicMaster);

        let lastNoteIndex = 0;
        const numNotes = 8;
        for(let i=0; i<numNotes; i++) {
           if (Math.random() > 0.4) {
              const t = measureStart + (i * (beatTime / 2));
              if (t >= safeDuration) break;
              const step = Math.floor(Math.random() * 3) - 1; 
              let idx = lastNoteIndex + step;
              if (idx < 0) idx = 0;
              if (idx >= scale.length) idx = scale.length - 1;
              lastNoteIndex = idx;
              const osc = ctx.createOscillator();
              osc.type = style === 'tense' ? 'sawtooth' : 'triangle';
              osc.frequency.value = scale[idx] * 2; 
              const g = ctx.createGain();
              g.gain.setValueAtTime(0, t);
              g.gain.linearRampToValueAtTime(0.5, t + 0.05); 
              g.gain.exponentialRampToValueAtTime(0.001, t + 0.35); 
              osc.connect(g).connect(melGain);
              osc.start(t);
              osc.stop(t + 0.4);
           }
        }
    }

    if (style !== 'mysterious') {
       const rhythmGain = ctx.createGain();
       rhythmGain.gain.value = 0.06;
       rhythmGain.connect(musicMaster);
       const sixteenth = beatTime / 4;
       for(let i=0; i<16; i++) {
          const t = measureStart + (i * sixteenth);
          if (t >= safeDuration) break;
          const isBeat = i % 4 === 0;
          const amp = isBeat ? 0.6 : 0.3;
          const src = ctx.createBufferSource();
          src.buffer = percussionBuffer;
          const filter = ctx.createBiquadFilter();
          filter.type = 'highpass';
          filter.frequency.value = 5000; 
          const env = ctx.createGain();
          env.gain.setValueAtTime(amp, t);
          env.gain.exponentialRampToValueAtTime(0.001, t + 0.05); 
          src.connect(filter).connect(env).connect(rhythmGain);
          src.start(t);
       }
    }
  }

  return ctx.startRendering();
};

const calculateTimings = (voiceBuffers: (Int16Array | null)[], segments: ParsedSegment[]) => {
  let currentTime = 0;
  let maxDuration = 0;
  const startTimes: number[] = [];

  for (let i = 0; i < segments.length; i++) {
    startTimes.push(currentTime);
    const buf = voiceBuffers[i];
    const rawDur = buf ? buf.length / SAMPLE_RATE : 0;
    const contentLen = segments[i].speechDuration || rawDur;
    
    const audioEnd = currentTime + rawDur;
    if (audioEnd > maxDuration) maxDuration = audioEnd;

    currentTime += contentLen;
    if (contentLen > 0) currentTime += 0.12; 
  }
  
  return { startTimes, totalDuration: maxDuration + 1.0 };
};

// OPTIMIZATION: Write directly to Float32 buffer 
const stitchToBuffer = (
  target: Float32Array,
  buffers: (Int16Array | null)[],
  startTimes: number[],
  segments: ParsedSegment[],
  onlyType: 'character' | 'narrator',
  op: 'replace' | 'add' = 'replace'
) => {
  const len = target.length;
  // Pre-calc multipliers to avoid division in loop
  const posMult = 1 / 32767;
  const negMult = 1 / 32768;

  buffers.forEach((buf, i) => {
     if (!buf) return;
     const isNarr = segments[i].isNarrator;
     
     if (onlyType === 'character' && isNarr) return;
     if (onlyType === 'narrator' && !isNarr) return;

     const startSample = Math.floor(startTimes[i] * SAMPLE_RATE);
     
     for(let k=0; k < buf.length; k++) {
        const outIdx = startSample + k;
        if (outIdx < len) {
           const sample = buf[k];
           const floatVal = sample < 0 ? sample * negMult : sample * posMult;
           
           if (op === 'add') {
             target[outIdx] += floatVal;
           } else {
             target[outIdx] = floatVal;
           }
        }
     }
  });
};


export const renderSFXTrack = async(
  totalDuration: number,
  segments: ParsedSegment[],
  startTimes: number[]
): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  const ctx = new OfflineAudioContext(1, Math.floor(sampleRate * totalDuration), sampleRate);
  
  const sfxPromises = segments.map(async (seg, i) => {
     if (seg.sfx) {
        const buffer = await generateSFX(seg.sfx);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(startTimes[i]);
     }
  });

  await Promise.all(sfxPromises);
  return ctx.startRendering();
};


export const generateTrackBuffers = async (
  voiceBuffers: (Int16Array | null)[],
  segments: ParsedSegment[],
  scene: SceneContext
): Promise<{ dialogue: AudioBuffer, score: AudioBuffer, ambience: AudioBuffer, sfx: AudioBuffer, duration: number }> => {

  const timing = calculateTimings(voiceBuffers, segments);
  const totalDuration = timing.totalDuration;
  const totalSamples = Math.ceil(totalDuration * SAMPLE_RATE);

  // OPTIMIZATION: Create reverb OAC directly for the whole dialogue track
  // Avoids allocating an intermediate Float32Array for 'dry' dialogue
  const ctx = new OfflineAudioContext(1, totalSamples + (SAMPLE_RATE * 1.5), SAMPLE_RATE);
  
  // 1. Stitch Character (Dry) DIRECTLY into the convolver input buffer
  const dryBuffer = ctx.createBuffer(1, totalSamples, SAMPLE_RATE);
  const dryData = dryBuffer.getChannelData(0);
  stitchToBuffer(dryData, voiceBuffers, timing.startTimes, segments, 'character', 'replace');

  // 2. Setup Reverb Graph using the pre-filled buffer
  const source = ctx.createBufferSource();
  source.buffer = dryBuffer;

  const convolver = ctx.createConvolver();
  convolver.buffer = getImpulseResponse(ctx, 1.5, 3.0); 
  convolver.normalize = true;

  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();

  dryGain.gain.value = 0.9; // 1 - mix (mix=0.1)
  wetGain.gain.value = 0.1;

  source.connect(dryGain);
  source.connect(convolver);
  convolver.connect(wetGain);
  
  dryGain.connect(ctx.destination);
  wetGain.connect(ctx.destination);
  source.start();
  
  // 3. Render Reverb
  const reverbBuffer = await ctx.startRendering();
  
  // 4. Stitch Narrator directly into the Reverb Output (mixing it in)
  const dialogueChannel = reverbBuffer.getChannelData(0);
  stitchToBuffer(dialogueChannel, voiceBuffers, timing.startTimes, segments, 'narrator', 'add');

  // 5. Parallel Gen
  const [mixedAmbience, score, sfx] = await Promise.all([
    generateAmbience(totalDuration, scene.ambientSounds), 
    generateAdvancedScore(totalDuration, scene.scoreStyle),
    renderSFXTrack(totalDuration, segments, timing.startTimes)
  ]);

  return {
    dialogue: reverbBuffer,
    score,
    ambience: mixedAmbience,
    sfx,
    duration: totalDuration
  };
};