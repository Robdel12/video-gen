import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import util from 'util';
import tmp from 'tmp';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execAsyncSafe, hasProblematicChars, normalizeFilename } from './utils/shell-utils.js';
import { createStructuredCompletion, parseStructuredResponse, createAssetAnalysisSchema, getOpenAIClient } from './utils/openai-utils.js';
import { PROJECT_STRUCTURE } from './utils/project-utils.js';

const execAsync = util.promisify(exec);
const tmpFileAsync = util.promisify(tmp.file);

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (one level up from src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Cache configuration
const CACHE_DIR = path.join(__dirname, '..', '.frame-cache');
const CACHE_METADATA_FILE = 'metadata.json';

/**
 * Creates a SHA256 hash of a file
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} SHA256 hash of the file
 */
async function getFileSHA256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest('hex');
}

/**
 * Ensures the cache directory exists
 * @returns {Promise<void>}
 */
async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true });
}

/**
 * Gets the cache directory path for a specific video
 * @param {string} videoPath - Path to the video file
 * @param {string} videoSHA - SHA256 hash of the video file
 * @returns {string} Cache directory path for this video
 */
function getVideoCacheDir(videoPath, videoSHA) {
  const filename = path.basename(videoPath, path.extname(videoPath));
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9\-_]/g, '_');
  return path.join(CACHE_DIR, `${sanitizedFilename}_${videoSHA.substring(0, 12)}`);
}

/**
 * Loads cached frame metadata for a video
 * @param {string} cacheDir - Cache directory for the video
 * @returns {Promise<Object|null>} Cached metadata or null if not found
 */
async function loadCachedFrameMetadata(cacheDir) {
  try {
    const metadataPath = path.join(cacheDir, CACHE_METADATA_FILE);
    const metadataContent = await fs.readFile(metadataPath, 'utf-8');
    return JSON.parse(metadataContent);
  } catch (error) {
    return null;
  }
}

/**
 * Saves frame metadata to cache
 * @param {string} cacheDir - Cache directory for the video
 * @param {Object} metadata - Metadata to save
 * @returns {Promise<void>}
 */
async function saveCachedFrameMetadata(cacheDir, metadata) {
  await fs.mkdir(cacheDir, { recursive: true });
  const metadataPath = path.join(cacheDir, CACHE_METADATA_FILE);
  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
}

/**
 * Cleans up outdated cache entries for a video (when SHA changes)
 * @param {string} videoPath - Path to the video file
 * @param {string} currentSHA - Current SHA256 hash of the video
 * @returns {Promise<void>}
 */
