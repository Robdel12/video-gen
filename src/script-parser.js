import fs from 'fs/promises';
import dotenv from 'dotenv';
import { createReadStream } from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import path from 'path';
import { fileURLToPath } from 'url';
import { getOpenAIClient } from './utils/openai-utils.js';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (one level up from src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB OpenAI limit



async function getFileSize(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    throw new Error(`Could not get file size for ${filePath}: ${error.message}`);
  }
}

/**
 * Compresses audio file to fit within OpenAI's file size limits
 * @param {string} inputPath - Path to input audio file
 * @param {string} outputPath - Path for compressed output
 * @param {number} targetSizeBytes - Target file size in bytes
 * @returns {Promise<string>} Path to compressed file
 */
async function compressAudio(inputPath, outputPath, targetSizeBytes) {
  return new Promise((resolve, reject) => {
    console.log(`Compressing audio file from ${inputPath} to ${outputPath}...`);

    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }

      const duration = metadata.format.duration;
      if (!duration) {
        reject(new Error('Could not determine audio duration'));
        return;
      }

      // Calculate target bitrate with safety margin
      const targetBitrate = Math.floor((targetSizeBytes * 8) / duration * 0.9 / 1000);
      const minBitrate = 32; // Minimum for speech quality
      const finalBitrate = Math.max(targetBitrate, minBitrate);

      console.log(`Target bitrate: ${finalBitrate}kbps for ${duration}s audio`);

      ffmpeg(inputPath)
        .audioCodec('libmp3lame')
        .audioBitrate(finalBitrate)
        .audioChannels(1) // Mono for speech
        .audioFrequency(22050) // Lower sample rate for speech
        .on('end', () => {
          console.log('Audio compression completed');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Error compressing audio:', err);
          reject(err);
        })
        .save(outputPath);
    });
  });
}

/**
 * Transcribes audio using OpenAI Whisper with caching support
 * @param {string} audioPath - Path to audio file
 * @param {string} cachePath - Path to cache file (optional)
 * @returns {Promise<Array>} Array of word objects with timestamps
 */
async function transcribeAudio(audioPath, cachePath = null) {
  // Try to use cache if provided
  if (cachePath) {
    try {
      await fs.access(cachePath);
      console.log('Found Whisper cache. Reading from cache...');
      const cachedData = await fs.readFile(cachePath, 'utf-8');
      const transcriptionWords = JSON.parse(cachedData);
      if (Array.isArray(transcriptionWords)) {
        return transcriptionWords;
      } else {
        console.warn('Cache data is not in the expected format. Fetching from API.');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn('Error reading Whisper cache:', error);
      }
      console.log('Whisper cache not found or unreadable. Calling Whisper API...');
    }
  } else {
    console.log('No cache path provided. Calling Whisper API...');
  }

  // Check file size and compress if necessary
  let finalAudioPath = audioPath;
  const fileSize = await getFileSize(audioPath);

  if (fileSize > MAX_FILE_SIZE) {
    console.log(`Audio file size (${Math.round(fileSize / 1024 / 1024 * 10) / 10}MB) exceeds OpenAI limit (${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)`);

    const ext = path.extname(audioPath);
    const basename = path.basename(audioPath, ext);
    const dirname = path.dirname(audioPath);
    const compressedPath = path.join(dirname, `${basename}_compressed.mp3`);

    try {
      await compressAudio(audioPath, compressedPath, MAX_FILE_SIZE);
      finalAudioPath = compressedPath;

      const compressedSize = await getFileSize(compressedPath);
      console.log(`Compressed file size: ${Math.round(compressedSize / 1024 / 1024 * 10) / 10}MB`);

      if (compressedSize > MAX_FILE_SIZE) {
        console.warn('Compressed file still exceeds limit, but proceeding anyway...');
      }
    } catch (compressionError) {
      console.error('Failed to compress audio file:', compressionError);
      console.log('Proceeding with original file (may fail due to size limit)...');
    }
  }

  try {
    const client = getOpenAIClient();
    const transcription = await client.audio.transcriptions.create({
      file: createReadStream(finalAudioPath),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word'] // Request word-level timestamps
    }); const wordsToCache = transcription.words || [];

    // Save to cache if cache path provided
    if (cachePath) {
      try {
        await fs.writeFile(cachePath, JSON.stringify(wordsToCache, null, 2));
        console.log('Whisper response cached successfully.');
      } catch (cacheError) {
        console.error('Error writing to Whisper cache:', cacheError);
      }
    }

    // Clean up compressed file if created
    if (finalAudioPath !== audioPath) {
      try {
        await fs.unlink(finalAudioPath);
        console.log('Cleaned up compressed audio file');
      } catch (cleanupError) {
        console.warn('Could not clean up compressed file:', cleanupError.message);
      }
    }

    return wordsToCache;
  } catch (error) {
    console.error(`Error transcribing audio ${finalAudioPath}:`, error);

    // Clean up compressed file on error
    if (finalAudioPath !== audioPath) {
      try {
        await fs.unlink(finalAudioPath);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }
    }

    throw error;
  }
}

