import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
import { analyzeFrame, transcribeAudio, generateSpeech } from './services/geminiService';
import { playBeep, playSonarPing } from './utils/audioUtils';
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
  const [isProcessing, setIsProcessing] = useState(false);
  
  // Refs
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Audio Playback Ref
  const audioContextRef = useRef<AudioContext | null>(null);

  // Initialize Audio
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
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
       if (audioBase64 && audioContextRef.current) {
         try {
           const binaryString = atob(audioBase64);
           const len = binaryString.length;
           const bytes = new Uint8Array(len);
           for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
           
           const audioBuffer = await audioContextRef.current.decodeAudioData(bytes.buffer);
           const source = audioContextRef.current.createBufferSource();
           source.buffer = audioBuffer;
           source.connect(audioContextRef.current.destination);
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
    if (!canvas || !lastResponse || !webcamRef.current?.video) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const video = webcamRef.current.video;
    
    // Match visual size
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;
    
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const drawBox = (box: number[], color: string, label: string) => {
       const [ymin, xmin, ymax, xmax] = box;
       const x = (xmin / 1000) * canvas.width;
       const y = (ymin / 1000) * canvas.height;
       const w = ((xmax - xmin) / 1000) * canvas.width;
       const h = ((ymax - ymin) / 1000) * canvas.height;

       // Tactical Corners
       const lineLen = Math.min(w, h) * 0.2;
       ctx.strokeStyle = color;
       ctx.lineWidth = 3;
       
       // Top Left
       ctx.beginPath(); ctx.moveTo(x, y + lineLen); ctx.lineTo(x, y); ctx.lineTo(x + lineLen, y); ctx.stroke();
       // Top Right
       ctx.beginPath(); ctx.moveTo(x + w - lineLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + lineLen); ctx.stroke();
       // Bottom Right
       ctx.beginPath(); ctx.moveTo(x + w, y + h - lineLen); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - lineLen, y + h); ctx.stroke();
       // Bottom Left
       ctx.beginPath(); ctx.moveTo(x + lineLen, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - lineLen); ctx.stroke();

       // Label
       ctx.fillStyle = color;
       ctx.globalAlpha = 0.8;
       ctx.fillRect(x, y - 22, ctx.measureText(label).width + 10, 22);
       ctx.globalAlpha = 1.0;
       ctx.fillStyle = "#000000";
       ctx.font = "bold 14px Courier New";
       ctx.fillText(label.toUpperCase(), x + 5, y - 6);
    };

    lastResponse.visual_debug.hazards.forEach(h => drawBox(h.box_2d, '#FF3333', h.label));
    lastResponse.visual_debug.safe_path.forEach(p => drawBox(p.box_2d, '#00FF66', p.label));

  }, [lastResponse]);

  // --- Navigation Loop ---
  const runNavigationLoop = useCallback(async () => {
    if (appState !== AppState.SCANNING || isProcessing || !webcamRef.current) return;

    const imageSrc = webcamRef.current.getScreenshot();
    if (!imageSrc) return;

    setIsProcessing(true);
    // Silent internal beep or very low volume if preferred, keeping it for rhythm
    // playBeep(880, 20); 

    const base64Image = imageSrc.split(',')[1];

    try {
      const data = await analyzeFrame(base64Image);
      setLastResponse(data);
      playSonarPing(data.stereo_pan);
      speak(data.navigation_command, false);
    } catch (error) {
      console.error("Loop Error", error);
    } finally {
      setIsProcessing(false);
    }
  }, [appState, isProcessing, speak]);

  useEffect(() => {
    let intervalId: any;
    if (appState === AppState.SCANNING) {
      runNavigationLoop();
      intervalId = setInterval(runNavigationLoop, 3500); // Slightly longer interval to allow speech
    }
    return () => clearInterval(intervalId);
  }, [appState, runNavigationLoop]);

  // --- Input ---
  const startListening = async () => {
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
    if (lastResponse?.safety_status === 'STOP') return 'text-sonar-alert';
    if (lastResponse?.safety_status === 'CAUTION') return 'text-sonar-yellow';
    return 'text-sonar-safe';
  };

  const getAlertBg = () => {
    if (lastResponse?.safety_status === 'STOP') return 'bg-red-900/50 animate-pulse';
    return '';
  };

  return (
    <div className={`relative h-screen w-screen bg-grid overflow-hidden font-sans select-none ${getAlertBg()}`}>
      
      {/* 1. Viewport Layer */}
      <div className="absolute inset-4 z-0 border-2 border-zinc-800 bg-black rounded-lg overflow-hidden flex items-center justify-center shadow-2xl shadow-black">
         <Webcam
           ref={webcamRef}
           audio={false}
           screenshotFormat="image/jpeg"
           videoConstraints={{ facingMode: "environment" }}
           className="w-full h-full object-contain opacity-90"
         />
         <canvas ref={canvasRef} className="absolute inset-0 w-full h-full object-contain pointer-events-none" />
         
         {/* Scanning Animation Line */}
         {appState === AppState.SCANNING && (
           <div className="absolute left-0 w-full h-1 bg-sonar-safe/50 shadow-[0_0_15px_rgba(0,255,102,0.8)] animate-scan pointer-events-none" />
         )}

         {/* Center Crosshair */}
         <div className="absolute text-sonar-white/30 text-2xl pointer-events-none">+</div>
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
                <div className={`w-3 h-3 rounded-full ${appState === AppState.SCANNING ? 'bg-sonar-safe animate-pulse' : 'bg-zinc-600'}`}></div>
                <span className="text-sm font-mono font-bold text-sonar-white">{appState}</span>
             </div>
             {lastResponse && (
               <div className={`mt-2 text-xl font-black font-mono tracking-widest ${getStatusColor()}`}>
                 [{lastResponse.safety_status}]
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
                {appState === AppState.PROCESSING_QUERY && (
                  <p className="text-sm font-mono text-sonar-yellow mt-2 animate-pulse">:: PROCESSING QUERY ::</p>
                )}
             </div>
           )}
           {appState === AppState.IDLE && !lastResponse && (
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
             disabled={appState === AppState.PROCESSING_QUERY}
             className={`col-span-2 rounded-xl font-bold text-lg flex flex-col items-center justify-center border-2 transition-all active:scale-95 ${
               appState === AppState.LISTENING 
               ? 'bg-sonar-white text-black border-sonar-white shadow-[0_0_20px_rgba(255,255,255,0.4)]' 
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
               appState === AppState.SCANNING
               ? 'bg-sonar-alert text-black border-sonar-alert shadow-[0_0_20px_rgba(255,51,51,0.5)]'
               : 'bg-sonar-safe text-black border-sonar-safe shadow-[0_0_20px_rgba(0,255,102,0.3)]'
             }`}
           >
             {appState === AppState.SCANNING ? 'STOP' : 'START'}
           </button>
        </div>

      </div>
    </div>
  );
};

export default App;