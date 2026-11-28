import type { AISettings } from '../types';
import { requestDigestJson } from './generate';
import { bookDigestId, parseBookDigestPayload, type BookDigest, type VolumeDigest } from './types';

export interface BookDigestRequest {
  bookHash: string;
  bookTitle: string;
  authorName?: string;
  volumes: VolumeDigest[];
  settings: AISettings;
  model: string;
  signal?: AbortSignal;
}

const SCHEMA = `{
  "logline": "one sentence that captures the whole book",
  "themes": ["a theme the book keeps returning to"],
  "characterArcs": [{ "name": "name", "change": "the arc from first appearance to the end" }],
  "structure": [{ "part": "volume or phase name", "summary": "what that part does for the whole" }],
  "threads": ["question the book leaves open"]
}`;

/** Compact rendering of a volume digest for the whole-book merge prompt. */
export function renderVolumeForMerge(volume: VolumeDigest): string {
  const lines = [`### Chapters ${volume.from + 1}–${volume.to + 1}`, volume.summary];
  if (volume.arcs.length > 0) lines.push(`Arcs: ${volume.arcs.join('; ')}`);
  if (volume.characters.length > 0) {
    lines.push(`Characters: ${volume.characters.map((c) => `${c.name} — ${c.change}`).join('; ')}`);
  }
  if (volume.threads.length > 0) lines.push(`Open threads: ${volume.threads.join('; ')}`);
  return lines.filter(Boolean).join('\n');
}

function buildBookPrompt(req: BookDigestRequest): string {
  const volumes = req.volumes.map(renderVolumeForMerge).join('\n\n');
  return `Write the whole-book digest of "${req.bookTitle}"${req.authorName ? ` by ${req.authorName}` : ''} from these volume summaries.

<VOLUME_DIGESTS>
${volumes}
</VOLUME_DIGESTS>

Reply with JSON of exactly this shape:
${SCHEMA}

The logline must stand alone. Cover the whole arc, not just the opening. Use only what the volume digests say, and keep a thread only if it is still open at the end.`;
}

/** Merge every volume digest into the whole-book digest. */
export async function generateBookDigest(req: BookDigestRequest): Promise<BookDigest> {
  if (req.volumes.length === 0) {
    throw new Error('A whole-book digest needs at least one volume summary.');
  }

  const payload = await requestDigestJson({
    settings: req.settings,
    prompt: buildBookPrompt(req),
    signal: req.signal,
    maxOutputTokens: 2000,
    parse: parseBookDigestPayload,
  });

  const now = Date.now();
  return {
    kind: 'book',
    id: bookDigestId(req.bookHash),
    bookHash: req.bookHash,
    bookTitle: req.bookTitle,
    model: req.model,
    createdAt: now,
    updatedAt: now,
    volumeIds: req.volumes.map((volume) => volume.id),
    ...payload,
  };
}
