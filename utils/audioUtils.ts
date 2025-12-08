// Singleton AudioContext to prevent "limit reached" errors
let audioCtx: AudioContext | null = null;

export const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
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

export const playCautionSound = (pan: number) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const startTime = ctx.currentTime;

  // Helper to play a single pulse
  const playPulse = (offset: number) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    // Triangle wave: Richer than sine, smoother than square/sawtooth
    // This fits "Distinct but less alarming than STOP"
    osc.type = 'triangle';
    
    // Pitch Slide: 600Hz down to 300Hz
    // Indicates "warning/negative" movement but in mid-range
    osc.frequency.setValueAtTime(600, startTime + offset);
    osc.frequency.exponentialRampToValueAtTime(300, startTime + offset + 0.15);

    // Spatial Panning
    let sourceNode: AudioNode = osc;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), startTime + offset);
      osc.connect(panner);
      sourceNode = panner;
    } else {
        // Fallback for browsers without StereoPanner
        sourceNode = osc;
    }

    // Connect chain
    sourceNode.connect(gain);
    gain.connect(ctx.destination);

    // Envelope (Quick warning blip)
    // Volume 0.15 is balanced between Safe (0.3 sine) and Stop (sawtooth)
    gain.gain.setValueAtTime(0, startTime + offset);
    gain.gain.linearRampToValueAtTime(0.15, startTime + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + offset + 0.15);

    osc.start(startTime + offset);
    osc.stop(startTime + offset + 0.2);
  };

  // Double pulse pattern "Bup-Bup" for noticeable attention
  playPulse(0);
  playPulse(0.18);
};

export const playSonarPing = (pan: number) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  // Explicitly set to sine for a pure sonar ping sound
  osc.type = 'sine';
  
  // Use StereoPanner if supported
  let nodeToConnectToGain: AudioNode = osc;
  
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    const safePan = Math.max(-1, Math.min(1, pan));
    panner.pan.setValueAtTime(safePan, ctx.currentTime);
    osc.connect(panner);
    nodeToConnectToGain = panner;
  } else {
    // Fallback logic handled by variable assignment;
    // We only connect osc directly to gain if panner isn't used below.
    nodeToConnectToGain = osc;
  }

  // Sonar "Ping" sound: High pitch dropping slightly
  osc.frequency.setValueAtTime(800, ctx.currentTime);
  osc.frequency.exponentialRampToValueAtTime(600, ctx.currentTime + 0.15);
  
  // Envelope
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.3, ctx.currentTime + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

  nodeToConnectToGain.connect(gain);
  gain.connect(ctx.destination);

  osc.start();
  osc.stop(ctx.currentTime + 0.3);
};