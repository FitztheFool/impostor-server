// impostor-server/src/index.ts
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.get('/health', (_req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

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

    emitToRoom(roomId, 'impostor:speakerTurn', {
        speakerId: currentSpeakerId,
        speakerName: currentSpeaker?.name,
        index: g.currentSpeakerIndex,
        total: g.speakingOrder.length,
        timePerRound: g.timePerRound,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (!g || g.roundState !== 'WRITING' || g.currentSpeakerIndex !== indexAtStart) return;
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

    if (isImpostor) {
        // Joueurs normaux: +2 chacun, +1 si a voté pour l'imposteur
        for (const p of g.players) {
            if (p.id === g.impostorId) continue;
            g.scores[p.id] = (g.scores[p.id] || 0) + 2;
            if (g.votes[p.id] === eliminatedId) {
                g.scores[p.id] += 1;
            }
        }

        emitToRoom(roomId, 'impostor:eliminated', {
            eliminatedId,
            eliminatedName: eliminated.name,
            isImpostor: true,
            votes: count,
        });

        startImpostorGuess(roomId);
    } else {
        // Innocent éliminé → imposteur gagne
        g.scores[g.impostorId!] = (g.scores[g.impostorId!] || 0) + 3;

        emitToRoom(roomId, 'impostor:eliminated', {
            eliminatedId,
            eliminatedName: eliminated.name,
            isImpostor: false,
            votes: count,
        });

        endGame(roomId, 'impostor');
    }
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
        if (g?.roundState === 'IMPOSTOR_GUESS') endGame(roomId, 'players');
    }, 30000);
}

function endGame(roomId: string, winner: 'players' | 'impostor') {
    const g = games.get(roomId);
    if (!g) return;
    g.roundState = 'END';

    const impostor = g.players.find(p => p.id === g.impostorId);

    emitToRoom(roomId, 'impostor:gameEnd', {
        winner,
        impostorId: g.impostorId,
        impostorName: impostor?.name,
        word: g.word,
        scores: g.scores,
        allClues: g.allClues,
    });

    games.delete(roomId);
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    socket.on('impostor:configure', ({ lobbyId, players, options }) => {
        const totalRounds = Math.min(Math.max(options?.rounds ?? 1, 1), 5);
        const timePerRound = Math.min(Math.max(options?.timePerRound ?? 60, 30), 120);
        const gamePlayers: Player[] = players.map((p: any) => ({
            id: p.userId,
            name: p.username,
            socketId: null,
            eliminated: false,
        }));
        const g = createGame(gamePlayers, totalRounds, timePerRound);
        g.expectedCount = players.length;
        games.set(lobbyId, g);
    });

    socket.on('impostor:join', ({ lobbyId, userId, playerName }) => {
        if (!lobbyId || !userId) return;
        socket.join(lobbyId);
        socket.data = { lobbyId, userId };

        if (!games.has(lobbyId)) {
            const g = createGame([], 1, 60);
            g.expectedCount = 0;
            games.set(lobbyId, g);
        }

        const g = games.get(lobbyId)!;
        const existing = g.players.find(p => p.id === userId);
        if (existing) {
            existing.socketId = socket.id;
        } else {
            g.players.push({ id: userId, name: playerName, socketId: socket.id, eliminated: false });
            g.scores[userId] = 0;
        }

        emitToRoom(lobbyId, 'impostor:players', {
            players: g.players.map(p => ({ id: p.id, name: p.name })),
        });

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

        g.unmaskVotes.add(userId);
        const total = g.players.length;
        const threshold = Math.floor(total / 2) + 1;

        emitToRoom(lobbyId, 'impostor:unmaskVoteUpdate', {
            count: g.unmaskVotes.size,
            threshold,
            voters: Array.from(g.unmaskVotes),
        });

        if (g.unmaskVotes.size >= threshold) {
            // Forcer la fin du round en cours et passer au vote
            g.currentSpeakerIndex = g.speakingOrder.length;
            // Ajouter des indices vides pour les joueurs qui n'ont pas encore soumis
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

        const correct = guess.trim().toLowerCase() === g.word?.toLowerCase();
        if (correct) {
            g.scores[g.impostorId] = (g.scores[g.impostorId] || 0) + 2;
        }

        emitToRoom(lobbyId, 'impostor:wordGuessResult', {
            guess,
            correct,
            word: g.word,
        });

        setTimeout(() => endGame(lobbyId, 'players'), 2000);
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
