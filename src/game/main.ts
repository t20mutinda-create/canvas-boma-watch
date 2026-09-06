import * as Phaser from 'phaser';
import { AUTO, Events, Game as PhaserGame, Scale, Scene } from 'phaser';
import {
    DIFFICULTIES,
    NIGHT_DURATION,
    audioEngine,
    type Difficulty,
    type GamePhase,
    type HudState,
} from './utils';

// ---------------------------------------------------------------------------
// BOMA NIGHT — constants
// ---------------------------------------------------------------------------
export const GAME_WIDTH = 540;
export const GAME_HEIGHT = 960;

export const COLORS = {
    BG_TOP: '#080C14',
    BG_BOTTOM: '#10192E',
    FENCE: 0x3D2714,
    FENCE_LIGHT: 0x5C3A21,
    CATTLE: 0x4A3524,
    CATTLE_LIGHT: 0x8A6B4F,
    HYENA: 0x1A1A24,
    EYE_RED: 0xFF3B30,
    EYE_GOLD: 0xFFB703,
    GOLD: 0xFDB813,
    FIRE: 0xFF7700,
} as const;

// ---------------------------------------------------------------------------
// EVENT BUS + event name constants (shared with App.tsx — never drift)
// ---------------------------------------------------------------------------
export const EventBus = new Events.EventEmitter();

export const EV_PHASE_CHANGED = 'phase-changed';
export const EV_CURRENT_SCENE_READY = 'current-scene-ready';
export const EV_HUD_UPDATED = 'hud-updated';
export const EV_SCREEN_SHAKE = 'screen-shake';
export const EV_START_GAME_REQUEST = 'start-game-request';
export const EV_PAUSE_GAME_REQUEST = 'pause-game-request';
export const EV_RESUME_GAME_REQUEST = 'resume-game-request';
export const EV_RESTART_GAME_REQUEST = 'restart-game-request';
export const EV_RETURN_MENU_REQUEST = 'return-menu-request';

const BOMA_X = GAME_WIDTH / 2;
const BOMA_Y = 500;
const BOMA_R = 75;
const SPAWN_DIST = 520;
const FLASH_COOLDOWN = 150; // ms per lane

interface LaneDef { angle: number; keys: string[]; label: string; }

const LANE_SETS: Record<number, LaneDef[]> = {
    2: [
        { angle: Math.PI,          keys: ['A', 'LEFT'],  label: 'A' },
        { angle: 0,                keys: ['D', 'RIGHT'], label: 'D' },
    ],
    3: [
        { angle: (225 * Math.PI) / 180, keys: ['Q', 'A', 'UP'],    label: 'Q' },
        { angle: (315 * Math.PI) / 180, keys: ['E', 'D'],          label: 'E' },
        { angle: Math.PI / 2,      keys: ['S', 'DOWN'],  label: 'S' },
    ],
    4: [
        { angle: -Math.PI / 2,     keys: ['W', 'UP'],    label: 'W' },
        { angle: 0,                keys: ['D', 'RIGHT'], label: 'D' },
        { angle: Math.PI / 2,      keys: ['S', 'DOWN'],  label: 'S' },
        { angle: Math.PI,          keys: ['A', 'LEFT'],  label: 'A' },
    ],
};

interface Hyena {
    sprite: Phaser.GameObjects.Container;
    body: Phaser.Physics.Arcade.Body;
    lane: number;
    angle: number;
    speed: number;
    trickster: boolean;
    behavior: 'advance' | 'pause' | 'sprint' | 'feint';
    behaviorTimer: number;
    usedTrick: boolean;
    fleeing: boolean;
    eyeL: Phaser.GameObjects.Arc;
    eyeR: Phaser.GameObjects.Arc;
    shadowWeaver: boolean;
}

interface Cattle { x: number; y: number; body: Phaser.GameObjects.Container; }

// ---------------------------------------------------------------------------
// StartGame factory
// ---------------------------------------------------------------------------
const StartGame = (parent: string) => {
    const config: Phaser.Types.Core.GameConfig = {
        type: AUTO,
        width: GAME_WIDTH,
        height: GAME_HEIGHT,
        parent,
        backgroundColor: COLORS.BG_TOP,
        roundPixels: true,
        scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
        physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 } } },
        scene: [Game],
    };
    const game = new PhaserGame(config);
    if (typeof window !== 'undefined') {
        (window as unknown as Record<string, unknown>).__PHASER_GAME__ = game;
        (window as unknown as Record<string, unknown>).__PHASER_EVENT_BUS__ = EventBus;
    }
    return game;
};

// ---------------------------------------------------------------------------
// THE GAME SCENE — everything lives here.
// ---------------------------------------------------------------------------
export class Game extends Scene {
    private phase: GamePhase = 'BOOT';
    private difficulty: Difficulty = 'easy';
    private lanes: LaneDef[] = [];
    private laneFlashReadyAt: number[] = [];
    private laneGuides: Phaser.GameObjects.Graphics[] = [];

