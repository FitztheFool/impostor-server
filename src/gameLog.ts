export type LogTone = 'move' | 'attack' | 'defend' | 'safety' | 'coup' | 'system' | 'score' | 'turn';

export interface GameLogEntry {
    id: number;
    tone: LogTone;
    text: string;
}

export interface LogHost {
    log: GameLogEntry[];
    logSeq?: number;
}

/** Append an entry to a game's action journal, capping its length. */
export function pushLog(host: LogHost, tone: LogTone, text: string, max = 200): void {
    host.logSeq = (host.logSeq ?? 0) + 1;
    host.log.push({ id: host.logSeq, tone, text });
    if (host.log.length > max) host.log.splice(0, host.log.length - max);
}
