import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import StartGame, {
    EventBus,
    EV_PHASE_CHANGED,
    EV_CURRENT_SCENE_READY,
    EV_HUD_UPDATED,
    EV_SCREEN_SHAKE,
    EV_START_GAME_REQUEST,
    EV_PAUSE_GAME_REQUEST,
    EV_RESUME_GAME_REQUEST,
    EV_RESTART_GAME_REQUEST,
    EV_RETURN_MENU_REQUEST,
} from './game/main';
import { DIFFICULTIES, audioEngine, type Difficulty, type GamePhase, type HudState } from './game/utils';

interface IRefPhaserGame {
    game: Phaser.Game | null;
    scene: Phaser.Scene | null;
}

const BEST_KEY = 'boma-night-best';

// ---------------------------------------------------------------------------
// Modular HUD / narrative sub-components (plan §3).
// ---------------------------------------------------------------------------

interface HerdCounterProps {
    herd: number;
    maxHerd: number;
    isCritical: boolean;
}

function HerdCounter({ herd, maxHerd, isCritical }: HerdCounterProps) {
    return (
        <div className={`hud-item herd${isCritical ? ' critical' : ''}`}>
            <span className="hud-label">HERD</span>
            {/* key on herd re-mounts the span so the bump animation replays on change */}
            <span key={`herd-${herd}`} className="hud-value bump">
                {herd} / {maxHerd}
            </span>
        </div>
    );
}

interface TimerProps {
    timeLeft: number;
    totalTime: number;
    dangerLevel: number;
}

function Timer({ timeLeft, totalTime, dangerLevel }: TimerProps) {
    const pct = totalTime > 0 ? Math.max(0, Math.min(100, (timeLeft / totalTime) * 100)) : 0;
    const danger = dangerLevel > 0.6;
    return (
        <div className="time-bar-wrap">
            <div className={`time-bar${danger ? ' danger' : ''}`} style={{ width: `${pct}%` }} />
            <span className={`time-text${danger ? ' danger' : ''}`}>{Math.ceil(timeLeft)}s to dawn</span>
        </div>
    );
}

type NarratorType = 'field-log' | 'countdown' | 'report' | 'modal';

interface NarratorTextProps {
    text: string;
    title?: string;
    type?: NarratorType;
}

function NarratorText({ text, title, type = 'field-log' }: NarratorTextProps) {
    if (type === 'countdown') {
        return (
            <div className="countdown-banner">
                {title ? <h2>{title}</h2> : null}
                <p>{text}</p>
            </div>
        );
    }
    if (type === 'report') {
        return <p className="report">{text}</p>;
    }
    if (type === 'modal') {
        return <p className="joke">{text}</p>;
    }
    // default: field-log
    return (
        <>
            {title ? <h1 className="title">{title}</h1> : null}
            <p className="field-log">{text}</p>
        </>
    );
}

// ---------------------------------------------------------------------------
// App shell — React↔Phaser bridge + phase overlays.
// ---------------------------------------------------------------------------