    private hyenas: Hyena[] = [];
    private cattle: Cattle[] = [];
    private herd = 0;
    private maxHerd = 0;
    private score = 0;
    private combo = 0;
    private timeLeft = NIGHT_DURATION;
    private danger = 0;

    private spawnTimer: Phaser.Time.TimerEvent | null = null;
    private nightTimer: Phaser.Time.TimerEvent | null = null;
    private hudTimer: Phaser.Time.TimerEvent | null = null;

    private lantern!: Phaser.GameObjects.Image;
    private campfire!: Phaser.GameObjects.Image;
    private bomaRing!: Phaser.GameObjects.Graphics;
    private dawnOverlay!: Phaser.GameObjects.Rectangle;
    private stars: Phaser.GameObjects.Image[] = [];
    private embers!: Phaser.GameObjects.Particles.ParticleEmitter;
    private keyHandlers: Array<() => void> = [];

    constructor() { super('Game'); }

    // ------------------------------------------------------------- preload
    preload() {
        // All visuals are procedurally generated in makeTextures().
        // Audio is synthesized via the Web Audio API in AudioEngine.
    }

    private safePlay(key: string, volume = 0.6) {
        if (this.cache.audio.exists(key)) this.sound.play(key, { volume });
    }

    // ------------------------------------------------------------- textures
    private makeTextures() {
        const g = this.add.graphics();

        // hyena silhouette (side profile, facing +x / right)
        g.fillStyle(COLORS.HYENA, 1);
        g.fillTriangle(-14, -10, -6, -18, -2, -9);          // ear
        g.fillTriangle(2, -12, 8, -20, 12, -10);            // ear
        g.fillRect(-16, -10, 32, 12);                        // body
        g.fillCircle(16, -6, 8);                             // head
        g.fillTriangle(20, -10, 30, -6, 20, -2);             // snout
        g.fillRect(-14, 2, 5, 10);                           // legs
        g.fillRect(8, 2, 5, 10);
        g.fillTriangle(-16, -8, -26, -14, -16, -2);          // tail
        g.fillStyle(0x26263a, 1);
        g.fillRect(-8, -12, 3, 4); g.fillRect(-2, -13, 3, 4); g.fillRect(4, -12, 3, 4); // spine ridge
        g.generateTexture('hyena', 64, 40);
        g.clear();

        // cattle silhouette (rounded body + head + horns)
        g.fillStyle(COLORS.CATTLE, 1);
        g.fillRoundedRect(-18, -10, 36, 20, 8);
        g.fillCircle(18, -8, 8);
        g.fillStyle(0xD9C7A6, 1);
        g.fillTriangle(22, -14, 28, -20, 24, -12);           // horn
        g.fillTriangle(14, -14, 8, -20, 12, -12);            // horn
        g.fillStyle(COLORS.CATTLE_LIGHT, 0.6);
        g.fillRoundedRect(-10, -6, 12, 8, 4);                // patch
        g.fillRect(-14, 10, 5, 8); g.fillRect(8, 10, 5, 8);   // legs
        g.generateTexture('cattle', 56, 44);
        g.clear();

        // lantern glow radial
        g.fillGradientStyle(0xfff4b8, 0xfff4b8, 0xffb703, 0xffb703, 0.0);
        g.fillCircle(64, 64, 64);
        g.fillGradientStyle(0xfff4b8, 0xfff4b8, 0xffb703, 0xffb703, 0.35);
        g.fillCircle(64, 64, 40);
        g.generateTexture('lantern_glow', 128, 128);
        g.clear();

        // campfire
        g.fillStyle(COLORS.FIRE, 1); g.fillTriangle(-8, 8, 0, -10, 8, 8);
        g.fillStyle(0xFFD166, 1); g.fillTriangle(-4, 8, 0, -4, 4, 8);
        g.fillStyle(0x5C3A21, 1); g.fillRect(-10, 8, 20, 4);
        g.generateTexture('campfire', 24, 24);
        g.clear();

        // acacia tree silhouette
        g.fillStyle(0x0B1120, 1);
        g.fillRect(-3, -20, 6, 26);
        g.fillEllipse(0, -26, 60, 18);
        g.fillEllipse(-14, -20, 30, 10);
        g.fillEllipse(16, -22, 26, 10);
        g.generateTexture('acacia', 80, 50);
        g.clear();

        // lane wedge (subtle moonlit path pointing +x, origin at left edge)
        g.fillStyle(0xE0CA9E, 0.05);
        g.fillTriangle(0, 0, SPAWN_DIST, -55, SPAWN_DIST, 55);
        g.generateTexture('lane_wedge', SPAWN_DIST, 110);
        g.clear();

        // fx_spark — small bright diamond
        g.fillStyle(0xFFF4B8, 1);
        g.fillTriangle(4, 0, 0, 4, 4, 8);
        g.fillTriangle(4, 0, 8, 4, 4, 8);
        g.generateTexture('fx_spark', 8, 8);
        g.clear();

        // fx_glow — soft radial dot
        g.fillStyle(0xFFB703, 0.6);
        g.fillCircle(6, 6, 6);
        g.fillStyle(0xFFD166, 0.9);
        g.fillCircle(6, 6, 3);
        g.generateTexture('fx_glow', 12, 12);
        g.clear();

        // fx_smoke — grey puff
        g.fillStyle(0x8A6B4F, 0.7);
        g.fillCircle(8, 8, 7);
        g.fillStyle(0x6B5540, 0.5);
        g.fillCircle(6, 6, 5);
        g.generateTexture('fx_smoke', 16, 16);
        g.clear();

        // fx_star — tiny white dot
        g.fillStyle(0xFFFFFF, 1);
        g.fillCircle(3, 3, 2);
        g.generateTexture('fx_star', 6, 6);
        g.destroy();
    }

