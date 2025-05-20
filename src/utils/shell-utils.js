/**
 * @fileoverview Shell utilities for safe command execution with file paths containing spaces and special characters
 */

import { execSync } from 'child_process';
import util from 'util';
import { exec } from 'child_process';

const execAsync = util.promisify(exec);

/**
 * Escapes a file path for safe use in shell commands.
 * Handles spaces, quotes, and other special characters properly.
 * @param {string} filePath - The file path to escape
 * @returns {string} Safely escaped file path
 */
export function escapeShellArg(filePath) {
  if (!filePath) return '""';

  // On Unix-like systems (macOS, Linux), wrap in single quotes and escape any single quotes
  // This is more robust than double quotes for handling most special characters
  return "'" + filePath.replace(/'/g, "'\"'\"'") + "'";
}

/**
 * Executes a command with properly escaped file paths.
 * @param {string} command - The command template with {0}, {1}, etc. placeholders
 * @param {...string} filePaths - File paths to escape and substitute
 * @returns {Promise<{stdout: string, stderr: string}>} Command result
 */
export async function execAsyncSafe(command, ...filePaths) {
  const escapedPaths = filePaths.map(escapeShellArg);
  let finalCommand = command;

  // Replace {0}, {1}, etc. with escaped paths
  escapedPaths.forEach((escapedPath, index) => {
    finalCommand = finalCommand.replace(new RegExp(`\\{${index}\\}`, 'g'), escapedPath);
  });

  return execAsync(finalCommand);
}

/**
 * Executes a synchronous command with properly escaped file paths.
 * @param {string} command - The command template with {0}, {1}, etc. placeholders
 * @param {Object} options - execSync options
 * @param {...string} filePaths - File paths to escape and substitute
 * @returns {string|Buffer} Command output
 */
export function execSyncSafe(command, options = {}, ...filePaths) {
  const escapedPaths = filePaths.map(escapeShellArg);
  let finalCommand = command;

  // Replace {0}, {1}, etc. with escaped paths
  escapedPaths.forEach((escapedPath, index) => {
    finalCommand = finalCommand.replace(new RegExp(`\\{${index}\\}`, 'g'), escapedPath);
  });

  return execSync(finalCommand, options);
}

/**
 * Normalizes a filename by replacing spaces and special characters with dashes.
 * Preserves the file extension.
 * @param {string} filename - The filename to normalize
 * @returns {string} Normalized filename
 */
export function normalizeFilename(filename) {
  if (!filename) return filename;

  const lastDotIndex = filename.lastIndexOf('.');
  const name = lastDotIndex > 0 ? filename.substring(0, lastDotIndex) : filename;
  const extension = lastDotIndex > 0 ? filename.substring(lastDotIndex) : '';

  // Normalize the name part
  const normalizedName = name
    .toLowerCase()                    // Convert to lowercase
    .replace(/\s+/g, '-')            // Replace spaces with dashes
    .replace(/[^a-z0-9\-_]/g, '')    // Remove special characters except dashes and underscores
    .replace(/-+/g, '-')             // Replace multiple dashes with single dash
    .replace(/^-+|-+$/g, '');        // Remove leading/trailing dashes

  return normalizedName + extension;
}

/**
 * Checks if a filename contains characters that might cause shell issues.
 * @param {string} filename - The filename to check
 * @returns {boolean} True if filename has problematic characters
 */
export function hasProblematicChars(filename) {
  if (!filename) return false;

  // Characters that commonly cause issues in shell commands
  const problematicChars = /[\s'"\\`$&;<>|(){}[\]*?~]/;
  return problematicChars.test(filename);
}
