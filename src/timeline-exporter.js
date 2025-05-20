/**
 * @fileoverview Timeline Exporter - Exports FCPXML timelines with video duration validation
 * and Ken Burns effects. Prioritizes video boundaries over minimum duration requirements
 * to prevent clips extending beyond actual video file durations.
 */

import fs from 'fs';
import path from 'path';
import { create } from 'xmlbuilder2';
import { createHash } from 'crypto';
import { execSync } from 'child_process';
import { execSyncSafe } from './utils/shell-utils.js';

// Cache for video durations to avoid repeated ffprobe calls
const videoDurationCache = new Map();

/**
 * Get actual video duration using ffprobe
 * @param {string} videoPath - Path to video file
 * @returns {number|null} Duration in seconds, or null if failed
 */
function getVideoDuration(videoPath) {
  try {
    const output = execSyncSafe('ffprobe -v quiet -show_entries format=duration -of csv=p=0 {0}', { encoding: 'utf8' }, videoPath);
    return parseFloat(output.trim());
  } catch (error) {
    console.warn(`[Video Duration] Could not get duration for ${videoPath}: ${error.message}`);
    return null;
  }
}

/**
 * Get cached video duration to avoid repeated ffprobe calls
 * @param {string} videoPath - Path to video file
 * @returns {number|undefined} Cached duration in seconds
 */
function getCachedVideoDuration(videoPath) {
  if (!videoDurationCache.has(videoPath)) {
    const duration = getVideoDuration(videoPath);
    if (duration !== null) {
      videoDurationCache.set(videoPath, duration);
    }
  }
  return videoDurationCache.get(videoPath);
}

/**
 * Format time for FCPXML (e.g., "N/Ds") and quantize to frame boundaries
 * @param {number} timeInSeconds - Time in seconds
 * @param {number} fdNum - Frame duration numerator
 * @param {number} fdDen - Frame duration denominator
 * @param {boolean} ensureMinDuration - Ensure at least one frame duration
 * @returns {string} Formatted time string for FCPXML
 */
function formatTimeToFCPXML(timeInSeconds, fdNum, fdDen, ensureMinDuration = false) {
  if (ensureMinDuration && timeInSeconds <= 0) {
    timeInSeconds = fdNum / fdDen; // Ensure at least one frame duration
  }
  // Prevent NaN or negative results before rounding
  if (isNaN(timeInSeconds) || timeInSeconds < 0) timeInSeconds = 0;

  const numFrames = Math.round(timeInSeconds * fdDen / fdNum);
  return `${numFrames * fdNum}/${fdDen}s`;
}

/**
 * Generate Ken Burns effect pan rectangles for an image clip using FCP's adjust-crop format
 * @param {number} imageIndex - Index of the image (for variation)
 * @param {Object} previousEffect - Previous image's end state for smooth transitions
 * @returns {Object} Ken Burns pan rectangles (start and end)
 */
function generateKenBurnsEffect(imageIndex = 0, previousEffect = null) {
  // Define different Ken Burns movement patterns
  // Values are crop percentages: left, top, right, bottom
  // Smaller crop area = more zoomed in
  const patterns = [
    // Zoom in from center
    { type: 'zoom-in', direction: 'center', zoomStart: 10, zoomEnd: 0 },
    // Zoom in with left to right pan
    { type: 'zoom-in', direction: 'left-right', zoomStart: 12, zoomEnd: 0 },
    // Zoom in with right to left pan
    { type: 'zoom-in', direction: 'right-left', zoomStart: 12, zoomEnd: 0 },
    // Zoom in with top to bottom pan
    { type: 'zoom-in', direction: 'top-bottom', zoomStart: 10, zoomEnd: 0 },
    // Zoom in with bottom to top pan
    { type: 'zoom-in', direction: 'bottom-top', zoomStart: 10, zoomEnd: 0 },
    // Zoom out effect
    { type: 'zoom-out', direction: 'center', zoomStart: 0, zoomEnd: 15 },
    // Slow pan while staying zoomed
    { type: 'pan', direction: 'left-right', zoomStart: 5, zoomEnd: 5 },
    { type: 'pan', direction: 'right-left', zoomStart: 5, zoomEnd: 5 },
  ];

  // Select pattern with some variation but try to create flow
  let selectedPattern;

  // Every 4th image, do a zoom out or reset to create breathing room
  if (imageIndex % 4 === 3) {
    selectedPattern = patterns.find(p => p.type === 'zoom-out') || patterns[5];
  }
  // If previous effect ended zoomed in, sometimes continue with a pan or gentle zoom
  else if (previousEffect && isZoomedIn(previousEffect.end)) {
    const flowPatterns = patterns.filter(p => p.type === 'pan' || (p.type === 'zoom-in' && p.zoomEnd > 3));
    selectedPattern = flowPatterns[imageIndex % flowPatterns.length] || patterns[imageIndex % patterns.length];
  }
  // Otherwise, use regular variation
  else {
    selectedPattern = patterns[imageIndex % patterns.length];
  }

  // Generate start and end rectangles based on pattern
  let start, end;

  // If we have a previous effect that ended zoomed, try to start from a similar zoom level
  if (previousEffect && isZoomedIn(previousEffect.end) && selectedPattern.type !== 'zoom-out') {
    start = createSmoothTransition(previousEffect.end, selectedPattern);
  } else {
    start = createRectFromPattern(selectedPattern, 'start');
  }

  end = createRectFromPattern(selectedPattern, 'end');

  return { start, end, pattern: selectedPattern };
}

