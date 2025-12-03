import React, { useState, useRef, useEffect } from 'react';
import { analyzeText, generateSpeech } from './services/geminiService';
import { 
  getAudioContext, 
  generateTrackBuffers,
  generateSFX
} from './services/audioEngine';
import { 
  AnalysisResult, 
  CharacterProfile, 
  AVAILABLE_VOICES, 
  ProcessingState,
  AudioTracks,
  ParsedSegment
} from './types';
import { 
  PlayIcon, 
  PauseIcon, 
  ArrowPathIcon, 
  DocumentTextIcon, 
  SpeakerWaveIcon,
  MusicalNoteIcon,
  SparklesIcon,
  UserIcon,
  BookOpenIcon,
  BoltIcon
} from '@heroicons/react/24/solid';

const DEFAULT_TEXT = `The old house stood silent on the hill. 
"I don't like this," whispered Sarah, clutching her coat tighter.
"Don't be such a coward," Mark retorted, flashing his flashlight at the broken windows. "It's just wood and stone."
Thunder rumbled overhead, shaking the ground beneath them.
"Did you hear that?" Sarah asked, her voice trembling.
The front door creaked open slowly, revealing the darkness inside.`;

class AsyncJobQueue {
  private concurrency: number;
  private active: number = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(concurrency: number = 4) {
    this.concurrency = concurrency;
  }

  add<T>(task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const wrapper = async () => {
        try {
           const result = await task();
           resolve(result);
        } catch (e) {
           reject(e);
        } finally {
           this.active--;
           this.next();
        }
      };
      this.queue.push(wrapper);
      this.next();
    });
  }

  private next() {
    if (this.active >= this.concurrency || this.queue.length === 0) return;
    this.active++;
    const task = this.queue.shift();
    task?.();
  }
}

// OPTIMIZATION: High concurrency to handle background pre-fetching and batching
const ttsQueue = new AsyncJobQueue(16); 
const sfxQueue = new AsyncJobQueue(8);

interface SpeechTask {
   startIndex: number;
   indices: number[];
   textToSpeak: string;
   speaker: string;
   isNarrator: boolean;
}

