import { randomUUID } from 'crypto';
import type { Game, Player } from './types';

// ─── State ────────────────────────────────────────────────────────────────────

export const games = new Map<string, Game>();

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGame(players: Player[], totalRounds: number, timePerRound: number): Game {
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
        currentGameId: null,
    };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

export function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

export async function fetchRandomWord(): Promise<string> {
    const baseUrl = process.env.FRONTEND_URL ?? 'http://localhost:3000';
    const res = await fetch(`${baseUrl}/api/words`);
    if (!res.ok) throw new Error(`Failed to fetch words: ${res.status}`);
    const cards: { words: string[] }[] = (await res.json()) as any;
    const card = cards[Math.floor(Math.random() * cards.length)];
    return card.words[Math.floor(Math.random() * card.words.length)];
}

export async function saveAttempts(
    gameType: string,
    gameId: string,
    scores: { userId: string; score: number; placement?: number; abandon?: boolean }[],
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
        console.log(`[${gameType}] scores saved for ${gameId}`);
    } catch (err) {
        console.error(`[${gameType}] saveAttempts error:`, err);
    }
}
