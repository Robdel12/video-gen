#!/usr/bin/env node

import { Command } from 'commander';
import { normalizeAssetFilenames, processAssets } from './asset-processor.js';
import { parseScript } from './script-parser.js';
import { mapSegments } from './segment-mapper.js';
import { exportFcpXml } from './timeline-exporter.js';
import { validateProjectStructure, createProjectStructure, findVoiceoverFile, generateProjectTitle } from './utils/project-utils.js';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (one level up from src/)
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const program = new Command();

program
  .name('video-gen')
  .description('AI-powered tool to create documentary-style video timelines from assets and voiceover')
  .version('1.0.0');

/**
 * Initialize a new video project in the current directory
 */
program
  .command('init')
  .description('Create project structure with assets/ directory and README')
  .option('-f, --force', 'Overwrite existing project structure')
  .action(async (options) => {
    const projectDir = process.cwd();
    await createProjectStructure(projectDir, options.force);
    console.log('✅ Project initialized successfully!');
    console.log('\nNext steps:');
    console.log('1. Export your OpenAI API key: export OPENAI_API_KEY=your_api_key_here');
    console.log('2. Add your audio file (voiceover.mp3, audio.wav, etc.) to the project root');
    console.log('3. Add your image/video assets to the assets/ directory');
    console.log('4. Run "video-gen generate" to create your timeline');
  });

/**
 * Validate the current project structure
 */
program
  .command('validate')
  .description('Check if project has required assets/ directory and voiceover audio file')
  .option('--audio <path>', 'Custom audio file path to validate')
  .action(async (options) => {
    const projectDir = process.cwd();
    try {
      const validation = await validateProjectStructure(projectDir, options.audio);

      if (validation.isValid) {
        console.log('✅ Project structure is valid!');
        console.log(`📁 Assets directory: ${validation.assetsDir}`);
        console.log(`🎵 Voiceover file: ${validation.voiceoverPath}`);
        console.log(`📊 Found ${validation.assetCount} assets`);
      } else {
        console.log('❌ Project structure issues found:');
        validation.errors.forEach(error => console.log(`  • ${error}`));

        if (validation.warnings.length > 0) {
          console.log('\n⚠️  Warnings:');
          validation.warnings.forEach(warning => console.log(`  • ${warning}`));
        }

        console.log('\nRun "video-gen init" to set up the project structure.');
        process.exit(1);
      }
    } catch (error) {
      console.error('Error validating project:', error.message);
      process.exit(1);
    }
  });

/**
 * Generate the complete video timeline
 */
program
  .command('generate')
  .description('Run full pipeline: analyze assets, transcribe audio, map segments, export FCPXML')
  .option('-r, --run-id [id]', 'Specify a run ID (auto-generated if not provided)')
  .option('--skip-validation', 'Skip project structure validation')
  .option('--force-all', 'Force regeneration of all artifacts')
  .option('--min-duration <seconds>', 'Minimum clip duration in seconds', '3')
  .option('--target-segment-duration <seconds>', 'Target segment duration in seconds', '10')
  .option('--audio <path>', 'Custom audio file path (defaults to auto-detect)')
  .option('--title <title>', 'Custom project title')
  .action(async (options) => {
    await executeFullPipeline(options);
  });

/**
 * Process assets only
 */
program
  .command('assets')
  .description('Analyze images and videos in assets/ folder using OpenAI Vision API')
  .option('-r, --run-id <id>', 'Specify a run ID (defaults to "current")')
  .option('--skip-validation', 'Skip project structure validation')
  .option('--force', 'Force regeneration of assets.json')
  .action(async (options) => {
    await executeSingleStep('assets', options);
  });

/**
 * Process voiceover/segments only
 */
program
  .command('voiceover')
  .alias('segments')
  .description('Transcribe audio using OpenAI Whisper and create timed segments')
  .option('-r, --run-id <id>', 'Specify a run ID (defaults to "current")')
  .option('--skip-validation', 'Skip project structure validation')
  .option('--force', 'Force regeneration of segments.json')
  .option('--target-segment-duration <seconds>', 'Target segment duration in seconds', '10')
  .option('--audio <path>', 'Custom audio file path (defaults to auto-detect)')
  .action(async (options) => {
    await executeSingleStep('segments', options);
  });

