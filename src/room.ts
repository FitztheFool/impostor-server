import { Server } from 'socket.io';
import type { Clue, Player } from './types';
import { games, fetchRandomWord, fetchRelatedWord, saveAttempts } from './game';
import { shuffle, emitToSpectators } from '@kwizar/shared';
import { pushLog, type LogTone } from './gameLog';

let _io: Server;

export function initRoom(io: Server) {
    _io = io;
}

function emitToRoom(roomId: string, event: string, data: any) {
    _io.to(roomId).emit(event, data);
}

/** Push a journal entry and broadcast the updated log to the room. */
export function logEvent(roomId: string, tone: LogTone, text: string) {
    const g = games.get(roomId);
    if (!g) return;
    pushLog(g, tone, text);
    _io.to(roomId).emit('impostor:log', { log: g.log.slice(-100) });
}

// ─── Game start ───────────────────────────────────────────────────────────────

export async function startGame(roomId: string) {
    const g = games.get(roomId);
    if (!g) return;
    g.currentGameId = require('crypto').randomUUID();

    const { word, groupId } = await fetchRandomWord();
    const impostorIndex = Math.floor(Math.random() * g.players.length);
    g.word = word;
    g.wordGroupId = groupId;
    g.impostorId = g.players[impostorIndex].id;

    // Assign Mr White (if enabled) — different player from impostor
    if (g.misterWhiteEnabled && g.players.length >= 3 && groupId) {
        const nonImpostors = g.players.filter(p => p.id !== g.impostorId);
        const mrWhitePlayer = nonImpostors[Math.floor(Math.random() * nonImpostors.length)];
        g.misterWhiteId = mrWhitePlayer.id;
        g.misterWhiteWord = await fetchRelatedWord(groupId, word);
        // Fallback: if group has no other word, disable Mr White for this game
        if (!g.misterWhiteWord) g.misterWhiteId = null;
    }

    // Speaking order — impostor never first
    const shuffled = shuffle(g.players.map(p => p.id));
    if (shuffled[0] === g.impostorId && shuffled.length > 1) {
        const swapIdx = Math.floor(Math.random() * (shuffled.length - 1)) + 1;
        [shuffled[0], shuffled[swapIdx]] = [shuffled[swapIdx], shuffled[0]];
    }
    g.speakingOrder = shuffled;

    console.log(`[IMPOSTOR] Room ${roomId} — mot: "${word}" — imposteur: ${g.impostorId}${g.misterWhiteId ? ` — Mr White: ${g.misterWhiteId} (${g.misterWhiteWord})` : ''}`);

    for (const p of g.players) {
        if (p.socketId) {
            const isMrWhite = p.id === g.misterWhiteId;
            const isImpostor = p.id === g.impostorId;
            _io.to(p.socketId).emit('impostor:gameStart', {
                role: isImpostor ? 'impostor' : 'player',
                word: isImpostor ? null : isMrWhite ? g.misterWhiteWord : word,
                misterWhiteEnabled: !!g.misterWhiteId,
                players: g.players.map(p => ({ id: p.id, name: p.name })),
                totalRounds: g.totalRounds,
                speakingOrder: g.speakingOrder,
            });
        }
    }

    // Spectateurs : vue PUBLIQUE seulement (ni mot, ni identité de l'imposteur).
    emitToSpectators(_io, roomId, uid => g.players.some(p => p.id === uid), 'impostor:gameStart', {
        role: 'spectator', word: null, misterWhiteEnabled: !!g.misterWhiteId,
        players: g.players.map(p => ({ id: p.id, name: p.name })),
        totalRounds: g.totalRounds, speakingOrder: g.speakingOrder,
    });

    logEvent(roomId, 'system', `La partie commence — ${g.players.length} joueurs, démasquez l'imposteur`);
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

    logEvent(roomId, 'turn', `Manche ${g.currentRound}/${g.totalRounds} — phase d'indices`);
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
    g.mrWhiteVotes = {};

    emitToRoom(roomId, 'impostor:votingPhase', {
        round: g.currentRound,
        totalRounds: g.totalRounds,
        players: g.players.map(p => ({ id: p.id, name: p.name })),
        timePerRound: g.timePerRound,
        misterWhiteEnabled: !!g.misterWhiteId,
    });

    setTimeout(() => {
        const g = games.get(roomId);
        if (g?.roundState === 'VOTING') resolveVote(roomId);
    }, g.timePerRound * 1000);
}

