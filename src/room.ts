import { Server } from 'socket.io';
import type { Clue, Player } from './types';
import { games, shuffle, fetchRandomWord, saveAttempts } from './game';

let _io: Server;

export function initRoom(io: Server) {
    _io = io;
}

function emitToRoom(roomId: string, event: string, data: any) {
    _io.to(roomId).emit(event, data);
}

// ─── Game start ───────────────────────────────────────────────────────────────

export async function startGame(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.currentGameId = require('crypto').randomUUID();

    const word = await fetchRandomWord();
    const impostorIndex = Math.floor(Math.random() * g.players.length);
    g.word = word;
    g.impostorId = g.players[impostorIndex].id;

    // Speaking order — impostor never first
    const shuffled = shuffle(g.players.map(p => p.id));
    if (shuffled[0] === g.impostorId && shuffled.length > 1) {
        const swapIdx = Math.floor(Math.random() * (shuffled.length - 1)) + 1;
        [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
    }
    g.speakingOrder = shuffled;

    console.log(`[IMPOSTOR] Room ${roomId} — mot: "${word}" — imposteur: ${g.impostorId}`);

    for (const p of g.players) {
        if (p.socketId) {
            _io.to(p.socketId).emit('impostor:gameStart', {
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

// ─── Writing phase ────────────────────────────────────────────────────────────

export function startWritingPhase(roomId: string) {
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

export function startSpeakerTurn(roomId: string) {
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
        if (!g.cluesThisRound.find(c => c.playerId === currentSpeakerId)) {
            g.cluesThisRound.push({ playerId: currentSpeakerId, playerName: currentSpeaker?.name ?? '', text: '' });
        }
        g.currentSpeakerIndex++;
        startSpeakerTurn(roomId);
    }, g.timePerRound * 1000);
}

// ─── Reveal ───────────────────────────────────────────────────────────────────

export function revealClues(roomId: string) {
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

// ─── Voting ───────────────────────────────────────────────────────────────────

export function startVoting(roomId: string) {
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

export function resolveVote(roomId: string) {
    const g = games.get(roomId);
    if (!g || g.roundState !== 'VOTING') return;

    const count: Record<string, number> = {};
    for (const targetId of Object.values(g.votes)) {
        count[targetId] = (count[targetId] || 0) + 1;
    }

    let eliminatedId = g.players[0].id;
    let max = 0;
    for (const [id, votes] of Object.entries(count)) {
        if (votes > max) { max = votes; eliminatedId = id; }
    }

    const eliminated = g.players.find(p => p.id === eliminatedId)!;
    const isImpostor = eliminatedId === g.impostorId;
    g.impostorCaught = isImpostor;

    if (isImpostor) {
        for (const p of g.players) {
            if (p.id === g.impostorId) continue;
            g.scores[p.id] = (g.scores[p.id] || 0) + 1;
            if (g.votes[p.id] === eliminatedId) g.scores[p.id] += 2;
        }
    } else {
        g.scores[g.impostorId!] = (g.scores[g.impostorId!] || 0) + 3;
        for (const p of g.players) {
            if (p.id === g.impostorId) continue;
            if (g.votes[p.id] === g.impostorId) g.scores[p.id] = (g.scores[p.id] || 0) + 1;
        }
    }

    emitToRoom(roomId, 'impostor:eliminated', {
        eliminatedId,
        eliminatedName: eliminated.name,
        isImpostor,
        votes: count,
    });

    startImpostorGuess(roomId);
}

// ─── Impostor guess ───────────────────────────────────────────────────────────

export function startImpostorGuess(roomId: string) {
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

// ─── End ──────────────────────────────────────────────────────────────────────

export function endGame(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.roundState = 'END';

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
    saveAttempts('IMPOSTOR', g.currentGameId ?? roomId, sorted.map((p, i) => ({
        userId: p.id,
        score: g.scores[p.id] ?? 0,
        placement: i + 1,
        abandon: g.surrenderUserId === p.id,
    })));

    games.delete(roomId);
}
