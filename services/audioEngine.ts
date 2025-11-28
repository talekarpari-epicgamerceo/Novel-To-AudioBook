import { SceneContext, ParsedSegment } from "../types";

let audioCtx: AudioContext | null = null;
const SAMPLE_RATE = 24000;

export const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  }
  return audioCtx;
};

export const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
};

export const decodeAudioData = async (arrayBuffer: ArrayBuffer): Promise<AudioBuffer> => {
  const ctx = getAudioContext();
  
  if (arrayBuffer.byteLength === 0) {
     return ctx.createBuffer(1, 100, SAMPLE_RATE); // Return tiny silence
  }

  // Gemini TTS returns Raw PCM 16-bit, 24kHz, Mono, Little Endian.
  const dataView = new DataView(arrayBuffer);
  // Ensure we have complete 2-byte samples
  const numSamples = Math.floor(arrayBuffer.byteLength / 2);
  
  const audioBuffer = ctx.createBuffer(1, numSamples, SAMPLE_RATE);
  const channelData = audioBuffer.getChannelData(0);

  for (let i = 0; i < numSamples; i++) {
    const sample = dataView.getInt16(i * 2, true); 
    // Normalize Int16 (-32768..32767) to Float32 (-1.0..1.0)
    channelData[i] = sample < 0 ? sample / 32768 : sample / 32767;
  }

  return audioBuffer;
};

export const createSilenceBuffer = (duration: number): AudioBuffer => {
  const ctx = getAudioContext();
  const safeDuration = Math.max(0.1, duration); 
  return ctx.createBuffer(1, Math.floor(SAMPLE_RATE * safeDuration), SAMPLE_RATE);
};

export const trimSilence = (buffer: AudioBuffer): AudioBuffer => {
  const data = buffer.getChannelData(0);
  let start = 0;
  let end = data.length;
  // Threshold for silence detection (lower is more sensitive)
  const threshold = 0.005; 

  while (start < end && Math.abs(data[start]) < threshold) start++;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;

  // If buffer is mostly silence or too short, return as is or return silence
  if (end - start < buffer.sampleRate * 0.05) return buffer; 

  const ctx = getAudioContext();
  const newBuffer = ctx.createBuffer(buffer.numberOfChannels, end - start, buffer.sampleRate);
  
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const channelData = buffer.getChannelData(ch);
    const newChannelData = newBuffer.getChannelData(ch);
    newChannelData.set(channelData.subarray(start, end));
  }
  return newBuffer;
};

// --- Reverb Generation ---

let cachedImpulse: AudioBuffer | null = null;

const getImpulseResponse = (ctx: BaseAudioContext, duration: number, decay: number) => {
  // Optimization: Return cached buffer if available. 
  // Note: AudioBuffers can be shared across contexts if created by the main context, 
  // but OfflineAudioContext is strict. However, the data generation is the expensive part.
  if (cachedImpulse) return cachedImpulse;

  const length = ctx.sampleRate * duration;
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  const left = impulse.getChannelData(0);
  const right = impulse.getChannelData(1);

  for (let i = 0; i < length; i++) {
    const n = i / length;
    // Exponential decay
    const val = Math.pow(1 - n, decay) * (Math.random() * 2 - 1);
    left[i] = val;
    right[i] = val;
  }
  
  cachedImpulse = impulse;
  return impulse;
};

export const applyReverb = async (inputBuffer: AudioBuffer, mix: number = 0.3): Promise<AudioBuffer> => {
  const ctx = new OfflineAudioContext(1, inputBuffer.length, inputBuffer.sampleRate);
  
  const source = ctx.createBufferSource();
  source.buffer = inputBuffer;

  const convolver = ctx.createConvolver();
  // Short, tight room reverb for dialogue. Reuses cached impulse if available.
  convolver.buffer = getImpulseResponse(ctx, 1.5, 3.0); 

  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();

  dryGain.gain.value = 1 - mix;
  wetGain.gain.value = mix;

  source.connect(dryGain);
  source.connect(convolver);
  convolver.connect(wetGain);
  
  dryGain.connect(ctx.destination);
  wetGain.connect(ctx.destination);

  source.start();
  return ctx.startRendering();
};


