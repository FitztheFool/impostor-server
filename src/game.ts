import { randomUUID } from 'crypto';
import type { Game, Player } from './types';

// ─── State ────────────────────────────────────────────────────────────────────

export const games = new Map<string, Game>();

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGame(players: Player[], totalRounds: number, timePerRound: number, misterWhiteEnabled = false): Game {
    const scores: Record<string, number> = {};
    for (const p of players) scores[p.id] = 0;
    return {
        players,
        scores,
        expectedCount: 0,
        started: false,
        word: null,
        wordGroupId: null,
        impostorId: null,
        misterWhiteEnabled,
        misterWhiteId: null,
        misterWhiteWord: null,
        mrWhiteCaught: false,
        mrWhiteVotes: {},
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
        currentGameId: null,
        disconnectTimers: new Map(),
        log: [],
        logSeq: 0,
    };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

export async function fetchRandomWord(): Promise<{ word: string; groupId: string | null }> {
    const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/words`);
    if (!res.ok) throw new Error(`Failed to fetch words: ${res.status}`);
    const cards: { id?: string; words: string[] }[] = (await res.json()) as any;
    const card = cards[Math.floor(Math.random() * cards.length)];
    const word = card.words[Math.floor(Math.random() * card.words.length)];
    return { word, groupId: card.id ?? null };
}

export async function fetchRelatedWord(groupId: string, exclude: string): Promise<string | null> {
    const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/words/related?groupId=${encodeURIComponent(groupId)}&exclude=${encodeURIComponent(exclude)}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { word: string | null };
    return data.word ?? null;
}

export async function saveAttempts(
    gameType: string,
    gameId: string,
    scores: { userId: string; score: number; placement?: number | null; abandon?: boolean }[],
) {
    const frontendUrl = process.env.FRONTEND_URL;
    const secret = process.env.INTERNAL_API_KEY;
    if (!frontendUrl || !secret) return;
    try {
        const res = await fetch(`${frontendUrl}/api/attempts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ gameType, gameId, scores }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        console.log(`[${gameType.toUpperCase()}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType.toUpperCase()}] saveAttempts error:`, err);
    }
}