export function resolveVote(roomId: string) {
    const g = games.get(roomId);
    if (!g || g.roundState !== 'VOTING') return;

    // Resolve impostor vote
    const count: Record<string, number> = {};
    for (const targetId of Object.values(g.votes)) {
        count[targetId] = (count[targetId] || 0) + 1;
    }
    let eliminatedId = g.players[0].id;
    let max = 0;
    for (const [id, votes] of Object.entries(count)) {
        if (votes > max) { max = votes; eliminatedId = id; }
    }
    const isImpostor = eliminatedId === g.impostorId;
    g.impostorCaught = isImpostor;

    // Resolve Mr White vote
    let mrWhiteEliminatedId: string | null = null;
    const mrWhiteCount: Record<string, number> = {};
    if (g.misterWhiteId) {
        for (const targetId of Object.values(g.mrWhiteVotes)) {
            mrWhiteCount[targetId] = (mrWhiteCount[targetId] || 0) + 1;
        }
        let mrWhiteMax = 0;
        for (const [id, votes] of Object.entries(mrWhiteCount)) {
            if (votes > mrWhiteMax) { mrWhiteMax = votes; mrWhiteEliminatedId = id; }
        }
        g.mrWhiteCaught = mrWhiteEliminatedId === g.misterWhiteId;
    }

    // Scoring
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
    if (g.misterWhiteId) {
        if (g.mrWhiteCaught) {
            // Players who correctly identified Mr White get +1
            for (const p of g.players) {
                if (p.id === g.impostorId || p.id === g.misterWhiteId) continue;
                if (g.mrWhiteVotes[p.id] === g.misterWhiteId) g.scores[p.id] = (g.scores[p.id] || 0) + 1;
            }
        } else {
            // Mr White successfully blended in: +2
            g.scores[g.misterWhiteId] = (g.scores[g.misterWhiteId] || 0) + 2;
        }
    }

    const eliminated = g.players.find(p => p.id === eliminatedId)!;
    const mrWhiteEliminated = mrWhiteEliminatedId ? g.players.find(p => p.id === mrWhiteEliminatedId) : null;

    emitToRoom(roomId, 'impostor:eliminated', {
        eliminatedId,
        eliminatedName: eliminated.name,
        isImpostor,
        votes: count,
        mrWhiteEliminatedId,
        mrWhiteEliminatedName: mrWhiteEliminated?.name ?? null,
        mrWhiteCaught: g.mrWhiteCaught,
        mrWhiteVotes: mrWhiteCount,
    });

    logEvent(roomId, isImpostor ? 'coup' : 'attack',
        `${eliminated.name} est éliminé — ${isImpostor ? "c'était l'imposteur !" : "innocent !"}`);
    if (mrWhiteEliminated) {
        logEvent(roomId, g.mrWhiteCaught ? 'coup' : 'system',
            `${mrWhiteEliminated.name} accusé d'être Mr White — ${g.mrWhiteCaught ? 'démasqué !' : 'à tort'}`);
    }

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

    // An abandon makes the quitter's side lose: the impostor leaving hands the
    // win to the players; any other player leaving hands it to the impostor.
    let winner: 'players' | 'impostor';
    if (g.surrenderUserId) {
        winner = g.surrenderUserId === g.impostorId ? 'players' : 'impostor';
    } else {
        winner = (g.impostorCaught && !g.impostorGuessCorrect) ? 'players' : 'impostor';
    }
    const impostor = g.players.find(p => p.id === g.impostorId);
    const mrWhite = g.misterWhiteId ? g.players.find(p => p.id === g.misterWhiteId) : null;

    logEvent(roomId, 'coup', `${winner === 'players' ? 'Les joueurs gagnent' : "L'imposteur gagne"} ! Imposteur : ${impostor?.name ?? '?'}, mot : « ${g.word ?? '?'} »`);

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
        misterWhiteEnabled: g.misterWhiteEnabled,
        misterWhiteId: g.misterWhiteId,
        misterWhiteName: mrWhite?.name ?? null,
        misterWhiteWord: g.misterWhiteWord,
        mrWhiteCaught: g.mrWhiteCaught,
    });

    const isAbandon = (id: string) => g.surrenderUserId === id;
    const finishers = g.players.filter(p => !isAbandon(p.id));
    const sortedFinishers = [...finishers].sort((a, b) => (g.scores[b.id] ?? 0) - (g.scores[a.id] ?? 0));
    saveAttempts('IMPOSTOR', g.currentGameId ?? roomId, g.players.map(p => {
        const abandon = isAbandon(p.id);
        return {
            userId: p.id,
            score: g.scores[p.id] ?? 0,
            placement: abandon ? null : sortedFinishers.findIndex(x => x.id === p.id) + 1,
            abandon,
        };
    })).then(elo => { if (elo.length) emitToRoom(roomId, 'elo:update', { gameType: 'IMPOSTOR', elo }); });

    games.delete(roomId);
}
