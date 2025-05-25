// Type definitions for SilverBullet MCP Server

export interface SBFile {
    name: string;
    lastModified: number;
    contentType: string;
    size: number;
    perm: 'ro' | 'rw';
}

export interface SearchMatch {
    type: 'title' | 'content';
    line: number;
    content: string;
    matchCount: number;
    context?: string;
    startLine?: number;
    endLine?: number;
}

export interface SearchResult {
    filename: string;
    permission: 'ro' | 'rw';
    matches: SearchMatch[];
    score: number;
}

export interface CacheEntry {
    content: string;
    lastModified: number;
}

export interface NoteInfo {
    name: string;
    perm: 'ro' | 'rw';
}