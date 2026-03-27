// impostor-server/src/index.ts
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.get('/health', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

// ── Save attempts ─────────────────────────────────────────────────────────────

async function saveAttempts(gameType: string, gameId: string, scores: { userId: string; score: number; placement?: number; abandon?: boolean }[]) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}

const PORT = process.env.PORT || 10010;

// ─── Types ────────────────────────────────────────────────────────────────────

interface Player {
    id: string;
    name: string;
    socketId: string | null;
    eliminated: boolean;
}

interface Clue {
    playerId: string;
    playerName: string;
    text: string;
}

interface Game {
    players: Player[];
    scores: Record<string, number>;
    expectedCount: number;
    started: boolean;
    word: string | null;
    impostorId: string | null;
    roundState: 'WAITING' | 'WRITING' | 'REVEAL' | 'VOTING' | 'IMPOSTOR_GUESS' | 'END';
    totalRounds: number;
    currentRound: number;
    timePerRound: number;
    speakingOrder: string[];
    currentSpeakerIndex: number;
    cluesThisRound: Clue[];
    allClues: { round: number; clues: Clue[] }[];
    votes: Record<string, string>;
    unmaskVotes: Set<string>;
    impostorCaught: boolean;
    impostorGuess: string | null;
    impostorGuessCorrect: boolean;
    surrenderUserId?: string;
}

// ─── State ────────────────────────────────────────────────────────────────────

const games = new Map<string, Game>();