/**
 * Map segments to assets only
 */
program
  .command('mapping')
  .alias('map')
  .description('Use AI to intelligently match audio segments with appropriate visual assets')
  .option('-r, --run-id <id>', 'Specify a run ID (defaults to "current")')
  .option('--skip-validation', 'Skip project structure validation')
  .option('--force', 'Force regeneration of timeline.json')
  .action(async (options) => {
    await executeSingleStep('mapping', options);
  });

/**
 * Export FCPXML timeline only
 */
program
  .command('export')
  .alias('xml')
  .description('Generate Final Cut Pro XML timeline from mapped segments and assets')
  .option('-r, --run-id <id>', 'Specify a run ID (defaults to "current")')
  .option('--skip-validation', 'Skip project structure validation')
  .option('--force', 'Always regenerate FCPXML')
  .option('--min-duration <seconds>', 'Minimum clip duration in seconds', '3')
  .option('--title <title>', 'Custom project title')
  .action(async (options) => {
    await executeSingleStep('export', options);
  });

/**
 * List all runs in the current project
 */
program
  .command('list')
  .description('Show all pipeline runs with timestamps and generated artifacts')
  .option('--detail', 'Show detailed information about each run')
  .action(async (options) => {
    const projectDir = process.cwd();
    const artifactsDir = path.join(projectDir, 'artifacts');

    try {
      await fs.access(artifactsDir);
      const runs = await fs.readdir(artifactsDir, { withFileTypes: true });
      const runDirs = runs.filter(entry => entry.isDirectory()).map(entry => entry.name);

      if (runDirs.length === 0) {
        console.log('No runs found in this project.');
        return;
      }

      console.log(`Found ${runDirs.length} run(s) in this project:\n`);

      for (const runId of runDirs.sort()) {
        const runDir = path.join(artifactsDir, runId);
        const stats = await fs.stat(runDir);

        if (options.detail) {
          console.log(`📁 Run: ${runId}`);
          console.log(`   Created: ${stats.mtime.toLocaleString()}`);

          // Check which artifacts exist
          const artifacts = ['assets.json', 'segments.json', 'timeline.json', 'generated-timeline.fcpxml'];
          const existingArtifacts = [];

          for (const artifact of artifacts) {
            try {
              await fs.access(path.join(runDir, artifact));
              existingArtifacts.push(artifact);
            } catch {
              // Artifact doesn't exist
            }
          }

          console.log(`   Artifacts: ${existingArtifacts.join(', ')}`);
          console.log();
        } else {
          console.log(`${runId} (${stats.mtime.toLocaleDateString()})`);
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No artifacts directory found. Run "video-gen generate" first.');
      } else {
        console.error('Error listing runs:', error.message);
      }
    }
  });

/**
 * Clean up artifacts
 */
program
  .command('clean')
  .description('Remove generated artifacts, run directories, or Whisper transcription cache')
  .option('--run-id <id>', 'Clean specific run ID')
  .option('--all', 'Clean all runs')
  .option('--cache', 'Clean Whisper cache')
  .action(async (options) => {
    const projectDir = process.cwd();

    if (options.cache) {
      // Clean both old cache location and new artifact-based caches
      const oldCachePath = path.join(projectDir, 'whisper_cache.json');
      const artifactsDir = path.join(projectDir, 'artifacts');
      let cachesCleaned = 0;

      // Clean old cache location
      try {
        await fs.unlink(oldCachePath);
        console.log('✅ Old Whisper cache cleaned');
        cachesCleaned++;
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Error cleaning old cache:', error.message);
        }
      }

      // Clean cache files in artifacts directory
      try {
        const runs = await fs.readdir(artifactsDir, { withFileTypes: true });
        for (const run of runs) {
          if (run.isDirectory()) {
            const cachePath = path.join(artifactsDir, run.name, 'whisper_cache.json');
            try {
              await fs.unlink(cachePath);
              console.log(`✅ Whisper cache cleaned for run: ${run.name}`);
              cachesCleaned++;
            } catch (error) {
              if (error.code !== 'ENOENT') {
                console.error(`Error cleaning cache for run ${run.name}:`, error.message);
              }
            }
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error('Error accessing artifacts directory:', error.message);
        }
      }

      if (cachesCleaned === 0) {
        console.log('No Whisper cache files found');
      }
    }

    if (options.all) {
      const artifactsDir = path.join(projectDir, 'artifacts');
      try {
        await fs.rm(artifactsDir, { recursive: true, force: true });
        console.log('✅ All artifacts cleaned');
      } catch (error) {
        console.error('Error cleaning artifacts:', error.message);
      }
    } else if (options.runId) {
      const runDir = path.join(projectDir, 'artifacts', options.runId);
      try {
        await fs.rm(runDir, { recursive: true });
        console.log(`✅ Run ${options.runId} cleaned`);
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log(`Run ${options.runId} not found`);
        } else {
          console.error('Error cleaning run:', error.message);
        }
      }
    } else {
      console.log('Specify --all, --run-id <id>, or --cache to clean artifacts');
    }
  });