// --- Procedural Generation using OfflineAudioContext for better quality ---

const createNoiseBuffer = (ctx: BaseAudioContext) => {
  const bufferSize = ctx.sampleRate * 4; // 4 seconds loop is enough to avoid obvious repetition
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const output = buffer.getChannelData(0);
  let lastOut = 0;
  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    // Simple Pink Noise approximation (1/f)
    output[i] = (lastOut + (0.02 * white)) / 1.02;
    lastOut = output[i];
    output[i] *= 3.5; // Compensate for gain loss
  }
  return buffer;
};

export const generateAmbience = async (
  duration: number, 
  type: SceneContext['roomToneType'] | SceneContext['bgNoiseType']
): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  // Min duration 1s to avoid errors
  const safeDuration = Math.max(1, duration);
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * safeDuration), sampleRate);

  if (type === 'silence' || type === 'none') {
    return ctx.createBuffer(2, Math.floor(sampleRate * safeDuration), sampleRate);
  }

  // Create Noise Source
  const noiseBuffer = createNoiseBuffer(ctx);
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer;
  source.loop = true;

  // Filter based on type to shape the noise (Coloring)
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  if (type === 'quiet_room') {
    // Room tone is usually low rumble
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    gain.gain.value = 0.5;
  } else if (type === 'nature') {
    // Nature has some highs (leaves) and lows (wind)
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    gain.gain.value = 0.4;
  } else if (type === 'rain') {
    filter.type = 'lowpass';
    filter.frequency.value = 800;
    gain.gain.value = 0.6;
  } else if (type === 'city') {
    filter.type = 'bandpass';
    filter.frequency.value = 1000;
    filter.Q.value = 0.5;
    gain.gain.value = 0.4;
  } else if (type === 'machinery' || type === 'industrial') {
    filter.type = 'lowpass';
    filter.frequency.value = 200;
    gain.gain.value = 0.8;
  } else {
    // Default
    filter.type = 'lowpass';
    filter.frequency.value = 500;
    gain.gain.value = 0.3;
  }

  source.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  source.start();

  return ctx.startRendering();
};

// --- SFX Generation ---

const random = (min: number, max: number) => Math.random() * (max - min) + min;