/**
 * Creates segments from Whisper word data by grouping words into segments
 * @param {Array} whisperWords - Array of word objects with timestamps
 * @param {number} targetDuration - Target segment duration in seconds
 * @returns {Array} Array of segment objects
 */
function createSegmentsFromWords(whisperWords, targetDuration = 10) {
  if (!whisperWords || whisperWords.length === 0) {
    return [];
  }

  const MIN_SEGMENT_DURATION = 3;
  const segments = [];
  let currentSegment = {
    words: [],
    start: whisperWords[0].start,
    end: whisperWords[0].end
  };

  for (let i = 0; i < whisperWords.length; i++) {
    const word = whisperWords[i];
    const segmentDuration = word.end - currentSegment.start;

    // If adding this word would exceed target duration and we have words, finish current segment
    if (segmentDuration > targetDuration && currentSegment.words.length > 0) {
      // Ensure current segment meets minimum duration
      const currentDuration = currentSegment.end - currentSegment.start;
      if (currentDuration < MIN_SEGMENT_DURATION) {
        console.warn(`[Script Parser] Segment duration ${currentDuration.toFixed(3)}s below minimum. Extending to ${MIN_SEGMENT_DURATION}s`);
        currentSegment.end = currentSegment.start + MIN_SEGMENT_DURATION;
      }

      // Finalize current segment
      segments.push({
        id: segments.length,
        start: currentSegment.start,
        end: currentSegment.end,
        text: currentSegment.words.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim()
      });

      // Start new segment
      currentSegment = {
        words: [word],
        start: word.start,
        end: word.end
      };
    } else {
      // Add word to current segment
      currentSegment.words.push(word);
      currentSegment.end = word.end;
    }
  }

  // Add the final segment if it has words
  if (currentSegment.words.length > 0) {
    // Ensure final segment has minimum duration
    const finalDuration = currentSegment.end - currentSegment.start;
    if (finalDuration < MIN_SEGMENT_DURATION) {
      console.warn(`[Script Parser] Final segment duration ${finalDuration.toFixed(3)}s below minimum. Extending to ${MIN_SEGMENT_DURATION}s`);
      currentSegment.end = currentSegment.start + MIN_SEGMENT_DURATION;
    }

    segments.push({
      id: segments.length,
      start: currentSegment.start,
      end: currentSegment.end,
      text: currentSegment.words.map(w => w.word).join(' ').replace(/\s+/g, ' ').trim()
    });
  }

  // Post-process: Fix zero-duration segments and prevent overlaps
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const duration = segment.end - segment.start;

    if (duration <= 0) {
      console.warn(`[Script Parser] Zero-duration segment ${segment.id} detected. Duration: ${duration}s`);

      // If not the last segment, ensure no overlap with next
      if (i < segments.length - 1) {
        const nextSegment = segments[i + 1];
        const gapToNext = nextSegment.start - segment.start;
        const safeExtension = Math.min(MIN_SEGMENT_DURATION, gapToNext * 0.8);
        segment.end = segment.start + Math.max(MIN_SEGMENT_DURATION, safeExtension);
      } else {
        // Last segment can be safely extended
        segment.end = segment.start + MIN_SEGMENT_DURATION;
      }

      console.warn(`[Script Parser] Fixed segment ${segment.id} duration to ${(segment.end - segment.start).toFixed(3)}s`);
    }
  }

  console.log(`[Script Parser] Created ${segments.length} segments. Duration validation complete.`);
  return segments;
}

/**
 * Main function to parse script and create segments from audio transcription
 * @param {string} audioPath - Path to audio file
 * @param {string} outputPath - Path for output segments JSON
 * @param {number} targetSegmentDuration - Target duration per segment
 * @param {string} cachePath - Optional path for Whisper cache
 * @returns {Promise<Array>} Array of generated segments
 */
export async function parseScript(audioPath = 'voiceover.mp3', outputPath = 'segments.json', targetSegmentDuration = 10, cachePath = null) {
  console.log(`🎵 Processing audio file: ${audioPath}`);

  // Get word-level timestamps from Whisper
  const whisperWords = await transcribeAudio(audioPath, cachePath);

  if (!whisperWords || whisperWords.length === 0) {
    console.error('No Whisper words found. Cannot create segments.');
    return [];
  }

  // Create segments by grouping words
  const segments = createSegmentsFromWords(whisperWords, targetSegmentDuration);

  console.log(`Created ${segments.length} segments with average duration of ${targetSegmentDuration}s`);

  // Write segments to file
  await fs.writeFile(outputPath, JSON.stringify(segments, null, 2));
  console.log(`✅ ${outputPath} generated with ${segments.length} segments!`);

  return segments;
}