async function cleanupOutdatedCache(videoPath, currentSHA) {
  const filename = path.basename(videoPath, path.extname(videoPath));
  const sanitizedFilename = filename.replace(/[^a-zA-Z0-9\-_]/g, '_');

  try {
    const entries = await fs.readdir(CACHE_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.startsWith(`${sanitizedFilename}_`)) {
        const dirSHA = entry.name.split('_').pop();
        if (dirSHA !== currentSHA.substring(0, 12)) {
          const outdatedCacheDir = path.join(CACHE_DIR, entry.name);
          console.log(`🧹 Cleaning up outdated cache for ${filename}: ${entry.name}`);
          await fs.rm(outdatedCacheDir, { recursive: true, force: true });
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Failed to cleanup outdated cache for ${filename}:`, error.message);
  }
}

/**
 * Checks if frames are cached and valid for a video
 * @param {string} filePath - Path to the video file
 * @param {Array<string>} timestamps - Required frame timestamps
 * @returns {Promise<Object|null>} Cached frame data or null if invalid/missing
 */
async function getCachedFrames(filePath, timestamps) {
  try {
    await ensureCacheDir();

    const videoSHA = await getFileSHA256(filePath);
    const cacheDir = getVideoCacheDir(filePath, videoSHA);

    // Clean up outdated cache entries first
    await cleanupOutdatedCache(filePath, videoSHA);

    const metadata = await loadCachedFrameMetadata(cacheDir);
    if (!metadata) {
      return null;
    }

    // Verify all required timestamps are cached
    const cachedTimestamps = Object.keys(metadata.frames || {});
    const allTimestampsAvailable = timestamps.every(ts => cachedTimestamps.includes(ts));

    if (!allTimestampsAvailable) {
      console.log(`📁 Cache miss: Missing some timestamps for ${path.basename(filePath)}`);
      return null;
    }

    // Verify frame files still exist
    for (const ts of timestamps) {
      const frameInfo = metadata.frames[ts];
      if (!frameInfo || !frameInfo.imagePath) {
        return null;
      }

      try {
        await fs.access(frameInfo.imagePath);
      } catch {
        console.log(`📁 Cache miss: Frame file missing for ${path.basename(filePath)} at ${ts}s`);
        return null;
      }
    }

    console.log(`✅ Cache hit: Using cached frames for ${path.basename(filePath)}`);
    return {
      metadata,
      cacheDir,
      videoSHA
    };

  } catch (error) {
    console.warn(`Warning: Failed to check cache for ${path.basename(filePath)}:`, error.message);
    return null;
  }
}

/**
 * Caches extracted frames for a video
 * @param {string} filePath - Path to the video file
 * @param {string} videoSHA - SHA256 hash of the video
 * @param {number} duration - Video duration in seconds
 * @param {Array<Object>} frameAnalyses - Frame analysis results
 * @returns {Promise<void>}
 */
async function cacheFrames(filePath, videoSHA, duration, frameAnalyses) {
  try {
    const cacheDir = getVideoCacheDir(filePath, videoSHA);
    await fs.mkdir(cacheDir, { recursive: true });

    const metadata = {
      videoPath: filePath,
      videoSHA,
      duration,
      cachedAt: new Date().toISOString(),
      frames: {}
    };

    // Copy frame analyses and their associated image files to cache
    for (const frame of frameAnalyses) {
      if (frame.tempImagePath && frame.timestamp) {
        const cachedImagePath = path.join(cacheDir, `frame_${frame.timestamp.replace('.', '_')}.jpg`);

        try {
          await fs.copyFile(frame.tempImagePath, cachedImagePath);
          metadata.frames[frame.timestamp] = {
            timestamp: frame.timestamp,
            description: frame.description,
            imagePath: cachedImagePath,
            analysisError: frame.analysisError || false
          };
        } catch (copyError) {
          console.warn(`Warning: Failed to cache frame ${frame.timestamp} for ${path.basename(filePath)}:`, copyError.message);
        }
      }
    }

    await saveCachedFrameMetadata(cacheDir, metadata);
    console.log(`💾 Cached ${Object.keys(metadata.frames).length} frames for ${path.basename(filePath)}`);

  } catch (error) {
    console.warn(`Warning: Failed to cache frames for ${path.basename(filePath)}:`, error.message);
  }
}

/**
 * Determines frame extraction timestamps based on video duration
 * @param {number} durationInSeconds - Video duration in seconds
 * @returns {Array<string>} Array of timestamp strings for frame extraction
 */
function getFrameTimestamps(durationInSeconds) {
  const duration = Number(durationInSeconds);
  if (isNaN(duration) || duration <= 0.1) return [];

  let timestamps = [];
  const MIN_INTERVAL_SECONDS = 30;
  const MAX_FRAMES_LONG_VIDEO = 10;

  if (duration < 1) {
    // Very short videos
    timestamps.push(Math.max(0.05, duration * 0.5).toFixed(2));
  } else if (duration < 5) {
    // Short videos: 1-5 seconds
    timestamps.push("1.00");
    if (duration > 2.5) {
      timestamps.push(Math.min(duration - 0.1, duration * 0.75).toFixed(2));
    }
  } else if (duration < 30) {
    // Medium videos: 5-30 seconds
    timestamps.push((duration * 0.25).toFixed(2));
    timestamps.push((duration * 0.75).toFixed(2));
  } else {
    // Long videos: 30+ seconds
    timestamps.push((duration * 0.10).toFixed(2)); // Early frame

    const numberOfMiddleFrames = Math.min(MAX_FRAMES_LONG_VIDEO - 2, Math.floor((duration * 0.8) / MIN_INTERVAL_SECONDS));

    if (numberOfMiddleFrames > 0) {
      const middleSectionDuration = duration * 0.8;
      const actualInterval = middleSectionDuration / (numberOfMiddleFrames + 1);

      for (let i = 1; i <= numberOfMiddleFrames; i++) {
        timestamps.push((duration * 0.10 + i * actualInterval).toFixed(2));
      }
    }
    timestamps.push((duration * 0.90).toFixed(2)); // Late frame
  }

  // Ensure unique, sorted timestamps within bounds
  return [...new Set(timestamps.map(ts => {
    let t = parseFloat(ts);
    const maxTs = Math.max(0, duration - Math.min(1, duration * 0.02));
    return Math.min(t, maxTs).toFixed(2);
  }))]
    .map(ts => parseFloat(ts).toFixed(2))
    .filter((ts, index, self) => self.indexOf(ts) === index)
    .sort((a, b) => parseFloat(a) - parseFloat(b));
}

/**
 * Discovers all media assets in the specified directory
 * @param {string} assetsDir - Directory containing assets
 * @returns {Promise<Array>} Array of asset objects with path and filename
 */
async function discoverAssets(assetsDir) {
  const entries = await fs.readdir(assetsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
    .map(entry => ({
      path: path.join(assetsDir, entry.name),
      filename: entry.name,
    }));
}

/**
 * Determines asset type based on file extension
 * @param {string} filename - Name of the file
 * @returns {Promise<string>} Asset type: 'image', 'video', or 'unknown'
 */
async function getAssetType(filename) {
  const ext = path.extname(filename).toLowerCase().slice(1);
  if (PROJECT_STRUCTURE.IMAGE_EXTENSIONS.includes(ext)) {
    return 'image';
  } else if (PROJECT_STRUCTURE.VIDEO_EXTENSIONS.includes(ext)) {
    return 'video';
  }
  return 'unknown';
}



/**
 * Analyzes a media file (image or video) and extracts descriptions
 * @param {string} filePath - Path to the media file
 * @param {string} assetType - Type of asset ('image' or 'video')
 * @param {string} filename - Original filename
 * @returns {Promise<Object>} Analysis results with descriptions
 */
async function analyzeMediaFile(filePath, assetType, filename) {
  let tempFramePaths = [];

  const userMessageTextForImage = "Analyze the provided image using both the visual content and the filename as context. Describe the image, focusing on its visual content, mood, and potential narrative impact for a documentary.";
  const userMessageTextForVideoFrame = "Analyze the provided frame from a video using both the visual content and the filename as context. Based on this single frame and filename, describe what the video likely portrays, focusing on action, mood, and potential use in a documentary.";

  try {
    if (assetType === 'image') {
      const imageBuffer = await fs.readFile(filePath);
      const base64ImageData = imageBuffer.toString('base64');
      let fileExtension = path.extname(filename).substring(1).toLowerCase();
      // Map file extensions to MIME types for OpenAI
      if (fileExtension === 'jpg') fileExtension = 'jpeg';
      // webp is supported as-is by OpenAI
      // Note: AVIF is not supported by OpenAI Vision API

      const analysis = await analyzeSingleFrame(base64ImageData, fileExtension, filename, userMessageTextForImage, 'image');
      return { type: 'image', originalFilename: filename, analysis: analysis };

    } else if (assetType === 'video') {
      let durationInSeconds = 0;
      const videoProcessingNotes = [];

      try {
        const { stdout } = await execAsyncSafe('ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 {0}', filePath);
        durationInSeconds = parseFloat(stdout);
        if (isNaN(durationInSeconds) || durationInSeconds <= 0) {
          videoProcessingNotes.push(`Could not determine valid duration for ${filename}, defaulting to 5s for frame extraction. ffprobe output: ${stdout}`);
          durationInSeconds = 5;
        }
      } catch (ffprobeError) {
        videoProcessingNotes.push(`Error getting duration for ${filename}: ${ffprobeError.message}. Defaulting to 5s.`);
        durationInSeconds = 5;
      }

      // Determine required timestamps based on video duration
      const timestamps = getFrameTimestamps(durationInSeconds);

      if (timestamps.length === 0) {
        let note = `No frames selected for ${filename} (duration: ${durationInSeconds.toFixed(2)}s). `;
        if (durationInSeconds <= 0.1) {
          note += `Video may be too short.`;
        } else {
          note += `Check getFrameTimestamps logic if duration seems adequate.`;
        }
        videoProcessingNotes.push(note);

        return {
          type: 'video',
          originalFilename: filename,
          duration: durationInSeconds,
          frames: [],
          notes: videoProcessingNotes
        };
      }

      // Check cache first with the required timestamps
      const cachedFramesResult = await getCachedFrames(filePath, timestamps);
      if (cachedFramesResult) {
        console.log(`📁 Using cached frames for ${filename} (${timestamps.length} frames)`);
        const { metadata } = cachedFramesResult;

        // Build frame analyses from cached data
        const frameAnalyses = [];
        for (const ts of timestamps) {
          const frameInfo = metadata.frames[ts];
          if (frameInfo && frameInfo.imagePath) {
            try {
              // Use cached frame data without re-analyzing
              const analysisResult = {
                timestamp: frameInfo.timestamp,
                description: frameInfo.description,
                analysisError: frameInfo.analysisError || false
              };

              // Store the cached image path for potential cleanup tracking
              analysisResult.tempImagePath = frameInfo.imagePath;
              frameAnalyses.push(analysisResult);
            } catch (frameError) {
              console.error(`Error processing cached frame at ${ts}s for ${filename}:`, frameError);
              frameAnalyses.push({
                description: `Analysis failed for cached frame at ${ts}s from ${filename}: ${frameError.message}`,
                timestamp: ts,
                analysisError: true
              });
            }
          }
        }

        return {
          type: 'video',
          originalFilename: filename,
          duration: metadata.duration,
          frames: frameAnalyses,
          notes: videoProcessingNotes
        };
      }

      // Cache miss - extract and analyze frames
      console.log(`🎬 Extracting ${timestamps.length} frames from ${filename} (${durationInSeconds.toFixed(2)}s)`);
      const frameAnalyses = [];

      for (let j = 0; j < timestamps.length; j++) {
        const ts = timestamps[j];
        let tempFramePath = null;
        try {
          console.log(`    [${j + 1}/${timestamps.length}] Analyzing frame at ${ts}s for ${filename}`);
          const tempFileResult = await tmpFileAsync({ postfix: '.jpg' });
          tempFramePath = tempFileResult;
          tempFramePaths.push(tempFramePath);

          await execAsyncSafe('ffmpeg -i {0} -ss ' + ts + ' -vframes 1 -f image2 -q:v 2 {1} -y', filePath, tempFramePath);
          const frameBuffer = await fs.readFile(tempFramePath);
          const base64ImageData = frameBuffer.toString('base64');
          const frameFilename = `${filename}_frame_at_${ts.replace('.', '_')}s.jpg`;
          const analysisResult = await analyzeSingleFrame(base64ImageData, 'jpeg', frameFilename, userMessageTextForVideoFrame, 'video_frame', ts);

          // Store temp path for caching
          analysisResult.tempImagePath = tempFramePath;
          frameAnalyses.push(analysisResult);
        } catch (frameError) {
          console.error(`Error processing frame at ${ts}s for ${filename}:`, frameError);
          frameAnalyses.push({
            description: `Analysis failed for frame at ${ts}s from ${filename}: ${frameError.message}`,
            timestamp: ts,
            analysisError: true,
            tempImagePath: tempFramePath
          });
        }
      }

      // Cache the extracted frames for future use
      try {
        await cacheFrames(filePath, await getFileSHA256(filePath), durationInSeconds, frameAnalyses);
      } catch (cacheError) {
        console.warn(`Warning: Failed to cache frames for ${filename}:`, cacheError.message);
      }
      return {
        type: 'video',
        originalFilename: filename,
        duration: durationInSeconds,
        frames: frameAnalyses,
        notes: videoProcessingNotes
      };
    } else {
      // Unsupported asset type
      return {
        type: 'unknown',
        originalFilename: filename,
        notes: [`Unsupported asset type for visual analysis.`]
      };
    }

  } catch (error) {
    console.error(`Critical error during media analysis for ${filename}:`, error);
    return {
      type: assetType || 'error',
      originalFilename: filename,
      error: `Critical analysis failure: ${error.message}`,
      duration: 0,
      frames: [],
      notes: [`Critical analysis failure: ${error.message}`]
    };
  } finally {
    // Clean up temporary frame files
    for (const tempPath of tempFramePaths) {
      try {
        await fs.unlink(tempPath);
      } catch (cleanupError) {
        console.warn(`Warning: Failed to clean up temporary frame file ${tempPath}: ${cleanupError.message}`);
      }
    }
  }
}

/**
 * Analyzes a single frame or image using OpenAI Vision API
 * @param {string} base64ImageData - Base64 encoded image data
 * @param {string} fileExtension - File extension (jpeg, png, etc.)
 * @param {string} sourceFilename - Original filename for error reporting
 * @param {string} userMessageText - User message for the AI analysis
 * @param {string} assetCategory - Category: 'image' or 'video_frame'
 * @param {string|null} timestamp - Timestamp for video frames
 * @returns {Promise<Object>} Analysis result with description
 */
async function analyzeSingleFrame(base64ImageData, fileExtension, sourceFilename, userMessageText, assetCategory, timestamp = null) {
  const systemPromptContent = `You are an expert AI assistant for a documentary film editor.
Your task is to analyze visual assets (images or representative frames from videos) and provide concise, evocative descriptions that will help the editor decide how to use them in a sports documentary.
Focus on the visual content, mood, potential narrative impact, and any key subjects or actions.
Use both the visual content AND the filename as context clues to better understand what the asset represents.

For an IMAGE asset:
Provide a concise, engaging description of the image content (ideally under 30 words), highlighting its relevance for a documentary. Use the filename as additional context. Example: 'Vintage shot of mechanics working tirelessly on a Ford GT40 in the pits.'

For a VIDEO asset (you will be given a single representative frame from the video):
Based on this single frame and the filename, provide a concise, engaging description of what the video likely portrays (ideally under 30 words). Focus on action, mood, and potential use in a documentary. Example: 'Dynamic onboard footage suggesting intense race action, possibly from a driver's POV.'

If the frame is uninformative or the content is unclear, state that clearly.`;

  const userMessageContent = [
    { type: "text", text: `${userMessageText}\n\nFilename: ${sourceFilename}` },
    {
      type: "image_url",
      image_url: {
        url: `data:image/${fileExtension};base64,${base64ImageData}`,
        detail: "low"
      }
    }
  ];

  try {
    if (!base64ImageData) {
      return { description: `Analysis failed for ${sourceFilename}: Could not extract image data.`, analysisError: true };
    }

    console.log(`      ⏳ Sending ${assetCategory === 'video_frame' ? `frame (${timestamp}s)` : 'image'} from ${sourceFilename} to OpenAI API...`);
    const schema = createAssetAnalysisSchema(assetCategory === 'video_frame');
    const response = await createStructuredCompletion({
      messages: [
        { role: 'system', content: systemPromptContent },
        { role: 'user', content: userMessageContent },
      ],
      schema,
      schemaName: "asset_analysis"
    });

    const parsedResponse = parseStructuredResponse(response, sourceFilename);

    if (!parsedResponse || typeof parsedResponse.description !== 'string') {
      console.error(`Error analyzing ${sourceFilename}: LLM response missing or invalid description.`);
      return { description: `Analysis failed for ${sourceFilename}: Missing or invalid description.`, analysisError: true };
    }

    const result = { description: parsedResponse.description };
    if (assetCategory === 'video_frame') {
      // Use the timestamp from response or fallback to calculated timestamp
      result.timestamp = parsedResponse.timestamp_seconds || timestamp;
    }
    return result;

  } catch (error) {
    console.error(`Error during single frame/image analysis for ${sourceFilename}:`, error);
    return { description: `Analysis failed for ${sourceFilename} due to an error: ${error.message}`, analysisError: true };
  }
}

/**
 * Main function to process all assets in a directory
 * @param {string} assetsDir - Directory containing assets
 * @param {string} outputPath - Path for output JSON file
 * @returns {Promise<Array>} Array of processed asset objects
 */
export async function processAssets(assetsDir = 'assets', outputPath = 'assets.json') {
  console.log(`🔍 Discovering assets in: ${assetsDir}`);
  const assetEntries = await discoverAssets(assetsDir);
  console.log(`📁 Found ${assetEntries.length} potential assets`);

  // Check for problematic filenames and warn user
  const problematicFiles = assetEntries.filter(asset => hasProblematicChars(asset.filename));
  if (problematicFiles.length > 0) {
    console.log(`\n⚠️  Warning: Found ${problematicFiles.length} files with names that may cause issues:`);
    problematicFiles.forEach(asset => {
      const normalized = normalizeFilename(asset.filename);
      console.log(`   ${asset.filename} → suggested: ${normalized}`);
    });
    console.log(`\n💡 Tip: Run 'video-gen normalize --dry-run' to see what would be changed`);
    console.log(`   or 'video-gen normalize' to create normalized copies\n`);
  }

  const processedAssets = [];

  for (let i = 0; i < assetEntries.length; i++) {
    const asset = assetEntries[i];
    const assetTypeFromDiscovery = await getAssetType(asset.filename);
    console.log(`\n[${i + 1}/${assetEntries.length}] Processing: ${asset.filename} (type: ${assetTypeFromDiscovery})`);
    if (assetTypeFromDiscovery === 'unknown') {
      processedAssets.push({
        path: asset.path,
        originalFilename: asset.filename,
        type: 'unknown',
        notes: "Asset type not supported for processing."
      });
      continue;
    }

    const analysisOutput = await analyzeMediaFile(asset.path, assetTypeFromDiscovery, asset.filename);

    if (analysisOutput.error) {
      processedAssets.push({
        path: asset.path,
        originalFilename: analysisOutput.originalFilename || asset.filename,
        type: analysisOutput.type === 'error' ? assetTypeFromDiscovery : analysisOutput.type,
        error: analysisOutput.error,
        notes: analysisOutput.notes ? analysisOutput.notes.join("; ") : analysisOutput.error
      });
      continue;
    }

    if (analysisOutput.type === 'image') {
      const imageAssetData = {
        path: asset.path,
        originalFilename: analysisOutput.originalFilename,
        type: 'image',
        description: analysisOutput.analysis.description,
      };

      let notes = [];
      if (analysisOutput.analysis.analysisError) {
        imageAssetData.error = true;
        const errDesc = analysisOutput.analysis.description;
        if (errDesc && (errDesc.toLowerCase().includes('failed') || errDesc.toLowerCase().includes('error'))) {
          notes.push(errDesc);
        } else {
          notes.push(`Analysis error: ${errDesc}`);
        }
      }
      if (analysisOutput.analysis.analysisNote) {
        notes.push(analysisOutput.analysis.analysisNote);
      }
      if (notes.length > 0) imageAssetData.notes = notes.join("; ");
      processedAssets.push(imageAssetData);

    } else if (analysisOutput.type === 'video') {
      const videoAssetData = {
        path: asset.path,
        originalFilename: analysisOutput.originalFilename,
        type: 'video',
        totalDurationSeconds: parseFloat(analysisOutput.duration.toFixed(2)),
        frames: analysisOutput.frames.map(frame => {
          const frameData = {
            timestamp: frame.timestamp,
            description: frame.description,
          };

          let frameNotes = [];
          if (frame.analysisError) {
            frameData.error = true;
            const errDesc = frame.description;
            if (errDesc && (errDesc.toLowerCase().includes('failed') || errDesc.toLowerCase().includes('error'))) {
              frameNotes.push(errDesc);
            } else {
              frameNotes.push(`Frame analysis error: ${errDesc}`);
            }
          }
          if (frame.analysisNote) {
            frameNotes.push(frame.analysisNote);
          }
          if (frameNotes.length > 0) frameData.notes = frameNotes.join("; ");
          return frameData;
        }),
      };

      if (analysisOutput.notes && analysisOutput.notes.length > 0) {
        videoAssetData.processingNotes = analysisOutput.notes.join("; ");
      }
      processedAssets.push(videoAssetData);

    } else if (analysisOutput.type === 'unknown') {
      processedAssets.push({
        path: asset.path,
        originalFilename: analysisOutput.originalFilename,
        type: 'unknown',
        notes: analysisOutput.notes ? analysisOutput.notes.join("; ") : "Unsupported asset type."
      });
    }
  }

  await fs.writeFile(outputPath, JSON.stringify(processedAssets, null, 2));
  console.log(`✅ ${outputPath} generated!`);
  return processedAssets;
}

/**
 * Creates a normalized copy of assets with problematic filenames
 * @param {string} assetsDir - Directory containing assets
 * @param {boolean} dryRun - If true, only reports what would be changed without making changes
 * @returns {Promise<Object>} Report of normalization results
 */
export async function normalizeAssetFilenames(assetsDir = 'assets', dryRun = false) {
  console.log(`🔍 Checking for assets with problematic filenames in: ${assetsDir}`);

  const assetEntries = await discoverAssets(assetsDir);
  const results = {
    checked: 0,
    problematic: 0,
    normalized: 0,
    errors: [],
    changes: []
  };

  for (const asset of assetEntries) {
    results.checked++;

    if (hasProblematicChars(asset.filename)) {
      results.problematic++;
      const normalizedFilename = normalizeFilename(asset.filename);
      const normalizedPath = path.join(assetsDir, normalizedFilename);

      const change = {
        original: asset.filename,
        normalized: normalizedFilename,
        originalPath: asset.path,
        normalizedPath: normalizedPath
      };

      if (normalizedFilename !== asset.filename) {
        results.changes.push(change);

        if (!dryRun) {
          try {
            // Check if target filename already exists
            try {
              await fs.access(normalizedPath);
              results.errors.push(`Cannot normalize ${asset.filename} to ${normalizedFilename}: target file already exists`);
              continue;
            } catch {
              // Target doesn't exist, safe to proceed
            }

            // Copy file to normalized name
            await fs.copyFile(asset.path, normalizedPath);
            console.log(`✅ Normalized: ${asset.filename} → ${normalizedFilename}`);
            results.normalized++;

            // Optionally remove original (commented out for safety)
            // await fs.unlink(asset.path);

          } catch (error) {
            results.errors.push(`Error normalizing ${asset.filename}: ${error.message}`);
          }
        } else {
          console.log(`📝 Would normalize: ${asset.filename} → ${normalizedFilename}`);
        }
      }
    }
  }

  // Report results
  console.log(`\n📊 Filename Analysis Results:`);
  console.log(`   Total files checked: ${results.checked}`);
  console.log(`   Files with problematic names: ${results.problematic}`);

  if (results.changes.length > 0) {
    console.log(`   Files that ${dryRun ? 'would be' : 'were'} normalized: ${results.changes.length}`);
    if (!dryRun && results.normalized > 0) {
      console.log(`   Successfully normalized: ${results.normalized}`);
    }
  } else {
    console.log(`   ✅ All filenames are already clean!`);
  }

  if (results.errors.length > 0) {
    console.log(`   ❌ Errors: ${results.errors.length}`);
    results.errors.forEach(error => console.log(`      ${error}`));
  }

  return results;
}