/**
 * Check if a rectangle represents a zoomed-in state
 * @param {Object} rect - Rectangle with left, right, top, bottom properties
 * @returns {boolean} True if the rectangle is considered zoomed in
 */
function isZoomedIn(rect) {
  const totalCrop = rect.left + rect.right + rect.top + rect.bottom;
  return totalCrop > 8; // Arbitrary threshold for "zoomed in"
}

/**
 * Create a smooth transition from previous end to new pattern
 * @param {Object} previousEnd - Previous effect's end rectangle
 * @param {Object} pattern - New pattern to transition to
 * @returns {Object} Rectangle for smooth transition
 */
function createSmoothTransition(previousEnd, pattern) {
  // Start with a similar zoom level but maybe shift position slightly
  const avgCrop = (previousEnd.left + previousEnd.right + previousEnd.top + previousEnd.bottom) / 4;

  switch (pattern.direction) {
    case 'left-right':
      return { left: avgCrop + 2, top: avgCrop, right: avgCrop - 2, bottom: avgCrop };
    case 'right-left':
      return { left: avgCrop - 2, top: avgCrop, right: avgCrop + 2, bottom: avgCrop };
    case 'top-bottom':
      return { left: avgCrop, top: avgCrop + 2, right: avgCrop, bottom: avgCrop - 2 };
    case 'bottom-top':
      return { left: avgCrop, top: avgCrop - 2, right: avgCrop, bottom: avgCrop + 2 };
    default:
      return { left: avgCrop, top: avgCrop, right: avgCrop, bottom: avgCrop };
  }
}

/**
 * Create rectangle from pattern and phase (start/end)
 * @param {Object} pattern - Ken Burns pattern with type, direction, and zoom values
 * @param {string} phase - 'start' or 'end'
 * @returns {Object} Rectangle with left, top, right, bottom properties
 */
function createRectFromPattern(pattern, phase) {
  const isStart = phase === 'start';
  const zoom = isStart ? pattern.zoomStart : pattern.zoomEnd;

  switch (pattern.direction) {
    case 'center':
      return { left: zoom, top: zoom, right: zoom, bottom: zoom };

    case 'left-right':
      if (pattern.type === 'pan') {
        return isStart
          ? { left: zoom + 3, top: zoom, right: zoom - 3, bottom: zoom }
          : { left: zoom - 3, top: zoom, right: zoom + 3, bottom: zoom };
      } else {
        return isStart
          ? { left: zoom + 3, top: zoom, right: zoom - 3, bottom: zoom }
          : { left: zoom - 3, top: zoom, right: zoom + 3, bottom: zoom };
      }

    case 'right-left':
      if (pattern.type === 'pan') {
        return isStart
          ? { left: zoom - 3, top: zoom, right: zoom + 3, bottom: zoom }
          : { left: zoom + 3, top: zoom, right: zoom - 3, bottom: zoom };
      } else {
        return isStart
          ? { left: zoom - 3, top: zoom, right: zoom + 3, bottom: zoom }
          : { left: zoom + 3, top: zoom, right: zoom - 3, bottom: zoom };
      }

    case 'top-bottom':
      return isStart
        ? { left: zoom, top: zoom + 3, right: zoom, bottom: zoom - 3 }
        : { left: zoom, top: zoom - 3, right: zoom, bottom: zoom + 3 };

    case 'bottom-top':
      return isStart
        ? { left: zoom, top: zoom - 3, right: zoom, bottom: zoom + 3 }
        : { left: zoom, top: zoom + 3, right: zoom, bottom: zoom - 3 };

    default:
      return { left: zoom, top: zoom, right: zoom, bottom: zoom };
  }
}

