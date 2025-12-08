import { GoogleGenAI, Type, Modality } from "@google/genai";
import { SonarResponse } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const SYSTEM_INSTRUCTION = `
**Role:** You are "SonarAI," an advanced spatial navigation engine for the visually impaired.
**Input:** A camera frame from the user's perspective (frontal view).
**User Intent:** The user is walking indoors and needs immediate, actionable safety guidance.

**CORE REASONING PROCESS (Thinking Chain):**
1.  **Scan & Detect:** Identify dynamic hazards (people, closing doors), static obstacles (chairs, bags), and navigational signs (Exit, Room Numbers, Warnings like "Wet Floor").
2.  **Spatial Parsing:** Determine the "Walkable Path". Is it clear? Is it blocked?
3.  **Semantic Analysis:** If text is detected (e.g., "WET FLOOR"), prioritize this as a HIGH-LEVEL HAZARD even if the path looks physically clear.
4.  **Coordinate Mapping:** Locate the center of the primary target or the safest path gap on a horizontal axis from -1.0 (Left) to 1.0 (Right).

**OUTPUT FORMAT (Strict JSON Only):**
{
  "safety_status": "SAFE" | "CAUTION" | "STOP",
  "reasoning_summary": "Concise context (Max 12 words). E.g., 'Chair blocking center path.'",
  "navigation_command": "Short, imperative voice command (Max 8 words). E.g., 'Stop. Wet floor ahead. Go left.'",
  "stereo_pan": 0.0, // A float between -1.0 (Left) and 1.0 (Right) representing where the clear path or target is. 0.0 is Center.
  "visual_debug": {
    "hazards": [ {"label": "Bag", "box_2d": [ymin, xmin, ymax, xmax]} ], // Coordinates must be normalized 0-1000
    "safe_path": [ {"label": "Path", "box_2d": [ymin, xmin, ymax, xmax]} ] // Coordinates must be normalized 0-1000
  }
}
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

export const analyzeFrame = async (base64Image: string, customPrompt?: string): Promise<SonarResponse> => {
  try {
    const prompt = customPrompt || "Analyze this scene for navigation safety. Return boxes in [ymin, xmin, ymax, xmax] format scaled 0-1000.";
    
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
        thinkingConfig: {
          thinkingBudget: 16000, // Budget for reasoning
        },
      },
    });

    if (response.text) {
      // Clean potential Markdown code blocks
      let cleanText = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleanText) as SonarResponse;
    }
    throw new Error("No response text");
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    // Fallback safety response
    return {
      safety_status: "STOP",
      reasoning_summary: "Error connecting to AI.",
      navigation_command: "Connection error. Stop.",
      stereo_pan: 0,
      visual_debug: { hazards: [], safe_path: [] },
    };
  }
};

export const transcribeAudio = async (audioBase64: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          { inlineData: { mimeType: "audio/wav", data: audioBase64 } },
          { text: "Transcribe this audio exactly." },
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
      model: "gemini-2.5-flash-preview-tts",
      contents: {
        parts: [{ text: text }],
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Aoede" }, // Clear, assertive voice
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