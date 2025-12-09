import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { analyzeFrame, transcribeAudio, generateSpeech } from './services/geminiService';
import { playBeep, playSonarPing, playCautionSound, getAudioContext, playRawPCM } from './utils/audioUtils';
import { SonarResponse, AppState } from './types';

// Helper for converting blobs to base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      console.log(`[App] Blob converted to Base64. Size: ${base64.length}`);
      resolve(base64);
    };
    reader.onerror = (e) => {
        console.error("[App] Blob conversion error", e);
        reject(e);
    };
    reader.readAsDataURL(blob);
  });
};

// Language Configuration
interface LanguageOption {
  name: string;
  code: string; 
  locale: string; 
  label: string; 
  flag: string; 
}

const LANGUAGES: LanguageOption[] = [
  { name: 'English', code: 'en', locale: 'en-US', label: 'ENG', flag: '🇺🇸' },
  { name: 'Spanish', code: 'es', locale: 'es-ES', label: 'ESP', flag: '🇪🇸' },
  { name: 'French', code: 'fr', locale: 'fr-FR', label: 'FRA', flag: '🇫🇷' },
  { name: 'German', code: 'de', locale: 'de-DE', label: 'DEU', flag: '🇩🇪' },
  { name: 'Japanese', code: 'ja', locale: 'ja-JP', label: 'JPN', flag: '🇯🇵' },
];