export const generateSFX = async (type: string): Promise<AudioBuffer> => {
   const sampleRate = SAMPLE_RATE;
   // Use a generous 4s buffer for SFX to allow for tails and multi-step sounds
   const ctx = new OfflineAudioContext(2, sampleRate * 4, sampleRate);
   const t = type.toLowerCase();
   
   // Master Compressor to glue layers together
   const compressor = ctx.createDynamicsCompressor();
   compressor.threshold.value = -20;
   compressor.ratio.value = 4;
   compressor.connect(ctx.destination);

   if (t.includes('thunder') || t.includes('explosion') || t.includes('boom')) {
      // Layer 1: The Rumble (Low end power)
      const noise1 = createNoiseBuffer(ctx);
      const src1 = ctx.createBufferSource();
      src1.buffer = noise1;
      const filter1 = ctx.createBiquadFilter();
      filter1.type = 'lowpass';
      filter1.frequency.setValueAtTime(400, 0);
      filter1.frequency.exponentialRampToValueAtTime(50, 2.5); // Pitch drop
      const gain1 = ctx.createGain();
      gain1.gain.setValueAtTime(0, 0);
      gain1.gain.linearRampToValueAtTime(0.8, 0.1); 
      gain1.gain.exponentialRampToValueAtTime(0.01, 3.5); 
      src1.connect(filter1).connect(gain1).connect(compressor);
      src1.start(0);

      // Layer 2: The Crackle (High end texture)
      const noise2 = createNoiseBuffer(ctx);
      const src2 = ctx.createBufferSource();
      src2.buffer = noise2;
      const filter2 = ctx.createBiquadFilter();
      filter2.type = 'bandpass';
      filter2.frequency.value = random(1000, 1500);
      filter2.Q.value = 1;
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, 0.1); // Slight delay
      gain2.gain.linearRampToValueAtTime(0.4, 0.2);
      gain2.gain.exponentialRampToValueAtTime(0.01, 1.0);
      src2.connect(filter2).connect(gain2).connect(compressor);
      src2.start(0);

      // Layer 3: Sub-bass impact
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(60, 0);
      osc.frequency.exponentialRampToValueAtTime(20, 1.0);
      const oscGain = ctx.createGain();
      oscGain.gain.setValueAtTime(0.5, 0);
      oscGain.gain.exponentialRampToValueAtTime(0.01, 1.5);
      osc.connect(oscGain).connect(compressor);
      osc.start(0);

   } else if (t.includes('wind') || t.includes('howl')) {
      // Layer 1: Main Howl
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

      // Layer 2: Air/Hiss (Secondary Texture)
      const noise2 = createNoiseBuffer(ctx);
      const src2 = ctx.createBufferSource();
      src2.buffer = noise2;
      const filter2 = ctx.createBiquadFilter();
      filter2.type = 'highpass';
      filter2.frequency.value = 1200;
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, 0);
      gain2.gain.linearRampToValueAtTime(0.2, 1.0);
      gain2.gain.linearRampToValueAtTime(0, 3.5);
      src2.connect(filter2).connect(gain2).connect(compressor);
      src2.start(0);

   } else if (t.includes('creak') || t.includes('door') || t.includes('squeak')) {
      // Layer 1: The Groan (Sawtooth with wobbly pitch)
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

      // Layer 2: High friction (Filtered Noise)
      const noise = createNoiseBuffer(ctx);
      const src2 = ctx.createBufferSource();
      src2.buffer = noise;
      const filter2 = ctx.createBiquadFilter();
      filter2.type = 'highpass';
      filter2.frequency.value = 2500;
      const gain2 = ctx.createGain();
      gain2.gain.setValueAtTime(0, 0);
      gain2.gain.linearRampToValueAtTime(0.1, 0.3);
      gain2.gain.linearRampToValueAtTime(0, 1.5);
      src2.connect(filter2).connect(gain2).connect(compressor);
      src2.start(0);

   } else if (t.includes('footstep') || t.includes('step') || t.includes('walk')) {
      // 3 steps with variations
      for(let i=0; i<3; i++) {
        const time = i * random(0.5, 0.65); // Vary rhythm slightly

        // Layer 1: Thud (Low body)
        const noise = createNoiseBuffer(ctx);
        const src = ctx.createBufferSource();
        src.buffer = noise;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = random(100, 180); // Vary tone
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, time);
        gain.gain.linearRampToValueAtTime(0.5, time + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
        
        src.connect(filter).connect(gain).connect(compressor);
        src.start(time);
        src.stop(time + 0.3);

        // Layer 2: Crunch (High detail)
        const noise2 = createNoiseBuffer(ctx);
        const src2 = ctx.createBufferSource();
        src2.buffer = noise2;
        const filter2 = ctx.createBiquadFilter();
        filter2.type = 'highpass';
        filter2.frequency.value = 1500;
        const gain2 = ctx.createGain();
        gain2.gain.setValueAtTime(0, time);
        gain2.gain.linearRampToValueAtTime(0.15, time + 0.01);
        gain2.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

        src2.connect(filter2).connect(gain2).connect(compressor);
        src2.start(time);
        src2.stop(time + 0.2);
      }
   } else if (t.includes('shatter') || t.includes('glass') || t.includes('crash')) {
       // Layer 1: Impact
       const noise = createNoiseBuffer(ctx);
       const src = ctx.createBufferSource();
       src.buffer = noise;
       const gain = ctx.createGain();
       gain.gain.setValueAtTime(0.8, 0);
       gain.gain.exponentialRampToValueAtTime(0.01, 0.3);
       src.connect(gain).connect(compressor);
       src.start(0);

       // Layer 2: Debris (Multiple randomized high-freq pips)
       for (let i = 0; i < 15; i++) {
           const osc = ctx.createOscillator();
           osc.type = 'triangle';
           osc.frequency.value = random(2000, 8000);
           const tStart = random(0.05, 0.6);
           const dur = random(0.05, 0.2);
           
           const g = ctx.createGain();
           g.gain.setValueAtTime(0, tStart);
           g.gain.linearRampToValueAtTime(random(0.05, 0.2), tStart + 0.01);
           g.gain.exponentialRampToValueAtTime(0.001, tStart + dur);
           
           osc.connect(g).connect(compressor);
           osc.start(tStart);
           osc.stop(tStart + dur + 0.1);
       }
   } else if (t.includes('rustle') || t.includes('leaves')) {
      // Layer 1: Broad movement
      const noise = createNoiseBuffer(ctx);
      const src = ctx.createBufferSource();
      src.buffer = noise;
      const filter = ctx.createBiquadFilter();
      filter.type = 'highpass';
      filter.frequency.value = 1000;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, 0);
      gain.gain.linearRampToValueAtTime(0.2, 0.2);
      gain.gain.linearRampToValueAtTime(0, 1.0);
      
      // Jitter
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 15;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.1;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      lfo.start();

      src.connect(filter).connect(gain).connect(compressor);
      src.start();

      // Layer 2: Snap/Crackle (Occasional crisp sound)
      for(let i=0; i<3; i++) {
         const tRand = random(0.1, 0.8);
         const noise2 = createNoiseBuffer(ctx);
         const src2 = ctx.createBufferSource();
         src2.buffer = noise2;
         const filter2 = ctx.createBiquadFilter();
         filter2.type = 'highpass';
         filter2.frequency.value = 3000;
         const gain2 = ctx.createGain();
         gain2.gain.setValueAtTime(0, tRand);
         gain2.gain.linearRampToValueAtTime(0.1, tRand + 0.01);
         gain2.gain.exponentialRampToValueAtTime(0.001, tRand + 0.1);
         src2.connect(filter2).connect(gain2).connect(compressor);
         src2.start(tRand);
         src2.stop(tRand + 0.2);
      }
   } else {
      // Generic Impact
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

   return ctx.startRendering();
}


