import { GoogleGenAI, Type, Schema, Modality } from "@google/genai";
import { AnalysisResult, ParsedSegment, SceneContext } from "../types";

const API_KEY = process.env.API_KEY || '';

const ai = new GoogleGenAI({ apiKey: API_KEY });

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
    scoreStyle: { type: Type.STRING, enum: ['happy', 'sad', 'tense', 'mysterious', 'romantic', 'neutral'] }
  },
  required: ["location", "mood", "roomToneType", "bgNoiseType", "scoreStyle"]
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

// Helper to remove overlaps between segments to prevent "Said twice" errors
const cleanSegments = (segments: ParsedSegment[]): ParsedSegment[] => {
  const cleaned = [...segments];
  for (let i = 0; i < cleaned.length - 1; i++) {
    const current = cleaned[i];
    const next = cleaned[i + 1];
    
    // Check if next text starts with a suffix of current text
    const currText = current.text.trim();
    const nextText = next.text;
    
    // Safety check: if current segment is just a quote mark or very short, ignore
    if (currText.length < 2) continue;

    // Find overlapping string
    // Case: Seg 1 "Hello," -> Seg 2 "Hello," said John
    // We want to detect "Hello," in Seg 2 and remove it.
    let overlapFound = false;
    let checkLen = Math.min(currText.length, nextText.length);
    
    // Optimization: Check for exact prefix match first (most common hallucination)
    if (nextText.trim().startsWith(currText)) {
       // Only strip if the original text doesn't explicitly repeat it.
       // Since we don't have the raw full text map here easily, we assume strict segmentation.
       // If Seg 1 is Dialogue and Seg 2 is Narrator, they should NOT overlap.
       if (current.isNarrator !== next.isNarrator) {
          const overlapIndex = nextText.indexOf(currText);
          if (overlapIndex !== -1) {
             cleaned[i+1].text = nextText.substring(overlapIndex + currText.length);
             overlapFound = true;
          }
       }
    }
  }
  
  // Second pass: Ensure no empty segments after cleaning
  return cleaned.filter(s => s.text.trim().length > 0);
};

export const analyzeText = async (text: string): Promise<AnalysisResult> => {
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

      5. **SOUND EFFECTS (SFX FIELD)**:
         - Scan the narration text for specific sound events.
         - Examples: "The door creaked open" -> sfx: "creak/door". "Thunder rumbled overhead" -> sfx: "thunder". "He walked away" -> sfx: "footsteps". "Leaves rustled" -> sfx: "rustle". "The glass shattered" -> sfx: "shatter/crash".
         - Assign this keyword to the segment containing the description.

      6. **CONTEXT**:
         - Analyze the scene location, mood, and soundscape requirements.

      Analyze this text:
      "${text.slice(0, 20000)}" 
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
      
      // Post-process to fix any hallucinations/duplicates
      result.segments = cleanSegments(result.segments);

      // Add IDs for React keys
      result.segments = result.segments.map((s, i) => ({
        ...s,
        id: `seg_${Date.now()}_${i}`,
        originalText: s.text
      }));
      return result;
    }
    throw new Error("No response from AI");
  } catch (error) {
    console.error("Analysis Error:", error);
    throw error;
  }
};

export const generateSpeech = async (text: string, voiceName: string, context: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: `
        Acting Instruction: ${context}
        
        Line to perform: "${text}"
      `,
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
    return audioData;
  } catch (error) {
    console.error("TTS Error:", error);
    throw error;
  }
};
