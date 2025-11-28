import React, { useState, useRef, useEffect } from 'react';
import { analyzeText, generateSpeech } from './services/geminiService';
import { 
  getAudioContext, 
  base64ToArrayBuffer, 
  decodeAudioData, 
  generateTrackBuffers,
  createSilenceBuffer,
  applyReverb,
  trimSilence
} from './services/audioEngine';
import { 
  AnalysisResult, 
  CharacterProfile, 
  AVAILABLE_VOICES, 
  ProcessingState,
  AudioTracks
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
  AdjustmentsHorizontalIcon,
  BoltIcon
} from '@heroicons/react/24/solid';

const DEFAULT_TEXT = `The old house stood silent on the hill. 
"I don't like this," whispered Sarah, clutching her coat tighter.
"Don't be such a coward," Mark retorted, flashing his flashlight at the broken windows. "It's just wood and stone."
Thunder rumbled overhead, shaking the ground beneath them.
"Did you hear that?" Sarah asked, her voice trembling.
The front door creaked open slowly, revealing the darkness inside.`;

export default function App() {
  const [text, setText] = useState<string>(DEFAULT_TEXT);
  const [status, setStatus] = useState<ProcessingState>('idle');
  const [parsedData, setParsedData] = useState<AnalysisResult | null>(null);
  const [characterProfiles, setCharacterProfiles] = useState<CharacterProfile[]>([]);
  
  // Audio Data
  const [audioTracks, setAudioTracks] = useState<AudioTracks | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0-100
  
  // Mixer State
  const [volDialogue, setVolDialogue] = useState(0.9);
  const [volScore, setVolScore] = useState(0.4); // Default 40% as requested
  const [volAmbience, setVolAmbience] = useState(0.05); // Default 5%
  const [volSFX, setVolSFX] = useState(0.5); // Default 50%
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);

  // Refs for Audio Graph
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

  // 1. Handle File Upload
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

  // 2. Analyze Text
  const handleAnalyze = async () => {
    if (!text.trim()) return;
    setStatus('analyzing');
    setParsedData(null);
    setAudioTracks(null);
    
    try {
      const result = await analyzeText(text);
      setParsedData(result);
      
      const uniqueSpeakers = Array.from(new Set(result.segments.map(s => s.speaker)));
      const profiles: CharacterProfile[] = uniqueSpeakers.map(name => {
        if (name === 'Narrator') {
          return { name, gender: 'male', voiceId: 'Fenrir' };
        }
        const segment = result.segments.find(s => s.speaker === name);
        const gender = segment?.gender || 'neutral';
        const availableForGender = AVAILABLE_VOICES.filter(v => 
          (gender === 'neutral' ? true : v.gender === gender) && v.id !== 'Fenrir'
        );
        const pool = availableForGender.length > 0 ? availableForGender : AVAILABLE_VOICES;
        const randomVoice = pool[Math.floor(Math.random() * pool.length)];
        return { name, gender: gender as any, voiceId: randomVoice.id };
      });
      
      setCharacterProfiles(profiles);
      setStatus('reviewing');
    } catch (err) {
      console.error(err);
      setStatus('error');
    }
  };

  // 3. Generate Audio
  const handleGenerateAudio = async () => {
    if (!parsedData) return;
    setStatus('generating_speech');
    
    try {
      const updatedSegments = [...parsedData.segments];
      const buffers: AudioBuffer[] = [];

      for (let i = 0; i < updatedSegments.length; i++) {
        const seg = updatedSegments[i];
        if (!seg.text.trim()) {
           const duration = Math.max(0.1, seg.text.length * 0.05);
           buffers.push(createSilenceBuffer(duration));
           continue;
        }

        const profile = characterProfiles.find(p => p.name === seg.speaker);
        const voiceId = profile?.voiceId || 'Puck'; 
        
        // Detailed context building for acting instruction
        let context = "";
        if (seg.isNarrator) {
           context = "Narration. Read this in a clear, descriptive storytelling tone.";
        } else {
           // It's dialogue
           context = `Character: ${seg.speaker} (${seg.gender}). 
           Emotion/Tone: ${seg.emotion}. 
           Pay close attention to any reporting verbs in the emotion instruction (e.g. whispered, shouted).`;
        }

        const base64Audio = await generateSpeech(seg.text, voiceId, context);
        const arrayBuffer = base64ToArrayBuffer(base64Audio);
        let audioBuffer = await decodeAudioData(arrayBuffer);
        
        // Trim silence to prevent audio doubling/gapping
        audioBuffer = trimSilence(audioBuffer);

        // Apply Reverb to Dialogue only (to create space) - Reduced to 0.1 mix
        if (!seg.isNarrator) {
           audioBuffer = await applyReverb(audioBuffer, 0.1); 
        }
        
        updatedSegments[i].assignedVoiceId = voiceId;
        updatedSegments[i].audioBuffer = audioBuffer;
        buffers.push(audioBuffer);
      }

      setStatus('mixing');
      
      // Generate individual track buffers, passing segments for SFX timing
      const tracks = await generateTrackBuffers(buffers, updatedSegments, parsedData.scene);
      setAudioTracks(tracks);
      setStatus('playing'); 

    } catch (err) {
      console.error("Audio Generation Error:", err);
      setStatus('error');
    }
  };

  // Dynamic Volume Updates
  useEffect(() => {
    if (gainsRef.current.dialogue) gainsRef.current.dialogue.gain.value = volDialogue;
    if (gainsRef.current.score) gainsRef.current.score.gain.value = volScore;
    if (gainsRef.current.ambience) gainsRef.current.ambience.gain.value = volAmbience;
    if (gainsRef.current.sfx) gainsRef.current.sfx.gain.value = volSFX;
  }, [volDialogue, volScore, volAmbience, volSFX]);

  // Dynamic Speed Updates
  useEffect(() => {
    if (sourcesRef.current.dialogue) sourcesRef.current.dialogue.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.score) sourcesRef.current.score.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.ambience) sourcesRef.current.ambience.playbackRate.value = playbackSpeed;
    if (sourcesRef.current.sfx) sourcesRef.current.sfx.playbackRate.value = playbackSpeed;
  }, [playbackSpeed]);


  // Playback Control
  const togglePlayback = () => {
    const ctx = getAudioContext();
    audioContextRef.current = ctx;
    
    if (isPlaying) {
      // STOP
      ['dialogue', 'score', 'ambience', 'sfx'].forEach(key => {
        const k = key as keyof typeof sourcesRef.current;
        if (sourcesRef.current[k]) {
          sourcesRef.current[k]?.stop();
          sourcesRef.current[k] = null;
        }
      });
      pauseTimeRef.current = (ctx.currentTime - startTimeRef.current) * playbackSpeed; 
      setIsPlaying(false);
    } else {
      // START
      if (!audioTracks) return;
      
      // Create Gains
      const gainD = ctx.createGain();
      const gainS = ctx.createGain();
      const gainA = ctx.createGain();
      const gainSFX = ctx.createGain();
      
      gainD.gain.value = volDialogue;
      gainS.gain.value = volScore;
      gainA.gain.value = volAmbience;
      gainSFX.gain.value = volSFX;
      
      gainD.connect(ctx.destination);
      gainS.connect(ctx.destination);
      gainA.connect(ctx.destination);
      gainSFX.connect(ctx.destination);
      
      gainsRef.current = { dialogue: gainD, score: gainS, ambience: gainA, sfx: gainSFX };

      // Create Sources
      const srcD = ctx.createBufferSource();
      const srcS = ctx.createBufferSource();
      const srcA = ctx.createBufferSource();
      const srcSFX = ctx.createBufferSource();
      
      srcD.buffer = audioTracks.dialogue;
      srcS.buffer = audioTracks.score;
      srcA.buffer = audioTracks.ambience;
      srcSFX.buffer = audioTracks.sfx;
      
      srcD.connect(gainD);
      srcS.connect(gainS);
      srcA.connect(gainA);
      srcSFX.connect(gainSFX);

      // Apply Speed
      srcD.playbackRate.value = playbackSpeed;
      srcS.playbackRate.value = playbackSpeed;
      srcA.playbackRate.value = playbackSpeed;
      srcSFX.playbackRate.value = playbackSpeed;
      
      const offset = (pauseTimeRef.current % audioTracks.duration);
      
      srcD.start(0, offset);
      srcS.start(0, offset);
      srcA.start(0, offset);
      srcSFX.start(0, offset);
      
      sourcesRef.current = { dialogue: srcD, score: srcS, ambience: srcA, sfx: srcSFX };
      startTimeRef.current = ctx.currentTime - (offset / playbackSpeed);
      
      setIsPlaying(true);

      srcD.onended = () => {
         // Simple check to see if we reached end
         if ((ctx.currentTime - startTimeRef.current) * playbackSpeed >= audioTracks.duration - 0.5) {
             setIsPlaying(false);
             pauseTimeRef.current = 0;
         }
      };
    }
  };

  // Progress Bar update
  useEffect(() => {
    let animationFrame: number;
    const updateProgress = () => {
      if (isPlaying && audioTracks && audioContextRef.current) {
        const elapsed = (audioContextRef.current.currentTime - startTimeRef.current) * playbackSpeed;
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
        
        {/* Step 1: Input */}
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

        {/* Step 2: Scene & Character Review */}
        {parsedData && (
          <section className="space-y-6 animate-fade-in-up">
            
            {/* Context Panel */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-6 backdrop-blur-sm">
               <h3 className="text-sm uppercase tracking-wider text-slate-500 mb-4 font-bold">Scene Context (AI Detected)</h3>
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
                    <div className="flex gap-2">
                       <span className="text-emerald-300 capitalize">{parsedData.scene.roomToneType.replace('_', ' ')}</span>
                       <span className="text-slate-600">+</span>
                       <span className="text-emerald-300 capitalize">{parsedData.scene.bgNoiseType}</span>
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

            {/* Script Breakdown */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
               <div className="bg-slate-900 p-4 border-b border-slate-800 flex justify-between items-center sticky top-0 z-10">
                 <div className="flex items-center gap-2">
                   <h3 className="font-semibold text-slate-200">Director's Script</h3>
                   <span className="text-xs bg-slate-800 px-2 py-0.5 rounded text-slate-400">
                     {parsedData.segments.length} segments
                   </span>
                 </div>
                 {status === 'reviewing' && (
                   <button 
                     onClick={handleGenerateAudio}
                     className="bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-1.5 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-emerald-500/20 flex items-center gap-2"
                   >
                     <SparklesIcon className="w-4 h-4" />
                     Generate Audio
                   </button>
                 )}
               </div>
               
               <div className="max-h-[500px] overflow-y-auto p-6 space-y-4 bg-slate-950/30">
                 {parsedData.segments.map((seg) => {
                   const profile = characterProfiles.find(p => p.name === seg.speaker);
                   return (
                    <div key={seg.id} className="relative group">
                      <div className={`p-4 rounded-lg border transition-all hover:border-slate-600 ${getSpeakerColor(seg.speaker, seg.isNarrator)}`}>
                        <div className="flex justify-between items-start mb-2 opacity-80">
                          <div className="flex items-center gap-2">
                            {seg.isNarrator ? (
                               <BookOpenIcon className="w-3 h-3 text-slate-400" />
                            ) : (
                               <UserIcon className="w-3 h-3 text-white" />
                            )}
                            <span className={`font-bold text-xs uppercase tracking-wider ${seg.isNarrator ? 'text-slate-400' : 'text-white'}`}>
                              {seg.speaker}
                            </span>
                            <span className="text-[10px] text-slate-300 opacity-70 border border-white/10 px-1.5 rounded-full">
                              {seg.emotion}
                            </span>
                          </div>
                          <div className="flex items-center gap-3">
                             {seg.sfx && (
                                <div className="flex items-center gap-1 text-[10px] text-yellow-400 bg-yellow-400/10 px-2 py-0.5 rounded-full border border-yellow-400/20">
                                   <BoltIcon className="w-3 h-3" />
                                   SFX: {seg.sfx}
                                </div>
                             )}
                             <div className="text-[10px] text-slate-400">
                               Voice: {profile?.voiceId}
                             </div>
                          </div>
                        </div>
                        <p className={`font-serif text-lg leading-relaxed text-slate-100 ${seg.isNarrator ? 'italic text-slate-400' : ''}`}>
                          {seg.originalText}
                        </p>
                      </div>
                    </div>
                   );
                 })}
               </div>
            </div>
          </section>
        )}

        {/* Mixer & Playback Controls */}
        {status === 'playing' && audioTracks && (
          <div className="fixed bottom-0 left-0 w-full bg-slate-900 border-t border-slate-800 p-4 shadow-2xl z-50 animate-slide-up">
            <div className="max-w-4xl mx-auto flex flex-col gap-4">
               
               {/* Timeline */}
               <div className="w-full">
                 <div className="flex justify-between text-xs text-slate-400 mb-1 font-mono">
                   <span>LIVE MIX</span>
                   <span>{Math.round(progress)}%</span>
                 </div>
                 <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                   <div 
                     className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-indigo-500 bg-[length:200%_100%] animate-pulse-slow"
                     style={{ width: `${progress}%` }}
                   />
                 </div>
               </div>

               <div className="flex flex-col md:flex-row items-center gap-6 md:gap-12">
                   
                   {/* Main Transport */}
                   <button 
                     onClick={togglePlayback}
                     className="w-16 h-16 bg-indigo-500 hover:bg-indigo-400 rounded-full flex items-center justify-center text-white shadow-lg transition-all active:scale-95 flex-shrink-0"
                   >
                     {isPlaying ? <PauseIcon className="w-8 h-8" /> : <PlayIcon className="w-8 h-8 ml-1" />}
                   </button>

                   {/* Mixing Console */}
                   <div className="flex-1 w-full grid grid-cols-2 md:grid-cols-5 gap-4 bg-slate-950/50 p-4 rounded-xl border border-slate-800">
                      
                      {/* Dialogue Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] uppercase text-slate-400 font-bold tracking-wider">
                           <span>Dialogue</span>
                           <span>{Math.round(volDialogue * 100)}%</span>
                        </div>
                        <input 
                          type="range" min="0" max="1" step="0.05" 
                          value={volDialogue} onChange={(e) => setVolDialogue(parseFloat(e.target.value))}
                          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                        />
                      </div>

                      {/* Score Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] uppercase text-slate-400 font-bold tracking-wider">
                           <span>Music</span>
                           <span>{Math.round(volScore * 100)}%</span>
                        </div>
                        <input 
                          type="range" min="0" max="1" step="0.05" 
                          value={volScore} onChange={(e) => setVolScore(parseFloat(e.target.value))}
                          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500"
                        />
                      </div>

                      {/* Ambience Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] uppercase text-slate-400 font-bold tracking-wider">
                           <span>Ambience</span>
                           <span>{Math.round(volAmbience * 100)}%</span>
                        </div>
                        <input 
                          type="range" min="0" max="1" step="0.05" 
                          value={volAmbience} onChange={(e) => setVolAmbience(parseFloat(e.target.value))}
                          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                        />
                      </div>

                      {/* SFX Slider (New) */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] uppercase text-slate-400 font-bold tracking-wider">
                           <span>Sounds</span>
                           <span>{Math.round(volSFX * 100)}%</span>
                        </div>
                        <input 
                          type="range" min="0" max="1" step="0.05" 
                          value={volSFX} onChange={(e) => setVolSFX(parseFloat(e.target.value))}
                          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-yellow-400"
                        />
                      </div>

                      {/* Speed Slider */}
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] uppercase text-slate-400 font-bold tracking-wider">
                           <span>Speed</span>
                           <span>{playbackSpeed}x</span>
                        </div>
                        <input 
                          type="range" min="0.5" max="1.5" step="0.25" 
                          value={playbackSpeed} onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                          className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-slate-400"
                        />
                         <div className="flex justify-between text-[8px] text-slate-600 px-1">
                            <span>0.5</span><span>1.0</span><span>1.5</span>
                         </div>
                      </div>

                   </div>
               </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}