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
  
  // Audio Playback Ref to avoid overlapping TTS
  const audioContextRef = useRef<AudioContext | null>(null);

  // Initialize Audio Context on first interaction
  const initAudio = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
  };

  // --- Voice Output Handling ---
  const speak = useCallback(async (text: string, useHighQuality = false) => {
    if (!text) return;
    
    // For navigation loop, we prefer SpeechSynthesis for 0 latency
    if (!useHighQuality && window.speechSynthesis) {
      window.speechSynthesis.cancel(); // Stop previous
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.2; // Slightly faster for navigation
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
      return;
    }

    // High Quality Gemini TTS (for detailed queries)
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
           // Fallback
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
    
    // Match canvas size to video display size
    canvas.width = video.clientWidth;
    canvas.height = video.clientHeight;
    
    // Clear previous
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Helper: Draw Box
    const drawBox = (box: number[], color: string, label: string) => {
       const [ymin, xmin, ymax, xmax] = box;
       // Coordinates are 0-1000. Convert to pixels.
       const x = (xmin / 1000) * canvas.width;
       const y = (ymin / 1000) * canvas.height;
       const w = ((xmax - xmin) / 1000) * canvas.width;
       const h = ((ymax - ymin) / 1000) * canvas.height;

       ctx.strokeStyle = color;
       ctx.lineWidth = 4;
       ctx.strokeRect(x, y, w, h);

       // Label background
       ctx.fillStyle = color;
       const textWidth = ctx.measureText(label).width;
       ctx.fillRect(x, y - 24, textWidth + 10, 24);

       // Label text
       ctx.fillStyle = "#000000";
       ctx.font = "bold 16px Arial";
       ctx.fillText(label, x + 5, y - 6);
    };

    // Draw Hazards (RED)
    lastResponse.visual_debug.hazards.forEach(h => {
        drawBox(h.box_2d, '#FF0000', h.label);
    });

    // Draw Safe Path (GREEN)
    lastResponse.visual_debug.safe_path.forEach(p => {
        drawBox(p.box_2d, '#00FF00', p.label);
    });

  }, [lastResponse]);

  // --- The Loop (Navigation) ---
  const runNavigationLoop = useCallback(async () => {
    if (appState !== AppState.SCANNING || isProcessing || !webcamRef.current) return;

    const imageSrc = webcamRef.current.getScreenshot();
    if (!imageSrc) return;

    setIsProcessing(true);
    playBeep(880, 50); // High pitch short beep for "Scanning"

    // Extract Base64
    const base64Image = imageSrc.split(',')[1];

    try {
      const data = await analyzeFrame(base64Image);
      setLastResponse(data);
      
      // Haptic/Audio Feedback (Pro Feature: Spatial Audio)
      playSonarPing(data.stereo_pan);
      
      // Voice Output
      speak(data.navigation_command, false);

    } catch (error) {
      console.error("Loop Error", error);
    } finally {
      setIsProcessing(false);
    }
  }, [appState, isProcessing, speak]);

  // Interval Effect
  useEffect(() => {
    let intervalId: any;
    if (appState === AppState.SCANNING) {
      // Immediate first run
      runNavigationLoop();
      // Loop every 3s
      intervalId = setInterval(runNavigationLoop, 3000);
    }
    return () => clearInterval(intervalId);
  }, [appState, runNavigationLoop]);


  // --- Voice Command Input ---
  const startListening = async () => {
    if (appState === AppState.SCANNING) setAppState(AppState.IDLE); // Pause scanning
    
    setAppState(AppState.LISTENING);
    playBeep(600, 100);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };

      mediaRecorderRef.current.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const base64Audio = await blobToBase64(audioBlob);
        
        setAppState(AppState.PROCESSING_QUERY);
        const query = await transcribeAudio(base64Audio);
        
        if (query && webcamRef.current) {
          const imageSrc = webcamRef.current.getScreenshot();
          if (imageSrc) {
             const base64Image = imageSrc.split(',')[1];
             speak("Analyzing...", false);
             const response = await analyzeFrame(base64Image, `User asked: "${query}". Answer them specifically and guide them.`);
             setLastResponse(response);
             // Use High Quality TTS for this interaction
             speak(response.navigation_command + " " + response.reasoning_summary, true);
          }
        } else {
            speak("I didn't hear that.", false);
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

  // --- UI Handlers ---
  const toggleNavigation = () => {
    initAudio();
    if (appState === AppState.SCANNING) {
      setAppState(AppState.IDLE);
      speak("Sonar Paused", false);
      setLastResponse(null);
    } else {
      setAppState(AppState.SCANNING);
      speak("Sonar Active. Scanning.", false);
    }
  };

  // Determine Background Color for "Emergency Stop"
  const getBackgroundColor = () => {
    if (lastResponse?.safety_status === 'STOP') return 'bg-sonar-alert animate-pulse';
    return 'bg-sonar-black';
  };

  return (
    <div className={`relative h-screen w-screen text-sonar-yellow overflow-hidden font-sans transition-colors duration-200 ${getBackgroundColor()}`}>
      
      {/* Camera Feed & Canvas Overlay */}
      <div className="absolute inset-0 z-0 bg-black flex items-center justify-center">
         <Webcam
           ref={webcamRef}
           audio={false}
           screenshotFormat="image/jpeg"
           videoConstraints={{ facingMode: "environment" }}
           className="absolute w-full h-full object-contain opacity-80"
         />
         <canvas 
           ref={canvasRef}
           className="absolute w-full h-full object-contain pointer-events-none"
         />
      </div>

      {/* Main Touch Interface */}
      <div className="absolute inset-0 z-20 flex flex-col justify-between p-4">
        
        {/* Top Status Bar */}
        <div className="bg-black/80 p-4 border-b-4 border-sonar-yellow">
          <h1 className="text-4xl font-black tracking-widest uppercase">SonarAI</h1>
          <div className="flex justify-between items-center mt-2">
            <span className={`text-2xl font-bold ${appState === AppState.SCANNING ? 'animate-pulse text-sonar-safe' : 'text-gray-500'}`}>
              {appState === AppState.SCANNING ? '● SCANNING' : appState === AppState.LISTENING ? '● LISTENING' : 'PAUSED'}
            </span>
             {lastResponse && (
                <span className={`text-3xl font-black px-4 py-1 ${
                  lastResponse.safety_status === 'STOP' ? 'bg-sonar-alert text-black' : 
                  lastResponse.safety_status === 'CAUTION' ? 'bg-sonar-yellow text-black' : 'bg-sonar-safe text-black'
                }`}>
                  {lastResponse.safety_status}
                </span>
             )}
          </div>
        </div>

        {/* Center Text Feedback (Massive) */}
        <div className="flex-grow flex items-center justify-center pointer-events-none">
           {lastResponse ? (
             <div className="bg-black/70 p-6 text-center rounded-xl max-w-lg">
               <p className="text-5xl font-bold leading-tight drop-shadow-md text-white">
                 {lastResponse.navigation_command}
               </p>
               {appState === AppState.PROCESSING_QUERY && (
                 <p className="text-2xl mt-4 animate-bounce text-sonar-white">Thinking...</p>
               )}
             </div>
           ) : (
             appState === AppState.IDLE && (
               <p className="text-4xl font-bold text-center opacity-50">Tap to Start</p>
             )
           )}
        </div>

        {/* Bottom Controls */}
        <div className="flex flex-col gap-4 mb-8">
           {/* Voice Command Button */}
           <button
             onMouseDown={startListening}
             onMouseUp={stopListening}
             onTouchStart={startListening}
             onTouchEnd={stopListening}
             disabled={appState === AppState.PROCESSING_QUERY}
             className="w-full bg-sonar-white text-black py-8 text-3xl font-bold rounded-2xl active:scale-95 transition-transform border-4 border-sonar-yellow"
           >
             {appState === AppState.LISTENING ? 'LISTENING...' : 'HOLD TO ASK'}
           </button>

           {/* Toggle Button */}
           <button
             onClick={toggleNavigation}
             className={`w-full py-12 text-4xl font-black rounded-2xl border-4 transition-colors ${
               appState === AppState.SCANNING 
               ? 'bg-sonar-black text-sonar-alert border-sonar-alert hover:bg-sonar-alert hover:text-black' 
               : 'bg-sonar-yellow text-black border-sonar-white hover:bg-white'
             }`}
           >
             {appState === AppState.SCANNING ? 'STOP' : 'START NAVIGATION'}
           </button>
        </div>
      </div>
    </div>
  );
};

export default App;