function createGame(players: Player[], totalRounds: number, timePerRound: number): Game {
    const scores: Record<string, number> = {};
    for (const p of players) scores[p.id] = 0;
    return {
        players,
        scores,
        expectedCount: 0,
        started: false,
        word: null,
        impostorId: null,
        roundState: 'WAITING',
        totalRounds,
        currentRound: 1,
        timePerRound,
        speakingOrder: [],
        currentSpeakerIndex: 0,
        cluesThisRound: [],
        allClues: [],
        votes: {},
        unmaskVotes: new Set(),
        impostorCaught: false,
        impostorGuess: null,
        impostorGuessCorrect: false,
    };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function emitToRoom(roomId: string, event: string, data: any) {
    io.to(roomId).emit(event, data);
}

async function fetchRandomWord(): Promise<string> {
    const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/words`);
    if (!res.ok) throw new Error(`Failed to fetch words: ${res.status}`);
    const cards: { words: string[] }[] = (await res.json()) as any;
    const card = cards[Math.floor(Math.random() * cards.length)];
    return card.words[Math.floor(Math.random() * card.words.length)];
}

// ─── Engine ───────────────────────────────────────────────────────────────────

async function startGame(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;

    const word = await fetchRandomWord();
    const impostorIndex = Math.floor(Math.random() * g.players.length);
    g.word = word;
    g.impostorId = g.players[impostorIndex].id;

    // Ordre de parole — impostor jamais premier
    const shuffled = shuffle(g.players.map(p => p.id));
    if (shuffled[0] === g.impostorId && shuffled.length > 1) {
        const swapIdx = Math.floor(Math.random() * (shuffled.length - 1)) + 1;
        [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
    }
    g.speakingOrder = shuffled;

    console.log(`[IMPOSTOR] Room ${roomId} — mot: "${word}" — imposteur: ${g.impostorId}`);

    for (const p of g.players) {
        if (p.socketId) {
            io.to(p.socketId).emit('impostor:gameStart', {
                role: p.id === g.impostorId ? 'impostor' : 'player',
                word: p.id === g.impostorId ? null : word,
                players: g.players.map(p => ({ id: p.id, name: p.name })),
                totalRounds: g.totalRounds,
                speakingOrder: g.speakingOrder,
            });
        }
    }

    startWritingPhase(roomId);
}

function startWritingPhase(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;

    g.roundState = 'WRITING';
    g.cluesThisRound = [];
    g.currentSpeakerIndex = 0;
    g.unmaskVotes = new Set();

    emitToRoom(roomId, 'impostor:writingPhase', {
        round: g.currentRound,
        totalRounds: g.totalRounds,
        speakingOrder: g.speakingOrder,
        players: g.players.map(p => ({ id: p.id, name: p.name })),
        timePerRound: g.timePerRound,
    });

    startSpeakerTurn(roomId);
}

function startSpeakerTurn(roomId: string) {
    const g = games.get(roomId);
    if (!g || g.roundState !== 'WRITING') return;

    if (g.currentSpeakerIndex >= g.speakingOrder.length) {
        revealClues(roomId);
        return;
    }

    const currentSpeakerId = g.speakingOrder[g.currentSpeakerIndex];
    const currentSpeaker = g.players.find(p => p.id === currentSpeakerId);
    const indexAtStart = g.currentSpeakerIndex;
    const roundAtStart = g.currentRound;

    emitToRoom(roomId, 'impostor:speakerTurn', {
        speakerId: currentSpeakerId,
        speakerName: currentSpeaker?.name,
        index: g.currentSpeakerIndex,
        total: g.speakingOrder.length,
        timePerRound: g.timePerRound,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (!g || g.roundState !== 'WRITING' || g.currentSpeakerIndex !== indexAtStart || g.currentRound !== roundAtStart) return;
        // Auto-advance avec indice vide si le joueur n'a pas soumis
        if (!g.cluesThisRound.find(c => c.playerId === currentSpeakerId)) {
            g.cluesThisRound.push({ playerId: currentSpeakerId, playerName: currentSpeaker?.name ?? '', text: '' });
        }
        g.currentSpeakerIndex++;
        startSpeakerTurn(roomId);
    }, g.timePerRound * 1000);
}

function revealClues(roomId: string) {
    const g = games.get(roomId);
    if (!g || g.roundState !== 'WRITING') return;

    g.roundState = 'REVEAL';
    g.allClues.push({ round: g.currentRound, clues: [...g.cluesThisRound] });

    emitToRoom(roomId, 'impostor:cluesRevealed', {
        round: g.currentRound,
        totalRounds: g.totalRounds,
        clues: g.cluesThisRound,
        allClues: g.allClues,
        isLastRound: g.currentRound >= g.totalRounds,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (!g || g.roundState !== 'REVEAL') return;
        if (g.currentRound >= g.totalRounds) {
            startVoting(roomId);
        } else {
            g.currentRound++;
            startWritingPhase(roomId);
        }
    }, 5000);
}

function startVoting(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.roundState = 'VOTING';
    g.votes = {};

    emitToRoom(roomId, 'impostor:votingPhase', {
        round: g.currentRound,
        totalRounds: g.totalRounds,
        players: g.players.map(p => ({ id: p.id, name: p.name })),
        timePerRound: g.timePerRound,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (g?.roundState === 'VOTING') resolveVote(roomId);
    }, g.timePerRound * 1000);
}

function resolveVote(roomId: string) {
    const g = games.get(roomId);
    if (!g || g.roundState !== 'VOTING') return;

    // Compter les votes
    const count: Record<string, number> = {};
    for (const targetId of Object.values(g.votes)) {
        count[targetId] = (count[targetId] || 0) + 1;
    }

    // Trouver le plus voté
    let eliminatedId = g.players[0].id;
    let max = 0;
    for (const [id, votes] of Object.entries(count)) {
        if (votes > max) { max = votes; eliminatedId = id; }
    }

    const eliminated = g.players.find(p => p.id === eliminatedId)!;
    const isImpostor = eliminatedId === g.impostorId;
    g.impostorCaught = isImpostor;

    if (isImpostor) {
        // +1 pour tous les joueurs normaux (équipe) + +2 pour ceux qui ont voté pour l'imposteur
        for (const p of g.players) {
            if (p.id === g.impostorId) continue;
            g.scores[p.id] = (g.scores[p.id] || 0) + 1;
            if (g.votes[p.id] === eliminatedId) {
                g.scores[p.id] += 2;
            }
        }
    } else {
        // Mauvais vote → +3 pour l'imposteur + +1 pour ceux qui avaient voté pour l'imposteur
        g.scores[g.impostorId!] = (g.scores[g.impostorId!] || 0) + 3;
        for (const p of g.players) {
            if (p.id === g.impostorId) continue;
            if (g.votes[p.id] === g.impostorId) {
                g.scores[p.id] = (g.scores[p.id] || 0) + 1;
            }
        }
    }

    emitToRoom(roomId, 'impostor:eliminated', {
        eliminatedId,
        eliminatedName: eliminated.name,
        isImpostor,
        votes: count,
    });

    // Dans tous les cas → l'imposteur tente de deviner le mot
    startImpostorGuess(roomId);
}

function startImpostorGuess(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.roundState = 'IMPOSTOR_GUESS';

    const impostor = g.players.find(p => p.id === g.impostorId);

    emitToRoom(roomId, 'impostor:guessPhase', {
        impostorId: g.impostorId,
        impostorName: impostor?.name,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (g?.roundState === 'IMPOSTOR_GUESS') endGame(roomId);
    }, 30000);
}

function endGame(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.roundState = 'END';

    // Les joueurs gagnent si l'imposteur a été correctement identifié ET n'a pas deviné le mot
    const winner: 'players' | 'impostor' = (g.impostorCaught && !g.impostorGuessCorrect) ? 'players' : 'impostor';

    const impostor = g.players.find(p => p.id === g.impostorId);

    emitToRoom(roomId, 'impostor:finished', {
        winner,
        impostorId: g.impostorId,
        impostorName: impostor?.name,
        word: g.word,
        scores: g.scores,
        allClues: g.allClues,
        votes: g.votes,
        impostorGuess: g.impostorGuess,
        impostorGuessCorrect: g.impostorGuessCorrect,
        impostorCaught: g.impostorCaught,
    });

    const sorted = [...g.players].sort((a, b) => (g.scores[b.id] ?? 0) - (g.scores[a.id] ?? 0));
    saveAttempts('IMPOSTOR', roomId, sorted.map((p, i) => ({
        userId: p.id,
        score: g.scores[p.id] ?? 0,
        placement: i + 1,
        abandon: g.surrenderUserId === p.id,
    })));

    games.delete(roomId);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    socket.on('impostor:configure', ({ lobbyId, players, options }, ack) => {
        const totalRounds = Math.min(Math.max(options?.rounds ?? 1, 1), 5);
        const timePerRound = Math.min(Math.max(options?.timePerRound ?? 60, 30), 120);
        const existing = games.get(lobbyId);
        const gamePlayers: Player[] = players.map((p: any) => ({
            id: p.userId,
            name: p.username,
            socketId: existing?.players.find((ep: Player) => ep.id === p.userId)?.socketId ?? null,
            eliminated: false,
        }));
        if (existing) {
            existing.players = gamePlayers;
            existing.expectedCount = players.length;
            existing.totalRounds = totalRounds;
            existing.timePerRound = timePerRound;
        } else {
            const g = createGame(gamePlayers, totalRounds, timePerRound);
            g.expectedCount = players.length;
            games.set(lobbyId, g);
        }
        const g = games.get(lobbyId)!;
        const connected = g.players.filter((p: Player) => p.socketId !== null).length;
        if (!g.started && g.expectedCount > 0 && connected >= g.expectedCount) {
            g.started = true;
            setTimeout(() => startGame(lobbyId), 500);
        }
        if (typeof ack === 'function') ack();
    });

    socket.on('impostor:join', ({ lobbyId, userId, playerName }) => {
        if (!lobbyId || !userId) return;
        socket.join(lobbyId);
        socket.data = { lobbyId, userId };

        if (!games.has(lobbyId)) {
            socket.emit('notFound');
            return;
        }

        const g = games.get(lobbyId)!;
        const existing = g.players.find(p => p.id === userId);
        if (existing) {
            existing.socketId = socket.id;
        } else if (!g.started) {
            g.players.push({ id: userId, name: playerName, socketId: socket.id, eliminated: false });
            g.scores[userId] = 0;
        }
        // Si g.started && !existing : spectateur — rejoint la room mais n'est pas joueur

        emitToRoom(lobbyId, 'impostor:players', {
            players: g.players.map(p => ({ id: p.id, name: p.name })),
        });

        // Reconnexion en cours de partie — renvoyer l'état courant
        if (existing && g.started && g.roundState !== 'WAITING') {
            const role = userId === g.impostorId ? 'impostor' : 'player';
            socket.emit('impostor:gameStart', {
                role,
                word: role === 'impostor' ? null : g.word,
                players: g.players.map(p => ({ id: p.id, name: p.name })),
                totalRounds: g.totalRounds,
                speakingOrder: g.speakingOrder,
            });
            if (g.roundState === 'WRITING') {
                socket.emit('impostor:writingPhase', {
                    round: g.currentRound,
                    totalRounds: g.totalRounds,
                    speakingOrder: g.speakingOrder,
                    players: g.players.map(p => ({ id: p.id, name: p.name })),
                    timePerRound: g.timePerRound,
                });
                for (let i = 0; i < g.cluesThisRound.length; i++) {
                    const clue = g.cluesThisRound[i];
                    socket.emit('impostor:clueSubmitted', {
                        playerId: clue.playerId, playerName: clue.playerName,
                        text: clue.text, submittedCount: i + 1, total: g.speakingOrder.length,
                    });
                }
                const currentSpeakerId = g.speakingOrder[g.currentSpeakerIndex];
                socket.emit('impostor:speakerTurn', {
                    speakerId: currentSpeakerId,
                    speakerName: g.players.find(p => p.id === currentSpeakerId)?.name,
                    index: g.currentSpeakerIndex,
                    total: g.speakingOrder.length,
                    timePerRound: g.timePerRound,
                });
            } else if (g.roundState === 'REVEAL') {
                socket.emit('impostor:cluesRevealed', {
                    round: g.currentRound, totalRounds: g.totalRounds,
                    clues: g.cluesThisRound, allClues: g.allClues,
                    isLastRound: g.currentRound >= g.totalRounds,
                });
            } else if (g.roundState === 'VOTING') {
                socket.emit('impostor:votingPhase', {
                    players: g.players.map(p => ({ id: p.id, name: p.name })),
                    round: g.currentRound, timePerRound: g.timePerRound,
                });
            } else if (g.roundState === 'IMPOSTOR_GUESS') {
                socket.emit('impostor:guessPhase', {
                    impostorId: g.impostorId,
                    impostorName: g.players.find(p => p.id === g.impostorId)?.name ?? '',
                });
            } else if (g.roundState === 'END') {
                socket.emit('impostor:finished', {
                    winner: g.impostorCaught ? 'players' : 'impostor',
                    impostorId: g.impostorId,
                    impostorName: g.players.find(p => p.id === g.impostorId)?.name ?? '',
                    word: g.word, scores: g.scores, votes: g.votes,
                    impostorCaught: g.impostorCaught, impostorGuess: g.impostorGuess,
                    impostorGuessCorrect: g.impostorGuessCorrect, allClues: g.allClues,
                });
            }
        }

        const connected = g.players.filter(p => p.socketId !== null).length;
        if (!g.started && g.expectedCount > 0 && connected >= g.expectedCount) {
            g.started = true;
            setTimeout(() => startGame(lobbyId), 500);
        }
    });

    // Joueur écrit son indice
    socket.on('impostor:submitClue', ({ lobbyId, text }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'WRITING' || !userId) return;
        if (g.speakingOrder[g.currentSpeakerIndex] !== userId) return;
        if (g.cluesThisRound.find(c => c.playerId === userId)) return;

        const player = g.players.find(p => p.id === userId);
        g.cluesThisRound.push({ playerId: userId, playerName: player?.name ?? '', text: text.trim() });

        emitToRoom(lobbyId, 'impostor:clueSubmitted', {
            playerId: userId,
            playerName: player?.name ?? '',
            text: text.trim(),
            submittedCount: g.cluesThisRound.length,
            total: g.speakingOrder.length,
        });

        g.currentSpeakerIndex++;
        startSpeakerTurn(lobbyId);
    });

    // Demande de démasquage
    socket.on('impostor:requestUnmask', ({ lobbyId }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'WRITING' || !userId) return;
        if (!g.players.find(p => p.id === userId)) return;

        g.unmaskVotes.add(userId);
        const total = g.players.length;
        const threshold = Math.floor(total / 2) + 1;

        emitToRoom(lobbyId, 'impostor:unmaskVoteUpdate', {
            count: g.unmaskVotes.size,
            threshold,
            voters: Array.from(g.unmaskVotes),
        });

        if (g.unmaskVotes.size >= threshold) {
            // Majorité atteinte → passer directement au vote
            g.currentSpeakerIndex = g.speakingOrder.length;
            for (const pid of g.speakingOrder) {
                if (!g.cluesThisRound.find(c => c.playerId === pid)) {
                    const p = g.players.find(pl => pl.id === pid);
                    g.cluesThisRound.push({ playerId: pid, playerName: p?.name ?? '', text: '' });
                }
            }
            g.allClues.push({ round: g.currentRound, clues: [...g.cluesThisRound] });
            startVoting(lobbyId);
        }
    });

    // Vote
    socket.on('impostor:vote', ({ lobbyId, targetId }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'VOTING' || !userId) return;
        if (!g.players.find(p => p.id === userId)) return;
        g.votes[userId] = targetId;

        emitToRoom(lobbyId, 'impostor:voteUpdate', {
            votedCount: Object.keys(g.votes).length,
            total: g.players.length,
        });

        if (Object.keys(g.votes).length >= g.players.length) {
            resolveVote(lobbyId);
        }
    });

    // Imposteur devine le mot
    socket.on('impostor:guessWord', ({ lobbyId, guess }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'IMPOSTOR_GUESS' || !userId) return;
        if (userId !== g.impostorId) return;

        const normalize = (s: string) => s.trim().normalize('NFC').toLowerCase();
        const correct = normalize(guess) === normalize(g.word ?? '');
        g.impostorGuess = guess.trim();
        g.impostorGuessCorrect = correct;
        if (correct) {
            g.scores[g.impostorId] = (g.scores[g.impostorId] || 0) + 2;
        }

        emitToRoom(lobbyId, 'impostor:wordGuessResult', {
            guess,
            correct,
            word: g.word,
        });

        setTimeout(() => endGame(lobbyId), 2000);
    });

    socket.on('impostor:surrender', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId) return;
        const g = games.get(lobbyId);
        if (g) g.surrenderUserId = userId;
        endGame(lobbyId);
    });

    socket.on('disconnect', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId || !userId) return;
        const g = games.get(lobbyId);
        if (!g) return;
        const p = g.players.find(p => p.id === userId);
        if (p) p.socketId = null;
    });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, () => console.log('[IMPOSTOR] realtime listening on', PORT));
