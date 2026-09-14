/**
 * Append-only original-message archive.
 *
 * Before a range of messages is replaced by a summary, the original messages
 * are written to an append-only store. `/restore` reads the last snapshot back
 * so a bad compaction is never fatal.
 *
 * The store defaults to `$DSH_DATA_DIR/archive/compaction.log` and can be
 * pointed anywhere via config.archiveDir.
 *
 * @module dsh-compactor/store
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type { HarnessMessage } from './types.js'

export interface ArchiveEntry {
 /** Monotonic archive id. */
  id: string
  sessionId: string
 /** Absolute indices into the session message list (inclusive). */
  startIdx: number
  endIdx: number
  reason: string
 /** Original messages that were replaced. */
  messages: HarnessMessage[]
 /** Token count of the replaced span before compression. */
  tokensBefore: number
  createdAt: string
}

/** Resolve the default archive directory from the environment. */
export function defaultArchiveDir(): string {
  return process.env.DSH_DATA_DIR
    ? path.join(process.env.DSH_DATA_DIR, 'archive')
    : path.join(process.cwd(), '.dsh-compactor-archive')
}

/** Append-only store backed by a JSON Lines file. */
export class ArchiveStore {
  readonly file: string
  private entries: ArchiveEntry[] = []

  constructor(dir?: string, sessionId = 'global') {
    const base = dir ?? defaultArchiveDir()
    this.file = path.join(base, `compaction.${sessionId}.log`)
  }

 /** Ensure the archive directory exists. */
  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
  }

 /** Append one entry to the JSONL file and keep an in-memory index. */
  append(entry: Omit<ArchiveEntry, 'id' | 'createdAt'>): ArchiveEntry {
    this.ensureDir()
    const full: ArchiveEntry = {
      ...entry,
      id: `${Date.now()}-${this.entries.length + 1}`,
      createdAt: new Date().toISOString(),
    }
    this.entries.push(full)
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n', 'utf8')
    return full
  }

 /** Read all entries from disk (rebuilds the in-memory index). */
  load(): ArchiveEntry[] {
    this.ensureDir()
    if (!fs.existsSync(this.file)) return []
    const text = fs.readFileSync(this.file, 'utf8')
    const loaded: ArchiveEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        loaded.push(JSON.parse(line) as ArchiveEntry)
      } catch {
 // skip corrupted lines — append-only keeps the rest intact
      }
    }
    this.entries = loaded
    return loaded
  }

 /** Return the most recent entry for a session (used by `/restore`). */
  latest(sessionId: string): ArchiveEntry | null {
    const entries = this.load()
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].sessionId === sessionId) return entries[i]
    }
    return null
  }

 /** Return the entry with a specific id, or null. */
  get(id: string): ArchiveEntry | null {
    const entries = this.load()
    return entries.find((e) => e.id === id) ?? null
  }

 /** Total number of archived entries. */
  get size(): number {
    return this.load().length
  }
}
