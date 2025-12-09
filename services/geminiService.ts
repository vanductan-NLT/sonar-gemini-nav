import { GoogleGenAI, Type, Modality } from "@google/genai";
import { SonarResponse } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const SYSTEM_INSTRUCTION = `
**Role:** SonarAI, a spatial navigation engine.
**Task:** Analyze the camera frame. Identify hazards and walkable paths.
**Constraint:** Return ONLY valid minified JSON. Do NOT use Markdown code blocks. Do NOT include explanations outside the JSON.

**JSON OUTPUT FORMAT:**
{"safety_status":"SAFE"|"CAUTION"|"STOP","reasoning_summary":"<Max 5 words>","navigation_command":"<Max 5 words>","stereo_pan":<float -1.0 to 1.0>,"visual_debug":{"hazards":[{"label":"string","box_2d":[ymin,xmin,ymax,xmax]}],"safe_path":[{"label":"string","box_2d":[ymin,xmin,ymax,xmax]}]}}
`;

// Schema for structured output
const schema = {
  type: Type.OBJECT,
  properties: {
    safety_status: { type: Type.STRING, enum: ["SAFE", "CAUTION", "STOP"] },
    reasoning_summary: { type: Type.STRING },
    navigation_command: { type: Type.STRING },
    stereo_pan: { type: Type.NUMBER },
    visual_debug: {
      type: Type.OBJECT,
      properties: {
        hazards: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            },
          },
        },
        safe_path: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              label: { type: Type.STRING },
              box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER } },
            },
          },
        },
      },
    },
  },
  required: ["safety_status", "navigation_command", "stereo_pan", "visual_debug"],
};

export const analyzeFrame = async (base64Image: string, language: string = 'English', customPrompt?: string): Promise<SonarResponse> => {
  try {
    const langInstruction = `Output in ${language}.`;
    const prompt = customPrompt 
      ? `${customPrompt} ${langInstruction}`
      : `Scan hazards. ${langInstruction}`;
    
    // USING GEMINI 3 PRO as requested
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview", 
      contents: {
        parts: [
          { inlineData: { mimeType: "image/jpeg", data: base64Image } },
          { text: prompt },
        ],
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        systemInstruction: SYSTEM_INSTRUCTION,
      },
    });

    if (response.text) {
      // Robust cleaning just in case model ignores "No Markdown" instruction
      let cleanText = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleanText) as SonarResponse;
    }
    throw new Error("No response text");
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    // Fallback safety response
    return {
      safety_status: "STOP",
      reasoning_summary: "AI Connection Lost",
      navigation_command: "Stop.",
      stereo_pan: 0,
      visual_debug: { hazards: [], safe_path: [] },
    };
  }
};

export const transcribeAudio = async (audioBase64: string, language: string = 'English'): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
          { text: `Transcribe strictly. Language: ${language}.` },
        ],
      },
    });
    return response.text || "";
  } catch (error) {
    console.error("Transcription error:", error);
    return "";
  }
};

export const generateSpeech = async (text: string): Promise<string | null> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts", // Keep TTS on Flash for low latency audio generation
      contents: {
        parts: [{ text: text }],
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" },
          },
        },
      },
    });

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return audioData || null;
  } catch (error) {
    console.error("TTS Error:", error);
    return null;
  }
};