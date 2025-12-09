import { GoogleGenAI, Type, Modality } from "@google/genai";
import { SonarResponse } from "../types";

// Support both standard API_KEY and GEMINI_API_KEY as requested
const apiKey = process.env.API_KEY || (process.env as any).GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: apiKey });

const SYSTEM_INSTRUCTION = `
**Role:** SonarAI, a spatial navigation engine.
**Task:** Perform DEEP REASONING on the camera frame.
1. **Safety Check:** Assess overall danger (e.g., wet floor, closing doors, traffic, obstacles).
2. **Semantic Reading:** Read critical text (e.g., "EXIT", "Restroom", Warning signs).
3. **Pathfinding:** Identify the safest walkable corridor.
**Constraint:** Return ONLY valid minified JSON. Do NOT use Markdown code blocks.

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

// Helper to handle parsing and retries with logging
const generateWithFallback = async (params: any, primaryModel: string, fallbackModel: string, taskName: string) => {
    console.log(`[GeminiService] Starting ${taskName} with primary model: ${primaryModel}`);
    try {
        const response = await ai.models.generateContent({
            model: primaryModel,
            ...params
        });
        console.log(`[GeminiService] ${taskName} success with ${primaryModel}`);
        return response;
    } catch (error: any) {
        console.warn(`[GeminiService] ${primaryModel} failed for ${taskName}. Status: ${error.status || 'Unknown'}, Message: ${error.message}`);
        
        // Retry on 429 (Quota) or 500 (Server Error)
        if (error.status === 429 || error.status === 503 || error.status === 500 || error.message?.includes("429")) {
            console.warn(`[GeminiService] Retrying ${taskName} with fallback model: ${fallbackModel}`);
            try {
                const fallbackResponse = await ai.models.generateContent({
                    model: fallbackModel,
                    ...params
                });
                console.log(`[GeminiService] ${taskName} success with ${fallbackModel}`);
                return fallbackResponse;
            } catch (fallbackError: any) {
                console.error(`[GeminiService] Fallback ${fallbackModel} also failed for ${taskName}.`, fallbackError);
                throw fallbackError;
            }
        }
        throw error;
    }
};

export const analyzeFrame = async (base64Image: string, language: string = 'English', customPrompt?: string): Promise<SonarResponse> => {
  try {
    console.log(`[GeminiService] analyzeFrame called. Image size: ${Math.round(base64Image.length / 1024)}KB`);
    
    const langInstruction = `Output in ${language}.`;
    const prompt = customPrompt 
      ? `${customPrompt} ${langInstruction}`
      : `Perform deep reasoning: Check safety, read signs, find safe path. ${langInstruction}`;
    
    const requestParams = {
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
    };

    // Use Flash as primary for speed/stability, Pro as fallback or specialized
    // Changing primary to Flash to reduce 500 errors and latency
    const response = await generateWithFallback(requestParams, "gemini-2.5-flash", "gemini-3-pro-preview", "Image Analysis");

    if (response.text) {
      console.log(`[GeminiService] Raw Analysis Response:`, response.text.substring(0, 100) + "...");
      // Robust cleaning just in case model ignores "No Markdown" instruction or wraps it
      let cleanText = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
      try {
          const parsed = JSON.parse(cleanText) as SonarResponse;
          return parsed;
      } catch (e) {
          console.error(`[GeminiService] JSON Parse Error. Raw text:`, response.text);
          throw e;
      }
    }
    throw new Error("No response text received from Gemini");
  } catch (error) {
    console.error("[GeminiService] Final Analyze Error:", error);
    // Fallback safety response
    return {
      safety_status: "STOP",
      reasoning_summary: "AI Error. Proceed with caution.",
      navigation_command: "Stop.",
      stereo_pan: 0,
      visual_debug: { hazards: [], safe_path: [] },
    };
  }
};

export const transcribeAudio = async (audioBase64: string, mimeType: string, language: string = 'English'): Promise<string> => {
  try {
    // Sanitize MIME type (remove codecs, e.g., "audio/webm;codecs=opus" -> "audio/webm")
    // The API often throws 500 if specific codecs are passed in the MIME string
    const cleanMimeType = mimeType.split(';')[0];
    
    console.log(`[GeminiService] transcribeAudio called. Original Mime: ${mimeType}, Clean Mime: ${cleanMimeType}, Size: ${Math.round(audioBase64.length / 1024)}KB`);

    const requestParams = {
      contents: {
        parts: [
          { inlineData: { mimeType: cleanMimeType, data: audioBase64 } },
          { text: `Transcribe this audio strictly. Language: ${language}. Return only the transcription text.` },
        ],
      },
    };

    // Using Flash for transcription as it is more stable for audio
    const response = await generateWithFallback(requestParams, "gemini-2.5-flash", "gemini-3-pro-preview", "Audio Transcription");
    
    const text = response.text || "";
    console.log(`[GeminiService] Transcription Result: "${text}"`);
    return text;
  } catch (error) {
    console.error("[GeminiService] Transcription Final Error:", error);
    return "";
  }
};

export const generateSpeech = async (text: string): Promise<string | null> => {
  try {
    console.log(`[GeminiService] generateSpeech called for text: "${text.substring(0, 20)}..."`);
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts", 
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
    if (audioData) {
        console.log(`[GeminiService] TTS Success. Audio data length: ${audioData.length}`);
        return audioData;
    } else {
        console.warn(`[GeminiService] TTS returned no inline data.`);
        return null;
    }
  } catch (error) {
    console.error("[GeminiService] TTS Error:", error);
    return null;
  }
};