/**
 * Normalize asset filenames
 */
program
  .command('normalize')
  .description('Normalize asset filenames by replacing spaces and special characters with dashes')
  .option('--dry-run', 'Show what would be changed without making changes')
  .option('--assets-dir <dir>', 'Assets directory to normalize (defaults to "assets")')
  .action(async (options) => {
    const projectDir = process.cwd();
    const assetsDir = options.assetsDir || path.join(projectDir, 'assets');

    try {
      console.log(`🔧 ${options.dryRun ? 'Analyzing' : 'Normalizing'} asset filenames...`);
      const results = await normalizeAssetFilenames(assetsDir, options.dryRun);

      if (options.dryRun && results.changes.length > 0) {
        console.log(`\n💡 To apply these changes, run: video-gen normalize`);
        console.log(`⚠️  Note: Original files will be kept - normalized copies will be created`);
      }

    } catch (error) {
      console.error('❌ Error normalizing filenames:', error.message);
      process.exit(1);
    }
  });


/**
 * Execute a single step of the pipeline
 */
async function executeSingleStep(stepName, options) {
  const projectDir = process.cwd();

  try {
    // Validate project structure unless skipped
    if (!options.skipValidation) {
      const validation = await validateProjectStructure(projectDir, options.audio);
      if (!validation.isValid) {
        console.log('❌ Project structure issues found:');
        validation.errors.forEach(error => console.log(`  • ${error}`));
        process.exit(1);
      }
    }

    // Use provided run ID or default to "current" for single steps
    const runId = options.runId || 'current';
    const artifactsDir = path.join(projectDir, 'artifacts', runId);
    await fs.mkdir(artifactsDir, { recursive: true });

    console.log(`🚀 Executing step: ${stepName}`);
    console.log(`📁 Project: ${path.basename(projectDir)}`);
    console.log(`🔖 Run ID: ${runId}`);
    console.log();

    // Execute the specific step
    switch (stepName) {
    case 'assets':
      await executeAssetsStep(projectDir, artifactsDir, options);
      break;
    case 'segments':
      await executeSegmentsStep(projectDir, artifactsDir, options);
      break;
    case 'mapping':
      await executeMappingStep(projectDir, artifactsDir, options);
      break;
    case 'export':
      await executeExportStep(projectDir, artifactsDir, options);
      break;
    default:
      throw new Error(`Unknown step: ${stepName}`);
    }

    console.log(`\n✅ Step '${stepName}' completed successfully!`);
    console.log(`📁 Artifacts saved to: artifacts/${runId}/`);

  } catch (error) {
    console.error(`❌ Step '${stepName}' failed:`, error.message);
    process.exit(1);
  }
}

/**
 * Execute the full pipeline
 */
