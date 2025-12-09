import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import * as tf from '@tensorflow/tfjs';
import * as cocoSsd from '@tensorflow-models/coco-ssd';
import { analyzeFrame, transcribeAudio, generateSpeech } from './services/geminiService';
import { playBeep, playSonarPing, playCautionSound, getAudioContext } from './utils/audioUtils';
import { SonarResponse, AppState } from './types';

// Helper for converting blobs to base64
const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
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
        await tf.ready();
        const model = await cocoSsd.load({ base: 'lite_mobilenet_v2' }); // Use lite model for speed
        netRef.current = model;
        setModelLoaded(true);
        console.log("COCO-SSD Loaded");
      } catch (err) {
        console.error("Failed to load COCO-SSD", err);
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
    
    if (!useHighQuality && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.2; 
      utterance.pitch = 1.0;
      utterance.lang = currentLang.locale; 
      window.speechSynthesis.speak(utterance);
      return;
    }

    if (useHighQuality) {
       const audioBase64 = await generateSpeech(text);
       const ctx = getAudioContext();
       if (audioBase64 && ctx) {
         try {
           const binaryString = atob(audioBase64);
           const len = binaryString.length;
           const bytes = new Uint8Array(len);
           for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
           
           const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
           const source = ctx.createBufferSource();
           source.buffer = audioBuffer;
           source.connect(ctx.destination);
           source.start(0);
         } catch (e) {
           console.error("Audio decode error", e);
           const utterance = new SpeechSynthesisUtterance(text);
           utterance.lang = currentLang.locale;
           window.speechSynthesis.speak(utterance);
         }
       }
    }
  }, [currentLang.locale]);

  const selectLanguage = (index: number) => {
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
            // Filter out common overlaps if needed, or just draw all
            if (appState === AppState.SCANNING && !emergencyLatch) {
                detectedObjectsRef.current.forEach(obj => {
                    // Ignore persons if we have Gemini data to avoid clutter, or keep them for raw tracking
                    drawBox(obj.bbox[0], obj.bbox[1], obj.bbox[2], obj.bbox[3], '#00FFFF', `${obj.class} ${(obj.score*100).toFixed(0)}%`, false);
                });
            }

            // 4. Render Gemini Detections (Strategic Layer - Red/Green)
            const geminiData = lastResponseRef.current;
            if (geminiData) {
                if (geminiData.visual_debug?.hazards) {
                    geminiData.visual_debug.hazards.forEach(h => {
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
                        const [ymin, xmin, ymax, xmax] = p.box_2d;
                        const x = (xmin / 1000) * canvas.width;
                        const y = (ymin / 1000) * canvas.height;
                        const w = ((xmax - xmin) / 1000) * canvas.width;
                        const hBox = ((ymax - ymin) / 1000) * canvas.height;
                        
                        let label = p.label || 'SAFE PATH';
                        if (label.toUpperCase() === 'PATH') label = 'SAFE PATH';
                        drawBox(x, y, w, hBox, '#00FF66', label, true);
                    });
                }
                
                // Draw Pan Indicator
                drawPanIndicator(ctx, canvas.width, canvas.height, geminiData);
            }
        }
      }
      animationFrameIdRef.current = requestAnimationFrame(loop);
    };

    animationFrameIdRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animationFrameIdRef.current);
  }, [appState, emergencyLatch]);

  const drawPanIndicator = (ctx: CanvasRenderingContext2D, w: number, h: number, data: SonarResponse) => {
    const pan = data.stereo_pan;
    const cy = h * 0.93;
    const cx = w / 2;
    const barW = w * 0.6;
    
    // Track
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.moveTo(cx - barW/2, cy);
    ctx.lineTo(cx + barW/2, cy);
    ctx.stroke();

    // Indicator
    const ix = cx + (Math.max(-1, Math.min(1, pan)) * (barW/2));
    let color = '#00FF66';
    if (data.safety_status === 'CAUTION') color = '#FFD700';
    if (data.safety_status === 'STOP') color = '#FF3333';

    ctx.shadowColor = color;
    ctx.shadowBlur = 10;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(ix, cy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  };

  // --- Gemini Navigation Loop (Recursive) ---
  const runNavigationLoop = useCallback(async () => {
    if (appState !== AppState.SCANNING || isProcessingRef.current || !webcamRef.current || emergencyLatch) return;

    const video = webcamRef.current.video;
    if (!video || video.readyState !== 4) {
        requestAnimationFrame(() => runNavigationLoop());
        return;
    }

    isProcessingRef.current = true;
    setIsProcessingState(true);

    let base64Image = "";
    // Optimize Image for Cloud
    if (processingCanvasRef.current) {
        const pCtx = processingCanvasRef.current.getContext('2d');
        if (pCtx) {
            pCtx.drawImage(video, 0, 0, 512, 512);
            base64Image = processingCanvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
        }
    }

    try {
      const data = await analyzeFrame(base64Image, currentLang.name);
      setLastResponse(data);
      
      const combinedText = data.reasoning_summary 
        ? `${data.navigation_command}. ${data.reasoning_summary}`
        : data.navigation_command;
      
      // Throttle speech: Only speak if critical or simple command
      const voiceMessage = (data.safety_status !== 'SAFE' || !lastResponseRef.current) 
        ? combinedText 
        : data.navigation_command;

      if (data.safety_status === 'STOP') {
        setEmergencyLatch(true);
        playBeep(1000, 500, 'sawtooth');
        speak(voiceMessage, false);
      } else if (data.safety_status === 'CAUTION') {
        playCautionSound(data.stereo_pan);
        speak(voiceMessage, false);
      } else {
        playSonarPing(data.stereo_pan);
        speak(voiceMessage, false);
      }
    } catch (error) {
      console.error("Gemini Loop Error", error);
    } finally {
      isProcessingRef.current = false;
      setIsProcessingState(false);
      // Loop
      if (appState === AppState.SCANNING && !emergencyLatch) {
         requestAnimationFrame(() => runNavigationLoop()); 
      }
    }
  }, [appState, speak, emergencyLatch, currentLang.name]);

  // Trigger Gemini Loop
  useEffect(() => {
    if (appState === AppState.SCANNING && !emergencyLatch) {
      runNavigationLoop();
    }
    return () => {
        isProcessingRef.current = false;
        setIsProcessingState(false);
    };
  }, [appState, emergencyLatch, runNavigationLoop]);


  // --- User Input & UI Methods ---
  const startListening = async () => {
    if (emergencyLatch) return;
    if (appState === AppState.SCANNING) setAppState(AppState.IDLE);
    setAppState(AppState.LISTENING);
    playBeep(600, 100);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
      mediaRecorderRef.current.onstop = async () => {
        try {
          if (audioChunksRef.current.length === 0) return;
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
          const base64Audio = await blobToBase64(audioBlob);
          setAppState(AppState.PROCESSING_QUERY);
          setIsProcessingState(true);
          const query = await transcribeAudio(base64Audio, currentLang.name);
          
          if (query && webcamRef.current) {
            const imageSrc = webcamRef.current.getScreenshot();
            if (imageSrc) {
               const base64Image = imageSrc.split(',')[1];
               speak("Processing", false);
               const response = await analyzeFrame(base64Image, currentLang.name, `User asked: "${query}". Answer strictly based on the visual input.`);
               setLastResponse(response);
               speak(response.navigation_command + " " + response.reasoning_summary, true);
            }
          } else {
              speak("Unclear.", false);
          }
        } catch (error) {
          console.error("Query Error", error);
        } finally {
          setAppState(AppState.IDLE);
          setIsProcessingState(false);
        }
      };
      mediaRecorderRef.current.start();
    } catch (e) {
      console.error("Mic error", e);
      setAppState(AppState.IDLE);
    }
  };

  const stopListening = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      playBeep(400, 100);
    }
  };

  const toggleNavigation = () => {
    initAudio();
    if (emergencyLatch) {
      setEmergencyLatch(false);
      setAppState(AppState.IDLE);
      setLastResponse(null);
      detectedObjectsRef.current = [];
      speak("System Reset", false);
      return;
    }
    if (appState === AppState.SCANNING) {
      setAppState(AppState.IDLE);
      speak("Paused", false);
      setLastResponse(null);
      detectedObjectsRef.current = [];
    } else {
      setAppState(AppState.SCANNING);
      speak("Scanning", false);
    }
  };

  const getStatusColor = () => {
    if (emergencyLatch) return 'text-sonar-alert';
    if (lastResponse?.safety_status === 'STOP') return 'text-sonar-alert';
    if (lastResponse?.safety_status === 'CAUTION') return 'text-sonar-yellow';
    return 'text-sonar-safe';
  };

  const getAlertBg = () => {
    if (emergencyLatch) return 'bg-red-600 animate-flash';
    if (lastResponse?.safety_status === 'STOP') return 'bg-red-900/50 animate-pulse';
    return '';
  };

  const renderDirectionIndicator = () => {
    if (emergencyLatch) return <div className="text-8xl font-black text-white animate-pulse">STOP</div>;
    if (!lastResponse || appState !== AppState.SCANNING) return null;
    const pan = lastResponse.stereo_pan;
    if (pan < -0.3) return <div className="text-6xl font-black text-sonar-safe animate-pulse">←</div>;
    if (pan > 0.3) return <div className="text-6xl font-black text-sonar-safe animate-pulse">→</div>;
    return <div className="text-6xl font-black text-sonar-safe animate-pulse">↑</div>;
  };

  return (
    <div className={`relative h-screen w-screen bg-grid overflow-hidden font-sans select-none transition-colors duration-200 ${getAlertBg()}`}>
      
      <canvas ref={processingCanvasRef} width={512} height={512} className="hidden" />

      {/* Language Overlay */}
      {showLangList && (
        <div className="absolute inset-0 z-50 bg-black/95 flex flex-col items-center justify-center p-6 backdrop-blur-md animate-in fade-in duration-200">
          <h2 className="text-sonar-white font-mono text-2xl font-bold mb-8 tracking-widest border-b border-zinc-800 pb-2">SELECT LANGUAGE</h2>
          <div className="grid grid-cols-1 gap-4 w-full max-w-sm h-3/4 overflow-y-auto">
            {LANGUAGES.map((lang, index) => (
              <button
                key={lang.code}
                onClick={() => selectLanguage(index)}
                className={`p-5 rounded-lg border-2 font-mono text-xl font-bold tracking-wider transition-all active:scale-95 flex justify-between items-center ${
                  index === langIndex 
                    ? 'border-sonar-yellow text-sonar-black bg-sonar-yellow shadow-[0_0_20px_rgba(255,215,0,0.4)]' 
                    : 'border-zinc-800 text-zinc-400 bg-zinc-900/50 hover:border-sonar-white hover:text-sonar-white'
                }`}
              >
                <div className="flex items-center gap-4">
                    <span className="text-2xl">{lang.flag}</span>
                    <span>{lang.name.toUpperCase()}</span>
                </div>
                {index === langIndex && <span>●</span>}
              </button>
            ))}
          </div>
          <button onClick={() => setShowLangList(false)} className="mt-8 px-8 py-3 rounded border border-zinc-700 text-zinc-400 font-mono text-sm">CANCEL</button>
        </div>
      )}

      {/* Viewport */}
      <div className={`absolute inset-4 z-0 border-4 rounded-lg overflow-hidden flex items-center justify-center shadow-2xl shadow-black transition-colors duration-300 ${
           emergencyLatch ? 'border-sonar-alert bg-red-900/20' : 
           isProcessingState ? 'border-sonar-yellow animate-pulse bg-black' : 
           'border-zinc-800 bg-black'
      }`}>
         <Webcam
           ref={webcamRef}
           audio={false}
           screenshotFormat="image/jpeg"
           videoConstraints={{ facingMode: "environment" }}
           className="w-full h-full object-contain opacity-90"
         />
         <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
         
         {appState === AppState.SCANNING && !emergencyLatch && (
           <div className="absolute left-0 w-full h-1 bg-sonar-safe/50 shadow-[0_0_15px_rgba(0,255,102,0.8)] animate-scan pointer-events-none" />
         )}

         <div className="absolute z-30 pointer-events-none drop-shadow-lg">
            {renderDirectionIndicator() || <div className="text-sonar-white/30 text-2xl">+</div>}
         </div>
         
         {!modelLoaded && !emergencyLatch && (
            <div className="absolute top-4 right-4 text-xs font-mono text-zinc-500">LOADING TENSORFLOW...</div>
         )}
      </div>

      {/* HUD */}
      <div className="absolute inset-0 z-20 flex flex-col justify-between p-6 pointer-events-none">
        
        <div className="flex justify-between items-start pointer-events-auto">
          <div>
            <div className="flex items-center gap-3">
               <h1 className="text-3xl font-black tracking-tighter text-sonar-white font-mono">SONAR<span className="text-sonar-yellow">.AI</span></h1>
               <button onClick={() => setShowLangList(true)} className="bg-zinc-900/90 border border-zinc-700 text-sonar-yellow font-mono text-xs font-bold px-3 py-1 rounded hover:bg-zinc-800 active:scale-95 transition-all flex items-center gap-1 shadow-lg">
                 <span>{currentLang.label}</span><span className="text-[10px] opacity-70">▼</span>
               </button>
            </div>
            <p className="text-xs text-zinc-500 font-mono tracking-widest mt-1">
                GEMINI 3 PRO + COCO-SSD
            </p>
          </div>
          
          <div className="flex flex-col items-end">
             <div className="flex items-center gap-2 bg-black/80 px-3 py-1 rounded border border-zinc-800">
                <div className={`w-3 h-3 rounded-full ${emergencyLatch ? 'bg-sonar-alert animate-ping' : appState === AppState.SCANNING ? 'bg-sonar-safe animate-pulse' : 'bg-zinc-600'}`}></div>
                <span className="text-sm font-mono font-bold text-sonar-white">{emergencyLatch ? 'EMERGENCY' : appState}</span>
             </div>
             {lastResponse && (
               <div className={`mt-2 text-xl font-black font-mono tracking-widest ${getStatusColor()}`}>
                 [{emergencyLatch ? 'STOP' : lastResponse.safety_status}]
               </div>
             )}
          </div>
        </div>

        <div className="flex justify-center items-center">
           {lastResponse && (
             <div className="bg-black/80 backdrop-blur-sm border-l-4 border-sonar-yellow px-6 py-4 max-w-sm rounded-r-lg shadow-lg transform transition-all duration-300">
                <p className="text-3xl font-bold text-white leading-tight">
                   {lastResponse.navigation_command}
                </p>
                {isProcessingState && (
                  <p className="text-sm font-mono text-sonar-yellow mt-2 animate-pulse">:: PROCESSING QUERY ::</p>
                )}
             </div>
           )}
           {appState === AppState.IDLE && !lastResponse && !emergencyLatch && (
              <div className="text-zinc-600 font-mono text-sm animate-pulse">SYSTEM STANDBY</div>
           )}
        </div>

        <div className="grid grid-cols-5 gap-4 pointer-events-auto h-24 mb-4">
           <button
             onMouseDown={startListening}
             onMouseUp={stopListening}
             onTouchStart={startListening}
             onTouchEnd={stopListening}
             disabled={isProcessingState || emergencyLatch}
             className={`col-span-2 rounded-xl font-bold text-lg flex flex-col items-center justify-center border-2 transition-all active:scale-95 ${
               appState === AppState.LISTENING 
               ? 'bg-sonar-white text-black border-sonar-white' 
               : emergencyLatch 
                  ? 'bg-zinc-900/50 text-zinc-600 border-zinc-800 cursor-not-allowed'
                  : 'bg-zinc-900/90 text-zinc-300 border-zinc-700 hover:border-sonar-white'
             }`}
           >
             <span className="text-2xl mb-1">{appState === AppState.LISTENING ? '◉' : '○'}</span>
             <span className="text-xs font-mono">HOLD TO SPEAK</span>
           </button>

           <div className="col-span-1"></div>

           <button
             onClick={toggleNavigation}
             className={`col-span-2 rounded-xl font-black text-xl flex items-center justify-center border-2 transition-all active:scale-95 shadow-lg ${
               emergencyLatch
               ? 'bg-sonar-white text-black border-sonar-alert shadow-[0_0_30px_rgba(255,0,0,0.8)] animate-pulse'
               : appState === AppState.SCANNING
               ? 'bg-sonar-alert text-black border-sonar-alert shadow-[0_0_20px_rgba(255,51,51,0.5)]'
               : 'bg-sonar-safe text-black border-sonar-safe shadow-[0_0_20px_rgba(0,255,102,0.3)]'
             }`}
           >
             {emergencyLatch ? 'RESET SYSTEM' : appState === AppState.SCANNING ? 'STOP' : 'START'}
           </button>
        </div>
      </div>
    </div>
  );
};

export default App;