const App: React.FC = () => {
  // State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [lastResponse, setLastResponse] = useState<SonarResponse | null>(null);
  const [isProcessingState, setIsProcessingState] = useState(false); 
  const [emergencyLatch, setEmergencyLatch] = useState(false);
  const [langIndex, setLangIndex] = useState(0); 
  const [showLangList, setShowLangList] = useState(false);
  const [modelLoaded, setModelLoaded] = useState(false);

  const currentLang = LANGUAGES[langIndex];
  
  // Refs
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null); 
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false); // For Gemini Loop lock
  
  // Realtime Detection Refs
  const netRef = useRef<cocoSsd.ObjectDetection | null>(null);
  const detectedObjectsRef = useRef<cocoSsd.DetectedObject[]>([]);
  const isDetectingRef = useRef(false); // For TFJS Loop lock
  const lastResponseRef = useRef<SonarResponse | null>(null); // Mirror state for render loop
  const animationFrameIdRef = useRef<number>(0);

  // Initialize Audio
  const initAudio = () => {
    getAudioContext();
  };

  // --- Load TensorFlow Model ---
  useEffect(() => {
    const loadModel = async () => {
      try {
        console.log("[App] Loading TFJS Model...");
        // tf.ready() checks if the backend is set. 
        try {
            await tf.ready();
        } catch (e) {
            console.warn("TF Ready warning:", e);
        }
        
        const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' }); // Use lite model for speed
        netRef.current = model;
        setModelLoaded(true);
        console.log("[App] COCO-SSD Loaded Successfully");
      } catch (err) {
        console.error("[App] Failed to load COCO-SSD", err);
      }
    };
    loadModel();
  }, []);

  // --- Sync State to Ref for Render Loop ---
  useEffect(() => {
    lastResponseRef.current = lastResponse;
  }, [lastResponse]);

  // --- Voice Output ---
  const speak = useCallback(async (text: string, useHighQuality = false) => {
    if (!text) return;
    console.log(`[App] Speaking: "${text}" (HighQuality: ${useHighQuality})`);
    
    // Basic SpeechSynthesis (Offline / Fallback)
    if (!useHighQuality && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.1; 
      utterance.pitch = 1.0;
      utterance.lang = currentLang.locale; 
      window.speechSynthesis.speak(utterance);
      return;
    }

    // High Quality Neural TTS
    if (useHighQuality) {
       const audioBase64 = await generateSpeech(text);
       if (audioBase64) {
         // Use the raw PCM player
         await playRawPCM(audioBase64);
       } else {
         console.warn("[App] High quality speech failed, falling back to synthesis");
         // Fallback
         const utterance = new SpeechSynthesisUtterance(text);
         utterance.lang = currentLang.locale;
         window.speechSynthesis.speak(utterance);
       }
    }
  }, [currentLang.locale]);

  const selectLanguage = (index: number) => {
    console.log(`[App] Switching language to ${LANGUAGES[index].name}`);
    setLangIndex(index);
    setShowLangList(false);
    const newLang = LANGUAGES[index];
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(newLang.name);
    utterance.lang = newLang.locale;
    window.speechSynthesis.speak(utterance);
  };

  // --- Unified Render & Detection Loop (60 FPS) ---
  useEffect(() => {
    const loop = async () => {
      const canvas = canvasRef.current;
      const video = webcamRef.current?.video;
      
      if (canvas && video && video.readyState === 4) {
        // Match dimensions
        if (canvas.width !== video.clientWidth) canvas.width = video.clientWidth;
        if (canvas.height !== video.clientHeight) canvas.height = video.clientHeight;

        const ctx = canvas.getContext('2d');
        if (ctx) {
            // 1. Run Local Object Detection (Fast, Async, Non-blocking)
            if (netRef.current && appState === AppState.SCANNING && !emergencyLatch && !isDetectingRef.current) {
                isDetectingRef.current = true;
                // Run detection on next microtask
                netRef.current.detect(video, undefined, 0.4).then(detections => {
                    detectedObjectsRef.current = detections;
                    isDetectingRef.current = false;
                }).catch(e => {
                    console.warn("TF Detection error", e);
                    isDetectingRef.current = false;
                });
            }

            // 2. Clear & Draw
            ctx.clearRect(0, 0, canvas.width, canvas.height);

            // Helper to draw boxes
            const drawBox = (
                x: number, y: number, w: number, h: number, 
                color: string, label: string, isThick: boolean = false
            ) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = isThick ? 4 : 2;
                ctx.strokeRect(x, y, w, h);

                // Label Background
                ctx.fillStyle = color;
                const fontSize = isThick ? 14 : 10;
                ctx.font = `bold ${fontSize}px Courier New`;
                const textMetrics = ctx.measureText(label);
                const textWidth = textMetrics.width;
                const textHeight = fontSize + 4;
                
                // Keep label inside canvas
                let ly = y - textHeight;
                if (ly < 0) ly = y;
                let lx = x;
                if (lx + textWidth > canvas.width) lx = canvas.width - textWidth;

                ctx.globalAlpha = 0.8;
                ctx.fillRect(lx, ly, textWidth + 8, textHeight);
                ctx.globalAlpha = 1.0;

                ctx.fillStyle = '#000';
                ctx.textBaseline = 'top';
                ctx.fillText(label.toUpperCase(), lx + 4, ly + 2);
            };

            // 3. Render TFJS Detections (Tactical Layer - Cyan)
            if (appState === AppState.SCANNING && !emergencyLatch && detectedObjectsRef.current) {
                detectedObjectsRef.current.forEach(obj => {
                    // Filter out less important objects to reduce noise for visually impaired
                    if (['person', 'car', 'chair', 'door', 'couch', 'tv', 'laptop'].includes(obj.class) || obj.score > 0.7) {
                        drawBox(obj.bbox[0], obj.bbox[1], obj.bbox[2], obj.bbox[3], '#00FFFF', `${obj.class}`, false);
                    }
                });
            }

            // 4. Render Gemini Detections (Strategic Layer - Red/Green)
            const geminiData = lastResponseRef.current;
            if (geminiData) {
                if (geminiData.visual_debug?.hazards) {
                    geminiData.visual_debug.hazards.forEach(h => {
                        if (!h.box_2d) return; 
                        const [ymin, xmin, ymax, xmax] = h.box_2d;
                        const x = (xmin / 1000) * canvas.width;
                        const y = (ymin / 1000) * canvas.height;
                        const w = ((xmax - xmin) / 1000) * canvas.width;
                        const hBox = ((ymax - ymin) / 1000) * canvas.height;
                        drawBox(x, y, w, hBox, '#FF3333', `HAZARD: ${h.label}`, true);
                    });
                }
                if (geminiData.visual_debug?.safe_path) {
                    geminiData.visual_debug.safe_path.forEach(p => {
                        if (!p.box_2d) return; 
                        const [ymin, xmin, ymax, xmax] = p.box_2d;
                        const x = (xmin / 1000) * canvas.width;
                        const y = (ymin / 1000) * canvas.height;
                        const w = ((xmax - xmin) / 1000) * canvas.width;
                        const hBox = ((ymax - ymin) / 1000) * canvas.height;
                        drawBox(x, y, w, hBox, '#00FF66', p.label || 'PATH', true);
                    });
                }
            }
        }
      }
      animationFrameIdRef.current = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameIdRef.current);
  }, [appState, emergencyLatch]);

  // --- Gemini Intelligence Loop ---
  useEffect(() => {
    let intervalId: NodeJS.Timeout;

    const runGeminiCycle = async () => {
      if (appState !== AppState.SCANNING || isProcessingRef.current || emergencyLatch) return;
      
      const webcam = webcamRef.current;
      if (!webcam) return;
      
      const screenshot = webcam.getScreenshot();
      if (!screenshot) {
          console.warn("[App] Screenshot failed or empty");
          return;
      }
      
      isProcessingRef.current = true;
      setIsProcessingState(true);

      const base64Image = screenshot.split(',')[1];
      
      try {
        console.log("[App] Starting Gemini Cycle...");
        playBeep(880, 50, 'sine'); // Scanning blip
        
        const response = await analyzeFrame(base64Image, currentLang.name);
        
        if (response) {
            console.log("[App] Gemini Analysis Complete:", response.safety_status);
            setLastResponse(response);
            
            // Audio Feedback Logic
            if (response.safety_status === 'STOP') {
                playCautionSound(response.stereo_pan);
                speak(`STOP. ${response.reasoning_summary}`, true);
            } else if (response.safety_status === 'CAUTION') {
                playSonarPing(response.stereo_pan);
                speak(`Caution. ${response.navigation_command}`);
            } else {
                playSonarPing(response.stereo_pan);
                // Safe status: infrequent updates or just pings
                if (Math.random() > 0.7) {
                     speak(response.navigation_command);
                }
            }
        }
      } catch (e) {
        console.error("Gemini Cycle Error", e);
      } finally {
        isProcessingRef.current = false;
        setIsProcessingState(false);
      }
    };

    if (appState === AppState.SCANNING) {
      // Run every 6.0 seconds to balance latency and cost/quota
      intervalId = setInterval(runGeminiCycle, 6000); 
      runGeminiCycle(); // Run immediately on start
    }

    return () => clearInterval(intervalId);
  }, [appState, emergencyLatch, currentLang, speak]);


  // --- User Interactions ---

  const toggleScanning = () => {
    initAudio();
    if (appState === AppState.SCANNING) {
      console.log("[App] Pausing Scanning");
      setAppState(AppState.IDLE);
      setLastResponse(null);
      speak("System Paused");
    } else {
      console.log("[App] Starting Scanning");
      setAppState(AppState.SCANNING);
      speak("Sonar Active");
    }
  };

  const startListening = () => {
    initAudio();
    if (appState === AppState.SCANNING) {
       // Pause scanning while listening
       setAppState(AppState.LISTENING);
    }
    playBeep(600, 100); 
    console.log("[App] Start Listening (Microphone)");
    
    // Start Audio Recording
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.start();
      console.log(`[App] MediaRecorder Started. MimeType: ${mediaRecorder.mimeType}`);
    }).catch(err => {
        console.error("Mic access denied", err);
        speak("Microphone access denied.");
        setAppState(AppState.IDLE);
    });
  };

  const stopListening = async () => {
    console.log("[App] Stop Listening triggered");
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      // Get the correct mime type
      const mimeType = mediaRecorderRef.current.mimeType || 'audio/webm';
      
      mediaRecorderRef.current.onstop = async () => {
        const totalSize = audioChunksRef.current.reduce((acc, chunk) => acc + chunk.size, 0);
        console.log(`[App] Recording finished. Total Size: ${totalSize} bytes`);

        // Prevent processing empty or extremely short audio (clicks)
        if (totalSize < 5000) { // < 5KB is likely just a click/noise
            console.warn("[App] Audio too short, skipping transcription.");
            playBeep(200, 100); // Error low beep
            setAppState(AppState.IDLE);
            return;
        }

        // Create blob with correct mime type
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        const base64Audio = await blobToBase64(audioBlob);
        
        playBeep(400, 100); // End beep
        speak("Processing...");
        setIsProcessingState(true);

        const transcript = await transcribeAudio(base64Audio, mimeType, currentLang.name);
        
        // One-off query with the transcribed text context
        if (webcamRef.current) {
            const screenshot = webcamRef.current.getScreenshot();
            if (screenshot && transcript) {
                console.log(`[App] Sending Query with context: "${transcript}"`);
                const base64Image = screenshot.split(',')[1];
                const response = await analyzeFrame(base64Image, currentLang.name, `User Question: "${transcript}"`);
                
                setLastResponse(response);
                speak(response.reasoning_summary, true);
            } else {
                console.warn("[App] Missing screenshot or transcript");
                speak("I couldn't hear you clearly.");
            }
        }
        
        setIsProcessingState(false);
        // Return to scanning if we were scanning before
        setAppState(AppState.IDLE); 
      };
    }
  };

  return (
    <div className="relative w-screen h-screen bg-sonar-black text-sonar-white overflow-hidden font-mono">
      {/* Background Grid */}
      <div className="absolute inset-0 bg-grid opacity-20 pointer-events-none"></div>

      {/* Camera Layer */}
      <div className="absolute inset-0 z-0">
        <Webcam
          ref={webcamRef}
          audio={false}
          screenshotFormat="image/jpeg"
          videoConstraints={{ facingMode: "environment" }}
          className="w-full h-full object-cover opacity-60"
        />
      </div>

      {/* Canvas Overlay */}
      <canvas 
        ref={canvasRef} 
        className="absolute inset-0 z-10 pointer-events-none"
      />

      {/* Header */}
      <div className="absolute top-0 left-0 w-full p-4 z-20 flex justify-between items-center bg-gradient-to-b from-black/80 to-transparent">
        <div className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${appState === AppState.SCANNING ? 'bg-sonar-safe animate-pulse' : 'bg-gray-500'}`}></div>
            <h1 className="text-xl font-bold tracking-widest text-sonar-white">SONAR<span className="text-sonar-yellow">AI</span></h1>
        </div>
        
        <div className="relative">
            <button 
                onClick={() => setShowLangList(!showLangList)}
                className="bg-sonar-panel border border-gray-700 px-3 py-1 rounded-full text-sm font-bold flex items-center gap-2"
            >
                <span>{currentLang.flag}</span>
                <span>{currentLang.label}</span>
            </button>
            
            {showLangList && (
                <div className="absolute top-full right-0 mt-2 bg-sonar-panel border border-gray-700 rounded-xl overflow-hidden shadow-xl w-32">
                    {LANGUAGES.map((lang, idx) => (
                        <button 
                            key={lang.code}
                            onClick={() => selectLanguage(idx)}
                            className="w-full text-left px-4 py-2 hover:bg-gray-800 flex gap-2"
                        >
                            <span>{lang.flag}</span>
                            <span>{lang.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </div>
      </div>

      {/* Main Status HUD */}
      <div className="absolute top-20 left-4 right-4 z-20">
         {lastResponse ? (
             <div className={`p-4 rounded-xl border-l-4 backdrop-blur-md bg-black/60 shadow-lg transition-colors duration-500 ${
                 lastResponse.safety_status === 'STOP' ? 'border-sonar-alert' : 
                 lastResponse.safety_status === 'CAUTION' ? 'border-sonar-yellow' : 'border-sonar-safe'
             }`}>
                 <div className="flex justify-between items-start mb-1">
                     <span className={`text-2xl font-black tracking-tighter ${
                         lastResponse.safety_status === 'STOP' ? 'text-sonar-alert animate-pulse' : 
                         lastResponse.safety_status === 'CAUTION' ? 'text-sonar-yellow' : 'text-sonar-safe'
                     }`}>
                         {lastResponse.safety_status}
                     </span>
                     <span className="text-xs text-gray-400 font-sans mt-2">PAN: {lastResponse.stereo_pan.toFixed(1)}</span>
                 </div>
                 <p className="text-lg font-bold leading-tight mb-2">{lastResponse.navigation_command}</p>
                 <p className="text-sm text-gray-300 font-sans border-t border-gray-700 pt-2 mt-1 opacity-80">{lastResponse.reasoning_summary}</p>
             </div>
         ) : (
             <div className="p-4 rounded-xl border-l-4 border-gray-500 backdrop-blur-md bg-black/60">
                 <p className="text-gray-400">System Standby. Press Start.</p>
             </div>
         )}
      </div>

      {/* Scanner Animation Line */}
      {appState === AppState.SCANNING && (
        <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
            <div className="w-full h-1 bg-sonar-safe/50 shadow-[0_0_15px_rgba(0,255,100,0.8)] animate-scan"></div>
        </div>
      )}

      {/* Bottom Controls */}
      <div className="absolute bottom-0 left-0 w-full p-6 pb-10 z-30 bg-gradient-to-t from-black via-black/90 to-transparent flex flex-col gap-6 items-center">
        
        {/* Processing Indicator */}
        {isProcessingState && (
            <div className="flex items-center gap-2 text-sonar-yellow animate-pulse mb-2">
                <div className="w-2 h-2 bg-sonar-yellow rounded-full"></div>
                <span className="text-xs uppercase tracking-widest">Processing</span>
            </div>
        )}

        <div className="flex items-center gap-8 w-full justify-center">
            {/* Start/Stop Button */}
            <button
                onClick={toggleScanning}
                className={`w-20 h-20 rounded-full flex items-center justify-center border-4 shadow-[0_0_20px_rgba(0,0,0,0.5)] transition-all transform active:scale-95 ${
                    appState === AppState.SCANNING 
                    ? 'bg-sonar-alert border-sonar-alert text-black' 
                    : 'bg-sonar-safe border-sonar-safe text-black'
                }`}
            >
                {appState === AppState.SCANNING ? (
                    <div className="w-8 h-8 bg-black rounded-sm"></div>
                ) : (
                    <div className="w-0 h-0 border-t-[12px] border-t-transparent border-l-[20px] border-l-black border-b-[12px] border-b-transparent ml-1"></div>
                )}
            </button>

            {/* Mic Button (Hold to Speak) */}
            <button
                onPointerDown={startListening}
                onPointerUp={stopListening}
                onPointerLeave={stopListening}
                onContextMenu={(e) => e.preventDefault()} // Prevents right-click/long-press menu
                className={`w-16 h-16 rounded-full flex items-center justify-center border-2 transition-all transform active:scale-90 ${
                    appState === AppState.LISTENING
                    ? 'bg-sonar-yellow border-sonar-yellow text-black scale-110 shadow-[0_0_30px_#FFD700]'
                    : 'bg-transparent border-gray-500 text-gray-400'
                }`}
            >
                <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
            </button>
        </div>
      </div>
    </div>
  );
};

export default App;