function App() {
    const phaserRef = useRef<IRefPhaserGame | null>(null);
    const [phase, setPhase] = useState<GamePhase>('BOOT');
    const [difficulty, setDifficulty] = useState<Difficulty>('easy');
    const [hud, setHud] = useState<HudState>({
        herd: 10, maxHerd: 10, score: 0, timeLeft: 60, totalTime: 60, dangerLevel: 0,
    });
    const [shaking, setShaking] = useState(false);
    const [muted, setMuted] = useState(false);
    const [best, setBest] = useState<number>(() => {
        const raw = typeof window !== 'undefined' ? window.localStorage.getItem(BEST_KEY) : null;
        return raw ? Number(raw) || 0 : 0;
    });
    const [bumpKey, setBumpKey] = useState(0);
    const prevScore = useRef(0);
    // Mirror of the live phase for keyboard handlers (avoids stale closures).
    const phaseRef = useRef<GamePhase>('BOOT');
    // Buffers a phase emitted by Game.create() before the useEffect listener attaches.
    const pendingPhase = useRef<GamePhase | null>(null);

    useLayoutEffect(() => {
        // Buffer any EV_PHASE_CHANGED that fires during boot, before the
        // main useEffect subscribes. Removed once the real listener is live.
        const bufferPhase = (p: GamePhase) => { pendingPhase.current = p; };
        EventBus.on(EV_PHASE_CHANGED, bufferPhase);

        if (phaserRef.current === null) {
            const game = StartGame('game-container');
            phaserRef.current = { game, scene: null };
        }
        const handler = (scene: Phaser.Scene) => {
            if (phaserRef.current) phaserRef.current.scene = scene;
        };
        EventBus.on(EV_CURRENT_SCENE_READY, handler);
        return () => {
            EventBus.removeListener(EV_CURRENT_SCENE_READY, handler);
            EventBus.removeListener(EV_PHASE_CHANGED, bufferPhase);
            if (phaserRef.current) {
                phaserRef.current.game?.destroy(true);
                phaserRef.current = null;
            }
        };
    }, []);

    // Subscribe to Phaser -> React lifecycle events.
    // Race-condition guard: Game.create() can emit EV_PHASE_CHANGED('MENU')
    // synchronously during the useLayoutEffect boot, BEFORE this useEffect
    // attaches its listener. We buffer any phase emitted before mount and
    // replay it on subscribe so React never stays stuck in 'BOOT'.
    useEffect(() => {
        const onPhase = (p: GamePhase) => {
            phaseRef.current = p;
            setPhase(p);
        };
        const onHud = (s: HudState) => {
            setHud(s);
            if (s.score !== prevScore.current) {
                prevScore.current = s.score;
                setBumpKey(k => k + 1);
            }
        };
        const onShake = () => {
            setShaking(true);
            window.setTimeout(() => setShaking(false), 320);
        };
        EventBus.on(EV_PHASE_CHANGED, onPhase);
        EventBus.on(EV_HUD_UPDATED, onHud);
        EventBus.on(EV_SCREEN_SHAKE, onShake);
        // Replay a phase that arrived before we were listening (BOOT->MENU handshake).
        if (pendingPhase.current) {
            const p = pendingPhase.current;
            pendingPhase.current = null;
            onPhase(p);
        }
        return () => {
            EventBus.removeListener(EV_PHASE_CHANGED, onPhase);
            EventBus.removeListener(EV_HUD_UPDATED, onHud);
            EventBus.removeListener(EV_SCREEN_SHAKE, onShake);
        };
    }, []);

    // Save best score on win/loss
    useEffect(() => {
        if ((phase === 'WIN' || phase === 'LOSS') && hud.score > best) {
            setBest(hud.score);
            window.localStorage.setItem(BEST_KEY, String(hud.score));
        }
    }, [phase, hud.score, best]);

    const startGame = () => {
        audioEngine.click();
        EventBus.emit(EV_START_GAME_REQUEST, { difficulty });
    };
    const restart = () => {
        audioEngine.click();
        EventBus.emit(EV_RESTART_GAME_REQUEST, { difficulty });
    };
    const toMenu = () => {
        audioEngine.click();
        EventBus.emit(EV_RETURN_MENU_REQUEST);
    };
    const togglePause = () => {
        if (phaseRef.current === 'PLAYING') EventBus.emit(EV_PAUSE_GAME_REQUEST);
        else if (phaseRef.current === 'PAUSED') EventBus.emit(EV_RESUME_GAME_REQUEST);
    };
    const toggleMute = () => {
        const m = !muted;
        setMuted(m);
        audioEngine.setMuted(m);
    };

    // Always-fresh snapshot of the action closures for the global keyboard
    // listener, which is bound once. Reading through this ref avoids the
    // stale-closure trap where the empty-deps effect would otherwise capture
    // the first render's `difficulty` / `muted` / `phase` values.
    const actionsRef = useRef({ startGame, restart, togglePause, toggleMute });
    actionsRef.current = { startGame, restart, togglePause, toggleMute };

    // Keyboard shortcuts for menu / end screens / pause / mute (plan §3.5).
    // Registered once on window so it fires regardless of DOM focus (Phaser
    // canvas focus traps can't swallow it); reads live state via refs.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.code === 'Space' || e.code === 'Enter') {
                e.preventDefault(); // avoid page scroll / focus hopping
                const p = phaseRef.current;
                if (p === 'MENU') actionsRef.current.startGame();
                else if (p === 'WIN' || p === 'LOSS') actionsRef.current.restart();
            } else if (e.code === 'KeyP') {
                e.preventDefault();
                const p = phaseRef.current;
                if (p === 'PLAYING' || p === 'PAUSED') actionsRef.current.togglePause();
            } else if (e.code === 'KeyM') {
                e.preventDefault();
                actionsRef.current.toggleMute();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const laneLabels = DIFFICULTIES[difficulty].lanes === 4
        ? ['W', 'D', 'S', 'A']
        : DIFFICULTIES[difficulty].lanes === 3
            ? ['Q', 'E', 'S']
            : ['A', 'D'];
    const herdCritical = hud.herd <= 3;

    return (
        <div id="app">
            <div id={`game-container${shaking ? ' shake' : ''}`}></div>

            <div id="hud">
                {/* ------------------------------------------------ HUD ---- */}
                {(phase === 'PLAYING' || phase === 'PAUSED' || phase === 'COUNTDOWN') && (
                    <div className="hud-bar">
                        <HerdCounter herd={hud.herd} maxHerd={hud.maxHerd} isCritical={herdCritical} />
                        <div className="hud-item score">
                            <span className="hud-label">SCORE</span>
                            <span key={bumpKey} className="hud-value bump">{hud.score}</span>
                        </div>
                        <button className="icon-btn" onClick={toggleMute} aria-label="Toggle sound">
                            {muted ? 'MUTE' : 'SND'}
                        </button>
                        <button className="icon-btn" onClick={togglePause} aria-label="Pause">
                            {phase === 'PAUSED' ? '▶' : '⏸'}
                        </button>
                    </div>
                )}

                {(phase === 'PLAYING' || phase === 'PAUSED') && (
                    <>
                        <Timer timeLeft={hud.timeLeft} totalTime={hud.totalTime} dangerLevel={hud.dangerLevel} />
                        <div className="lane-hints">
                            {laneLabels.map((l, i) => (
                                <span key={i} className={`lane-hint${hud.dangerLevel > 0.6 ? ' danger' : ''}`}>
                                    Lane {i + 1}: <b>{l}</b> / tap
                                </span>
                            ))}
                        </div>
                    </>
                )}

                {/* ------------------------------------------- COUNTDOWN ---- */}
                {phase === 'COUNTDOWN' && (
                    <div className="overlay center">
                        <NarratorText type="countdown" title="NIGHT FALLS" text="The fisi are coming…" />
                    </div>
                )}

                {/* ------------------------------------------------ MENU ---- */}
                {phase === 'MENU' && (
                    <div className="overlay menu" onClick={startGame}>
                        <div className="menu-card" onClick={(e) => e.stopPropagation()}>
                            <NarratorText
                                type="field-log"
                                title="FISI NIGHT WATCH"
                                text="Field Log — 02:14 AM. Clinical rotation day 47. Sleep debt: catastrophic. Task: Keep these 10 ruminants breathing until dawn. The local fisi (hyenas) are already circling the perimeter. Flash the lanes to ward them off."
                            />
                            <div className="difficulty">
                                {(Object.keys(DIFFICULTIES) as Difficulty[]).map((d) => (
                                    <button
                                        key={d}
                                        className={`pill${difficulty === d ? ' active' : ''}`}
                                        onClick={() => { audioEngine.click(); setDifficulty(d); }}
                                        aria-pressed={difficulty === d}
                                    >
                                        <span className="pill-name">{DIFFICULTIES[d].label}</span>
                                        <span className="pill-sub">{DIFFICULTIES[d].lanes} lanes · {DIFFICULTIES[d].herd} head</span>
                                    </button>
                                ))}
                            </div>
                            <button className="play-btn" onClick={startGame}>{'▶'} START SHIFT</button>
                            <p className="hint">Tap/click anywhere or press Space/Enter · A/D or tap lanes to flash</p>
                            {best > 0 && <p className="best">Best watch: {best} pts</p>}
                        </div>
                    </div>
                )}

                {/* ----------------------------------------------- PAUSED ---- */}
                {phase === 'PAUSED' && (
                    <div className="overlay center">
                        <div className="modal">
                            <h2>Night Paused</h2>
                            <NarratorText type="modal" text="The fisi don't pause. You should." />
                            <button className="play-btn" onClick={togglePause}>Resume</button>
                            <button className="ghost-btn" onClick={toMenu}>Field Log</button>
                        </div>
                    </div>
                )}

                {/* ------------------------------------------------- WIN ---- */}
                {phase === 'WIN' && (
                    <div className="overlay center dawn" onClick={restart}>
                        <div className="modal" onClick={(e) => e.stopPropagation()}>
                            <h1 className="title win">Dawn Report — 06:00 AM</h1>
                            <NarratorText
                                type="report"
                                text={`60 seconds of sheer cortisol. Survived the night with ${hud.herd} cattle intact. The fisi retreated into the scrub. The cows didn't even say thank you.`}
                            />
                            <NarratorText type="modal" text={`Final score: ${hud.score}`} />
                            <button className="play-btn" onClick={restart}>Next Night Shift</button>
                            <button className="ghost-btn" onClick={toMenu}>Field Log</button>
                        </div>
                    </div>
                )}

                {/* ------------------------------------------------ LOSS ---- */}
                {phase === 'LOSS' && (
                    <div className="overlay center loss" onClick={restart}>
                        <div className="modal" onClick={(e) => e.stopPropagation()}>
                            <h1 className="title loss">Autopsy Report — Run Terminated</h1>
                            <NarratorText
                                type="report"
                                text="Herd dropped below 3 subjects. Sample size invalid, attending professor is going to fail me, and the fisi made off with three-quarters of the thesis data."
                            />
                            <NarratorText
                                type="modal"
                                text={`Survived ${hud.totalTime - Math.ceil(hud.timeLeft)}s · Score ${hud.score}`}
                            />
                            <button className="play-btn" onClick={restart}>Repeat Shift</button>
                            <button className="ghost-btn" onClick={toMenu}>Field Log</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;