import fs from 'fs/promises';
import path from 'path';

/**
 * Standard file and directory names for video projects
 */
export const PROJECT_STRUCTURE = {
  ASSETS_DIR: 'assets',
  ARTIFACTS_DIR: 'artifacts',
  VOICEOVER_NAMES: ['voiceover', 'audio', 'narration', 'voice', 'speech'],
  AUDIO_EXTENSIONS: ['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'],
  IMAGE_EXTENSIONS: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tiff', 'webp'],
  VIDEO_EXTENSIONS: ['mp4', 'mov', 'avi', 'mkv', 'wmv', 'flv', 'webm']
};

/**
 * Validates the structure of a video project directory
 * @param {string} projectDir - Path to the project directory
 * @param {string} customAudioPath - Optional custom audio file path
 * @returns {Promise<Object>} Validation result with isValid, errors, warnings, and metadata
 */
export async function validateProjectStructure(projectDir, customAudioPath = null) {
  const result = {
    isValid: true,
    errors: [],
    warnings: [],
    assetsDir: null,
    voiceoverPath: null,
    assetCount: 0
  };

  try {
    // Check if project directory exists
    await fs.access(projectDir);
  } catch (error) {
    result.isValid = false;
    result.errors.push(`Project directory does not exist: ${projectDir}`);
    return result;
  }

  // Check for assets directory
  const assetsDir = path.join(projectDir, PROJECT_STRUCTURE.ASSETS_DIR);
  try {
    await fs.access(assetsDir);
    result.assetsDir = assetsDir;

    // Count assets
    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    const mediaFiles = entries.filter(entry => {
      if (!entry.isFile() || entry.name.startsWith('.')) return false;
      const ext = path.extname(entry.name).toLowerCase().slice(1);
      return [...PROJECT_STRUCTURE.IMAGE_EXTENSIONS, ...PROJECT_STRUCTURE.VIDEO_EXTENSIONS].includes(ext);
    });

    result.assetCount = mediaFiles.length;

    if (mediaFiles.length === 0) {
      result.warnings.push('Assets directory is empty - add some images or videos');
    }
  } catch (error) {
    result.isValid = false;
    result.errors.push(`Assets directory not found: ${assetsDir}`);
  }

  // Check for voiceover file
  try {
    let voiceoverPath;
    if (customAudioPath) {
      // Validate custom audio path
      if (path.isAbsolute(customAudioPath)) {
        voiceoverPath = customAudioPath;
      } else {
        voiceoverPath = path.resolve(projectDir, customAudioPath);
      }
      await fs.access(voiceoverPath);
    } else {
      voiceoverPath = await findVoiceoverFile(projectDir);
    }
    result.voiceoverPath = voiceoverPath;
  } catch (error) {
    result.isValid = false;
    if (customAudioPath) {
      result.errors.push(`Custom audio file not found: ${customAudioPath}`);
    } else {
      result.errors.push(error.message);
    }
  }

  // Check for existing artifacts (informational)
  const artifactsDir = path.join(projectDir, PROJECT_STRUCTURE.ARTIFACTS_DIR);
  try {
    await fs.access(artifactsDir);
    const runs = await fs.readdir(artifactsDir, { withFileTypes: true });
    const runCount = runs.filter(entry => entry.isDirectory()).length;
    if (runCount > 0) {
      result.warnings.push(`Found ${runCount} existing run(s) in artifacts directory`);
    }
  } catch (error) {
    // No artifacts directory is fine
  }

  return result;
}

/**
 * Creates the standard project structure in the specified directory
 * @param {string} projectDir - Path to the project directory
 * @param {boolean} force - Whether to overwrite existing files
 */
export async function createProjectStructure(projectDir, force = false) {
  // Create assets directory
  const assetsDir = path.join(projectDir, PROJECT_STRUCTURE.ASSETS_DIR);
  await fs.mkdir(assetsDir, { recursive: true });

  // Note: .env file is not created automatically
  // Users should export OPENAI_API_KEY environment variable or create their own .env file

  // Create a README if it doesn't exist
  const readmePath = path.join(projectDir, 'README.md');
  try {
    await fs.access(readmePath);
    if (!force) {
      console.log('📄 README.md already exists');
    }
  } catch (error) {
    const readmeContent = `# Video Project

This is a video generation project created with video-gen CLI.

## Structure

- \`assets/\` - Place your images and videos here
- \`voiceover.mp3\` - Your voiceover audio file (or similar name/format)
- \`artifacts/\` - Generated artifacts from each run

## Setup

1. Export your OpenAI API key:
   \`\`\`bash
   export OPENAI_API_KEY=your_api_key_here
   \`\`\`

2. Place your voiceover audio file in the project root
3. Add your visual assets to the \`assets/\` directory

## Usage

1. Run \`video-gen validate\` to check project structure
2. Run \`video-gen generate\` to create your timeline
3. Import the generated FCPXML file into Final Cut Pro

## Commands

- \`video-gen validate\` - Check project structure
- \`video-gen generate\` - Generate video timeline
- \`video-gen assets\` - Process assets only
- \`video-gen voiceover\` - Process voiceover only
- \`video-gen mapping\` - Map segments to assets only
- \`video-gen export\` - Export FCPXML only
- \`video-gen list\` - List all runs
- \`video-gen clean\` - Clean up artifacts

For more information, run \`video-gen --help\`.
`;
    await fs.writeFile(readmePath, readmeContent);
    console.log('📄 Created README.md');
  }

  console.log(`📁 Created assets directory: ${assetsDir}`);
  console.log('');
  console.log('📋 Project structure created! Next steps:');
  console.log('1. Export your OpenAI API key: export OPENAI_API_KEY=your_api_key_here');
  console.log('2. Place your voiceover audio file in the project root');
  console.log('3. Add images/videos to the assets/ directory');
}

