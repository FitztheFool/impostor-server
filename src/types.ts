export interface Player {
    id: string;
    name: string;
    socketId: string | null;
    eliminated: boolean;
}

export interface Clue {
    playerId: string;
    playerName: string;
    text: string;
}

export interface Game {
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
    currentGameId: string | null;
}
