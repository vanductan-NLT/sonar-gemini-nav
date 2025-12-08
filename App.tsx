import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import { analyzeFrame, transcribeAudio, generateSpeech } from './services/geminiService';
import { playBeep, playSonarPing, getAudioContext } from './utils/audioUtils';
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

const App: React.FC = () => {
  // State
  const [appState, setAppState] = useState<AppState>(AppState.IDLE);
  const [lastResponse, setLastResponse] = useState<SonarResponse | null>(null);
  const [isProcessingState, setIsProcessingState] = useState(false); // For UI only
  const [emergencyLatch, setEmergencyLatch] = useState(false);
  
  // Refs
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isProcessingRef = useRef(false); // For logic checks (prevents re-render loops)
  
  // Initialize Audio (using Singleton)
  const initAudio = () => {
    getAudioContext();
  };

  // --- Voice Output ---
  const speak = useCallback(async (text: string, useHighQuality = false) => {
    if (!text) return;
    
    // Fast path for navigation loop
    if (!useHighQuality && window.speechSynthesis) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.3;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
      return;
    }

    // Quality path for queries
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
           window.speechSynthesis.speak(utterance);
         }
       }
    }
  }, []);

  // --- Canvas Drawing (Judge's View) ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !webcamRef.current?.video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const video = webcamRef.current.video;
    
    // Match visual size
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!lastResponse) return;

    const drawBox = (box: number[], color: string, label: string) => {
       const [ymin, xmin, ymax, xmax] = box;
       const x = (xmin / 1000) * canvas.width;
       const y = (ymin / 1000) * canvas.height;
       const w = ((xmax - xmin) / 1000) * canvas.width;
       const h = ((ymax - ymin) / 1000) * canvas.height;

       // 1. Draw Fill (Semi-transparent)
       ctx.globalAlpha = 0.15;
       ctx.fillStyle = color;
       ctx.fillRect(x, y, w, h);
       ctx.globalAlpha = 1.0;

       // 2. Draw Bounding Box Border
       ctx.strokeStyle = color;
       ctx.lineWidth = 3;
       ctx.strokeRect(x, y, w, h);

       // 3. Draw Corner Accents (Tech Look)
       const lineLen = Math.min(w, h) * 0.2;
       ctx.lineWidth = 5;
       ctx.beginPath(); 
       // TL
       ctx.moveTo(x, y + lineLen); ctx.lineTo(x, y); ctx.lineTo(x + lineLen, y);
       // TR
       ctx.moveTo(x + w - lineLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + lineLen);
       // BR
       ctx.moveTo(x + w, y + h - lineLen); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - lineLen, y + h);
       // BL
       ctx.moveTo(x + lineLen, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - lineLen);
       ctx.stroke();

       // 4. Draw Label Background
       const fontSize = 14;
       ctx.font = `bold ${fontSize}px Courier New`;
       const textMetrics = ctx.measureText(label.toUpperCase());
       const textWidth = textMetrics.width;
       
       ctx.fillStyle = color;
       ctx.fillRect(x, y - 24, textWidth + 12, 24);
       
       // 5. Draw Label Text
       ctx.fillStyle = "#000000";
       ctx.fillText(label.toUpperCase(), x + 6, y - 7);
    };

    if (lastResponse.visual_debug?.hazards) {
      lastResponse.visual_debug.hazards.forEach(h => drawBox(h.box_2d, '#FF3333', h.label));
    }
    if (lastResponse.visual_debug?.safe_path) {
      lastResponse.visual_debug.safe_path.forEach(p => drawBox(p.box_2d, '#00FF66', p.label));
    }

  }, [lastResponse]);

  // --- Navigation Loop ---
  const runNavigationLoop = useCallback(async () => {
    // Check ref instead of state to avoid dependency cycles
    if (appState !== AppState.SCANNING || isProcessingRef.current || !webcamRef.current || emergencyLatch) return;

    const imageSrc = webcamRef.current.getScreenshot();
    if (!imageSrc) return;

    // Set both ref and state
    isProcessingRef.current = true;
    setIsProcessingState(true);

    const base64Image = imageSrc.split(',')[1];

    try {
      const data = await analyzeFrame(base64Image);
      setLastResponse(data);
      
      if (data.safety_status === 'STOP') {
        setEmergencyLatch(true); // Latch emergency mode
        playBeep(1000, 500, 'sawtooth'); // Alarm sound
        speak(data.navigation_command, false);
      } else {
        playSonarPing(data.stereo_pan);
        speak(data.navigation_command, false);
      }
      
    } catch (error) {
      console.error("Loop Error", error);
    } finally {
      isProcessingRef.current = false;
      setIsProcessingState(false);
    }
  }, [appState, speak, emergencyLatch]);

  useEffect(() => {
    let intervalId: any;
    // Only run loop if scanning AND not in emergency mode
    if (appState === AppState.SCANNING && !emergencyLatch) {
      runNavigationLoop();
      intervalId = setInterval(runNavigationLoop, 3500); 
    }
    return () => clearInterval(intervalId);
  }, [appState, runNavigationLoop, emergencyLatch]);

  // --- Input ---
  const startListening = async () => {
    if (emergencyLatch) return; // Disable voice input during emergency
    if (appState === AppState.SCANNING) setAppState(AppState.IDLE);
    setAppState(AppState.LISTENING);
    playBeep(600, 100);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => audioChunksRef.current.push(event.data);
      
      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const base64Audio = await blobToBase64(audioBlob);
        
        setAppState(AppState.PROCESSING_QUERY);
        const query = await transcribeAudio(base64Audio);
        
        if (query && webcamRef.current) {
          const imageSrc = webcamRef.current.getScreenshot();
          if (imageSrc) {
             const base64Image = imageSrc.split(',')[1];
             speak("Processing", false);
             const response = await analyzeFrame(base64Image, `User asked: "${query}". Answer strictly based on the visual input. Be helpful.`);
             setLastResponse(response);
             speak(response.navigation_command + " " + response.reasoning_summary, true);
          }
        } else {
            speak("Unclear. Try again.", false);
        }
        setAppState(AppState.IDLE);
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
    // If in emergency latch, this button acts as RESET
    if (emergencyLatch) {
      setEmergencyLatch(false);
      setAppState(AppState.IDLE);
      setLastResponse(null);
      speak("System Reset", false);
      return;
    }

    if (appState === AppState.SCANNING) {
      setAppState(AppState.IDLE);
      speak("System Paused", false);
      setLastResponse(null);
    } else {
      setAppState(AppState.SCANNING);
      speak("System Active. Scanning.", false);
    }
  };

  // --- UI Helpers ---
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

  // Directional Indicator Helper
  const renderDirectionIndicator = () => {
    if (emergencyLatch) return <div className="text-8xl font-black text-white animate-pulse">STOP</div>;
    if (!lastResponse || appState !== AppState.SCANNING) return null;
    const pan = lastResponse.stereo_pan;
    
    if (pan < -0.3) {
      return <div className="text-6xl font-black text-sonar-safe animate-pulse">←</div>;
    } else if (pan > 0.3) {
      return <div className="text-6xl font-black text-sonar-safe animate-pulse">→</div>;
    } else {
      return <div className="text-6xl font-black text-sonar-safe animate-pulse">↑</div>;
    }
  };

  return (
    <div className={`relative h-screen w-screen bg-grid overflow-hidden font-sans select-none transition-colors duration-200 ${getAlertBg()}`}>
      
      {/* 1. Viewport Layer */}
      <div className={`absolute inset-4 z-0 border-2 rounded-lg overflow-hidden flex items-center justify-center shadow-2xl shadow-black ${emergencyLatch ? 'border-sonar-alert bg-red-900/20' : 'border-zinc-800 bg-black'}`}>
         <Webcam
           ref={webcamRef}
           audio={false}
           screenshotFormat="image/jpeg"
           videoConstraints={{ facingMode: "environment" }}
           className="w-full h-full object-contain opacity-90"
         />
         <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
         
         {/* Scanning Animation Line */}
         {appState === AppState.SCANNING && !emergencyLatch && (
           <div className="absolute left-0 w-full h-1 bg-sonar-safe/50 shadow-[0_0_15px_rgba(0,255,102,0.8)] animate-scan pointer-events-none" />
         )}

         {/* Center Crosshair or Direction */}
         <div className="absolute z-30 pointer-events-none drop-shadow-lg">
            {renderDirectionIndicator() || <div className="text-sonar-white/30 text-2xl">+</div>}
         </div>
      </div>

      {/* 2. HUD Layer */}
      <div className="absolute inset-0 z-20 flex flex-col justify-between p-6 pointer-events-none">
        
        {/* Top Header */}
        <div className="flex justify-between items-start">
          <div>
            <h1 className="text-3xl font-black tracking-tighter text-sonar-white font-mono">SONAR<span className="text-sonar-yellow">.AI</span></h1>
            <p className="text-xs text-zinc-500 font-mono tracking-widest">SPATIAL NAV ENGINE v1.0</p>
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

        {/* Dynamic Instruction Card */}
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

        {/* 3. Control Layer (Pointer Events Enabled) */}
        <div className="grid grid-cols-5 gap-4 pointer-events-auto h-24 mb-4">
           {/* Voice Command (Hold) */}
           <button
             onMouseDown={startListening}
             onMouseUp={stopListening}
             onTouchStart={startListening}
             onTouchEnd={stopListening}
             disabled={isProcessingState || emergencyLatch}
             className={`col-span-2 rounded-xl font-bold text-lg flex flex-col items-center justify-center border-2 transition-all active:scale-95 ${
               appState === AppState.LISTENING 
               ? 'bg-sonar-white text-black border-sonar-white shadow-[0_0_20px_rgba(255,255,255,0.4)]' 
               : emergencyLatch 
                  ? 'bg-zinc-900/50 text-zinc-600 border-zinc-800 cursor-not-allowed'
                  : 'bg-zinc-900/90 text-zinc-300 border-zinc-700 hover:border-sonar-white'
             }`}
           >
             <span className="text-2xl mb-1">{appState === AppState.LISTENING ? '◉' : '○'}</span>
             <span className="text-xs font-mono">HOLD TO SPEAK</span>
           </button>

           {/* Space */}
           <div className="col-span-1"></div>

           {/* Toggle Power */}
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