import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import { setupSocketAuth, corsConfig, connectToLobby } from '@kwizar/shared';

import type { Player } from './types';
import { games, createGame } from './game';
import {
    initRoom, startGame,
    startWritingPhase, startVoting, resolveVote,
    startImpostorGuess, endGame,
} from './room';

dotenv.config();

// ─── HTTP ─────────────────────────────────────────────────────────────────────

const app = express();
app.get('/health', (_req, res) => { res.set('Access-Control-Allow-Origin', '*'); res.status(200).send('ok'); });

const server = http.createServer(app);
const io = new Server(server, { cors: corsConfig, maxHttpBufferSize: 1e5 });

initRoom(io);

setupSocketAuth(io, new TextEncoder().encode(process.env.INTERNAL_API_KEY!));

const lobbySocket = connectToLobby('impostor-server', 'impostor');

lobbySocket.on('impostor:configure', ({ lobbyId, players, options }: any, ack?: () => void) => {
        const totalRounds = Math.min(Math.max(parseInt(options?.rounds ?? '1', 10) || 1, 1), 5);
        const timePerRound = Math.min(Math.max(parseInt(options?.timePerRound ?? '60', 10) || 60, 30), 120);

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

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on('connection', (socket) => {

    // ── Join / reconnect ──────────────────────────────────────────────────────
    socket.on('impostor:join', ({ lobbyId, playerName }) => {
        const { userId } = socket.data;
        if (!lobbyId || !userId) return;
        socket.join(lobbyId);
        socket.data.lobbyId = lobbyId;

        if (!games.has(lobbyId)) { socket.emit('notFound'); return; }

        const g = games.get(lobbyId)!;
        const existing = g.players.find(p => p.id === userId);

        if (existing) {
            existing.socketId = socket.id;
        } else if (!g.started) {
            g.players.push({ id: userId, name: playerName, socketId: socket.id, eliminated: false });
            g.scores[userId] = 0;
        }

        io.to(lobbyId).emit('impostor:players', {
            players: g.players.map(p => ({ id: p.id, name: p.name })),
        });

        // Reconnection mid-game — resync state
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
                    round: g.currentRound, totalRounds: g.totalRounds,
                    speakingOrder: g.speakingOrder,
                    players: g.players.map(p => ({ id: p.id, name: p.name })),
                    timePerRound: g.timePerRound,
                });
                g.cluesThisRound.forEach((clue, i) => {
                    socket.emit('impostor:clueSubmitted', {
                        playerId: clue.playerId, playerName: clue.playerName,
                        text: clue.text, submittedCount: i + 1, total: g.speakingOrder.length,
                    });
                });
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

    // ── Submit clue ───────────────────────────────────────────────────────────
    socket.on('impostor:submitClue', ({ lobbyId, text }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'WRITING' || !userId) return;
        if (g.speakingOrder[g.currentSpeakerIndex] !== userId) return;
        if (g.cluesThisRound.find(c => c.playerId === userId)) return;

        const safeText = typeof text === 'string' ? text.trim().slice(0, 300) : '';

        const player = g.players.find(p => p.id === userId);
        g.cluesThisRound.push({ playerId: userId, playerName: player?.name ?? '', text: safeText });

        io.to(lobbyId).emit('impostor:clueSubmitted', {
            playerId: userId,
            playerName: player?.name ?? '',
            text: safeText,
            submittedCount: g.cluesThisRound.length,
            total: g.speakingOrder.length,
        });

        g.currentSpeakerIndex++;
        // imported from room.ts — re-exported for internal use
        const { startSpeakerTurn } = require('./room');
        startSpeakerTurn(lobbyId);
    });

    // ── Request unmask ────────────────────────────────────────────────────────
    socket.on('impostor:requestUnmask', ({ lobbyId }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'WRITING' || !userId) return;
        if (!g.players.find(p => p.id === userId)) return;

        g.unmaskVotes.add(userId);
        const threshold = Math.floor(g.players.length / 2) + 1;

        io.to(lobbyId).emit('impostor:unmaskVoteUpdate', {
            count: g.unmaskVotes.size,
            threshold,
            voters: Array.from(g.unmaskVotes),
        });

        if (g.unmaskVotes.size >= threshold) {
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

    // ── Vote ──────────────────────────────────────────────────────────────────
    socket.on('impostor:vote', ({ lobbyId, targetId }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'VOTING' || !userId) return;
        if (!g.players.find(p => p.id === userId)) return;

        g.votes[userId] = targetId;
        io.to(lobbyId).emit('impostor:voteUpdate', {
            votedCount: Object.keys(g.votes).length,
            total: g.players.length,
        });

        if (Object.keys(g.votes).length >= g.players.length) resolveVote(lobbyId);
    });

    // ── Impostor guess ────────────────────────────────────────────────────────
    socket.on('impostor:guessWord', ({ lobbyId, guess }) => {
        const { userId } = socket.data || {};
        const g = games.get(lobbyId);
        if (!g || g.roundState !== 'IMPOSTOR_GUESS' || !userId) return;
        if (userId !== g.impostorId) return;

        const normalize = (s: string) => s.trim().normalize('NFC').toLowerCase();
        const correct = normalize(guess) === normalize(g.word ?? '');
        g.impostorGuess = guess.trim();
        g.impostorGuessCorrect = correct;
        if (correct) g.scores[g.impostorId] = (g.scores[g.impostorId] || 0) + 2;

        io.to(lobbyId).emit('impostor:wordGuessResult', { guess, correct, word: g.word });
        setTimeout(() => endGame(lobbyId), 2000);
    });

    // ── Surrender ─────────────────────────────────────────────────────────────
    socket.on('impostor:surrender', () => {
        const { lobbyId, userId } = socket.data || {};
        if (!lobbyId) return;
        const g = games.get(lobbyId);
        if (g) g.surrenderUserId = userId;
        endGame(lobbyId);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────
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

const PORT = process.env.PORT || 10010;
server.listen(PORT, () => console.log('[IMPOSTOR] realtime listening on', PORT));

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