    // ------------------------------------------------------------- create
    create() {
        this.makeTextures();
        this.buildBackdrop();
        this.buildBoma();
        this.setLanes(2);

        this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onPointerDown(p));

        EventBus.on(EV_START_GAME_REQUEST, this.onStartRequest, this);
        EventBus.on(EV_PAUSE_GAME_REQUEST, this.onPauseToggle, this);
        EventBus.on(EV_RESUME_GAME_REQUEST, this.resumeGame, this);
        EventBus.on(EV_RESTART_GAME_REQUEST, this.onRestartRequest, this);
        EventBus.on(EV_RETURN_MENU_REQUEST, this.returnToMenu, this);

        this.phase = 'MENU';
        EventBus.emit(EV_PHASE_CHANGED, 'MENU');
        EventBus.emit(EV_CURRENT_SCENE_READY, this);

        this.events.once('shutdown', () => {
            this.time.removeAllEvents();
            this.tweens.killAll();
            this.input.keyboard?.removeAllListeners();
            this.input.removeAllListeners();
            EventBus.off(EV_START_GAME_REQUEST, this.onStartRequest, this);
            EventBus.off(EV_PAUSE_GAME_REQUEST, this.onPauseToggle, this);
            EventBus.off(EV_RESUME_GAME_REQUEST, this.resumeGame, this);
            EventBus.off(EV_RESTART_GAME_REQUEST, this.onRestartRequest, this);
            EventBus.off(EV_RETURN_MENU_REQUEST, this.returnToMenu, this);
            audioEngine.stop();
            this.sound.stopAll();
        });
    }

    // ------------------------------------------------------------- backdrop
    private buildBackdrop() {
        const bg = this.add.graphics();
        bg.fillGradientStyle(0x080c14, 0x080c14, 0x10192e, 0x10192e, 1);
        bg.fillRect(0, 0, GAME_WIDTH, GAME_HEIGHT);
        bg.setDepth(-10);

        // rolling horizon silhouettes (no prison-bar trees)
        const hills = this.add.graphics();
        hills.fillStyle(0x0b1120, 1);
        hills.fillPoints([
            new Phaser.Math.Vector2(0, 150), new Phaser.Math.Vector2(90, 120), new Phaser.Math.Vector2(200, 145),
            new Phaser.Math.Vector2(320, 110), new Phaser.Math.Vector2(430, 140), new Phaser.Math.Vector2(540, 125),
            new Phaser.Math.Vector2(540, 0), new Phaser.Math.Vector2(0, 0),
        ], true);
        hills.setDepth(-9);

        for (const [x, y, s] of [[60, 165, 0.8], [430, 150, 1.0], [500, 190, 0.6], [140, 830, 0.9], [420, 880, 0.7]] as const) {
            this.add.image(x, y, 'acacia').setScale(s).setDepth(-8).setAlpha(0.9);
        }

        // twinkling stars
        for (let i = 0; i < 40; i++) {
            const st = this.add.image(
                Phaser.Math.Between(10, GAME_WIDTH - 10),
                Phaser.Math.Between(10, 240),
                'fx_star',
            ).setScale(Phaser.Math.FloatBetween(0.15, 0.4)).setAlpha(0.7).setDepth(-7);
            this.tweens.add({
                targets: st, alpha: 0.15, duration: Phaser.Math.Between(800, 2200),
                yoyo: true, repeat: -1, delay: Phaser.Math.Between(0, 1500),
            });
            this.stars.push(st);
        }

        // fireflies
        for (let i = 0; i < 8; i++) {
            const ff = this.add.circle(
                Phaser.Math.Between(30, GAME_WIDTH - 30),
                Phaser.Math.Between(300, GAME_HEIGHT - 60),
                2, 0xBFFF5E, 0.8,
            ).setDepth(-5);
            this.tweens.add({
                targets: ff,
                x: ff.x + Phaser.Math.Between(-40, 40),
                y: ff.y + Phaser.Math.Between(-30, 30),
                alpha: 0.1,
                duration: Phaser.Math.Between(2500, 5000),
                yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
            });
        }

        this.dawnOverlay = this.add.rectangle(
            GAME_WIDTH / 2, GAME_HEIGHT / 2, GAME_WIDTH, GAME_HEIGHT, 0xFFB703, 0,
        ).setDepth(50).setOrigin(0.5);
    }

    // ------------------------------------------------------------- boma
    private buildBoma() {
        this.bomaRing = this.add.graphics().setDepth(2);
        this.drawBomaRing();

        this.campfire = this.add.image(BOMA_X, BOMA_Y + 8, 'campfire').setDepth(4);
        this.tweens.add({ targets: this.campfire, scaleY: 1.25, scaleX: 0.9, duration: 260, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });

        this.embers = this.add.particles(BOMA_X, BOMA_Y, 'fx_glow', {
            speed: { min: 10, max: 45 },
            angle: { min: 250, max: 290 },
            scale: { start: 0.25, end: 0 },
            alpha: { start: 0.9, end: 0 },
            lifespan: 1200,
            frequency: 120,
            quantity: 1,
            tint: [0xFF7700, 0xFFD166],
        }).setDepth(4);

        this.lantern = this.add.image(BOMA_X, BOMA_Y, 'lantern_glow')
            .setScale(1.6).setDepth(3).setBlendMode(Phaser.BlendModes.ADD).setAlpha(0.85);
        this.tweens.add({ targets: this.lantern, scale: 1.45, alpha: 0.7, duration: 900, yoyo: true, repeat: -1 });
    }

    private drawBomaRing() {
        const g = this.bomaRing;
        g.clear();
        g.lineStyle(8, COLORS.FENCE, 1);
        g.strokeCircle(BOMA_X, BOMA_Y, BOMA_R);
        g.lineStyle(4, COLORS.FENCE_LIGHT, 1);
        g.strokeCircle(BOMA_X, BOMA_Y, BOMA_R - 5);
        // thorn stakes around the ring
        for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2;
            const x = BOMA_X + Math.cos(a) * BOMA_R;
            const y = BOMA_Y + Math.sin(a) * BOMA_R;
            g.fillStyle(COLORS.FENCE_LIGHT, 1);
            g.fillTriangle(
                x - Math.sin(a) * 4, y + Math.cos(a) * 4,
                x + Math.cos(a) * 9, y + Math.sin(a) * 9,
                x + Math.sin(a) * 4, y - Math.cos(a) * 4,
            );
        }
    }

    // ------------------------------------------------------------- lanes
    private setLanes(count: number) {
        this.laneGuides.forEach(l => l.destroy());
        this.laneGuides = [];
        this.lanes = LANE_SETS[count] ?? LANE_SETS[2];
        this.laneFlashReadyAt = this.lanes.map(() => 0);

        this.lanes.forEach((lane, i) => {
            const wedge = this.add.graphics().setDepth(1);
            wedge.fillStyle(0xE0CA9E, 0.045);
            wedge.fillTriangle(
                BOMA_X + Math.cos(lane.angle) * (BOMA_R + 8), BOMA_Y + Math.sin(lane.angle) * (BOMA_R + 8),
                BOMA_X + Math.cos(lane.angle - 0.14) * SPAWN_DIST, BOMA_Y + Math.sin(lane.angle - 0.14) * SPAWN_DIST,
                BOMA_X + Math.cos(lane.angle + 0.14) * SPAWN_DIST, BOMA_Y + Math.sin(lane.angle + 0.14) * SPAWN_DIST,
            );
            this.laneGuides.push(wedge);
            void i;
        });
    }

    private laneAtPointer(x: number, y: number): number {
        const dx = x - BOMA_X;
        const dy = y - BOMA_Y;
        if (Math.hypot(dx, dy) < BOMA_R) return -1;
        const ang = Math.atan2(dy, dx);
        let best = -1;
        let bestDiff = Math.PI / 4 + 0.1; // max half-wedge tolerance
        this.lanes.forEach((lane, i) => {
            let d = Math.abs(ang - lane.angle);
            if (d > Math.PI) d = Math.PI * 2 - d;
            if (d < bestDiff) { bestDiff = d; best = i; }
        });
        return best;
    }

    private onPointerDown(p: Phaser.Input.Pointer) {
        if (this.phase !== 'PLAYING') return;
        const lane = this.laneAtPointer(p.x, p.y);
        if (lane >= 0) this.flashLane(lane);
    }

    // ------------------------------------------------------------- input keys
    private bindLaneKeys() {
        const kb = this.input.keyboard;
        if (!kb) return;
        const NUM_KEYS = ['ONE', 'TWO', 'THREE', 'FOUR'];
        this.lanes.forEach((lane, i) => {
            const idx = i;
            const handler = () => { if (this.phase === 'PLAYING') this.flashLane(idx); };
            const allKeys = [...lane.keys, NUM_KEYS[i]];
            for (const k of allKeys) {
                const key = kb.addKey(k);
                key.on('down', handler);
                this.keyHandlers.push(() => key.off('down', handler));
            }
        });
        const esc = kb.addKey('ESC');
        const p = kb.addKey('P');
        const toggle = () => { if (this.phase === 'PLAYING' || this.phase === 'PAUSED') this.onPauseToggle(); };
        esc.on('down', toggle); p.on('down', toggle);
        this.keyHandlers.push(() => { esc.off('down', toggle); p.off('down', toggle); });
    }

    private unbindLaneKeys() {
        this.keyHandlers.forEach(fn => fn());
        this.keyHandlers = [];
    }

    // ------------------------------------------------------------- flow
    private onStartRequest(payload?: { difficulty?: Difficulty }) {
        this.difficulty = payload?.difficulty ?? this.difficulty;
        this.beginCountdown();
    }

    private onRestartRequest(payload?: { difficulty?: Difficulty }) {
        if (payload?.difficulty) this.difficulty = payload.difficulty;
        this.beginCountdown();
    }

    private beginCountdown() {
        this.clearField();
        const cfg = DIFFICULTIES[this.difficulty];
        this.setLanes(cfg.lanes);
        this.bindLaneKeys();
        this.herd = cfg.herd;
        this.maxHerd = cfg.herd;
        this.score = 0;
        this.combo = 0;
        this.timeLeft = NIGHT_DURATION;
        this.danger = 0;
        this.spawnCattle(cfg.herd);
        this.drawBomaRing();
        this.phase = 'COUNTDOWN';
        EventBus.emit(EV_PHASE_CHANGED, 'COUNTDOWN');
        audioEngine.click();
        this.time.delayedCall(2400, () => {
            if (this.phase !== 'COUNTDOWN') return;
            this.phase = 'PLAYING';
            EventBus.emit(EV_PHASE_CHANGED, 'PLAYING');
            audioEngine.start();
            this.startTimers();
            this.emitHud();
        });
    }

    private startTimers() {
        const cfg = DIFFICULTIES[this.difficulty];
        this.spawnTimer = this.time.addEvent({
            delay: 1000, loop: true, callback: () => this.spawnTick(cfg),
        });
        this.nightTimer = this.time.addEvent({
            delay: 1000, repeat: NIGHT_DURATION - 1, loop: false,
            callback: () => {
                this.timeLeft -= 1;
                this.danger = Math.min(1, (1 - this.timeLeft / NIGHT_DURATION) * 0.6 + this.hyenas.length * 0.08);
                audioEngine.setDanger(this.danger);
                this.emitHud();
                if (this.timeLeft <= 0) this.win();
            },
        });
        this.hudTimer = this.time.addEvent({ delay: 250, loop: true, callback: () => this.emitHud() });
        this.spawnTick(cfg); // first hyena arrives quickly
    }

    private spawnTick(cfg: (typeof DIFFICULTIES)[Difficulty]) {
        if (this.phase !== 'PLAYING') return;
        const trickster = Math.random() < cfg.tricksterChance;
        this.spawnHyena(Phaser.Math.Between(0, this.lanes.length - 1), trickster);
        if (this.spawnTimer) {
            (this.spawnTimer as unknown as { delay: number }).delay = Phaser.Math.Between(
                Math.round(cfg.spawnMin * 1000),
                Math.round(cfg.spawnMax * 1000),
            );
        }
        // pack rusher: paired spawn at medium+ danger
        if (this.danger > 0.5 && this.lanes.length > 2 && Math.random() < 0.3) {
            this.time.delayedCall(350, () => {
                if (this.phase === 'PLAYING') this.spawnHyena(Phaser.Math.Between(0, this.lanes.length - 1), trickster);
            });
        }
    }

    // ------------------------------------------------------------- entities
    private spawnCattle(count: number) {
        this.cattle.forEach(c => c.body.destroy());
        this.cattle = [];
        const visible = Math.min(count, 6);
        for (let i = 0; i < visible; i++) {
            const a = (i / visible) * Math.PI * 2 + 0.4;
            const r = 30 + (i % 2) * 18;
            const x = BOMA_X + Math.cos(a) * r;
            const y = BOMA_Y + Math.sin(a) * r * 0.7 + 4;
            const c = this.add.container(x, y).setDepth(3);
            const spr = this.add.image(0, 0, 'cattle').setScale(0.55).setFlipX(Math.cos(a) < 0);
            c.add(spr);
            this.tweens.add({
                targets: c, y: y - 2, duration: Phaser.Math.Between(900, 1500),
                yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
            });
            this.cattle.push({ x, y, body: c });
        }
    }

    private spawnHyena(lane: number, trickster: boolean) {
        const cfg = DIFFICULTIES[this.difficulty];
        const def = this.lanes[lane];
        const dist = SPAWN_DIST - 20;
        const x = BOMA_X + Math.cos(def.angle) * dist;
        const y = BOMA_Y + Math.sin(def.angle) * dist;

        const shadowWeaver = trickster && Math.random() < 0.5;
        const spr = this.add.image(0, 0, 'hyena').setScale(0.8);
        const eyeColor = shadowWeaver ? 0x8B1A1A : (trickster ? COLORS.EYE_GOLD : COLORS.EYE_RED);
        const eyeL = this.add.circle(11, -8, 2.2, eyeColor).setBlendMode(Phaser.BlendModes.ADD);
        const eyeR = this.add.circle(15, -7, 2.2, eyeColor).setBlendMode(Phaser.BlendModes.ADD);
        const cont = this.add.container(x, y, [spr, eyeL, eyeR]).setDepth(6);
        // face toward boma center
        cont.rotation = def.angle + Math.PI + (Math.cos(def.angle + Math.PI) < 0 ? Math.PI : 0);
        const facing = def.angle + Math.PI;
        cont.rotation = facing;
        spr.setFlipX(Math.cos(facing) < 0);
        if (Math.cos(facing) < 0) { eyeL.x = -11; eyeR.x = -15; }
        cont.setScale(0.9);

        this.physics.add.existing(cont);
        const body = cont.body as Phaser.Physics.Arcade.Body;
        body.setCircle(14, -14, -14);
        body.setAllowGravity(false);

        const speed = Phaser.Math.Between(cfg.speedMin, cfg.speedMax);
        const hyena: Hyena = {
            sprite: cont, body, lane, angle: def.angle, speed,
            trickster, behavior: 'advance', behaviorTimer: 0, usedTrick: false,
            fleeing: false, eyeL, eyeR, shadowWeaver,
        };
        if (shadowWeaver) {
            cont.setAlpha(0.25);
            eyeL.setAlpha(0.35); eyeR.setAlpha(0.35);
        }
        this.hyenas.push(hyena);
    }

    private clearField() {
        this.hyenas.forEach(h => h.sprite.destroy());
        this.hyenas = [];
        this.cattle.forEach(c => c.body.destroy());
        this.cattle = [];
        if (this.spawnTimer) { this.spawnTimer.remove(); this.spawnTimer = null; }
        if (this.nightTimer) { this.nightTimer.remove(); this.nightTimer = null; }
        if (this.hudTimer) { this.hudTimer.remove(); this.hudTimer = null; }
        this.time.removeAllEvents();
        // NOTE: intentionally NOT calling this.tweens.killAll() here —
        // that would destroy ambient backdrop tweens (stars, fireflies,
        // campfire flicker, lantern pulse). Gameplay-specific tweens
        // (hyena flee, beams, score popups) target objects that are
        // already destroyed above, so Phaser GC handles them.
    }

    // ------------------------------------------------------------- actions
    private flashLane(lane: number) {
        const now = this.time.now;
        if ((this.laneFlashReadyAt[lane] ?? 0) > now) return;
        this.laneFlashReadyAt[lane] = now + FLASH_COOLDOWN;

        const def = this.lanes[lane];
        // beam visuals
        const beam = this.add.graphics().setDepth(8);
        beam.fillStyle(COLORS.GOLD, 0.35);
        beam.fillTriangle(
            BOMA_X, BOMA_Y,
            BOMA_X + Math.cos(def.angle - 0.16) * SPAWN_DIST, BOMA_Y + Math.sin(def.angle - 0.16) * SPAWN_DIST,
            BOMA_X + Math.cos(def.angle + 0.16) * SPAWN_DIST, BOMA_Y + Math.sin(def.angle + 0.16) * SPAWN_DIST,
        );
        this.tweens.add({ targets: beam, alpha: 0, duration: 280, onComplete: () => beam.destroy() });

        const ring = this.add.circle(BOMA_X, BOMA_Y, BOMA_R, COLORS.GOLD, 0).setStrokeStyle(6, COLORS.GOLD, 0.9).setDepth(9);
        this.tweens.add({
            targets: ring, scale: 4.5, alpha: 0, duration: 380, ease: 'Cubic.easeOut',
            onComplete: () => ring.destroy(),
        });

        // lantern lunge
        this.tweens.add({
            targets: this.lantern, scale: 2.2, alpha: 1, duration: 120, yoyo: true,
        });

        // hit detection along lane
        let hit = false;
        for (const h of [...this.hyenas]) {
            if (h.fleeing || h.lane !== lane) continue;
            const dx = h.sprite.x - BOMA_X;
            const dy = h.sprite.y - BOMA_Y;
            const dist = Math.hypot(dx, dy);
            if (dist > SPAWN_DIST + 40) continue;
            let d = Math.abs(Math.atan2(dy, dx) - def.angle);
            if (d > Math.PI) d = Math.PI * 2 - d;
            if (d < 0.3) {
                hit = true;
                this.scareHyena(h, dist);
            }
        }
        if (!hit) {
            this.combo = 0;
            audioEngine.click();
        }
    }

    private scareHyena(h: Hyena, dist: number) {
        h.fleeing = true;
        h.behavior = 'sprint';
        this.combo += 1;
        const distBonus = Math.round(Math.max(0, (SPAWN_DIST - dist)) / 10) * 5;
        const gained = 100 + distBonus + (this.combo - 1) * 25;
        this.score += gained;
        audioEngine.zap();
        this.safePlay('sfx_powerup', 0.35);

        // spark burst at hyena
        const burst = this.add.particles(h.sprite.x, h.sprite.y, 'fx_spark', {
            speed: { min: 80, max: 260 },
            scale: { start: 0.5, end: 0 },
            alpha: { start: 1, end: 0 },
            lifespan: 500,
            quantity: 16,
            tint: [0xFFF4B8, 0xFDB813, 0xFFB703],
            emitting: false,
        }).setDepth(10);
        burst.explode(16);
        this.time.delayedCall(700, () => burst.destroy());

        // floating score text
        const txt = this.add.text(h.sprite.x, h.sprite.y - 24, `+${gained}${this.combo > 1 ? ` x${this.combo}` : ''}`, {
            fontFamily: 'Arial Black', fontSize: '22px', color: '#FFD166',
            stroke: '#3D2714', strokeThickness: 4,
        }).setOrigin(0.5).setDepth(11);
        this.tweens.add({ targets: txt, y: txt.y - 40, alpha: 0, duration: 800, ease: 'Cubic.easeOut', onComplete: () => txt.destroy() });

        // flee away from boma
        const fleeAngle = h.angle;
        const sp = h.speed * 2.4;
        this.tweens.add({
            targets: h.sprite,
            x: BOMA_X + Math.cos(fleeAngle) * (SPAWN_DIST + 120),
            y: BOMA_Y + Math.sin(fleeAngle) * (SPAWN_DIST + 120),
            alpha: 0,
            duration: (SPAWN_DIST + 120 - Math.hypot(h.sprite.x - BOMA_X, h.sprite.y - BOMA_Y)) / sp * 1000,
            ease: 'Quad.easeIn',
            onComplete: () => this.removeHyena(h),
        });
        h.body.enable = false;
        this.emitHud();
    }

    private removeHyena(h: Hyena) {
        h.sprite.destroy();
        this.hyenas = this.hyenas.filter(x => x !== h);
    }

    private breach(h: Hyena) {
        this.removeHyena(h);
        this.herd = Math.max(0, this.herd - 1);
        this.combo = 0;
        this.cameras.main.shake(300, 0.015);
        this.cameras.main.flash(180, 120, 20, 20);
        EventBus.emit(EV_SCREEN_SHAKE, { intensity: 1 });
        this.safePlay('sfx_hit', 0.7);
        audioEngine.howl();

        // cow panic flash
        const dust = this.add.particles(BOMA_X, BOMA_Y, 'fx_smoke', {
            speed: { min: 40, max: 120 }, scale: { start: 0.6, end: 0 },
            alpha: { start: 0.6, end: 0 }, lifespan: 700, quantity: 10,
            tint: 0x8A6B4F, emitting: false,
        }).setDepth(7);
        dust.explode(10);
        this.time.delayedCall(900, () => dust.destroy());

        // remove one visible cow if herd shrank below visible count
        const visibleTarget = Math.min(this.herd, 6);
        while (this.cattle.length > visibleTarget) {
            const c = this.cattle.pop();
            c?.body.destroy();
        }
        this.drawBomaRing();
        this.emitHud();
        if (this.herd < 3) this.loss();
    }

    private onPauseToggle() {
        if (this.phase === 'PLAYING') {
            this.phase = 'PAUSED';
            this.physics.world.pause();
            this.tweens.pauseAll();
            this.sound.pauseAll();
            audioEngine.pause();
            EventBus.emit(EV_PHASE_CHANGED, 'PAUSED');
        } else if (this.phase === 'PAUSED') {
            this.resumeGame();
        }
    }

    private resumeGame() {
        if (this.phase !== 'PAUSED') return;
        this.phase = 'PLAYING';
        this.physics.world.resume();
        this.tweens.resumeAll();
        this.sound.resumeAll();
        audioEngine.resume();
        EventBus.emit(EV_PHASE_CHANGED, 'PLAYING');
    }

    private win() {
        this.finishRound();
        const bonus = this.herd * 250 + (this.difficulty === 'hard' ? 1000 : this.difficulty === 'medium' ? 500 : 0);
        this.score += bonus;
        this.phase = 'WIN';
        this.dawnTween();
        audioEngine.stop();
        this.safePlay('sfx_win', 0.8);
        this.emitHud();
        EventBus.emit(EV_PHASE_CHANGED, 'WIN');
    }

    private loss() {
        this.finishRound();
        this.phase = 'LOSS';
        audioEngine.stop();
        this.safePlay('sfx_gameover', 0.8);
        this.emitHud();
        EventBus.emit(EV_PHASE_CHANGED, 'LOSS');
    }

    private finishRound() {
        if (this.spawnTimer) { this.spawnTimer.remove(); this.spawnTimer = null; }
        if (this.nightTimer) { this.nightTimer.remove(); this.nightTimer = null; }
        if (this.hudTimer) { this.hudTimer.remove(); this.hudTimer = null; }
        this.unbindLaneKeys();
        this.hyenas.forEach(h => { if (!h.fleeing) this.removeHyena(h); });
        this.hyenas = [];
    }

    private returnToMenu() {
        this.finishRound();
        this.clearField();
        this.cattle.forEach(c => c.body.destroy());
        this.cattle = [];
        this.spawnCattle(4);
        this.setLanes(2);
        this.dawnOverlay.setAlpha(0);
        this.phase = 'MENU';
        EventBus.emit(EV_PHASE_CHANGED, 'MENU');
    }

    private dawnTween() {
        this.tweens.add({
            targets: this.dawnOverlay, alpha: { from: 0, to: 0.55 },
            duration: 2200, ease: 'Sine.easeIn',
        });
    }

    private emitHud() {
        const state: HudState = {
            herd: this.herd,
            maxHerd: this.maxHerd,
            score: this.score,
            timeLeft: Math.max(0, this.timeLeft),
            totalTime: NIGHT_DURATION,
            dangerLevel: this.danger,
        };
        EventBus.emit(EV_HUD_UPDATED, state);
    }

    // ------------------------------------------------------------- update
    update(_time: number, delta: number) {
        if (this.phase !== 'PLAYING') return;
        const dt = delta / 1000;

        for (const h of [...this.hyenas]) {
            if (h.fleeing || !h.sprite.active) continue;
            const dx = h.sprite.x - BOMA_X;
            const dy = h.sprite.y - BOMA_Y;
            const dist = Math.hypot(dx, dy);

            // shadow weaver fades in as it nears lantern range
            if (h.shadowWeaver) {
                const a = Phaser.Math.Clamp((dist - BOMA_R - 60) / 180, 0.2, 1);
                h.sprite.setAlpha(a);
                h.eyeL.setAlpha(Math.min(1, a + 0.2)); h.eyeR.setAlpha(Math.min(1, a + 0.2));
                h.eyeL.fillColor = dist < BOMA_R + 140 ? COLORS.EYE_RED : 0x8B1A1A;
                h.eyeR.fillColor = h.eyeL.fillColor;
            }

            // trickster behavior state machine
            let speed = h.speed;
            if (h.trickster && !h.usedTrick) {
                h.behaviorTimer -= delta;
                if (h.behavior === 'advance' && dist < SPAWN_DIST * 0.55) {
                    h.behavior = 'pause';
                    h.behaviorTimer = Phaser.Math.Between(450, 700);
                    h.eyeL.fillColor = 0xFFD166; h.eyeR.fillColor = 0xFFD166;
                    this.tweens.add({ targets: [h.eyeL, h.eyeR], scale: 2.2, yoyo: true, duration: 180, repeat: 2 });
                } else if (h.behavior === 'pause' && h.behaviorTimer <= 0) {
                    const roll = Math.random();
                    if (roll < 0.4 && this.lanes.length > 1) {
                        // feint: lane switch
                        h.usedTrick = true;
                        const other = Phaser.Math.Between(0, this.lanes.length - 1);
                        h.lane = other;
                        h.angle = this.lanes[other].angle;
                        h.behavior = 'sprint';
                    } else if (roll < 0.75) {
                        h.behavior = 'sprint';
                    } else {
                        h.behavior = 'advance';
                        h.usedTrick = true;
                    }
                }
                if (h.behavior === 'pause') speed = 0;
                if (h.behavior === 'sprint') speed = h.speed * 1.9;
            } else if (h.trickster && h.behavior === 'sprint') {
                speed = h.speed * 1.7;
            }

            // move toward boma along its current lane angle
            h.sprite.x -= Math.cos(h.angle) * speed * dt;
            h.sprite.y -= Math.sin(h.angle) * speed * dt;
            h.body.reset(h.sprite.x, h.sprite.y);

            // subtle trot bob
            h.sprite.rotation = h.angle + Math.PI + Math.sin(_time / 90 + h.lane) * 0.06;

            if (dist <= BOMA_R + 12) this.breach(h);
        }
    }
}

export default StartGame;