export default function App() {
  const [text, setText] = useState<string>(DEFAULT_TEXT);
  const [status, setStatus] = useState<ProcessingState>('idle');
  const [parsedData, setParsedData] = useState<AnalysisResult | null>(null);
  const [characterProfiles, setCharacterProfiles] = useState<CharacterProfile[]>([]);
  
  const [audioTracks, setAudioTracks] = useState<AudioTracks | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); 
  
  const [volDialogue, setVolDialogue] = useState(0.8);
  const [volScore, setVolScore] = useState(0.15); 
  const [volAmbience, setVolAmbience] = useState(0.5); 
  const [volSFX, setVolSFX] = useState(0.5); 
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<{
    dialogue: AudioBufferSourceNode | null;
    score: AudioBufferSourceNode | null;
    ambience: AudioBufferSourceNode | null;
    sfx: AudioBufferSourceNode | null;
  }>({ dialogue: null, score: null, ambience: null, sfx: null });
  
  const gainsRef = useRef<{
    dialogue: GainNode | null;
    score: GainNode | null;
    ambience: GainNode | null;
    sfx: GainNode | null;
  }>({ dialogue: null, score: null, ambience: null, sfx: null });

  const masterBusRef = useRef<{
     gain: GainNode | null;
     compressor: DynamicsCompressorNode | null;
  }>({ gain: null, compressor: null });

  const startTimeRef = useRef<number>(0);
  const pauseTimeRef = useRef<number>(0);
  const previousSpeedRef = useRef<number>(1.0);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        setText(event.target?.result as string);
      };
      reader.readAsText(file);
    }
  };

  const createSpeechTasks = (segments: ParsedSegment[]): SpeechTask[] => {
      const tasks: SpeechTask[] = [];
      let currentTask: SpeechTask | null = null;

      segments.forEach((seg, index) => {
         let canMerge = false;
         if (currentTask) {
             const prevSeg = segments[currentTask.indices[currentTask.indices.length-1]];
             if (seg.speaker === currentTask.speaker && 
                 seg.isNarrator === currentTask.isNarrator &&
                 !seg.sfx && !prevSeg.sfx) {
                 canMerge = true;
             }
         }

         if (canMerge && currentTask) {
             currentTask.indices.push(index);
             const separator = /[.!?"]$/.test(currentTask.textToSpeak) ? " " : " "; 
             currentTask.textToSpeak += separator + seg.text;
         } else {
             if (currentTask) tasks.push(currentTask);
             currentTask = {
                 startIndex: index,
                 indices: [index],
                 textToSpeak: seg.text,
                 speaker: seg.speaker,
                 isNarrator: seg.isNarrator
             };
         }
      });
      if (currentTask) tasks.push(currentTask);
      return tasks;
  };

  const prefetchAudio = (result: AnalysisResult, profiles: CharacterProfile[]) => {
      console.log("Starting Background Audio Pre-fetch...");
      const tasks = createSpeechTasks(result.segments);
      
      // Fire and forget - populates the cache
      tasks.forEach(task => {
          if (!task.textToSpeak.trim()) return;
          
          const profile = profiles.find(p => p.name === task.speaker);
          const voiceId = profile?.voiceId || 'Puck'; 
          
          let context = "";
          if (task.isNarrator) {
             context = "Narration. Read clear, descriptive tone."; 
             if (result.scene.narrativePerspective === 'first_person') {
                 context += " You are the protagonist.";
             }
          } else {
             context = `Character: ${task.speaker}. Act out the text naturally based on context.`;
          }

          // Add to queue but don't await result here
          ttsQueue.add(() => generateSpeech(task.textToSpeak, voiceId, context)).catch(e => console.warn("Prefetch error", e));
      });
      
      // Also pre-fetch SFX
      const uniqueSFX = [...new Set(result.segments.filter(s => s.sfx).map(s => s.sfx!))];
      uniqueSFX.forEach(sfx => {
         sfxQueue.add(() => generateSFX(sfx)).catch(e => console.warn("SFX Prefetch error", e));
      });
  };

  const handleAnalyze = async () => {
    if (!text.trim()) return;
    setStatus('analyzing');
    setParsedData(null);
    setAudioTracks(null);
    
    try {
      const tStart = performance.now();
      const result = await analyzeText(text);
      console.log(`Analysis took: ${(performance.now() - tStart).toFixed(0)}ms`);

      setParsedData(result);
      
      const uniqueSpeakers = Array.from(new Set(result.segments.map(s => s.speaker).filter(s => s !== 'Narrator')));
      const isThirdPerson = result.scene.narrativePerspective === 'third_person';
      
      const profiles: CharacterProfile[] = uniqueSpeakers.map(name => {
        const segment = result.segments.find(s => s.speaker === name);
        const gender = segment?.gender || 'neutral';
        const availableForGender = AVAILABLE_VOICES.filter(v => 
          (gender === 'neutral' ? true : v.gender === gender) && 
          (isThirdPerson ? v.id !== 'Fenrir' : true)
        );
        const pool = availableForGender.length > 0 ? availableForGender : AVAILABLE_VOICES;
        const randomVoice = pool[Math.floor(Math.random() * pool.length)];
        return { name, gender: gender as any, voiceId: randomVoice.id };
      });
      
      let narratorVoiceId = 'Fenrir'; 

      if (!isThirdPerson) {
         const protagName = result.scene.protagonistName;
         let protagProfile = profiles.find(p => p.name === protagName);
         if (!protagProfile) {
            protagProfile = profiles.find(p => p.name === 'I' || p.name === 'Me');
         }
         if (protagProfile) {
            narratorVoiceId = protagProfile.voiceId;
         } else {
            narratorVoiceId = 'Puck'; 
         }
      }

      profiles.push({ name: 'Narrator', gender: 'male', voiceId: narratorVoiceId });
      setCharacterProfiles(profiles);
      setStatus('reviewing');
      
      // OPTIMIZATION: Start generating audio immediately in the background
      prefetchAudio(result, profiles);

    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  };

  const handleGenerateAudio = async () => {
    if (!parsedData) return;
    setStatus('generating_speech');
    
    try {
      const tStart = performance.now();
      const updatedSegments = [...parsedData.segments];
      const audioBufferArray: (Int16Array | null)[] = new Array(updatedSegments.length).fill(null);

      // SFX Generation (Likely already cached by pre-fetch)
      const uniqueSFX = [...new Set(updatedSegments.filter(s => s.sfx).map(s => s.sfx!))];
      const sfxJob = Promise.all(
        uniqueSFX.map(sfxType => sfxQueue.add(async () => {
           await generateSFX(sfxType);
        }))
      );

      const tasks = createSpeechTasks(updatedSegments);

      const ttsJob = Promise.all(
        tasks.map(task => ttsQueue.add(async () => {
          if (!task.textToSpeak.trim()) return;

          const profile = characterProfiles.find(p => p.name === task.speaker);
          const voiceId = profile?.voiceId || 'Puck'; 
          
          let context = "";
          if (task.isNarrator) {
             context = "Narration. Read clear, descriptive tone."; 
             if (parsedData.scene.narrativePerspective === 'first_person') {
                 context += " You are the protagonist.";
             }
          } else {
             context = `Character: ${task.speaker}. Act out the text naturally based on context.`;
          }

          // This will hit the Promise cache if pre-fetch started it
          const rawAudio = await generateSpeech(task.textToSpeak, voiceId, context);
          
          const totalDuration = rawAudio.length / 24000;
          const totalChars = task.indices.reduce((acc, idx) => acc + updatedSegments[idx].text.length, 0);
          
          task.indices.forEach((idx, i) => {
             const seg = updatedSegments[idx];
             seg.assignedVoiceId = voiceId;
             const share = seg.text.length / totalChars;
             seg.speechDuration = totalDuration * share;

             if (i === 0) {
                audioBufferArray[idx] = rawAudio;
             } else {
                audioBufferArray[idx] = null;
             }
          });
        }))
      );

      await Promise.all([sfxJob, ttsJob]);
      console.log(`Speech Gen took: ${(performance.now() - tStart).toFixed(0)}ms`);
      
      setStatus('mixing');
      const tMix = performance.now();
      const tracks = await generateTrackBuffers(audioBufferArray, updatedSegments, parsedData.scene);
      console.log(`Mixing took: ${(performance.now() - tMix).toFixed(0)}ms`);
      
      setAudioTracks(tracks);
      setStatus('playing'); 

    } catch (err) {
      console.error("Audio Generation Error:", err);
      setStatus('error');
    }
  };

  useEffect(() => {
    if (gainsRef.current.dialogue) gainsRef.current.dialogue.gain.value = volDialogue;
    if (gainsRef.current.score) gainsRef.current.score.gain.value = volScore;
    if (gainsRef.current.ambience) gainsRef.current.ambience.gain.value = volAmbience;
    if (gainsRef.current.sfx) gainsRef.current.sfx.gain.value = volSFX;
  }, [volDialogue, volScore, volAmbience, volSFX]);

  useEffect(() => {
    const ctx = audioContextRef.current;
    if (isPlaying && ctx) {
       const now = ctx.currentTime;
       const currentElapsed = (now - startTimeRef.current) * previousSpeedRef.current;
       startTimeRef.current = now - (currentElapsed / playbackSpeed);
    }

    if (sourcesRef.current.dialogue) sourcesRef.current.dialogue.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.score) sourcesRef.current.score.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.ambience) sourcesRef.current.ambience.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.sfx) sourcesRef.current.sfx.playbackRate.value = playbackSpeed;

    previousSpeedRef.current = playbackSpeed;
  }, [playbackSpeed, isPlaying]);

  const stopAllSources = () => {
    ['dialogue', 'score', 'ambience', 'sfx'].forEach(key => {
      const k = key as keyof typeof sourcesRef.current;
      const node = sourcesRef.current[k];
      if (node) {
        try {
          node.stop();
          node.disconnect();
        } catch(e) {
          // Ignore if already stopped
        }
        sourcesRef.current[k] = null;
      }
    });
  };

  const togglePlayback = async () => {
    const ctx = getAudioContext();
    
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch (e) {
        console.error("Context resume failed", e);
      }
    }
    audioContextRef.current = ctx;
    
    if (isPlaying) {
      stopAllSources();
      pauseTimeRef.current = (ctx.currentTime - startTimeRef.current) * playbackSpeed; 
      setIsPlaying(false);
    } else {
      if (!audioTracks) return;
      
      const masterGain = ctx.createGain();
      masterGain.gain.value = 1.0;

      const masterCompressor = ctx.createDynamicsCompressor();
      masterCompressor.threshold.value = -24; 
      masterCompressor.knee.value = 30;
      masterCompressor.ratio.value = 12; 
      masterCompressor.attack.value = 0.003;
      masterCompressor.release.value = 0.25;

      masterGain.connect(masterCompressor);
      masterCompressor.connect(ctx.destination);
      
      masterBusRef.current = { gain: masterGain, compressor: masterCompressor };

      const gainD = ctx.createGain();
      const gainS = ctx.createGain();
      const gainA = ctx.createGain();
      const gainSFX = ctx.createGain();
      
      gainD.gain.value = volDialogue;
      gainS.gain.value = volScore;
      gainA.gain.value = volAmbience;
      gainSFX.gain.value = volSFX;
      
      gainD.connect(masterGain);
      gainS.connect(masterGain);
      gainA.connect(masterGain);
      gainSFX.connect(masterGain);
      
      gainsRef.current = { dialogue: gainD, score: gainS, ambience: gainA, sfx: gainSFX };

      const srcD = ctx.createBufferSource();
      const srcS = ctx.createBufferSource();
      const srcA = ctx.createBufferSource();
      const srcSFX = ctx.createBufferSource();
      
      srcD.buffer = audioTracks.dialogue;
      srcS.buffer = audioTracks.score;
      srcA.buffer = audioTracks.ambience;
      srcSFX.buffer = audioTracks.sfx;

      srcS.loop = true;
      srcA.loop = true;
      
      srcD.connect(gainD);
      srcS.connect(gainS);
      srcA.connect(gainA);
      srcSFX.connect(gainSFX);

      srcD.playbackRate.value = playbackSpeed;
      srcS.playbackRate.value = playbackSpeed;
      srcA.playbackRate.value = playbackSpeed;
      srcSFX.playbackRate.value = playbackSpeed;
      
      const offset = (pauseTimeRef.current % audioTracks.duration);
      const now = ctx.currentTime;
      startTimeRef.current = now - (offset / playbackSpeed);

      srcD.start(now, offset);
      srcS.start(now, offset % (srcS.buffer?.duration || 1));
      srcA.start(now, offset % (srcA.buffer?.duration || 1));
      srcSFX.start(now, offset);
      
      sourcesRef.current = { dialogue: srcD, score: srcS, ambience: srcA, sfx: srcSFX };
      
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    let animationFrame: number;
    const updateProgress = () => {
      if (isPlaying && audioTracks && audioContextRef.current) {
        const now = audioContextRef.current.currentTime;
        const elapsed = (now - startTimeRef.current) * playbackSpeed;
        
        if (elapsed >= audioTracks.duration) {
            stopAllSources();
            setIsPlaying(false);
            pauseTimeRef.current = 0;
            setProgress(100); 
            return;
        }

        const p = (elapsed / audioTracks.duration) * 100;
        setProgress(Math.min(p, 100));
        animationFrame = requestAnimationFrame(updateProgress);
      }
    };
    if (isPlaying) {
      updateProgress();
    }
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, audioTracks, playbackSpeed]);

  const getSpeakerColor = (speaker: string, isNarrator: boolean) => {
    if (isNarrator) return 'bg-slate-800/40 border-slate-700/50';
    const colors = [
      'bg-indigo-900/40 border-indigo-700/50', 
      'bg-rose-900/40 border-rose-700/50', 
      'bg-emerald-900/40 border-emerald-700/50', 
      'bg-amber-900/40 border-amber-700/50', 
      'bg-cyan-900/40 border-cyan-700/50'
    ];
    let hash = 0;
    for (let i = 0; i < speaker.length; i++) hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
    const index = Math.abs(hash) % colors.length;
    return colors[index];
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 p-4 md:p-8 flex flex-col items-center pb-60">
      <header className="w-full max-w-4xl mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
           <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
             <SpeakerWaveIcon className="w-6 h-6 text-white" />
           </div>
           <div>
             <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-200 to-purple-200">VoxNovel AI</h1>
             <p className="text-xs text-slate-500">Audiobook Generator</p>
           </div>
        </div>
        <div className="text-xs font-mono text-slate-600 border border-slate-800 px-3 py-1 rounded-full flex items-center gap-2">
          Status: 
          <span className={`uppercase font-bold ${status === 'error' ? 'text-red-400' : 'text-indigo-400'}`}>
            {status.replace('_', ' ')}
          </span>
        </div>
      </header>

      <main className="w-full max-w-4xl space-y-6">
        <section className={`transition-all duration-500 ${status !== 'idle' && status !== 'error' ? 'opacity-50 pointer-events-none grayscale' : ''}`}>
           <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-6 shadow-xl">
             <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
               <DocumentTextIcon className="w-5 h-5 text-indigo-400" /> Source Text
             </h2>
             <textarea 
               className="w-full h-40 bg-slate-950 border border-slate-800 rounded-lg p-4 text-sm font-serif leading-relaxed text-slate-300 focus:ring-2 focus:ring-indigo-500 focus:outline-none resize-none"
               value={text}
               onChange={(e) => setText(e.target.value)}
               placeholder="Paste novel text here..."
             />
             <div className="mt-4 flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer hover:text-indigo-400 transition-colors">
                  <span className="bg-slate-800 px-3 py-1.5 rounded-md border border-slate-700">Upload .txt</span>
                  <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
                </label>
                <button 
                  onClick={handleAnalyze}
                  disabled={status !== 'idle' && status !== 'error'}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white px-6 py-2 rounded-lg font-medium transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {status === 'analyzing' ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <SparklesIcon className="w-5 h-5" />}
                  Analyze Scene
                </button>
             </div>
           </div>
        </section>

        {parsedData && (
          <section className="space-y-6 animate-fade-in-up">
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
               <div className="flex justify-between items-center mb-4">
                  <h3 className="text-sm uppercase tracking-wider text-slate-500 font-bold">Scene Context</h3>
                  <div className="text-xs px-2 py-1 rounded bg-slate-800 border border-slate-700 text-slate-300">
                    {parsedData.scene.narrativePerspective === 'first_person' ? 'First Person POV' : 'Third Person POV'}
                    {parsedData.scene.protagonistName ? ` (${parsedData.scene.protagonistName})` : ''}
                  </div>
               </div>
               
               <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                  <div className="bg-slate-950 p-3 rounded border border-slate-800/50">
                    <span className="block text-xs text-slate-500 mb-1">Location</span>
                    <span className="text-indigo-300 font-medium">{parsedData.scene.location}</span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded border border-slate-800/50">
                    <span className="block text-xs text-slate-500 mb-1">Mood</span>
                    <span className="text-pink-300 font-medium">{parsedData.scene.mood}</span>
                  </div>
                  <div className="bg-slate-950 p-3 rounded border border-slate-800/50">
                    <span className="block text-xs text-slate-500 mb-1">Ambience</span>
                    <div className="flex flex-col gap-1">
                       <div className="flex gap-2">
                           <span className="text-emerald-300 capitalize">{parsedData.scene.roomToneType.replace('_', ' ')}</span>
                       </div>
                       <div className="flex flex-wrap gap-1">
                           {parsedData.scene.ambientSounds.map(s => (
                             <span key={s} className="text-[10px] bg-emerald-900/50 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-800/50">
                               {s}
                             </span>
                           ))}
                       </div>
                    </div>
                  </div>
                  <div className="bg-slate-950 p-3 rounded border border-slate-800/50 col-span-2 md:col-span-1">
                    <span className="block text-xs text-slate-500 mb-1">Musical Score</span>
                    <span className="text-amber-300 capitalize flex items-center gap-2">
                      <MusicalNoteIcon className="w-3 h-3" /> {parsedData.scene.scoreStyle}
                    </span>
                  </div>
               </div>
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
               <div className="bg-slate-900 p-4 border-b border-slate-800 flex justify-between items-center sticky top-0 z-10">
                 <div className="flex items-center gap-2">
                   <h3 className="font-semibold text-slate-200">Director's Script</h3>
                   <span className="text-xs bg-slate-800 text-slate-400 px-2 py-0.5 rounded-full">{parsedData.segments.length} segments</span>
                 </div>
                 {status === 'reviewing' && (
                   <button 
                     onClick={handleGenerateAudio}
                     className="bg-emerald-600 hover:bg-emerald-500 text-white text-sm px-4 py-1.5 rounded-lg flex items-center gap-2 transition-colors"
                   >
                     <BoltIcon className="w-4 h-4" /> Generate Audio
                   </button>
                 )}
               </div>
               
               <div className="max-h-[500px] overflow-y-auto p-4 space-y-3 bg-slate-950/50">
                 {parsedData.segments.map((seg) => (
                   <div 
                     key={seg.id} 
                     className={`p-4 rounded-lg border transition-all hover:border-slate-600 ${getSpeakerColor(seg.speaker, seg.isNarrator)}`}
                   >
                     <div className="flex justify-between items-start mb-2">
                        <div className="flex items-center gap-2">
                           <span className={`text-xs font-bold px-2 py-0.5 rounded uppercase tracking-wide ${seg.isNarrator ? 'bg-slate-800 text-slate-400' : 'bg-indigo-950 text-indigo-300'}`}>
                             {seg.speaker}
                           </span>
                           {!seg.isNarrator && (
                             <span className="text-[10px] text-slate-400 bg-slate-900/50 px-2 py-0.5 rounded border border-slate-800">
                               {seg.emotion}
                             </span>
                           )}
                           {seg.sfx && (
                             <span className="text-[10px] text-amber-400 bg-amber-950/30 px-2 py-0.5 rounded border border-amber-900/50 flex items-center gap-1">
                               <BoltIcon className="w-3 h-3" /> {seg.sfx}
                             </span>
                           )}
                        </div>
                     </div>
                     <p className={`text-sm leading-relaxed ${seg.isNarrator ? 'text-slate-400 italic font-serif' : 'text-slate-200'}`}>
                       {seg.text}
                     </p>
                   </div>
                 ))}
               </div>
            </div>
          </section>
        )}
      </main>

      {audioTracks && (
        <div className="fixed bottom-0 left-0 right-0 bg-slate-900 border-t border-slate-800 p-4 md:p-6 shadow-2xl z-50 animate-slide-up">
           <div className="max-w-4xl mx-auto">
              <div className="flex items-center gap-4 mb-6">
                 <button 
                   onClick={togglePlayback}
                   className="w-14 h-14 bg-indigo-500 hover:bg-indigo-400 rounded-full flex items-center justify-center text-white shadow-lg shadow-indigo-500/30 transition-all hover:scale-105"
                 >
                   {isPlaying ? <PauseIcon className="w-7 h-7" /> : <PlayIcon className="w-7 h-7 ml-1" />}
                 </button>
                 
                 <div className="flex-1 space-y-2">
                    <div className="flex justify-between text-xs text-slate-400 uppercase tracking-wider font-semibold">
                       <span>Master Output</span>
                       <span>{Math.floor(progress)}%</span>
                    </div>
                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                       <div 
                         className="h-full bg-gradient-to-r from-indigo-500 to-purple-500 transition-all duration-100 ease-linear"
                         style={{ width: `${progress}%` }}
                       />
                    </div>
                 </div>

                 <div className="flex flex-col items-center justify-center w-28">
                    <span className="text-[10px] text-slate-500 uppercase font-bold mb-2">Speed</span>
                    <input 
                      type="range" 
                      min="0" 
                      max="2" 
                      step="0.25" 
                      list="speed-markers"
                      value={playbackSpeed}
                      onChange={(e) => setPlaybackSpeed(Math.max(0.25, parseFloat(e.target.value)))}
                      className="w-full accent-indigo-500 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer mb-2"
                    />
                    <datalist id="speed-markers">
                      <option value="0.0" label="0"></option>
                      <option value="0.5"></option>
                      <option value="1.0" label="1x"></option>
                      <option value="1.5"></option>
                      <option value="2.0" label="2x"></option>
                    </datalist>
                    <span className="text-xs text-indigo-400 font-mono">{playbackSpeed.toFixed(2)}x</span>
                 </div>
              </div>

              <div className="grid grid-cols-4 gap-4 md:gap-8 border-t border-slate-800 pt-4">
                  <div className="space-y-2">
                     <div className="flex justify-between text-xs text-slate-400">
                       <span className="flex items-center gap-1"><UserIcon className="w-3 h-3" /> Voice</span>
                       <span>{Math.round(volDialogue * 100)}%</span>
                     </div>
                     <input 
                       type="range" min="0" max="1" step="0.05" 
                       value={volDialogue} 
                       onChange={(e) => setVolDialogue(parseFloat(e.target.value))}
                       className="w-full accent-indigo-500 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                     />
                  </div>
                  <div className="space-y-2">
                     <div className="flex justify-between text-xs text-slate-400">
                       <span className="flex items-center gap-1"><MusicalNoteIcon className="w-3 h-3" /> Score</span>
                       <span>{Math.round(volScore * 100)}%</span>
                     </div>
                     <input 
                       type="range" min="0" max="1" step="0.05" 
                       value={volScore} 
                       onChange={(e) => setVolScore(parseFloat(e.target.value))}
                       className="w-full accent-amber-500 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                     />
                  </div>
                  <div className="space-y-2">
                     <div className="flex justify-between text-xs text-slate-400">
                       <span className="flex items-center gap-1"><SparklesIcon className="w-3 h-3" /> Ambience</span>
                       <span>{Math.round(volAmbience * 100)}%</span>
                     </div>
                     <input 
                       type="range" min="0" max="1" step="0.05" 
                       value={volAmbience} 
                       onChange={(e) => setVolAmbience(parseFloat(e.target.value))}
                       className="w-full accent-emerald-500 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                     />
                  </div>
                  <div className="space-y-2">
                     <div className="flex justify-between text-xs text-slate-400">
                       <span className="flex items-center gap-1"><BoltIcon className="w-3 h-3" /> SFX</span>
                       <span>{Math.round(volSFX * 100)}%</span>
                     </div>
                     <input 
                       type="range" min="0" max="1" step="0.05" 
                       value={volSFX} 
                       onChange={(e) => setVolSFX(parseFloat(e.target.value))}
                       className="w-full accent-rose-500 h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                     />
                  </div>
              </div>
           </div>
        </div>
      )}
    </div>
  );
}