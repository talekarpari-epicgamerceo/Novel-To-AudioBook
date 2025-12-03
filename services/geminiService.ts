import { GoogleGenAI, Type, Schema, Modality } from "@google/genai";
import { AnalysisResult, ParsedSegment, SceneContext } from "../types";
import { base64ToInt16, trimSilenceRaw } from './audioEngine';

const API_KEY = process.env.API_KEY || '';

const ai = new GoogleGenAI({ apiKey: API_KEY });

// OPTIMIZATION: Cache Promises instead of values to deduplicate in-flight requests
const ttsPromiseCache = new Map<string, Promise<Int16Array>>(); 
const analysisCache = new Map<string, AnalysisResult>();

// Schema definitions
const segmentSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING, description: "The exact text content of this segment. Must include leading/trailing spaces if present in original." },
    speaker: { type: Type.STRING, description: "Name of the character speaking, or 'Narrator'." },
    isNarrator: { type: Type.BOOLEAN, description: "True if this is descriptive narration (e.g. 'he said'), False if dialogue." },
    gender: { type: Type.STRING, enum: ["male", "female", "neutral"], description: "Gender of the speaker." },
    emotion: { type: Type.STRING, description: "Tone of voice, emotion, or specific delivery instruction (e.g. 'Whispered fearfully', 'Shouted in anger', 'Dry sarcasm'). Capture the reporting verb here if present." },
    sfx: { type: Type.STRING, description: "If the text describes a specific sound effect (e.g., 'thunder crashed', 'door creaked', 'wind howled', 'footsteps'), extract a keyword here. Otherwise null." }
  },
  required: ["text", "speaker", "isNarrator", "gender", "emotion"]
};

const sceneSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    location: { type: Type.STRING },
    timeOfDay: { type: Type.STRING },
    mood: { type: Type.STRING },
    roomToneType: { type: Type.STRING, enum: ['quiet_room', 'nature', 'city', 'industrial', 'silence'] },
    bgNoiseType: { type: Type.STRING, enum: ['rain', 'wind', 'crowd', 'machinery', 'none'] },
    scoreStyle: { type: Type.STRING, enum: ['happy', 'sad', 'tense', 'mysterious', 'romantic', 'neutral'] },
    narrativePerspective: { type: Type.STRING, enum: ['first_person', 'third_person'], description: "Is the story told from 'I' perspective (first_person) or 'He/She' perspective (third_person)?" },
    protagonistName: { type: Type.STRING, description: "If first_person, who is the 'I'? If unknown, use 'Protagonist'. If third_person, leave null or empty." },
    ambientSounds: { 
      type: Type.ARRAY, 
      items: { type: Type.STRING },
      description: "List 3-5 specific background sounds that would be heard in this location to create an immersive atmosphere (e.g., 'distant traffic', 'birds chirping', 'fluorescent light hum', 'distant announcements', 'waves crashing')." 
    }
  },
  required: ["location", "mood", "roomToneType", "bgNoiseType", "scoreStyle", "narrativePerspective", "ambientSounds"]
};

const analysisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    segments: {
      type: Type.ARRAY,
      items: segmentSchema
    },
    scene: sceneSchema
  },
  required: ["segments", "scene"]
};

const cleanSegments = (segments: ParsedSegment[]): ParsedSegment[] => {
  const cleaned = [...segments];
  for (let i = 0; i < cleaned.length - 1; i++) {
    const current = cleaned[i];
    const next = cleaned[i + 1];
    
    const currText = current.text.trim();
    const nextText = next.text;
    
    if (currText.length < 2) continue;

    if (nextText.trim().startsWith(currText)) {
       if (current.isNarrator !== next.isNarrator) {
          const overlapIndex = nextText.indexOf(currText);
          if (overlapIndex !== -1) {
             cleaned[i+1].text = nextText.substring(overlapIndex + currText.length);
          }
       }
    }
  }
  return cleaned.filter(s => s.text.trim().length > 0);
};

