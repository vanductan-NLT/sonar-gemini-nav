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
    
    // Triangle wave for a "warning" timbre (softer than sawtooth, rougher than sine)
    osc.type = 'triangle';
    
    // Lower pitch for caution (300Hz -> 250Hz slide)
    osc.frequency.setValueAtTime(300, startTime + offset);
    osc.frequency.linearRampToValueAtTime(250, startTime + offset + 0.15);

    // Spatial Panning
    let sourceNode: AudioNode = osc;
    if (ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), startTime + offset);
      osc.connect(panner);
      sourceNode = panner;
    }

    // Connect chain
    sourceNode.connect(gain);
    gain.connect(ctx.destination);

    // Envelope (Double Pulse)
    gain.gain.setValueAtTime(0, startTime + offset);
    gain.gain.linearRampToValueAtTime(0.2, startTime + offset + 0.05);
    gain.gain.linearRampToValueAtTime(0, startTime + offset + 0.15);

    osc.start(startTime + offset);
    osc.stop(startTime + offset + 0.15);
  };

  // Schedule two pulses: "Bup-Bup"
  playPulse(0);
  playPulse(0.2);
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