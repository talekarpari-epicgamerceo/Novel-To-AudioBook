
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
  BoltIcon,
  MapPinIcon,
  FaceSmileIcon,
  ClockIcon
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

const ttsQueue = new AsyncJobQueue(24); 
const sfxQueue = new AsyncJobQueue(12);

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
  const [volSFX, setVolSFX] = useState(0.75); // Ensure 75% default
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

  const startTimeRef = useRef<number>(0);
  const pauseTimeRef = useRef<number>(0);
  const prevSpeedRef = useRef<number>(1.0);

  const NARRATOR_CONTEXT = "Strictly matter-of-fact delivery. Professional, neutral narrator. No emotion.";

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => setText(event.target?.result as string);
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
             const space = seg.text.startsWith(' ') ? '' : ' ';
             currentTask.textToSpeak += space + seg.text;
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
      const tasks = createSpeechTasks(result.segments);
      tasks.forEach(task => {
          if (!task.textToSpeak.trim()) return;
          const profile = profiles.find(p => p.name === task.speaker);
          const voiceId = profile?.voiceId || 'Puck'; 
          const context = task.isNarrator 
            ? NARRATOR_CONTEXT
            : `Character: ${task.speaker}. Deliver text with emotion: ${result.segments[task.startIndex].emotion}.`;
          generateSpeech(task.textToSpeak, voiceId, context).catch(() => {});
      });
  };

  const handleAnalyze = async () => {
    if (!text.trim()) return;
    setStatus('analyzing');
    setParsedData(null);
    setAudioTracks(null);
    setProgress(0);
    pauseTimeRef.current = 0;
    try {
      const result = await analyzeText(text);
      setParsedData(result);
      const uniqueSpeakers = Array.from(new Set(result.segments.map(s => s.speaker).filter(s => s !== 'Narrator')));
      const isThirdPerson = result.scene.narrativePerspective === 'third_person';
      const profiles: CharacterProfile[] = uniqueSpeakers.map(name => {
        const segment = result.segments.find(s => s.speaker === name);
        const gender = segment?.gender || 'neutral';
        const pool = AVAILABLE_VOICES.filter(v => (gender === 'neutral' ? true : v.gender === gender) && (isThirdPerson ? v.id !== 'Fenrir' : true));
        const voice = pool.length > 0 ? pool[Math.floor(Math.random() * pool.length)] : AVAILABLE_VOICES[0];
        return { name, gender: gender as any, voiceId: voice.id };
      });
      let narratorVoiceId = 'Fenrir'; 
      if (!isThirdPerson) {
         const protag = result.scene.protagonistName;
         let p = profiles.find(pr => pr.name === protag) || profiles.find(pr => pr.name === 'I' || pr.name === 'Me');
         if (p) narratorVoiceId = p.voiceId;
      }
      profiles.push({ name: 'Narrator', gender: 'male', voiceId: narratorVoiceId });
      setCharacterProfiles(profiles);
      setStatus('reviewing');
      prefetchAudio(result, profiles);
    } catch (err) {
      setStatus('error');
    }
  };

  const handleGenerateAudio = async () => {
    if (!parsedData) return;
    setStatus('generating_speech');
    setAudioTracks(null);
    setProgress(0);
    pauseTimeRef.current = 0;
    try {
      const updatedSegments = [...parsedData.segments];
      const audioBufferArray: (Int16Array | null)[] = new Array(updatedSegments.length).fill(null);
      const uniqueSFX = [...new Set(updatedSegments.filter(s => s.sfx).map(s => s.sfx!))];
      const sfxJob = Promise.all(uniqueSFX.map(sfxType => sfxQueue.add(() => generateSFX(sfxType))));
      const tasks = createSpeechTasks(updatedSegments);
      const ttsJob = Promise.all(tasks.map(task => ttsQueue.add(async () => {
          if (!task.textToSpeak.trim()) return;
          const profile = characterProfiles.find(p => p.name === task.speaker);
          const voiceId = profile?.voiceId || 'Puck'; 
          const context = task.isNarrator 
            ? NARRATOR_CONTEXT
            : `Character: ${task.speaker}. Deliver text with emotion: ${updatedSegments[task.startIndex].emotion}.`;
          const rawAudio = await generateSpeech(task.textToSpeak, voiceId, context);
          const totalDuration = rawAudio.length / 24000;
          const totalChars = task.indices.reduce((acc, idx) => acc + updatedSegments[idx].text.length, 0);
          task.indices.forEach((idx, i) => {
             const seg = updatedSegments[idx];
             seg.assignedVoiceId = voiceId;
             seg.speechDuration = totalDuration * (seg.text.length / totalChars);
             if (i === 0) audioBufferArray[idx] = rawAudio;
          });
      })));
      await Promise.all([sfxJob, ttsJob]);
      setStatus('mixing');
      const tracks = await generateTrackBuffers(audioBufferArray, updatedSegments, parsedData.scene);
      setAudioTracks(tracks);
      setStatus('playing'); 
    } catch (err) {
      setStatus('error');
    }
  };

  const stopAllSources = () => {
    ['dialogue', 'score', 'ambience', 'sfx'].forEach(key => {
      const k = key as keyof typeof sourcesRef.current;
      const node = sourcesRef.current[k];
      if (node) {
        try { node.stop(); node.disconnect(); } catch(e) {}
        sourcesRef.current[k] = null;
      }
    });
  };

  const togglePlayback = async () => {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') await ctx.resume();
    audioContextRef.current = ctx;

    if (isPlaying) {
      const now = ctx.currentTime;
      const elapsed = (now - startTimeRef.current) * playbackSpeed;
      stopAllSources();
      pauseTimeRef.current = elapsed; 
      setIsPlaying(false);
    } else {
      if (!audioTracks) return;
      
      const masterGain = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();
      masterGain.connect(compressor).connect(ctx.destination);
      
      const gD = ctx.createGain(); gD.gain.value = volDialogue; gD.connect(masterGain);
      const gS = ctx.createGain(); gS.gain.value = volScore; gS.connect(masterGain);
      const gA = ctx.createGain(); gA.gain.value = volAmbience; gA.connect(masterGain);
      const gSFX = ctx.createGain(); gSFX.gain.value = volSFX; gSFX.connect(masterGain);
      gainsRef.current = { dialogue: gD, score: gS, ambience: gA, sfx: gSFX };
      
      const sD = ctx.createBufferSource(); sD.buffer = audioTracks.dialogue; sD.connect(gD);
      const sS = ctx.createBufferSource(); sS.buffer = audioTracks.score; sS.connect(gS); sS.loop = true;
      const sA = ctx.createBufferSource(); sA.buffer = audioTracks.ambience; sA.connect(gA); sA.loop = true;
      const sSFX = ctx.createBufferSource(); sSFX.buffer = audioTracks.sfx; sSFX.connect(gSFX);
      
      [sD, sS, sA, sSFX].forEach(s => s.playbackRate.value = playbackSpeed);
      
      const now = ctx.currentTime;
      const offset = Math.max(0, pauseTimeRef.current % audioTracks.duration);
      
      // Calibrate start time for resume/initial play
      startTimeRef.current = now - (offset / playbackSpeed);
      
      sD.start(now, offset);
      sS.start(now, offset % (sS.buffer?.duration || 1));
      sA.start(now, offset % (sA.buffer?.duration || 1));
      sSFX.start(now, offset);
      
      sourcesRef.current = { dialogue: sD, score: sS, ambience: sA, sfx: sSFX };
      setIsPlaying(true);
    }
  };

  useEffect(() => {
    if (isPlaying && audioContextRef.current && audioTracks) {
      const now = audioContextRef.current.currentTime;
      const elapsed = (now - startTimeRef.current) * prevSpeedRef.current;
      startTimeRef.current = now - (elapsed / playbackSpeed);
      // Fix: cast Object.values to explicitly handle 'unknown' type when mapping source nodes
      (Object.values(sourcesRef.current) as (AudioBufferSourceNode | null)[]).forEach(source => {
        if (source) source.playbackRate.value = playbackSpeed;
      });
    }
    prevSpeedRef.current = playbackSpeed;
  }, [playbackSpeed, isPlaying, audioTracks]);

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
        
        setProgress(Math.min(100, (elapsed / audioTracks.duration) * 100));
        animationFrame = requestAnimationFrame(updateProgress);
      }
    };
    if (isPlaying) updateProgress();
    return () => cancelAnimationFrame(animationFrame);
  }, [isPlaying, audioTracks, playbackSpeed]);

  useEffect(() => {
    if (gainsRef.current.dialogue) gainsRef.current.dialogue.gain.value = volDialogue;
    if (gainsRef.current.score) gainsRef.current.score.gain.value = volScore;
    if (gainsRef.current.ambience) gainsRef.current.ambience.gain.value = volAmbience;
    if (gainsRef.current.sfx) gainsRef.current.sfx.gain.value = volSFX;
  }, [volDialogue, volScore, volAmbience, volSFX]);

  const getSpeakerColor = (speaker: string, isNarrator: boolean) => {
    if (isNarrator) return 'bg-slate-50 border-slate-200';
    const colors = ['bg-indigo-50 border-indigo-100', 'bg-rose-50 border-rose-100', 'bg-emerald-50 border-emerald-100', 'bg-amber-50 border-amber-100'];
    let hash = 0;
    for (let i = 0; i < speaker.length; i++) hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
    return colors[Math.abs(hash) % colors.length];
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8 flex flex-col items-center pb-60">
      <header className="w-full max-w-4xl mb-8 flex items-center justify-between">
        <div className="flex items-center gap-3">
           <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-purple-600 rounded-lg flex items-center justify-center shadow-md">
             <SpeakerWaveIcon className="w-6 h-6 text-white" />
           </div>
           <div>
             <h1 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-indigo-600 to-purple-700 font-serif">VoxNovel AI</h1>
             <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mt-0.5">Immersive Narratives</p>
           </div>
        </div>
        <div className="text-[10px] font-black uppercase tracking-widest text-slate-400 bg-white border border-slate-200 px-3 py-1 rounded-full flex items-center gap-2 shadow-sm">
          <span className={`w-1.5 h-1.5 rounded-full ${status === 'playing' ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`}></span>
          {status.replace('_', ' ')}
        </div>
      </header>

      <main className="w-full max-w-4xl space-y-8">
        <section className={`transition-all duration-500 ${status !== 'idle' && status !== 'error' ? 'opacity-40 pointer-events-none grayscale-[0.5]' : ''}`}>
           <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm ring-1 ring-slate-200/50">
             <h2 className="text-sm font-bold mb-4 flex items-center gap-2 text-slate-400 uppercase tracking-widest">
               <DocumentTextIcon className="w-4 h-4 text-indigo-400" /> Source Manuscript
             </h2>
             <textarea 
               className="w-full h-44 bg-slate-50 border border-slate-200 rounded-xl p-5 text-base font-serif leading-relaxed text-slate-800 focus:ring-2 focus:ring-indigo-500 focus:outline-none transition-all resize-none shadow-inner"
               value={text}
               onChange={(e) => setText(e.target.value)}
               placeholder="Enter your story..."
             />
             <div className="mt-5 flex items-center justify-between">
                <label className="text-xs font-bold text-slate-500 cursor-pointer bg-white border border-slate-200 px-4 py-2.5 rounded-xl hover:border-indigo-400 transition-all shadow-sm active:scale-95">
                  Upload Manuscript
                  <input type="file" accept=".txt" onChange={handleFileUpload} className="hidden" />
                </label>
                <button 
                  onClick={handleAnalyze}
                  disabled={status !== 'idle' && status !== 'error'}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-2.5 rounded-xl font-bold shadow-lg shadow-indigo-100 flex items-center gap-2 disabled:opacity-50 transition-all active:scale-95"
                >
                  {status === 'analyzing' ? <ArrowPathIcon className="w-5 h-5 animate-spin" /> : <SparklesIcon className="w-5 h-5" />}
                  Analyze Scene
                </button>
             </div>
           </div>
        </section>

        {parsedData && (
          <section className="space-y-6 animate-fade-in-up">
            <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm grid grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                { label: 'Mood', icon: FaceSmileIcon, val: parsedData.scene.mood, color: 'text-indigo-600', iconColor: 'text-indigo-400' },
                { label: 'Ambience', icon: SpeakerWaveIcon, val: parsedData.scene.roomToneType, color: 'text-emerald-600', iconColor: 'text-emerald-400' },
                { label: 'Score', icon: MusicalNoteIcon, val: parsedData.scene.scoreStyle, color: 'text-amber-600', iconColor: 'text-amber-400' },
                { label: 'Location', icon: MapPinIcon, val: parsedData.scene.location, color: 'text-rose-500', iconColor: 'text-rose-400' },
                { label: 'Time', icon: ClockIcon, val: parsedData.scene.timeOfDay || 'Unknown', color: 'text-slate-600', iconColor: 'text-slate-400' }
              ].map((item, idx) => (
                <div key={idx} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col justify-between h-32 transition-transform hover:-translate-y-1 shadow-sm">
                  <span className="text-[10px] text-slate-400 uppercase font-black flex items-center gap-2 shrink-0">
                    <item.icon className={`w-4 h-4 ${item.iconColor}`} /> {item.label}
                  </span>
                  <span className={`${item.color} font-black capitalize leading-tight text-sm overflow-hidden text-ellipsis line-clamp-2`}>
                    {item.val.replace('_', ' ')}
                  </span>
                </div>
              ))}
            </div>

            <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-md ring-1 ring-slate-200/50">
               <div className="p-4 bg-white border-b border-slate-100 flex justify-between items-center">
                 <h3 className="font-bold text-slate-400 text-xs uppercase tracking-widest flex items-center gap-2">
                    Director's Script
                 </h3>
                 {status === 'reviewing' && (
                   <button 
                     onClick={handleGenerateAudio}
                     className="bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-5 py-2.5 rounded-xl flex items-center gap-2 font-bold shadow-lg shadow-emerald-50 active:scale-95 transition-all"
                   >
                     <BoltIcon className="w-4 h-4" /> Synthesize Audio
                   </button>
                 )}
               </div>
               
               <div className="max-h-[440px] overflow-y-auto p-5 space-y-4 bg-slate-50/40 custom-scrollbar">
                 {parsedData.segments.map((seg) => (
                   <div key={seg.id} className={`p-5 rounded-2xl border-2 transition-all shadow-sm ${getSpeakerColor(seg.speaker, seg.isNarrator)}`}>
                     <div className="flex items-center gap-3 mb-3">
                        <span className="text-[10px] font-black uppercase tracking-wider bg-white px-2.5 py-1 rounded-lg border border-slate-200 shadow-sm text-slate-600">
                          {seg.speaker}
                        </span>
                        {!seg.isNarrator && (
                          <span className="text-[10px] text-slate-500 font-bold px-2 py-0.5 bg-slate-100/50 rounded-md ring-1 ring-slate-200/50 italic">
                             {seg.emotion}
                          </span>
                        )}
                        {seg.sfx && (
                          <span className="text-[10px] text-amber-600 font-black flex items-center gap-1.5 bg-amber-100/80 px-2.5 py-1 rounded-lg border border-amber-200 shadow-sm animate-pulse">
                            <BoltIcon className="w-3 h-3" /> {seg.sfx}
                          </span>
                        )}
                     </div>
                     <p className={`text-[15px] leading-relaxed tracking-tight ${seg.isNarrator ? 'text-slate-500 italic font-serif opacity-90' : 'text-slate-800 font-medium'}`}>
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
        <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-xl border-t border-slate-200 p-8 shadow-2xl z-50 animate-slide-up ring-1 ring-slate-200/50">
           <div className="max-w-4xl mx-auto space-y-8">
              <div className="flex items-center gap-8">
                 <button 
                   onClick={togglePlayback}
                   className="w-16 h-16 bg-indigo-600 hover:bg-indigo-500 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-indigo-200 transition-all hover:scale-105 active:scale-95 relative group"
                 >
                   <div className="absolute inset-0 bg-indigo-400 rounded-2xl animate-ping opacity-0 group-hover:opacity-20 transition-opacity"></div>
                   {isPlaying ? <PauseIcon className="w-9 h-9" /> : <PlayIcon className="w-9 h-9 ml-1" />}
                 </button>
                 
                 <div className="flex-1 space-y-3">
                    <div className="flex justify-between text-[11px] text-slate-400 font-black uppercase tracking-widest">
                       <span className="flex items-center gap-2">
                          <ClockIcon className="w-3 h-3" /> Playback Progress
                       </span>
                       <span className="font-mono text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100">
                          {Math.floor(progress)}%
                       </span>
                    </div>
                    <div className="h-3 bg-slate-100 rounded-full overflow-hidden border border-slate-200/50 shadow-inner">
                       <div 
                         className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-600 transition-all duration-150 ease-linear shadow-sm"
                         style={{ width: `${progress}%` }}
                       />
                    </div>
                 </div>

                 <div className="w-28 text-center bg-slate-50 p-3 rounded-2xl border border-slate-200 shadow-sm">
                    <span className="block text-[10px] text-slate-400 font-black uppercase mb-2 tracking-tighter">Speed Multiplier</span>
                    <input 
                      type="range" min="0.5" max="2" step="0.25" 
                      value={playbackSpeed}
                      onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                      className="w-full accent-indigo-600 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer"
                    />
                    <span className="text-xs font-mono font-black text-indigo-700 mt-2 block">{playbackSpeed.toFixed(2)}x</span>
                 </div>
              </div>

              <div className="grid grid-cols-4 gap-6 pt-6 border-t border-slate-100">
                  {[
                    { label: 'Dialogue', icon: UserIcon, val: volDialogue, set: setVolDialogue, color: 'accent-indigo-500' },
                    { label: 'Score', icon: MusicalNoteIcon, val: volScore, set: setVolScore, color: 'accent-amber-500' },
                    { label: 'Ambient', icon: SparklesIcon, val: volAmbience, set: setVolAmbience, color: 'accent-emerald-500' },
                    { label: 'SFX', icon: BoltIcon, val: volSFX, set: setVolSFX, color: 'accent-rose-500' }
                  ].map((vol, i) => (
                    <div key={i} className="space-y-3 p-3 rounded-2xl hover:bg-slate-50 transition-colors">
                       <span className="text-[10px] text-slate-400 font-black uppercase flex items-center gap-2">
                          <vol.icon className="w-3.5 h-3.5 opacity-60" /> {vol.label}
                       </span>
                       <input 
                         type="range" min="0" max="1" step="0.05" 
                         value={vol.val} 
                         onChange={(e) => vol.set(parseFloat(e.target.value))} 
                         className={`w-full ${vol.color} h-1.5 bg-slate-200/80 rounded-lg appearance-none cursor-pointer`} 
                       />
                    </div>
                  ))}
              </div>
           </div>
        </div>
      )}
    </div>
  );
}