// --- Advanced Score Generation ---

const NOTES = {
  'C2': 65.41, 'D2': 73.42, 'E2': 82.41, 'F2': 87.31, 'G2': 98.00, 'A2': 110.00, 'B2': 123.47,
  'C3': 130.81, 'D3': 146.83, 'E3': 164.81, 'F3': 174.61, 'G3': 196.00, 'A3': 220.00, 'Bb3': 233.08, 'B3': 246.94,
  'C4': 261.63, 'D4': 293.66, 'E4': 329.63, 'F4': 349.23, 'G4': 392.00, 'A4': 440.00, 'B4': 493.88,
  'C5': 523.25
};

const SCALES = {
  sad: [NOTES.A2, NOTES.C3, NOTES.E3, NOTES.A3, NOTES.B3, NOTES.C4], // Minor
  tense: [NOTES.C2, NOTES.C3, NOTES.F2, NOTES.F3, NOTES.G2], // Dissonant intervals
  happy: [NOTES.C3, NOTES.E3, NOTES.G3, NOTES.C4, NOTES.D4, NOTES.E4], // Major
  mysterious: [NOTES.D3, NOTES.F3, NOTES.A3, NOTES.Bb3, NOTES.C4], // D Minorish
  romantic: [NOTES.F3, NOTES.A3, NOTES.C4, NOTES.E4, NOTES.G4], // Major 7th feel
  neutral: [NOTES.C3, NOTES.G3]
};