async function executeFullPipeline(options) {
  const projectDir = process.cwd();

  try {
    // Validate project structure unless skipped
    if (!options.skipValidation) {
      const validation = await validateProjectStructure(projectDir, options.audio);
      if (!validation.isValid) {
        console.log('❌ Project structure issues found:');
        validation.errors.forEach(error => console.log(`  • ${error}`));
        process.exit(1);
      }
    }

    // Generate or use provided run ID
    const runId = options.runId || generateRunId();
    const artifactsDir = path.join(projectDir, 'artifacts', runId);
    await fs.mkdir(artifactsDir, { recursive: true });

    // Get voiceover file for project title generation
    let voiceoverFile;
    try {
      if (options.audio) {
        if (path.isAbsolute(options.audio)) {
          voiceoverFile = options.audio;
        } else {
          voiceoverFile = path.resolve(projectDir, options.audio);
        }
      } else {
        voiceoverFile = await findVoiceoverFile(projectDir);
      }
    } catch (error) {
      voiceoverFile = 'voiceover.mp3'; // Fallback
    }

    const projectTitle = await generateProjectTitle(projectDir, voiceoverFile, options.title);

    console.log(`🚀 Starting video generation pipeline`);
    console.log(`📁 Project: ${projectTitle}`);
    console.log(`🔖 Run ID: ${runId}`);
    console.log();

    const startTime = Date.now();

    // Step 1: Process Assets
    console.log('🔄 Step 1: Processing visual assets...');
    const step1Start = Date.now();
    await executeAssetsStep(projectDir, artifactsDir, options);
    const step1Duration = ((Date.now() - step1Start) / 1000).toFixed(1);
    console.log(`✅ Step 1 completed in ${step1Duration}s\n`);

    // Step 2: Process Voiceover/Segments
    console.log('🔄 Step 2: Transcribing voiceover and creating segments...');
    const step2Start = Date.now();
    await executeSegmentsStep(projectDir, artifactsDir, options);
    const step2Duration = ((Date.now() - step2Start) / 1000).toFixed(1);
    console.log(`✅ Step 2 completed in ${step2Duration}s\n`);

    // Step 3: Map Segments to Assets
    console.log('🔄 Step 3: Mapping audio segments to visual assets...');
    const step3Start = Date.now();
    await executeMappingStep(projectDir, artifactsDir, options);
    const step3Duration = ((Date.now() - step3Start) / 1000).toFixed(1);
    console.log(`✅ Step 3 completed in ${step3Duration}s\n`);

    // Step 4: Export FCPXML
    console.log('🔄 Step 4: Exporting FCPXML timeline...');
    const step4Start = Date.now();
    await executeExportStep(projectDir, artifactsDir, options);
    const step4Duration = ((Date.now() - step4Start) / 1000).toFixed(1);
    console.log(`✅ Step 4 completed in ${step4Duration}s\n`);

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log(`\n🎉 Pipeline completed successfully in ${totalDuration}s!`);
    console.log(`📁 Artifacts saved to: artifacts/${runId}/`);
    console.log(`🎬 Timeline: artifacts/${runId}/generated-timeline.fcpxml`);

  } catch (error) {
    console.error('❌ Pipeline failed:', error.message);
    process.exit(1);
  }
}

/**
 * Execute the assets processing step
 */
async function executeAssetsStep(projectDir, artifactsDir, options) {
  const assetsDir = path.join(projectDir, 'assets');
  const outputPath = path.join(artifactsDir, 'assets.json');

  // Check if we should skip this step
  if (!shouldForce(options) && await checkFileExistsAndNotEmpty(outputPath)) {
    console.log('⏭️  Assets already processed (use --force to regenerate)');
    return;
  }

  console.log('🖼️  Processing visual assets...');
  await processAssets(assetsDir, outputPath);
}

/**
 * Execute the segments processing step
 */
