/**
 * @fileoverview OpenAI utility functions for structured outputs and consistent client configuration
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory of this module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env from project root (two levels up from src/utils/)
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

/**
 * Creates and returns an OpenAI client instance with proper error handling
 * @returns {OpenAI} Configured OpenAI client
 * @throws {Error} If OPENAI_API_KEY is not set
 */
export function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      'OPENAI_API_KEY environment variable is required but not set.\n' +
      'Please set it in your .env file or environment:\n' +
      '  export OPENAI_API_KEY="your-api-key-here"\n' +
      '  Get your API key from: https://platform.openai.com/api-keys'
    );
  }

  return new OpenAI({ apiKey });
}

/**
 * Creates a chat completion with structured output using JSON schema
 * @param {Object} params - Parameters for the chat completion
 * @param {Array} params.messages - Array of message objects
 * @param {Object} params.schema - JSON schema for structured output
 * @param {string} params.schemaName - Name for the JSON schema
 * @param {string} [params.model] - Model to use
 * @returns {Promise<Object>} Chat completion response
 */
export async function createStructuredCompletion({ messages, schema, schemaName, model = 'gpt-4.1' }) {
  const client = getOpenAIClient();

  return await client.chat.completions.create({
    model,
    messages,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: schemaName,
        schema,
        strict: true
      }
    },
  });
}

/**
 * Parses structured output response and handles errors gracefully
 * @param {Object} response - OpenAI API response
 * @param {string} [contextInfo] - Additional context for error messages
 * @returns {Object} Parsed response data
 * @throws {Error} If parsing fails
 */
export function parseStructuredResponse(response, contextInfo = 'API call') {
  try {
    const content = response.choices[0].message.content;
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error parsing structured response for ${contextInfo}:`, error);
    throw new Error(`Failed to parse structured response for ${contextInfo}: ${error.message}`);
  }
}

/**
 * Common JSON schemas for different use cases
 */
export const schemas = {
  assetAnalysis: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A concise, engaging description of the visual content (ideally under 30 words), highlighting its relevance for a documentary"
      }
    },
    required: ["description"],
    additionalProperties: false
  },

  videoFrameAnalysis: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description: "A concise, engaging description of what the video frame shows (ideally under 30 words)"
      },
      timestamp_seconds: {
        type: "string",
        description: "The timestamp in seconds for this video frame"
      }
    },
    required: ["description", "timestamp_seconds"],
    additionalProperties: false
  },

  timelineMapping: {
    type: "object",
    properties: {
      timeline: {
        type: "array",
        description: "Array of timeline mappings for each segment",
        items: {
          type: "object",
          properties: {
            segmentId: {
              type: "integer",
              description: "The ID of the segment being mapped"
            },
            assetPath: {
              type: "string",
              description: "The path to the selected asset"
            },
            assetType: {
              type: "string",
              enum: ["image", "video"],
              description: "The type of asset"
            },
            frameTimestamp: {
              type: ["string", "null"],
              description: "For video assets, the timestamp of the frame to use"
            }
          },
          required: ["segmentId", "assetPath", "assetType", "frameTimestamp"],
          additionalProperties: false
        }
      }
    },
    required: ["timeline"],
    additionalProperties: false
  }
};

/**
 * Creates a schema for asset analysis with optional timestamp for video frames
 * @param {boolean} includeTimestamp - Whether to include timestamp field
 * @returns {Object} JSON schema
 */
export function createAssetAnalysisSchema(includeTimestamp = false) {
  if (includeTimestamp) {
    return schemas.videoFrameAnalysis;
  }
  return schemas.assetAnalysis;
}
