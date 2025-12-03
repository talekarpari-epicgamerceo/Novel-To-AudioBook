
export interface ParsedSegment {
  id: string;
  text: string;
  originalText: string;
  speaker: string;
  isNarrator: boolean;
  gender: 'male' | 'female' | 'neutral';
  emotion: string;
  sfx?: string; // New field for sound effects
  assignedVoiceId?: string;
  audioBuffer?: AudioBuffer;
  speechDuration?: number; // Duration of speech before reverb/tails
}

export interface CharacterProfile {
  name: string;
  gender: 'male' | 'female' | 'neutral';
  voiceId: string;
}

export interface SceneContext {
  location: string;
  timeOfDay: string;
  mood: string;
  roomToneType: 'quiet_room' | 'nature' | 'city' | 'industrial' | 'silence';
  bgNoiseType: 'rain' | 'wind' | 'crowd' | 'machinery' | 'none';
  scoreStyle: 'happy' | 'sad' | 'tense' | 'mysterious' | 'romantic' | 'neutral';
  narrativePerspective: 'first_person' | 'third_person';
  protagonistName?: string;
  ambientSounds: string[]; // List of specific sounds to generate
}

export interface AnalysisResult {
  segments: ParsedSegment[];
  scene: SceneContext;
}

export interface AudioTracks {
  dialogue: AudioBuffer;
  score: AudioBuffer;
  ambience: AudioBuffer;
  sfx: AudioBuffer; // New track
  duration: number;
}

export const AVAILABLE_VOICES = [
  { id: 'Puck', gender: 'male', style: 'Playful, Neutral' },
  { id: 'Kore', gender: 'female', style: 'Calm, Soothing' },
  { id: 'Fenrir', gender: 'male', style: 'Deep, Resonant' },
  { id: 'Charon', gender: 'male', style: 'Gravelly, Serious' },
  { id: 'Zephyr', gender: 'female', style: 'Soft, Gentle' },
];

export type ProcessingState = 'idle' | 'analyzing' | 'reviewing' | 'generating_speech' | 'mixing' | 'playing' | 'error';
