// ---------------------------------------------------------------------------
// BOMA NIGHT — shared types, difficulty configs and the Web Audio synth engine.
// ---------------------------------------------------------------------------

export type GamePhase = 'BOOT' | 'MENU' | 'COUNTDOWN' | 'PLAYING' | 'PAUSED' | 'WIN' | 'LOSS';
export type Difficulty = 'easy' | 'medium' | 'hard';

export interface HudState {
    herd: number;
    maxHerd: number;
    score: number;
    timeLeft: number;
    totalTime: number;
    dangerLevel: number;
}

export interface DifficultyConfig {
    lanes: number;
    herd: number;
    speedMin: number;
    speedMax: number;
    spawnMin: number;
    spawnMax: number;
    tricksterChance: number;
    label: string;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyConfig> = {
    easy:   { lanes: 2, herd: 10, speedMin: 120, speedMax: 180, spawnMin: 1.8, spawnMax: 2.5, tricksterChance: 0,    label: 'Easy' },
    medium: { lanes: 3, herd: 8,  speedMin: 180, speedMax: 260, spawnMin: 1.2, spawnMax: 1.8, tricksterChance: 0.25,  label: 'Medium' },
    hard:   { lanes: 4, herd: 6,  speedMin: 220, speedMax: 340, spawnMin: 0.8, spawnMax: 1.3, tricksterChance: 0.5,   label: 'Hard' },
};

export const NIGHT_DURATION = 60; // seconds of night watch before dawn

// ---------------------------------------------------------------------------
// Dynamic-tempo nocturnal chiptune synth (Web Audio API).
// Marimba-ish plucks + kalimba arpeggios + pulse bass + cicada hum, with the
// BPM rising from 105 to 145 as danger increases.
// ---------------------------------------------------------------------------
export class AudioEngine {
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;
    private timer: number | null = null;
    private step = 0;
    private danger = 0;
    private playing = false;
    muted = false;

    private ensure(): boolean {
        if (typeof window === 'undefined') return false;
        if (!this.ctx) {
            const AC: typeof AudioContext | undefined =
                window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return false;
            this.ctx = new AC();
            this.master = this.ctx.createGain();
            this.master.gain.value = 0.22;
            this.master.connect(this.ctx.destination);
        }
        return true;
    }

    setDanger(level: number) {
        this.danger = Math.max(0, Math.min(1, level));
    }

    setMuted(m: boolean) {
        this.muted = m;
        if (this.master && this.ctx) {
            this.master.gain.setTargetAtTime(m ? 0 : 0.22, this.ctx.currentTime, 0.05);
        }
    }

    start() {
        if (!this.ensure() || this.playing) return;
        this.playing = true;
        this.step = 0;
        this.scheduleLoop();
    }

    stop() {
        this.playing = false;
        if (this.timer !== null) {
            window.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    pause() { this.stop(); }
    resume() { this.start(); }

    private bpm() {
        return 105 + this.danger * 40; // 105 -> 145
    }

    private scheduleLoop() {
        if (!this.playing || !this.ctx) return;
        const stepDur = 60 / this.bpm() / 2; // eighth notes
        this.tick(this.step);
        this.step = (this.step + 1) % 16;
        this.timer = window.setTimeout(() => this.scheduleLoop(), stepDur * 1000);
    }

    private scale = [0, 3, 5, 7, 10, 12, 15]; // minor pentatonic-ish

    private tick(step: number) {
        if (!this.ctx || !this.master) return;
        const t = this.ctx.currentTime;
        // pulse bass every 4 steps
        if (step % 4 === 0) this.note(55 + (this.scale[step % 7] * 2), t, 0.22, 'triangle', 0.5);
        // kalimba arpeggio
        if (step % 2 === 0) {
            const idx = (step / 2 + Math.floor(step / 8)) % this.scale.length;
            this.note(220 * Math.pow(2, this.scale[idx] / 12), t, 0.18, 'sine', 0.28);
        }
        // marimba melody line, denser with danger
        if (this.danger > 0.35 && step % 3 === 1) {
            this.note(440 * Math.pow(2, this.scale[(step * 3) % this.scale.length] / 12), t, 0.12, 'sine', 0.16);
        }
        // tense sub-pulse at high danger
        if (this.danger > 0.6 && step % 8 === 6) this.note(82, t, 0.3, 'sawtooth', 0.18);
        // cicada shimmer every bar
        if (step === 0) this.cicada(t);
    }

    private note(freq: number, t: number, dur: number, type: OscillatorType, vol: number) {
        if (!this.ctx || !this.master) return;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(this.master);
        osc.start(t);
        osc.stop(t + dur + 0.05);
    }

    private cicada(t: number) {
        if (!this.ctx || !this.master) return;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        const lfo = this.ctx.createOscillator();
        const lfoGain = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = 4200;
        lfo.frequency.value = 55 + this.danger * 30;
        lfoGain.gain.value = 0.006;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.012, t + 0.2);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
        lfo.connect(lfoGain).connect(g.gain);
        osc.connect(g).connect(this.master);
        osc.start(t); lfo.start(t);
        osc.stop(t + 1.5); lfo.stop(t + 1.5);
    }

    // ---- one-shot SFX -------------------------------------------------------
    zap() {
        if (!this.ensure() || !this.ctx || !this.master || this.muted) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(1400, t);
        osc.frequency.exponentialRampToValueAtTime(300, t + 0.18);
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        osc.connect(g).connect(this.master);
        osc.start(t); osc.stop(t + 0.25);
    }

    howl() {
        if (!this.ensure() || !this.ctx || !this.master || this.muted) return;
        const t = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(340, t);
        osc.frequency.exponentialRampToValueAtTime(620, t + 0.25);
        osc.frequency.exponentialRampToValueAtTime(180, t + 0.7);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.1);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
        osc.connect(g).connect(this.master);
        osc.start(t); osc.stop(t + 0.8);
    }

    click() {
        if (!this.ensure() || !this.ctx || !this.master || this.muted) return;
        this.note(900, this.ctx.currentTime, 0.06, 'square', 0.15);
    }

    dispose() {
        this.stop();
        this.ctx?.close().catch(() => undefined);
        this.ctx = null;
    }
}

export const audioEngine = new AudioEngine();