async function executeSegmentsStep(projectDir, artifactsDir, options) {
  let voiceoverFile;

  if (options.audio) {
    // Use custom audio path
    if (path.isAbsolute(options.audio)) {
      voiceoverFile = options.audio;
    } else {
      voiceoverFile = path.resolve(projectDir, options.audio);
    }

    // Validate custom audio file exists
    try {
      await fs.access(voiceoverFile);
    } catch (error) {
      throw new Error(`Custom audio file not found: ${options.audio}`);
    }
  } else {
    // Auto-detect voiceover file
    voiceoverFile = await findVoiceoverFile(projectDir);
  }

  const outputPath = path.join(artifactsDir, 'segments.json');
  const cachePath = path.join(artifactsDir, 'whisper_cache.json'); // Move cache to artifacts

  // Check if we should skip this step
  if (!shouldForce(options) && await checkFileExistsAndNotEmpty(outputPath)) {
    console.log('⏭️  Segments already processed (use --force to regenerate)');
    return;
  }

  console.log('🎵 Processing voiceover and creating segments...');
  const targetDuration = parseFloat(options.targetSegmentDuration || '10');
  await parseScript(voiceoverFile, outputPath, targetDuration, cachePath);
}

/**
 * Execute the mapping step
 */
async function executeMappingStep(projectDir, artifactsDir, options) {
  const assetsPath = path.join(artifactsDir, 'assets.json');
  const segmentsPath = path.join(artifactsDir, 'segments.json');
  const outputPath = path.join(artifactsDir, 'timeline.json');

  // Check if we should skip this step
  if (!shouldForce(options) && await checkFileExistsAndNotEmpty(outputPath)) {
    console.log('⏭️  Mapping already completed (use --force to regenerate)');
    return;
  }

  // Check dependencies
  if (!await checkFileExistsAndNotEmpty(assetsPath)) {
    throw new Error('Assets not found. Run the assets step first.');
  }

  if (!await checkFileExistsAndNotEmpty(segmentsPath)) {
    throw new Error('Segments not found. Run the segments step first.');
  }

  console.log('🗺️  Mapping segments to assets...');
  await mapSegments(segmentsPath, assetsPath, outputPath);
}

/**
 * Execute the export step
 */
async function executeExportStep(projectDir, artifactsDir, options) {
  const segmentsPath = path.join(artifactsDir, 'segments.json');
  const timelinePath = path.join(artifactsDir, 'timeline.json');
  const outputPath = path.join(artifactsDir, 'generated-timeline.fcpxml');

  // Check dependencies
  if (!await checkFileExistsAndNotEmpty(segmentsPath)) {
    throw new Error('Segments not found. Run the segments step first.');
  }

  if (!await checkFileExistsAndNotEmpty(timelinePath)) {
    throw new Error('Timeline not found. Run the mapping step first.');
  }

  console.log('📤 Exporting FCPXML timeline...');

  // Generate project title
  let voiceoverFile;
  try {
    if (options.audio) {
      if (path.isAbsolute(options.audio)) {
        voiceoverFile = options.audio;
      } else {
        voiceoverFile = path.resolve(projectDir, options.audio);
      }
    } else {
      voiceoverFile = await findVoiceoverFile(projectDir);
    }
  } catch (error) {
    // Fallback if voiceover file not found
    voiceoverFile = 'voiceover.mp3';
  }

  const projectTitle = await generateProjectTitle(projectDir, voiceoverFile, options.title);
  const minDuration = parseFloat(options.minDuration || '3');

  await exportFcpXml(segmentsPath, timelinePath, outputPath, projectTitle, minDuration, true);
}

/**
 * Generate a unique run ID
 */
function generateRunId() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const random = randomBytes(4).toString('hex');
  return `${timestamp}-${random}`;
}

function shouldForce(options) {
  return Boolean(options.force || options.forceAll);
}

/**
 * Checks if a file exists and contains meaningful content
 */
async function checkFileExistsAndNotEmpty(filePath) {
  try {
    const stats = await fs.stat(filePath);
    if (stats.isFile() && stats.size > 2) {
      const content = await fs.readFile(filePath, 'utf-8');
      return content.trim().length > 2;
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
  return false;
}

// Parse command line arguments
program.parse();