export const generateAdvancedScore = async (duration: number, style: SceneContext['scoreStyle']): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  const safeDuration = Math.max(1, duration);
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * safeDuration), sampleRate);

  if (style === 'neutral') return ctx.createBuffer(2, Math.floor(sampleRate * safeDuration), sampleRate);

  const tempo = (style === 'tense' || style === 'happy') ? 120 : 70;
  const beatTime = 60 / tempo;
  const scale = SCALES[style] || SCALES.neutral;
  const rootNote = scale[0];

  // --- LAYER 1: PADS (Background Texture) ---
  const padGain = ctx.createGain();
  padGain.gain.value = 0.2;
  padGain.connect(ctx.destination);
  
  // Create a chord that sustains
  const chordNotes = [scale[0], scale[2] || scale[0] * 1.5, scale[4] || scale[0] * 2];
  chordNotes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = style === 'tense' ? 'sawtooth' : 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() * 10) - 5;
    
    // Slow LFO for movement
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.1 + (Math.random() * 0.2);
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 5;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.detune);

    // Envelope
    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0, 0);
    noteGain.gain.linearRampToValueAtTime(0.5 / chordNotes.length, safeDuration * 0.2);
    noteGain.gain.setValueAtTime(0.5 / chordNotes.length, safeDuration * 0.8);
    noteGain.gain.linearRampToValueAtTime(0, safeDuration);

    osc.connect(noteGain);
    noteGain.connect(padGain);
    osc.start();
    lfo.start();
  });


  // --- LAYER 2: BASS (Rhythm & Foundation) ---
  const bassGain = ctx.createGain();
  bassGain.gain.value = 0.25;
  bassGain.connect(ctx.destination);

  let currentTime = 0;
  while (currentTime < safeDuration) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    // Deep bass note
    osc.frequency.value = rootNote / 2; 

    const noteGain = ctx.createGain();
    const duration = style === 'tense' ? beatTime / 2 : beatTime * 2;
    
    noteGain.gain.setValueAtTime(0, currentTime);
    noteGain.gain.linearRampToValueAtTime(0.8, currentTime + 0.05);
    noteGain.gain.exponentialRampToValueAtTime(0.01, currentTime + duration);

    osc.connect(noteGain);
    noteGain.connect(bassGain);
    
    osc.start(currentTime);
    osc.stop(currentTime + duration);

    currentTime += duration;
  }

  // --- LAYER 3: ARPEGGIO / MELODY (Motion) ---
  if (style !== 'sad' && style !== 'mysterious') {
    const arpGain = ctx.createGain();
    arpGain.gain.value = 0.15;
    arpGain.connect(ctx.destination);
    
    // Simple delay effect
    const delay = ctx.createDelay();
    delay.delayTime.value = beatTime * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    delay.connect(feedback);
    feedback.connect(delay);
    arpGain.connect(delay);
    delay.connect(ctx.destination);

    let arpTime = 0;
    let noteIdx = 0;
    const arpSpeed = beatTime / 2;

    while (arpTime < safeDuration) {
      if (Math.random() > 0.3) { // 70% chance to play a note
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        const freq = scale[noteIdx % scale.length] * (Math.random() > 0.8 ? 2 : 1); // Occasional octave up
        osc.frequency.value = freq;

        const noteGain = ctx.createGain();
        noteGain.gain.setValueAtTime(0, arpTime);
        noteGain.gain.linearRampToValueAtTime(0.5, arpTime + 0.01);
        noteGain.gain.exponentialRampToValueAtTime(0.01, arpTime + 0.2);

        osc.connect(noteGain);
        noteGain.connect(arpGain);
        osc.start(arpTime);
        osc.stop(arpTime + 0.3);
      }
      noteIdx++;
      arpTime += arpSpeed;
    }
  }

  // --- LAYER 4: PERCUSSION/RHYTHM (Tonal Pluck - NO WHITE NOISE) ---
  const percGain = ctx.createGain();
  percGain.gain.value = 0.15;
  percGain.connect(ctx.destination);

  let percTime = 0;
  while (percTime < safeDuration) {
     if (style === 'tense' || style === 'happy' || style === 'mysterious') {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        // High pitch tonal pluck instead of noise
        osc.frequency.value = scale[2] * 4; 
        
        const noteGain = ctx.createGain();
        noteGain.gain.setValueAtTime(0, percTime);
        noteGain.gain.linearRampToValueAtTime(0.3, percTime + 0.005);
        noteGain.gain.exponentialRampToValueAtTime(0.001, percTime + 0.1);
        
        osc.connect(noteGain);
        noteGain.connect(percGain);
        osc.start(percTime);
        osc.stop(percTime + 0.15);
     }
     percTime += beatTime;
  }


  return ctx.startRendering();
};


