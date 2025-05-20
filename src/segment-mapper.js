import fs from 'fs/promises';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createStructuredCompletion, parseStructuredResponse, schemas, getOpenAIClient } from './utils/openai-utils.js';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (one level up from src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });



/**
 * Loads and parses JSON data from a file
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<Object>} Parsed JSON data
 */
async function loadJson(filePath) {
  const content = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Maps script segments to visual assets using AI analysis
 * @param {string} segmentsPath - Path to segments JSON file
 * @param {string} assetsPath - Path to assets JSON file
 * @param {string} outputPath - Path for output timeline JSON
 * @returns {Promise<Array>} Generated timeline array
 */
export async function mapSegments(segmentsPath = 'segments.json', assetsPath = 'assets.json', outputPath = 'timeline.json') {
  console.log(`🗺️  Loading segments from: ${segmentsPath}`);
  console.log(`🎨 Loading assets from: ${assetsPath}`);

  const [segments, assets] = await Promise.all([
    loadJson(segmentsPath),
    loadJson(assetsPath),
  ]);

  // Prepare segments for AI prompt
  const promptSegments = segments.map((segment, index) => ({
    segmentId: index,
    text: segment.text,
    estimatedDurationSeconds: segment.estimatedDurationSeconds
  }));

  const systemPrompt = `You are an expert AI Video Editor and Storyteller specializing in motorsport and racing documentaries.

Your critical task is to construct a compelling visual narrative by meticulously matching script segments to the most suitable visual assets, while maintaining visual diversity and professional pacing.

Each asset has a description derived from its actual visual content (for images) or a representative frame (for videos).

Your goal is to create a timeline that:
1. Matches the voiceover content accurately and meaningfully
2. Enhances the story and evokes appropriate emotions
3. Maintains viewer engagement through thoughtful visual sequencing
4. **PRIORITIZES ASSET DIVERSITY** - avoid using the same asset consecutively or repeatedly
5. **UTILIZES THE FULL ASSET LIBRARY** - strive to use as many different assets as possible
6. Creates smooth visual transitions that support the narrative flow
7. Balances dynamic racing footage with contextual images and close-ups

**ASSET DISTRIBUTION GUIDELINES:**
- Never use the same asset (same path + frameTimestamp) for consecutive segments
- Aim to use each unique asset at least once before repeating any asset
- When multiple assets could work for a segment, choose the one that hasn't been used recently
- Consider the visual rhythm: alternate between high-energy footage and more contemplative shots
- For racing documentaries: balance action shots, historical images, portraits, and environmental contexts

IMPORTANT OUTPUT REQUIREMENT:
- You MUST respond with a single JSON object.
- This JSON object MUST have a single top-level key named "timeline".
- The value of the "timeline" key MUST be a JSON array.
- This array MUST contain exactly one JSON object for EACH segment provided in the input 'Segments' array.
- If N segments are in the 'Segments' array, the "timeline" array MUST contain N objects.

Input 'Segments' array structure: [{ "segmentId": number, "text": string, "estimatedDurationSeconds"?: number (duration in seconds, optional) }, ...]
Input 'Assets' array structure: [{ "path": string, "type": string ("image" | "video_frame"), "description": string (for 'image' or specific 'video_frame'), "originalFilename": string, "frameTimestamp"?: string (string, e.g., "12.34", present for 'video_frame', indicates the time in seconds of the described frame) }, ...]

Each object in the "timeline" array MUST have the following structure:
{
  "segmentId": number,        // The segmentId from the input segment
  "assetPath": string,        // The path of the selected asset (e.g., "assets/video.mp4" or "assets/image.jpg")
  "assetType": string,        // Must be "image" or "video". If you selected a 'video_frame', set this to "video".
  "frameTimestamp": string | null // If assetType is "video", this is the frameTimestamp (e.g., "12.34") of the chosen video_frame. Set to null for "image" assetType.
}

Example of your JSON response (if 3 input segments were provided):
{
  "timeline": [
    { "segmentId": 0, "assetPath": "assets/dynamic_race_footage.mp4", "assetType": "video", "frameTimestamp": "10.50" },
    { "segmentId": 1, "assetPath": "assets/enzo_ferrari_portrait.jpg", "assetType": "image", "frameTimestamp": null },
    { "segmentId": 2, "assetPath": "assets/pit_stop_action.mp4", "assetType": "video", "frameTimestamp": "5.20" }
  ]
}

**EDITORIAL STRATEGY FOR MOTORSPORT DOCUMENTARIES:**
- Opening segments: Use establishing shots or iconic imagery
- Historical context: Prefer period photographs and archival footage
- Technical discussions: Close-ups of cars, engines, or driver preparations
- Dramatic moments: High-energy racing footage with appropriate emotional tone
- Transitions: Consider visual continuity (day/night, similar compositions, color palettes)
- Climactic moments: Save your most impactful footage for key narrative peaks

**ASSET SELECTION PRIORITY:**
1. **Content Match**: Asset description must align with segment narrative
2. **Visual Diversity**: Avoid consecutive use of same asset or very similar shots
3. **Emotional Resonance**: Choose assets that enhance the emotional arc
4. **Narrative Flow**: Ensure smooth visual transitions between segments
5. **Library Utilization**: Maximize use of available asset variety

Process all segments and return the complete JSON object.`;

  // Prepare assets for AI prompt, flattening video frames into selectable items
  const promptAssets = [];
  assets.forEach(asset => {
    if (asset.type === 'image') {
      if (asset.description && asset.path && asset.originalFilename) {
        promptAssets.push({
          path: asset.path,
          type: 'image',
          description: asset.description,
          originalFilename: asset.originalFilename,
        });
      } else {
        console.warn(`Skipping image asset due to missing properties: ${asset.originalFilename || asset.path}`);
      }
    } else if (asset.type === 'video' && asset.frames && asset.frames.length > 0) {
      if (!asset.path || !asset.originalFilename) {
        console.warn(`Skipping video asset due to missing path/originalFilename: ${asset.originalFilename || asset.path}`);
        return;
      }
      asset.frames.forEach(frame => {
        if (frame.description && frame.timestamp) {
          promptAssets.push({
            path: asset.path,
            type: 'video_frame',
            description: frame.description,
            originalFilename: asset.originalFilename,
            frameTimestamp: frame.timestamp
          });
        } else {
          console.warn(`Skipping frame in video ${asset.originalFilename} due to missing description/timestamp.`);
        }
      });
    } else if (asset.type === 'video' && (!asset.frames || asset.frames.length === 0)) {
      console.warn(`Video asset ${asset.originalFilename || asset.path} has no analyzable frames. It will not be presented to the LLM for selection.`);
    }
  });

  const userPrompt = `MOTORSPORT DOCUMENTARY ASSET MAPPING TASK:

Total segments to process: ${promptSegments.length}
Total unique assets available: ${promptAssets.length}

**ASSET DIVERSITY REQUIREMENT**: With ${promptAssets.length} assets available for ${promptSegments.length} segments, you have ${(promptAssets.length / promptSegments.length).toFixed(1)}x more assets than segments. This provides excellent opportunity for visual diversity.

**MANDATORY GUIDELINES:**
- NO asset should be used for consecutive segments (segmentId N and N+1)
- Prioritize using different assets for adjacent segments even if multiple assets could work
- Track your selections to maximize asset library utilization
- When multiple assets match a segment equally well, choose the one that creates better visual flow

Segments: ${JSON.stringify(promptSegments)}

Assets: ${JSON.stringify(promptAssets)}`;

  try {
    const response = await createStructuredCompletion({
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      schema: schemas.timelineMapping,
      schemaName: "timeline_mapping"
    });

    const parsedResponse = parseStructuredResponse(response, 'timeline mapping');
    const timeline = parsedResponse.timeline;

    // Validate timeline structure (basic sanity check)
    if (!Array.isArray(timeline)) {
      console.error('LLM response timeline is not an array:', parsedResponse);
      throw new Error('LLM response timeline is not an array');
    }

    // Validate timeline structure
    if (!timeline.every(item =>
      item.hasOwnProperty('segmentId') &&
      item.hasOwnProperty('assetPath') &&
      item.hasOwnProperty('assetType') && (item.assetType === 'image' || item.assetType === 'video') &&
      item.hasOwnProperty('frameTimestamp') && (item.assetType === 'image' ? item.frameTimestamp === null : typeof item.frameTimestamp === 'string' || item.frameTimestamp === null)
    )) {
      console.error('Invalid timeline structure from LLM:', JSON.stringify(timeline, null, 2));
      throw new Error('LLM response does not conform to the expected timeline item structure.');
    }

    // Validate segment count
    if (timeline.length !== promptSegments.length) {
      console.error(`LLM did not return an item for each segment. Expected: ${promptSegments.length}, Got: ${timeline.length}. Timeline: ${JSON.stringify(timeline, null, 2)}`);
      throw new Error(`LLM did not return an item for each segment. Expected: ${promptSegments.length}, Got: ${timeline.length}`);
    }

    // Check for asset diversity and warn about potential overuse
    const assetUsage = new Map();
    const consecutiveUsage = [];

    timeline.forEach((item, index) => {
      const assetKey = item.assetType === 'video'
        ? `${item.assetPath}#${item.frameTimestamp}`
        : item.assetPath;

      // Track usage count
      assetUsage.set(assetKey, (assetUsage.get(assetKey) || 0) + 1);

      // Check for consecutive usage
      if (index > 0) {
        const prevItem = timeline[index - 1];
        const prevAssetKey = prevItem.assetType === 'video'
          ? `${prevItem.assetPath}#${prevItem.frameTimestamp}`
          : prevItem.assetPath;

        if (assetKey === prevAssetKey) {
          consecutiveUsage.push({
            segments: [prevItem.segmentId, item.segmentId],
            asset: assetKey
          });
        }
      }
    });

    // Log asset diversity statistics
    const totalAssets = promptAssets.length;
    const usedAssets = assetUsage.size;
    const utilization = ((usedAssets / totalAssets) * 100).toFixed(1);

    console.log(`📊 Asset Utilization: ${usedAssets}/${totalAssets} (${utilization}%)`);

    if (consecutiveUsage.length > 0) {
      console.warn(`⚠️ Found ${consecutiveUsage.length} consecutive asset usage(s):`);
      consecutiveUsage.forEach(usage => {
        console.warn(`  - Segments ${usage.segments[0]}-${usage.segments[1]}: ${usage.asset}`);
      });
    } else {
      console.log(`✅ No consecutive asset usage detected - good visual diversity!`);
    }

    // Log usage statistics
    const sortedUsage = Array.from(assetUsage.entries()).sort((a, b) => b[1] - a[1]);
    if (sortedUsage.length > 0) {
      console.log(`📈 Most used asset: ${sortedUsage[0][0]} (${sortedUsage[0][1]} times)`);
      const unusedAssets = totalAssets - usedAssets;
      if (unusedAssets > 0) {
        console.log(`📉 ${unusedAssets} assets were not used`);
      }
    }

    await fs.writeFile(outputPath, JSON.stringify(timeline, null, 2));
    console.log(`✅ ${outputPath} generated!`);
    return timeline;

  } catch (error) {
    console.error('Error in mapSegments:', error);
    // Create empty timeline on error
    await fs.writeFile(outputPath, JSON.stringify([], null, 2));
    console.log(`⚠️ ${outputPath} generated with an empty array due to an error.`);
    throw error;
  }
}
