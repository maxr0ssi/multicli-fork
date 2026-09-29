import { z } from 'zod';
import { UnifiedTool } from './registry.js';
import { getChunks } from '../utils/chunkCache.js';
import { formatChangeModeResponse, summarizeChangeModeEdits } from '../utils/changeModeTranslator.js';

const inputSchema = z.object({
  cacheKey: z.string().describe("The cache key provided in the initial changeMode response"),
  chunkIndex: z.number().min(1).describe("Which chunk to retrieve (1-based index)")
});

export const fetchAntigravityChunkTool: UnifiedTool = {
  name: 'Fetch-Antigravity-Chunk',
  description: 'Retrieve a cached chunk from an Antigravity changeMode response.',

  zodSchema: inputSchema,

  prompt: {
    description: 'Fetch the next chunk of an Antigravity response',
    arguments: [
      {
        name: 'cacheKey',
        description: 'The cache key provided in the initial changeMode response',
        required: true
      },
      {
        name: 'chunkIndex',
        description: 'Which chunk to retrieve (1-based index)',
        required: true
      }
    ]
  },

  category: 'antigravity',

  execute: async (args: any): Promise<string> => {
    const { cacheKey, chunkIndex } = args;
    
    // Retrieve cached chunks
    const chunks = getChunks(cacheKey);
    
    if (!chunks) {
      return `No cached chunks found for "${cacheKey}". The key may be invalid or the cache expired (10-minute TTL). Re-run the original changeMode request to regenerate the chunks.`;
    }
    
    // Validate chunk index
    if (chunkIndex < 1 || chunkIndex > chunks.length) {
      return `Invalid chunk index: ${chunkIndex}. Available chunks: 1 to ${chunks.length}.`;
    }
    
    // Get the requested chunk
    const chunk = chunks[chunkIndex - 1];
    
    // Format the response
    let result = formatChangeModeResponse(
      chunk.edits,
      { current: chunkIndex, total: chunks.length, cacheKey }
    );
    
    // Add summary for first chunk
    if (chunkIndex === 1 && chunks.length > 1) {
      const allEdits = chunks.flatMap(c => c.edits);
      result = summarizeChangeModeEdits(allEdits, true) + '\n\n' + result;
    }
    
    return result;
  },
};
