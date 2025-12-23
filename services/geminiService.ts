
import { GoogleGenAI, Type, Schema, Modality } from "@google/genai";
import { AnalysisResult, ParsedSegment, SceneContext } from "../types";
import { base64ToInt16, trimSilenceRaw } from './audioEngine';

const API_KEY = process.env.API_KEY || '';

const ai = new GoogleGenAI({ apiKey: API_KEY });

const ttsPromiseCache = new Map<string, Promise<Int16Array>>(); 
const analysisCache = new Map<string, AnalysisResult>();

const segmentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING, description: "The exact text content." },
    speaker: { type: Type.STRING, description: "Name of the character or 'Narrator'." },
    isNarrator: { type: Type.BOOLEAN },
    gender: { type: Type.STRING, enum: ["male", "female", "neutral"] },
    emotion: { type: Type.STRING, description: "Dialogue tone. For Narrator: ALWAYS 'Matter-of-fact'." },
    sfx: { type: Type.STRING, description: "Short SFX keyword or null." }
  },
  required: ["text", "speaker", "isNarrator", "gender", "emotion"]
};

const sceneSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    location: { type: Type.STRING, description: "STRICT: 1-2 words only (e.g. 'Dark Hallway')." },
    timeOfDay: { type: Type.STRING, description: "STRICT: 1 word (e.g. 'Night')." },
    mood: { type: Type.STRING, description: "STRICT: 1 word (e.g. 'Tense')." },
    roomToneType: { type: Type.STRING, enum: ['quiet_room', 'nature', 'city', 'industrial', 'silence'] },
    bgNoiseType: { type: Type.STRING, enum: ['rain', 'wind', 'crowd', 'machinery', 'none'] },
    scoreStyle: { type: Type.STRING, enum: ['happy', 'sad', 'tense', 'mysterious', 'romantic', 'neutral'], description: "STRICT: Select one single word style." },
    narrativePerspective: { type: Type.STRING, enum: ['first_person', 'third_person'] },
    protagonistName: { type: Type.STRING },
    ambientSounds: { type: Type.ARRAY, items: { type: Type.STRING }, description: "3 brief sound keywords." }
  },
  required: ["location", "mood", "roomToneType", "bgNoiseType", "scoreStyle", "narrativePerspective", "ambientSounds"]
};

const analysisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    segments: { type: Type.ARRAY, items: segmentSchema },
    scene: sceneSchema
  },
  required: ["segments", "scene"]
};

export const analyzeText = async (text: string): Promise<AnalysisResult> => {
  const cacheKey = text.trim();
  if (analysisCache.has(cacheKey)) {
    return JSON.parse(JSON.stringify(analysisCache.get(cacheKey)));
  }

  const prompt = `
    Analyze novel text for an immersive audiobook. 
    
    UI CONSTRAINTS:
    - location, mood, scoreStyle, and timeOfDay MUST be 1-2 words maximum. No long descriptions.
    
    NARRATOR RULES:
    - Narrator emotion MUST ALWAYS be "Matter-of-fact".
    - Delivery should be strictly professional and consistent.

    Text to analyze: "${text.slice(0, 10000)}" 
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: prompt,
    config: {
      responseMimeType: "application/json",
      responseSchema: analysisSchema,
      systemInstruction: "You are a script processing engine. You enforce extreme brevity in scene labels and professional, matter-of-fact narration.",
    },
  });

  if (response.text) {
    const result = JSON.parse(response.text) as AnalysisResult;
    result.segments = result.segments.map((s, i) => ({
      ...s,
      id: `seg_${Date.now()}_${i}`,
      originalText: s.text,
      emotion: s.isNarrator ? "Matter-of-fact" : s.emotion
    }));
    analysisCache.set(cacheKey, result);
    return result;
  }
  throw new Error("No response");
};

export const generateSpeech = async (text: string, voiceName: string, context: string): Promise<Int16Array> => {
  const cacheKey = `${voiceName}:${context}:${text.trim()}`;
  if (ttsPromiseCache.has(cacheKey)) return ttsPromiseCache.get(cacheKey)!;

  const task = (async () => {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: `Instr: ${context}\nRead: "${text}"`,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName },
          },
        },
      },
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) throw new Error("No audio");
    let rawAudio = base64ToInt16(audioData);
    return trimSilenceRaw(rawAudio);
  })();

  ttsPromiseCache.set(cacheKey, task);
  return task;
};
