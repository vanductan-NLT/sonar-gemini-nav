// Singleton AudioContext to prevent "limit reached" errors
let audioCtx: AudioContext | null = null;

export const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(e => console.error("Audio resume failed", e));
  }
  return audioCtx;
};

// Simple oscillator beep for feedback
export const playBeep = (freq: number = 440, duration: number = 100, type: OscillatorType = 'sine') => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, ctx.currentTime);
  
  gain.gain.setValueAtTime(0.1, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + duration / 1000);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + duration / 1000);
};

// Play raw PCM audio from Gemini TTS (16-bit, 24kHz usually)
export const playRawPCM = async (base64Data: string, sampleRate = 24000) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const binaryString = atob(base64Data);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert Int16 PCM to Float32
    const int16Data = new Int16Array(bytes.buffer);
    const float32Data = new Float32Array(int16Data.length);
    
    for (let i = 0; i < int16Data.length; i++) {
      // Normalize 16-bit integer to -1.0 to 1.0 float
      float32Data[i] = int16Data[i] / 32768.0;
    }

    const buffer = ctx.createBuffer(1, float32Data.length, sampleRate);
    buffer.getChannelData(0).set(float32Data);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  } catch (e) {
    console.error("Error playing raw PCM", e);
  }
};

export const playCautionSound = (pan: number) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const startTime = ctx.currentTime;

  // Helper to play a single pulse
  const playPulse = (offset: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.type = 'triangle';
    
    // Pitch Slide: 600Hz down to 300Hz
    osc.frequency.setValueAtTime(600, startTime + offset);
    osc.frequency.exponentialRampToValueAtTime(300, startTime + offset + 0.15);

    // Envelope (Quick warning blip)
    gain.gain.setValueAtTime(0, startTime + offset);
    gain.gain.linearRampToValueAtTime(0.15, startTime + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + offset + 0.15);

    // Spatial Panning Logic
    let outputNode: AudioNode = gain;
    
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      const safePan = Math.max(-1, Math.min(1, pan));
      panner.pan.setValueAtTime(safePan, startTime + offset);
      gain.connect(panner);
      outputNode = panner;
    } else {
       // Fallback for browsers without StereoPanner
       const panner = ctx.createPanner();
       panner.panningModel = 'HRTF';
       panner.distanceModel = 'inverse';
       
       const x = Math.max(-1, Math.min(1, pan));
       // Position listener at origin
       ctx.listener.setPosition(0, 0, 0);
       // Position sound source
       panner.setPosition(x, 0, -1);
       
       gain.connect(panner);
       outputNode = panner;
    }

    outputNode.connect(ctx.destination);

    osc.connect(gain);
    osc.start(startTime + offset);
    osc.stop(startTime + offset + 0.2);
  };

  // Double pulse pattern "Bup-Bup"
  playPulse(0);
  playPulse(0.18);
};

export const playSonarPing = (pan: number) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  osc.type = 'sine';
  
  // Sonar "Ping" sound: High pitch dropping slightly
  const now = ctx.currentTime;
  osc.frequency.setValueAtTime(800, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.15);
  
  // Envelope
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.3, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

  // Spatial Panning Logic
  let outputNode: AudioNode = gain;

  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    const safePan = Math.max(-1, Math.min(1, pan));
    panner.pan.setValueAtTime(safePan, ctx.currentTime);
    gain.connect(panner);
    outputNode = panner;
  } else {
    // Fallback using PannerNode (HRTF 3D Audio)
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    
    const x = Math.max(-1, Math.min(1, pan));
    // Listener default is 0,0,0
    panner.setPosition(x, 0, -1); // Sound is in front, moving left/right
    
    gain.connect(panner);
    outputNode = panner;
  }

  outputNode.connect(ctx.destination);
  osc.connect(gain);

  osc.start(now);
  osc.stop(now + 0.3);
};