export const stitchDialogueTracks = async (
  voiceBuffers: AudioBuffer[]
): Promise<AudioBuffer> => {
  const ctx = getAudioContext();
  const MIX_RATE = SAMPLE_RATE;

  let totalDuration = 0;
  voiceBuffers.forEach(b => totalDuration += b.duration);
  // Add a little tail
  totalDuration += 1.0; 

  const output = ctx.createBuffer(1, Math.floor(totalDuration * MIX_RATE), MIX_RATE);
  const outData = output.getChannelData(0);

  let currentSample = 0;
  for (const vBuf of voiceBuffers) {
    const vData = vBuf.getChannelData(0);
    const length = vData.length;
    
    // Simple stitching
    for (let i = 0; i < length; i++) {
      if (currentSample + i < outData.length) {
        outData[currentSample + i] = vData[i];
      }
    }
    currentSample += length;
  }
  
  return output;
};


// Render the SFX track based on segment timing
export const renderSFXTrack = async(
  totalDuration: number,
  segments: ParsedSegment[],
  voiceBuffers: AudioBuffer[]
): Promise<AudioBuffer> => {
  const sampleRate = SAMPLE_RATE;
  const ctx = new OfflineAudioContext(1, Math.floor(sampleRate * totalDuration), sampleRate);
  
  let currentTime = 0;
  
  for(let i=0; i<segments.length; i++) {
     const seg = segments[i];
     const buf = voiceBuffers[i];
     
     if (seg.sfx) {
        // Generate the specific SFX
        const sfxBuffer = await generateSFX(seg.sfx);
        const src = ctx.createBufferSource();
        src.buffer = sfxBuffer;
        src.connect(ctx.destination);
        src.start(currentTime);
     }
     
     // Advance time by the duration of the current dialogue segment
     if (buf) {
        currentTime += buf.duration;
     }
  }
  
  return ctx.startRendering();
};


export const generateTrackBuffers = async (
  voiceBuffers: AudioBuffer[],
  segments: ParsedSegment[],
  scene: SceneContext
): Promise<{ dialogue: AudioBuffer, score: AudioBuffer, ambience: AudioBuffer, sfx: AudioBuffer, duration: number }> => {

  const dialogue = await stitchDialogueTracks(voiceBuffers);
  const totalDuration = dialogue.duration;

  // Generate Procedural Backing Tracks in parallel
  const [roomTone, bgNoise, score, sfx] = await Promise.all([
    generateAmbience(totalDuration, scene.roomToneType),
    generateAmbience(totalDuration, scene.bgNoiseType),
    generateAdvancedScore(totalDuration, scene.scoreStyle),
    renderSFXTrack(totalDuration, segments, voiceBuffers)
  ]);

  // Mix room tone and bg noise into one "Ambience" track for simplicity in the UI mixer
  const sampleRate = SAMPLE_RATE;
  const ctx = new OfflineAudioContext(2, Math.floor(sampleRate * totalDuration), sampleRate);
  
  // Ambience Mix
  const sourceRoom = ctx.createBufferSource();
  sourceRoom.buffer = roomTone;
  const sourceBg = ctx.createBufferSource();
  sourceBg.buffer = bgNoise;
  
  sourceRoom.connect(ctx.destination);
  sourceBg.connect(ctx.destination);
  
  sourceRoom.start();
  sourceBg.start();
  
  const mixedAmbience = await ctx.startRendering();

  return {
    dialogue,
    score,
    ambience: mixedAmbience,
    sfx,
    duration: totalDuration
  };
};