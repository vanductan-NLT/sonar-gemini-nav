export interface BoundingBox {
  label: string;
  box_2d: [number, number, number, number]; // ymin, xmin, ymax, xmax
}

export interface VisualDebug {
  hazards: BoundingBox[];
  safe_path: BoundingBox[];
}

export interface SonarResponse {
  safety_status: 'SAFE' | 'CAUTION' | 'STOP';
  reasoning_summary: string;
  navigation_command: string;
  stereo_pan: number; // -1.0 to 1.0
  visual_debug: VisualDebug;
}

export enum AppState {
  IDLE = 'IDLE',
  SCANNING = 'SCANNING',
  LISTENING = 'LISTENING', // For voice commands
  PROCESSING_QUERY = 'PROCESSING_QUERY'
}