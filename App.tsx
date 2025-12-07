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
      
      // Haptic/Audio Feedback
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

  // Render Helpers
  const renderOverlay = () => {
    if (!lastResponse) return null;
    
    // Helper to scale box coordinates [ymin, xmin, ymax, xmax] (0-1000) to %
    // Assuming Gemini 2D point returns usually normalized 0-1000 or 0-1.
    // The prompt implies a 2D box. Let's assume normalized 0-1 for simplicity, or scale if needed.
    // Standard Gemini detection is usually 0-1000. Let's normalize to 0-100%
    
    const normalize = (val: number) => (val / 1000) * 100;

    return (
      <div className="absolute inset-0 pointer-events-none z-10">
        {lastResponse.visual_debug.hazards.map((h, i) => {
             const [ymin, xmin, ymax, xmax] = h.box_2d;
             return (
               <div key={`haz-${i}`} 
                    className="absolute border-4 border-sonar-alert"
                    style={{
                      top: `${normalize(ymin)}%`,
                      left: `${normalize(xmin)}%`,
                      height: `${normalize(ymax - ymin)}%`,
                      width: `${normalize(xmax - xmin)}%`
                    }}>
                    <span className="bg-sonar-alert text-black font-bold text-lg p-1">{h.label}</span>
               </div>
             )
        })}
        {lastResponse.visual_debug.safe_path.map((p, i) => {
             const [ymin, xmin, ymax, xmax] = p.box_2d;
             return (
               <div key={`path-${i}`} 
                    className="absolute border-4 border-dashed border-sonar-safe opacity-50"
                    style={{
                      top: `${normalize(ymin)}%`,
                      left: `${normalize(xmin)}%`,
                      height: `${normalize(ymax - ymin)}%`,
                      width: `${normalize(xmax - xmin)}%`
                    }}>
               </div>
             )
        })}
      </div>
    )
  };

  return (
    <div className="relative h-screen w-screen bg-sonar-black text-sonar-yellow overflow-hidden font-sans">
      
      {/* Camera Feed */}
      <div className="absolute inset-0 z-0 opacity-80">
         <Webcam
           ref={webcamRef}
           audio={false}
           screenshotFormat="image/jpeg"
           videoConstraints={{ facingMode: "environment" }}
           className="h-full w-full object-cover"
         />
      </div>

      {/* Visual Debug Overlay */}
      {renderOverlay()}

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
             <div className="bg-black/70 p-6 text-center rounded-xl">
               <p className="text-5xl font-bold leading-tight drop-shadow-md">
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