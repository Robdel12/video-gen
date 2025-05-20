import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findVoiceoverFile, generateProjectTitle, validateProjectStructure } from '../src/utils/project-utils.js';
import { hasProblematicChars, normalizeFilename } from '../src/utils/shell-utils.js';

test('normalizeFilename keeps extensions and removes shell-hostile characters', () => {
  assert.equal(normalizeFilename('Monaco Voiceover (Final Cut).MP3'), 'monaco-voiceover-final-cut.MP3');
  assert.equal(normalizeFilename('  Race Day!!!.mov'), 'race-day.mov');
});

test('hasProblematicChars catches filenames that should be normalized', () => {
  assert.equal(hasProblematicChars('Race Day.mov'), true);
  assert.equal(hasProblematicChars('race-day.mov'), false);
});

test('findVoiceoverFile prefers standard voiceover names', async () => {
  let projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-gen-'));

  try {
    await fs.writeFile(path.join(projectDir, 'voiceover.mp3'), '');
    await fs.writeFile(path.join(projectDir, 'other.wav'), '');

    assert.equal(await findVoiceoverFile(projectDir), path.join(projectDir, 'voiceover.mp3'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('validateProjectStructure reports assets and voiceover metadata', async () => {
  let projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'video-gen-'));

  try {
    await fs.mkdir(path.join(projectDir, 'assets'));
    await fs.writeFile(path.join(projectDir, 'assets', 'clip.mp4'), '');
    await fs.writeFile(path.join(projectDir, 'voiceover.mp3'), '');

    let result = await validateProjectStructure(projectDir);

    assert.equal(result.isValid, true);
    assert.equal(result.assetCount, 1);
    assert.equal(result.voiceoverPath, path.join(projectDir, 'voiceover.mp3'));
  } finally {
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});

test('generateProjectTitle uses custom title before deriving from the folder name', async () => {
  assert.equal(await generateProjectTitle('/tmp/my-video', '/tmp/voiceover.mp3', 'Custom Title'), 'Custom Title');
  assert.equal(await generateProjectTitle('/tmp/my-video', '/tmp/voiceover.mp3'), 'My Video');
});
