import React, { useState, useRef, useEffect, useCallback } from 'react';
import Webcam from 'react-webcam';
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
  code: string; // for Gemini
  locale: string; // for Web Speech API
  label: string; // UI Button label
  flag: string; // Emoji flag
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
  const [isProcessingState, setIsProcessingState] = useState(false); // For UI only
  const [emergencyLatch, setEmergencyLatch] = useState(false);
  const [langIndex, setLangIndex] = useState(0); // Default to English
  const [showLangList, setShowLangList] = useState(false);

  const currentLang = LANGUAGES[langIndex];
  
  // Refs
  const webcamRef = useRef<Webcam>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const processingCanvasRef = useRef<HTMLCanvasElement>(null); // Hidden canvas for resizing
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
      utterance.rate = 1.2; 
      utterance.pitch = 1.0;
      utterance.lang = currentLang.locale; 
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
           utterance.lang = currentLang.locale;
           window.speechSynthesis.speak(utterance);
         }
       }
    }
  }, [currentLang.locale]);

  // --- Language Selection ---
  const selectLanguage = (index: number) => {
    setLangIndex(index);
    setShowLangList(false);
    const newLang = LANGUAGES[index];
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(newLang.name);
    utterance.lang = newLang.locale;
    window.speechSynthesis.speak(utterance);
  };

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

    const drawBox = (box: number[], color: string, label: string, fillOpacity = 0.15) => {
       const [ymin, xmin, ymax, xmax] = box;
       const x = (xmin / 1000) * canvas.width;
       const y = (ymin / 1000) * canvas.height;
       const w = ((xmax - xmin) / 1000) * canvas.width;
       const h = ((ymax - ymin) / 1000) * canvas.height;

       ctx.globalAlpha = fillOpacity;
       ctx.fillStyle = color;
       ctx.fillRect(x, y, w, h);
       ctx.globalAlpha = 1.0;

       ctx.strokeStyle = color;
       ctx.lineWidth = 3;
       ctx.strokeRect(x, y, w, h);

       // Tech corners
       const lineLen = Math.min(w, h) * 0.2;
       ctx.lineWidth = 5;
       ctx.beginPath(); 
       ctx.moveTo(x, y + lineLen); ctx.lineTo(x, y); ctx.lineTo(x + lineLen, y);
       ctx.moveTo(x + w - lineLen, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + lineLen);
       ctx.moveTo(x + w, y + h - lineLen); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - lineLen, y + h);
       ctx.moveTo(x + lineLen, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - lineLen);
       ctx.stroke();

       // Label
       const fontSize = 14;
       ctx.font = `bold ${fontSize}px Courier New`;
       const text = label.toUpperCase();
       const textMetrics = ctx.measureText(text);
       const paddingX = 8;
       const paddingY = 6;
       const textWidth = textMetrics.width;
       const labelHeight = fontSize + (paddingY * 2);
       const labelWidth = textWidth + (paddingX * 2);
       
       let labelX = x;
       if (labelX + labelWidth > canvas.width) labelX = canvas.width - labelWidth;
       if (labelX < 0) labelX = 0;

       let labelY = y - labelHeight; 
       if (labelY < 0) labelY = y;
       if (labelY + labelHeight > canvas.height) labelY = canvas.height - labelHeight;

       ctx.fillStyle = color;
       ctx.shadowColor = "rgba(0,0,0,0.8)";
       ctx.shadowBlur = 4;
       ctx.fillRect(labelX, labelY, labelWidth, labelHeight);
       ctx.shadowBlur = 0; 
       
       ctx.fillStyle = "#000000";
       ctx.textBaseline = 'middle';
       ctx.fillText(text, labelX + paddingX, labelY + (labelHeight / 2) + 1);
    };

    if (lastResponse.visual_debug?.hazards) {
      lastResponse.visual_debug.hazards.forEach(h => drawBox(h.box_2d, '#FF3333', h.label, 0.15));
    }
    if (lastResponse.visual_debug?.safe_path) {
      lastResponse.visual_debug.safe_path.forEach(p => {
        let label = p.label || 'SAFE PATH';
        if (label.toUpperCase() === 'PATH') label = 'SAFE PATH';
        drawBox(p.box_2d, '#00FF66', label, 0.3);
      });
    }

    // --- Stereo Pan Visualizer ---
    const pan = lastResponse.stereo_pan;
    const centerY = canvas.height * 0.93; 
    const centerX = canvas.width / 2;
    const barWidth = canvas.width * 0.6; 
    
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.moveTo(centerX - barWidth/2, centerY);
    ctx.lineTo(centerX + barWidth/2, centerY);
    ctx.stroke();

    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.moveTo(centerX, centerY - 10);
    ctx.lineTo(centerX, centerY + 10);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = 'bold 12px Courier New';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText('L', centerX - barWidth/2 - 10, centerY);
    ctx.textAlign = 'left';
    ctx.fillText('R', centerX + barWidth/2 + 10, centerY);

    const clampedPan = Math.max(-1, Math.min(1, pan));
    const indicatorX = centerX + (clampedPan * (barWidth / 2));
    
    let indicatorColor = '#00FF66'; 
    if (lastResponse.safety_status === 'CAUTION') indicatorColor = '#FFD700';
    if (lastResponse.safety_status === 'STOP') indicatorColor = '#FF3333';

    ctx.shadowColor = indicatorColor;
    ctx.shadowBlur = 15;
    ctx.fillStyle = indicatorColor;
    ctx.beginPath();
    ctx.arc(indicatorX, centerY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.fillStyle = indicatorColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.font = 'bold 10px Courier New';
    ctx.fillText(`PAN: ${pan.toFixed(2)}`, centerX, centerY + 15);

  }, [lastResponse]);

  // --- Navigation Loop (Recursive) ---
  const runNavigationLoop = useCallback(async () => {
    // Stop condition: Not scanning, or processing lock, or invalid webcam
    if (appState !== AppState.SCANNING || isProcessingRef.current || !webcamRef.current || emergencyLatch) return;

    const video = webcamRef.current.video;
    if (!video || video.readyState !== 4) {
        // Retry shortly if video not ready
        requestAnimationFrame(() => runNavigationLoop());
        return;
    }

    // Lock processing
    isProcessingRef.current = true;
    setIsProcessingState(true);

    let base64Image = "";

    // 1. Resize and Optimize Image
    if (processingCanvasRef.current) {
        const pCtx = processingCanvasRef.current.getContext('2d');
        if (pCtx) {
            // Draw 512x512 for optimal AI input speed
            pCtx.drawImage(video, 0, 0, 512, 512);
            // Export low quality JPEG
            base64Image = processingCanvasRef.current.toDataURL('image/jpeg', 0.6).split(',')[1];
        }
    }

    // Fallback
    if (!base64Image) {
        const src = webcamRef.current.getScreenshot();
        if (src) base64Image = src.split(',')[1];
    }

    if (!base64Image) {
        isProcessingRef.current = false;
        setIsProcessingState(false);
        requestAnimationFrame(() => runNavigationLoop());
        return;
    }

    try {
      const data = await analyzeFrame(base64Image, currentLang.name);
      setLastResponse(data);
      
      const combinedText = data.reasoning_summary 
        ? `${data.navigation_command}. ${data.reasoning_summary}`
        : data.navigation_command;
      
      const wordCount = combinedText.split(/\s+/).filter(w => w.length > 0).length;
      const voiceMessage = (wordCount <= 10 && data.reasoning_summary) 
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
      console.error("Loop Error", error);
    } finally {
      // Release Lock
      isProcessingRef.current = false;
      setIsProcessingState(false);
      
      // RECURSIVE CALL: Schedule next frame immediately via AnimationFrame
      // This is the fastest possible loop that respects browser painting
      if (appState === AppState.SCANNING && !emergencyLatch) {
         requestAnimationFrame(() => runNavigationLoop()); 
      }
    }
  }, [appState, speak, emergencyLatch, currentLang.name]);

  // Start Loop Trigger
  useEffect(() => {
    if (appState === AppState.SCANNING && !emergencyLatch) {
      runNavigationLoop();
    }
    // Cleanup ensures we don't leave processing states stuck if component unmounts
    return () => {
        isProcessingRef.current = false;
        setIsProcessingState(false);
    };
  }, [appState, emergencyLatch, runNavigationLoop]);

  // --- Input ---
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
               const response = await analyzeFrame(base64Image, currentLang.name, `User asked: "${query}". Answer strictly based on the visual input. Be helpful.`);
               setLastResponse(response);
               speak(response.navigation_command + " " + response.reasoning_summary, true);
            }
          } else {
              speak("Unclear. Try again.", false);
          }
        } catch (error) {
          console.error("Voice Processing Error", error);
          speak("Error processing command", false);
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
      
      {/* Hidden processing canvas */}
      <canvas ref={processingCanvasRef} width={512} height={512} className="hidden" />

      {/* Language List Overlay */}
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
          <button 
            onClick={() => setShowLangList(false)}
            className="mt-8 px-8 py-3 rounded border border-zinc-700 text-zinc-400 font-mono text-sm hover:text-white hover:border-white transition-colors"
          >
            CANCEL
          </button>
        </div>
      )}

      {/* 1. Viewport Layer - Border pulses yellow during AI processing */}
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
        <div className="flex justify-between items-start pointer-events-auto">
          <div>
            <div className="flex items-center gap-3">
               <h1 className="text-3xl font-black tracking-tighter text-sonar-white font-mono">SONAR<span className="text-sonar-yellow">.AI</span></h1>
               
               <button 
                 onClick={() => setShowLangList(true)}
                 className="bg-zinc-900/90 border border-zinc-700 text-sonar-yellow font-mono text-xs font-bold px-3 py-1 rounded hover:bg-zinc-800 active:scale-95 transition-all flex items-center gap-1 shadow-lg"
                 aria-label="Select Language"
               >
                 <span>{currentLang.label}</span>
                 <span className="text-[10px] opacity-70">▼</span>
               </button>
            </div>
            <p className="text-xs text-zinc-500 font-mono tracking-widest mt-1">SPATIAL NAV ENGINE v1.0</p>
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