/**
 * Finds the voiceover audio file in the project directory
 * @param {string} projectDir - Path to the project directory
 * @returns {Promise<string>} Path to the voiceover file
 * @throws {Error} If no voiceover file is found
 */
export async function findVoiceoverFile(projectDir) {
  for (const baseName of PROJECT_STRUCTURE.VOICEOVER_NAMES) {
    for (const ext of PROJECT_STRUCTURE.AUDIO_EXTENSIONS) {
      const candidatePath = path.join(projectDir, `${baseName}.${ext}`);
      try {
        await fs.access(candidatePath);
        return candidatePath;
      } catch (error) {
        // File doesn't exist, continue searching
      }
    }
  }

  // If no standard names found, look for any audio file in the root
  try {
    const entries = await fs.readdir(projectDir, { withFileTypes: true });
    const audioFiles = entries
      .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
      .filter(entry => {
        const ext = path.extname(entry.name).toLowerCase().slice(1);
        return PROJECT_STRUCTURE.AUDIO_EXTENSIONS.includes(ext);
      });

    if (audioFiles.length === 1) {
      return path.join(projectDir, audioFiles[0].name);
    } else if (audioFiles.length > 1) {
      throw new Error(`Multiple audio files found. Please rename one to 'voiceover.mp3' or use a standard name: ${PROJECT_STRUCTURE.VOICEOVER_NAMES.join(', ')}`);
    }
  } catch (error) {
    // Ignore readdir errors
  }

  throw new Error(`No voiceover audio file found. Please add a file like: ${PROJECT_STRUCTURE.VOICEOVER_NAMES.map(name => `${name}.mp3`).join(', ')}`);
}

/**
 * Generates a project title from available sources
 * @param {string} projectDir - Path to the project directory
 * @param {string} voiceoverPath - Path to the voiceover file
 * @param {string} customTitle - Optional custom title provided by user
 * @returns {Promise<string>} Generated project title
 */
export async function generateProjectTitle(projectDir, voiceoverPath, customTitle = null) {
  // Use custom title if provided
  if (customTitle && customTitle.trim()) {
    return customTitle.trim();
  }

  // Use directory name as title
  const dirName = path.basename(projectDir);
  if (dirName && dirName !== '.' && dirName !== '..') {
    return dirName.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  // Last resort: use voiceover filename
  const voiceoverName = path.basename(voiceoverPath, path.extname(voiceoverPath));
  return voiceoverName.replace(/[-_]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Gets information about assets in the assets directory
 * @param {string} assetsDir - Path to the assets directory
 * @returns {Promise<Object>} Asset information
 */
export async function getAssetInfo(assetsDir) {
  try {
    const entries = await fs.readdir(assetsDir, { withFileTypes: true });
    const assets = entries.filter(entry => {
      if (!entry.isFile() || entry.name.startsWith('.')) return false;
      const ext = path.extname(entry.name).toLowerCase().slice(1);
      return [...PROJECT_STRUCTURE.IMAGE_EXTENSIONS, ...PROJECT_STRUCTURE.VIDEO_EXTENSIONS].includes(ext);
    });

    const images = assets.filter(asset => {
      const ext = path.extname(asset.name).toLowerCase().slice(1);
      return PROJECT_STRUCTURE.IMAGE_EXTENSIONS.includes(ext);
    });

    const videos = assets.filter(asset => {
      const ext = path.extname(asset.name).toLowerCase().slice(1);
      return PROJECT_STRUCTURE.VIDEO_EXTENSIONS.includes(ext);
    });

    return {
      total: assets.length,
      images: images.length,
      videos: videos.length,
      files: assets.map(asset => asset.name)
    };
  } catch (error) {
    return { total: 0, images: 0, videos: 0, files: [] };
  }
}