export const analyzeText = async (text: string): Promise<AnalysisResult> => {
  const cacheKey = text.trim();
  if (analysisCache.has(cacheKey)) {
    return JSON.parse(JSON.stringify(analysisCache.get(cacheKey)));
  }

  try {
    const prompt = `
      You are a meticulous audiobook script editor and director.
      Your task: Convert the raw novel text into a strictly segmented Director's Script.

      CRITICAL RULES:
      1. **EXACT FIDELITY**: The combination of all output segments MUST perfectly reconstruct the input text. Do NOT delete or change a single character, space, or punctuation mark.
      2. **STRICT SEGMENTATION**: 
         - **Dialogue**: Text spoken by a character (usually in quotes).
         - **Narration**: Everything else (speech tags like "he said", descriptive sentences).
         - **SPLIT THEM**: You must create separate segments when switching between Dialogue and Narration.
         - **SPACING**: If the input is ["I don't know," said John.], you must split it into:
           Segment 1: "I don't know," (Speaker: John, isNarrator: false)
           Segment 2: " said John." (Speaker: Narrator, isNarrator: true) - Note the leading space is preserved in this segment.
      
      3. **AVOID DUPLICATION**:
         - **COMMON MISTAKE**: Do NOT include the narration tag inside the dialogue segment.
         - INCORRECT: Text: "No," he said. -> Seg: "No," he said.
         - CORRECT: Seg 1: "No," | Seg 2: " he said."

      4. **DIRECTING INSTRUCTIONS (EMOTION FIELD)**:
         - For Dialogue: Look immediately at the narration *following* or *preceding* the quote for "Reporting Verbs" (e.g., "whispered", "shouted", "muttered", "hissed").
         - If the text says ["Get out!" he screamed.], the emotion for "Get out!" MUST be "Screamed/Shouted loud".
         - If the text says ["Be quiet," she whispered.], the emotion for "Be quiet," MUST be "Whispered/Soft".
         - Capture the exact tone implied by the context.
         - **Narrator Tone**: Also assign emotions to narration if the scene requires it (e.g. "Tense", "Fast-paced", "Melancholy").

      5. **SOUND EFFECTS (SFX FIELD)**:
         - Scan the narration text for specific sound events.
         - Examples: "The door creaked open" -> sfx: "creak/door". "Thunder rumbled overhead" -> sfx: "thunder". "He walked away" -> sfx: "footsteps". "Leaves rustled" -> sfx: "rustle". "The glass shattered" -> sfx: "shatter/crash".
         - Look for micro-interactions: "sighed", "gasped", "shifted in chair", "clothes rustled".
         - Assign this keyword to the segment containing the description.

      6. **CONTEXT & PERSPECTIVE**:
         - Analyze the scene location, mood, and soundscape requirements.
         - **PERSPECTIVE**: Determine if the text is First Person ("I walked") or Third Person ("He walked").
         - If First Person, identify the Protagonist's name if possible (e.g. from dialogue like "John, come here!").
         - **AMBIENCE**: Think of the location described. List 3-5 specific sounds one would hear there to create a realistic, layered atmosphere.

      Analyze this text:
      "${text.slice(0, 25000)}" 
    `;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: analysisSchema,
        systemInstruction: "You are a text processing engine. You preserve every byte of text including whitespace. You NEVER duplicate text across segments.",
      },
    });

    if (response.text) {
      const result = JSON.parse(response.text) as AnalysisResult;
      result.segments = cleanSegments(result.segments);
      result.segments = result.segments.map((s, i) => ({
        ...s,
        id: `seg_${Date.now()}_${i}`,
        originalText: s.text
      }));
      analysisCache.set(cacheKey, result);
      return result;
    }
    throw new Error("No response from AI");
  } catch (error) {
    console.error("Analysis Error:", error);
    throw error;
  }
};

export const generateSpeech = (text: string, voiceName: string, context: string): Promise<Int16Array> => {
  const cacheKey = `${voiceName}:${context}:${text.trim()}`;
  
  // If a request is already in flight (or completed), return that promise.
  // This deduplicates simultaneous requests (Pre-fetch vs Button Click).
  if (ttsPromiseCache.has(cacheKey)) {
     return ttsPromiseCache.get(cacheKey)!;
  }

  const task = (async () => {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: `Instr: ${context}\nText: "${text}"`,
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
      if (!audioData) {
        throw new Error("No audio data returned");
      }

      let rawAudio = base64ToInt16(audioData);
      rawAudio = trimSilenceRaw(rawAudio);
      return rawAudio;
    } catch (error) {
      console.error("TTS Error:", error);
      // Remove failed promise from cache so it can be retried
      ttsPromiseCache.delete(cacheKey);
      throw error;
    }
  })();

  ttsPromiseCache.set(cacheKey, task);
  return task;
};