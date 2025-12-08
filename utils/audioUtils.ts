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

export const playSonarPing = (pan: number) => {
  const ctx = getAudioContext();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  
  // Use StereoPanner if supported
  let nodeToConnectToGain: AudioNode = osc;
  
  if (ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    const safePan = Math.max(-1, Math.min(1, pan));
    panner.pan.setValueAtTime(safePan, ctx.currentTime);
    osc.connect(panner);
    nodeToConnectToGain = panner;
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