/**
 * Exports an FCPXML timeline based on generated segments and timeline mapping.
 * Includes comprehensive flash clip prevention with video duration validation that
 * prioritizes video boundaries over minimum duration requirements.
 * @param {string} segmentsPath - Path to segments.json
 * @param {string} timelinePath - Path to timeline.json
 * @param {string} outputPath - Path to output .fcpxml file
 * @param {string} projectBaseName - Base name for the project and event (default: 'Generated')
 * @param {number} minDurationSeconds - Minimum duration for clips in seconds (default: 3)
 * @param {boolean} enableKenBurns - Whether to add Ken Burns effects to image clips (default: true)
 */
export async function exportFcpXml(segmentsPath, timelinePath, outputPath, projectBaseName = 'Generated', minDurationSeconds = 3, enableKenBurns = true) {
  console.log(`📊 Loading timeline data from: ${timelinePath}`);
  console.log(`⏱️  Minimum clip duration: ${minDurationSeconds}s`);
  console.log(`🎬 Ken Burns effects: ${enableKenBurns ? 'enabled' : 'disabled'}`);
  
  const segments = JSON.parse(fs.readFileSync(segmentsPath, 'utf-8'));
  const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf-8'));

  // Enhanced zero-duration segment detection and fixing
  const MIN_SEGMENT_DURATION = 0.1; // 100ms minimum duration
  let fixedSegments = 0;

  console.log(`[Timeline Exporter] Validating ${segments.length} segments for zero-duration issues...`);

  segments.forEach((segment, index) => {
    const duration = segment.end - segment.start;
    if (duration <= 0) {
      fixedSegments++;
      console.warn(`[Zero Duration Fix] Segment ${segment.id} had ${duration <= 0 ? 'zero/negative' : 'insufficient'} duration (${duration.toFixed(4)}s). Fixing...`);

      // Calculate safe extension without overlapping next segment
      if (index < segments.length - 1) {
        const nextSegment = segments[index + 1];
        const gapToNext = nextSegment.start - segment.start;

        if (gapToNext > MIN_SEGMENT_DURATION) {
          // Safe to extend to minimum duration
          segment.end = segment.start + MIN_SEGMENT_DURATION;
        } else if (gapToNext > 0) {
          // Use 80% of available gap to prevent overlap
          segment.end = segment.start + (gapToNext * 0.8);
        } else {
          // Next segment starts at same time or earlier - use minimum duration anyway
          segment.end = segment.start + MIN_SEGMENT_DURATION;
          console.warn(`[Zero Duration Fix] Warning: Segment ${segment.id} may overlap with segment ${nextSegment.id}`);
        }
      } else {
        // Last segment, safe to extend
        segment.end = segment.start + MIN_SEGMENT_DURATION;
      }

      console.warn(`[Zero Duration Fix] Segment ${segment.id} duration fixed to ${(segment.end - segment.start).toFixed(4)}s`);
    } else if (duration < MIN_SEGMENT_DURATION) {
      // Also fix segments that are too short (but not zero)
      fixedSegments++;
      console.warn(`[Duration Enhancement] Segment ${segment.id} duration ${duration.toFixed(4)}s below minimum. Extending to ${MIN_SEGMENT_DURATION}s`);

      if (index < segments.length - 1) {
        const nextSegment = segments[index + 1];
        const gapToNext = nextSegment.start - segment.end;
        const extensionNeeded = MIN_SEGMENT_DURATION - duration;

        if (gapToNext >= extensionNeeded) {
          segment.end = segment.start + MIN_SEGMENT_DURATION;
        } else {
          // Extend as much as safe
          segment.end += Math.max(gapToNext * 0.8, 0.01); // At least 10ms extension
        }
      } else {
        segment.end = segment.start + MIN_SEGMENT_DURATION;
      }

      console.warn(`[Duration Enhancement] Segment ${segment.id} duration enhanced to ${(segment.end - segment.start).toFixed(4)}s`);
    }
  });

  if (fixedSegments > 0) {
    console.warn(`[Timeline Exporter] Fixed ${fixedSegments} segments with duration issues`);
  } else {
    console.log(`[Timeline Exporter] ✅ All segments have valid durations`);
  }

  // Compute usage durations per asset for resource durations
  const assetUsage = {}; // Stores max used time for each asset
  timeline.forEach(entry => {
    const { assetPath, segmentId, assetType, frameTimestamp } = entry;
    const segment = segments.find(s => s.id === segmentId);

    if (!segment || typeof segment.start !== 'number' || typeof segment.end !== 'number') {
      console.warn(`[Asset Usage] Skipping timeline entry: Segment data for ID '${segmentId}' (asset '${assetPath}') is missing or invalid.`);
      return; // Skip this entry if segment data is problematic
    }

    const clipDuration = segment.end - segment.start;

    if (isNaN(clipDuration) || clipDuration < 0) {
      console.warn(`[Asset Usage] Skipping timeline entry: Invalid clip duration (${clipDuration}) for segment ID '${segmentId}' (asset '${assetPath}').`);
      return; // Skip this entry if clip duration is invalid
    }

    const currentFrameTimestamp = (assetType === 'video' && typeof frameTimestamp === 'number') ? frameTimestamp : 0;
    const usedEndForThisClip = currentFrameTimestamp + clipDuration;

    if (isNaN(usedEndForThisClip)) {
      console.warn(`[Asset Usage] Skipping timeline entry: Calculated usedEnd is NaN for asset '${assetPath}', segment ID '${segmentId}'.`);
      return; // Skip if usedEnd is NaN (should be caught by earlier checks)
    }

    // Initialize or update the maximum used duration for this asset
    assetUsage[assetPath] = Math.max(assetUsage[assetPath] || 0, usedEndForThisClip);
  });

  // Compute total duration in seconds
  const totalDuration = segments.reduce((sum, s) => sum + (s.end - s.start), 0);

  // Build XML document
  const xmlDoc = create({ version: '1.0', encoding: 'UTF-8' });
  const fcpxml = xmlDoc.ele('fcpxml', { version: '1.13' });

  // Resources: format + assets
  const resources = fcpxml.ele('resources');
  const mainFormat = {
    id: 'r1',
    name: 'FFVideoFormat1080p30',
    frameDuration: '1001/30000s', // Standard NTSC frame rate (29.97 fps)
    width: '1920',
    height: '1080'
  };
  resources.ele('format', mainFormat);

  // Note: Ken Burns effects use adjust-crop with pan-rect elements, not transform parameters

  // Parse frame duration for quantization
  const [fdNumStr, fdDenStrWithS] = mainFormat.frameDuration.split('/');
  const fdNum = parseInt(fdNumStr);
  const fdDen = parseInt(fdDenStrWithS.slice(0, -1)); // Remove 's' and parse

  // Define media assets
  const assetIds = {};
  Object.keys(assetUsage).forEach((assetPath, idx) => {
    const assetResourceId = `r${idx + 2}`; // r1 is the format, assets start from r2
    assetIds[assetPath] = assetResourceId; // Populate map for spine references

    const firstTimelineEntryForAsset = timeline.find(e => e.assetPath === assetPath);
    const assetType = firstTimelineEntryForAsset ? firstTimelineEntryForAsset.assetType : 'image';
    const isImage = assetType === 'image';

    const resolvedAssetPath = path.resolve(assetPath);
    // Create a deterministic UID based on the asset's absolute path
    const hash = createHash('sha1').update(resolvedAssetPath).digest('hex');
    // FCPXML UIDs are often 32-character uppercase hex strings, but can vary.
    // Taking first 32 chars of SHA1 hash and uppercasing.
    const deterministicUid = hash.substring(0, 32).toUpperCase();

    const fileUrl = encodeURI(`file://${resolvedAssetPath}`); // Use resolvedAssetPath for consistency

    let assetAttributes = {
      id: assetResourceId,
      name: path.basename(assetPath),
      start: '0s',
      uid: deterministicUid, // Use the deterministic UID
    };

    if (isImage) {
      assetAttributes.duration = '0s'; // Images in resources have 0s duration
      assetAttributes.hasVideo = '1';
      assetAttributes.videoSources = '1';
      assetAttributes.format = 'r1'; // Use the sequence format so imported stills fit the generated timeline.
    } else { // Is Video
      let effectiveAssetDuration = assetUsage[assetPath];
      // Video asset duration in resources should be positive.
      // This duration is the total used portion of the video file.
      assetAttributes.duration = formatTimeToFCPXML(effectiveAssetDuration, fdNum, fdDen, true);
      assetAttributes.hasVideo = '1';
      assetAttributes.format = 'r1';
    }

    const assetEl = resources.ele('asset', assetAttributes);
    assetEl.ele('media-rep', {
      kind: 'original-media',
      src: fileUrl
      // sig: example.xml has 'sig' attribute here. Potentially a checksum or unique ID.
    });
  });

  // Library / Event / Project / Sequence
  const library = fcpxml.ele('library');
  const eventName = projectBaseName && projectBaseName !== 'Generated' ? `${projectBaseName} Event` : 'GeneratedEvent';
  const projectName = projectBaseName && projectBaseName !== 'Generated' ? `${projectBaseName} Project` : 'GeneratedProject';

  const event = library.ele('event', { name: eventName });
  const project = event.ele('project', { name: projectName });

  // Calculate total sequence duration by summing quantized clip durations
  let calculatedTotalDurationInSeconds = 0;
  timeline.forEach(entry => {
    const segment = segments.find(s => s.id === entry.segmentId);
    if (segment) {
      let clipDurationSec = segment.end - segment.start;

      // Apply the same minimum duration logic as in spine population
      if (clipDurationSec < minDurationSeconds) {
        clipDurationSec = minDurationSeconds;
      }

      if (clipDurationSec <= 0) {
        clipDurationSec = Math.max(fdNum / fdDen, minDurationSeconds); // Use the larger of 1 frame or minDuration
      }

      calculatedTotalDurationInSeconds += clipDurationSec; // Sum of effective seconds
    }
  });


  const sequence = project.ele('sequence', {
    format: 'r1',
    duration: formatTimeToFCPXML(calculatedTotalDurationInSeconds, fdNum, fdDen), // Quantized total duration
    tcStart: '0s', // Assuming 0s tcStart, could also be quantized if different
    tcFormat: 'NDF', // Non-Drop Frame
    audioLayout: 'stereo',
    audioRate: '48k'
  });
  const spine = sequence.ele('spine');

  // Populate spine with asset-clip elements
  let currentPositionSec = 0;
  let imageIndex = 0; // Track image clips for Ken Burns variation
  let previousKenBurns = null; // Track previous Ken Burns effect for smooth transitions

  timeline.forEach(entry => {
    const segment = segments.find(s => s.id === entry.segmentId);
    // Skip if segment not found, though this should ideally not happen
    if (!segment) {
      console.warn(`[Spine Population] Segment ID '${entry.segmentId}' not found. Skipping clip for asset '${entry.assetPath}'.`);
      return;
    }

    let spineClipDurationSec = segment.end - segment.start;
    const originalDuration = spineClipDurationSec;

    // Enhanced duration validation with multiple layers of protection
    // Priority order: 1) Prevent zero/negative durations (flash fix), 2) Video boundaries, 3) User minimums
    const MINIMUM_CLIP_DURATION = Math.max(fdNum / fdDen, 0.033); // At least 1 frame or 33ms (30fps frame)

    // Layer 1: Check for zero or negative duration (critical flash bug prevention)
    if (spineClipDurationSec <= 0) {
      console.error(`[Spine Population] CRITICAL: Segment ID '${entry.segmentId}' has ${spineClipDurationSec <= 0 ? 'zero/negative' : 'invalid'} duration (${originalDuration.toFixed(4)}s). This causes FCP flashes!`);
      spineClipDurationSec = Math.max(MINIMUM_CLIP_DURATION, minDurationSeconds);
      console.warn(`[Spine Population] Fixed segment ${entry.segmentId} duration: ${originalDuration.toFixed(4)}s → ${spineClipDurationSec.toFixed(4)}s`);
    }

    // Layer 2: Apply minimum duration for non-video clips or when not conflicting with video bounds
    // (Video boundary validation will override this later if needed)
    else if (spineClipDurationSec < minDurationSeconds && entry.assetType !== 'video') {
      console.warn(`[Spine Population] Image segment ${entry.segmentId} duration ${originalDuration.toFixed(2)}s below minimum ${minDurationSeconds}s. Extending to minimum.`);
      spineClipDurationSec = minDurationSeconds;
    }
    else if (spineClipDurationSec < minDurationSeconds && entry.assetType === 'video') {
      // For video clips, tentatively apply minimum but video bounds check will override if needed
      console.warn(`[Spine Population] Video segment ${entry.segmentId} duration ${originalDuration.toFixed(2)}s below minimum ${minDurationSeconds}s. Will extend unless video bounds prevent it.`);
      spineClipDurationSec = minDurationSeconds;
    }

    // Layer 3: Ensure at least one frame duration (technical minimum)
    else if (spineClipDurationSec < MINIMUM_CLIP_DURATION) {
      console.warn(`[Spine Population] Segment ID '${entry.segmentId}' duration ${originalDuration.toFixed(4)}s below technical minimum (1 frame). Extending to ${MINIMUM_CLIP_DURATION.toFixed(4)}s.`);
      spineClipDurationSec = MINIMUM_CLIP_DURATION;
    }

    // Final validation
    if (spineClipDurationSec <= 0 || isNaN(spineClipDurationSec)) {
      console.error(`[Spine Population] EMERGENCY: Could not fix duration for segment ${entry.segmentId}. Using fallback duration.`);
      spineClipDurationSec = minDurationSeconds;
    }

    // Video duration validation - prevent clips from extending beyond actual video file length
    // For video clips, prioritize staying within video bounds over minimum duration requirements
    if (entry.assetType === 'video' && entry.frameTimestamp !== null && entry.frameTimestamp !== undefined) {
      const frameTimestampSec = parseFloat(entry.frameTimestamp);
      if (!isNaN(frameTimestampSec)) {
        // Get actual video duration
        const videoDuration = getCachedVideoDuration(entry.assetPath);
        if (videoDuration !== undefined && videoDuration !== null) {
          const proposedClipEnd = frameTimestampSec + spineClipDurationSec;

          if (proposedClipEnd > videoDuration) {
            const maxPossibleDuration = videoDuration - frameTimestampSec;
            console.warn(`[Video Validation] Clip for ${path.basename(entry.assetPath)} would extend beyond video end`);
            console.warn(`  Start: ${frameTimestampSec.toFixed(2)}s, Requested: ${spineClipDurationSec.toFixed(2)}s, Video: ${videoDuration.toFixed(2)}s`);
            console.warn(`  Proposed end: ${proposedClipEnd.toFixed(2)}s > Video end: ${videoDuration.toFixed(2)}s`);

            if (maxPossibleDuration > MINIMUM_CLIP_DURATION) {
              // Trim clip to fit within video bounds - prioritize video boundary over minimum duration
              spineClipDurationSec = maxPossibleDuration;
              console.warn(`  ✅ Trimmed to maximum available duration: ${maxPossibleDuration.toFixed(2)}s`);
            } else if (maxPossibleDuration > 0) {
              // Very short remaining duration - still use it to avoid extending beyond video
              spineClipDurationSec = maxPossibleDuration;
              console.warn(`  ⚠️ Using short duration ${maxPossibleDuration.toFixed(3)}s (video boundary takes priority)`);
            } else {
              // Start point is at or beyond video end - this shouldn't happen
              console.error(`  ❌ ERROR: Start point ${frameTimestampSec.toFixed(2)}s >= video duration ${videoDuration.toFixed(2)}s`);
              console.error(`  🔧 Fallback: Moving start to video beginning`);
              spineClipDurationSec = Math.min(minDurationSeconds, videoDuration);
              // frameTimestamp will be adjusted below in clipAttrs section
            }
          }
        } else {
          console.warn(`[Video Validation] Could not determine duration for ${entry.assetPath} - unable to validate clip bounds`);
        }
      }
    }

    const clipAttrs = {
      name: path.basename(entry.assetPath),
      offset: formatTimeToFCPXML(currentPositionSec, fdNum, fdDen),
      ref: assetIds[entry.assetPath],
      duration: formatTimeToFCPXML(spineClipDurationSec, fdNum, fdDen)
    };

    if (entry.assetType === 'video' && entry.frameTimestamp !== null && entry.frameTimestamp !== undefined) {
      const frameTimestampSec = parseFloat(entry.frameTimestamp);
      if (!isNaN(frameTimestampSec)) {
        // Additional check: if we had to reset due to invalid start point, adjust to beginning
        const videoDuration = getCachedVideoDuration(entry.assetPath);
        if (videoDuration !== undefined && frameTimestampSec >= videoDuration) {
          console.warn(`[Video Validation] Adjusting invalid start time ${frameTimestampSec.toFixed(2)}s to 0s for ${path.basename(entry.assetPath)}`);
          clipAttrs.start = formatTimeToFCPXML(0, fdNum, fdDen);
        } else {
          clipAttrs.start = formatTimeToFCPXML(frameTimestampSec, fdNum, fdDen);
        }
      } else {
        console.warn(`[Spine Population] Invalid frameTimestamp \'${entry.frameTimestamp}\' for video asset \'${entry.assetPath}\'. Omitting 'start' attribute.`);
      }
    }

    const videoElement = spine.ele(entry.assetType === 'video' ? 'video' : 'video', clipAttrs); // Still images are also <video> in FCPXML spine apparently

    // Add Ken Burns effect to image clips using FCP's adjust-crop format
    if (enableKenBurns && entry.assetType === 'image') {
      const kenBurns = generateKenBurnsEffect(imageIndex, previousKenBurns);

      // Use FCP's adjust-crop element with pan-rect for Ken Burns effect
      const adjustCrop = videoElement.ele('adjust-crop', { mode: 'pan' });

      // Start pan rectangle (more cropped = zoomed in)
      adjustCrop.ele('pan-rect', {
        left: kenBurns.start.left,
        top: kenBurns.start.top,
        right: kenBurns.start.right,
        bottom: kenBurns.start.bottom
      });

      // End pan rectangle
      adjustCrop.ele('pan-rect', {
        left: kenBurns.end.left,
        top: kenBurns.end.top,
        right: kenBurns.end.right,
        bottom: kenBurns.end.bottom
      });

      console.log(`[Ken Burns] Applied ${kenBurns.pattern.type} ${kenBurns.pattern.direction} effect to image ${path.basename(entry.assetPath)} - Start: ${kenBurns.start.left},${kenBurns.start.top},${kenBurns.start.right},${kenBurns.start.bottom} -> End: ${kenBurns.end.left},${kenBurns.end.top},${kenBurns.end.right},${kenBurns.end.bottom}`);

      // Store this effect for the next image
      previousKenBurns = kenBurns;
      imageIndex++;
    }

    currentPositionSec += spineClipDurationSec; // Accumulate effective duration in seconds
  });

  // Write out XML
  let xmlString = xmlDoc.end({ prettyPrint: true });
  xmlString = xmlString.replace(
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>'
  );
  fs.writeFileSync(outputPath, xmlString, 'utf-8');
}

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , segmentsPath, timelinePath, outputPath, cliProjectBaseName, minDurationStr, kenBurnsStr] = process.argv;
  const minDurationSeconds = minDurationStr ? parseFloat(minDurationStr) : 3; // Default to 3 seconds
  const enableKenBurns = kenBurnsStr !== 'false'; // Default to true, set false if explicitly specified
  exportFcpXml(segmentsPath, timelinePath, outputPath, cliProjectBaseName || 'Script', minDurationSeconds, enableKenBurns) // Default to "Script" if not provided via CLI
    .then(() => console.log(`FCPXML timeline written to ${outputPath} with minimum clip duration of ${minDurationSeconds}s${enableKenBurns ? ' and Ken Burns effects enabled' : ''}`))
    .catch(console.error);
}
