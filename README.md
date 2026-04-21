# Video Gen

An AI-assisted video editing CLI that turns a folder of media assets plus a voiceover into a Final Cut Pro XML timeline.

This is an old-but-fun prototype: it analyzes images and video frames, transcribes voiceover audio, asks an LLM to map narration segments to visuals, and exports a rough documentary-style edit as FCPXML. It is not trying to be a polished product. It is a useful demo of the pipeline and a decent starting point for experiments.

No sample media, generated artifacts, local `.env` files, or API keys are included in this repo.

## The Experiment

The question behind this project was pretty simple:

> If I already have a narration script, an AI-generated voiceover that reads that script, and a pile of related images and videos, how close can I get to a real edited video automatically?

The workflow is meant to look like this:

1. Write or generate a transcript/script.
2. Generate a voiceover from that script with text-to-speech.
3. Collect images and video clips that fit the subject.
4. Run the pipeline.
5. Import the generated `.fcpxml` into Final Cut Pro.

The important trick is that the voiceover becomes the timing source. The tool transcribes the voiceover back into words with timestamps, groups those words into narration segments, and then builds the visual edit around those segment timings. That gives the generated edit real pacing instead of just guessing how long each image or clip should stay on screen.

For the longer version, see [Architecture](docs/ARCHITECTURE.md).

## Requirements

- Node.js 20+
- `ffmpeg` available on your `PATH`
- An OpenAI API key
- Final Cut Pro if you want to import the generated `.fcpxml`

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Make the CLI available locally:**
   ```bash
   npm link
   ```

3. **Set your OpenAI API key:**
   ```bash
   export OPENAI_API_KEY=your_api_key_here
   ```

   You can also copy `.env.example` to `.env` while developing locally. Do not commit real keys.

4. **Set up a video project:**
   ```bash
   mkdir my-video-project
   cd my-video-project
   video-gen init
   ```

5. **Add your content:**
   - Place your voiceover audio file in the project root (e.g., `voiceover.mp3`, `audio.wav`, etc.)
   - Add images and videos to the `assets/` directory

6. **Generate your timeline:**
   ```bash
   video-gen generate
   
   # Or with custom options:
   video-gen generate --title "My Racing Documentary" --audio custom-audio.wav
   ```

7. **Import the generated FCPXML file into Final Cut Pro to edit and render your video**

## Project Structure

The CLI expects projects to follow this standardized structure:

```
your-project/
├── assets/                   # Your images and videos
│   ├── image1.jpg
│   ├── video1.mp4
│   └── ...
├── voiceover.mp3            # Audio file (various names/formats supported)
├── artifacts/               # Generated outputs (created automatically)
│   └── <run-id>/
│       ├── assets.json
│       ├── segments.json
│       ├── timeline.json
│       ├── whisper_cache.json
│       └── generated-timeline.fcpxml
```

### Supported File Formats

**Audio files** (voiceover):
- `.mp3`, `.wav`, `.m4a`, `.flac`, `.ogg`, `.aac`
- Supported names: `voiceover.*`, `audio.*`, `narration.*`, `voice.*`, `speech.*`

**Visual assets**:
- **Images**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.bmp`, `.tiff`, `.webp`
- **Videos**: `.mp4`, `.mov`, `.avi`, `.mkv`, `.wmv`, `.flv`, `.webm`

## Commands

### `video-gen init`
Create project structure with assets/ directory and README.

```bash
video-gen init [options]

Options:
  -f, --force    Overwrite existing project structure
```

### `video-gen validate`
Check if project has required assets/ directory and voiceover audio file.

```bash
video-gen validate [options]

Options:
  --audio <path>    Custom audio file path to validate
```

### `video-gen generate`
Run full pipeline: analyze assets, transcribe audio, map segments, export FCPXML.

```bash
video-gen generate [options]

Options:
  -r, --run-id [id]                    Specify a run ID (auto-generated if not provided)
  --skip-validation                    Skip project structure validation
  --force-all                          Force regeneration of all artifacts
  --min-duration <seconds>             Minimum clip duration in seconds (default: 3)
  --target-segment-duration <seconds>  Target segment duration in seconds (default: 10)
  --audio <path>                       Custom audio file path (defaults to auto-detect)
  --title <title>                      Custom project title (defaults to directory name)
```

### `video-gen assets`
Analyze images and videos in assets/ folder using OpenAI Vision API.

```bash
video-gen assets [options]

Options:
  -r, --run-id <id>    Specify a run ID (defaults to "current")
  --skip-validation    Skip project structure validation
  --force              Force regeneration of assets.json
```

### `video-gen voiceover` (alias: `segments`)
Transcribe audio using OpenAI Whisper and create timed segments.

```bash
video-gen voiceover [options]

Options:
  -r, --run-id <id>                    Specify a run ID (defaults to "current")
  --skip-validation                    Skip project structure validation
  --force                              Force regeneration of segments.json
  --target-segment-duration <seconds>  Target segment duration in seconds (default: 10)
  --audio <path>                       Custom audio file path (defaults to auto-detect)
```

### `video-gen mapping` (alias: `map`)
Use AI to intelligently match audio segments with appropriate visual assets.

```bash
video-gen mapping [options]

Options:
  -r, --run-id <id>    Specify a run ID (defaults to "current")
  --skip-validation    Skip project structure validation
  --force              Force regeneration of timeline.json
```

### `video-gen export` (alias: `xml`)
Generate Final Cut Pro XML timeline from mapped segments and assets.

```bash
video-gen export [options]

Options:
  -r, --run-id <id>        Specify a run ID (defaults to "current")
  --skip-validation        Skip project structure validation
  --force                  Always regenerate FCPXML
  --min-duration <seconds> Minimum clip duration in seconds (default: 3)
  --title <title>          Custom project title
```

### `video-gen list`
Show all pipeline runs with timestamps and generated artifacts.

```bash
video-gen list [options]

Options:
  --detail    Show detailed information about each run
```

### `video-gen clean`
Remove generated artifacts, run directories, or Whisper transcription cache.

```bash
video-gen clean [options]

Options:
  --run-id <id>    Clean specific run ID
  --all            Clean all runs
  --cache          Clean Whisper cache
```

### `video-gen normalize`
Normalize asset filenames by replacing spaces and special characters with dashes.

```bash
video-gen normalize [options]

Options:
  --dry-run            Show what would be changed without making changes
  --assets-dir <dir>   Assets directory to normalize (defaults to "assets")
```

## Usage Examples

### Basic Workflow
```bash
# Set up a new project
mkdir my-video-project && cd my-video-project
video-gen init

# Export your API key
export OPENAI_API_KEY=your_api_key_here

# Add your files (copy voiceover.mp3 and assets)
# ...

# Generate timeline
video-gen generate
```

### Step-by-Step Workflow
```bash
# Process assets only to see what's detected
video-gen assets

# Process voiceover and create segments
video-gen voiceover

# Map segments to assets
video-gen mapping

# Export final FCPXML
video-gen export
```

### Advanced Options
```bash
# Use custom audio file and title
video-gen generate --audio custom-narration.wav --title "My Documentary"

# Force regeneration with custom settings
video-gen generate --force-all --min-duration 5 --target-segment-duration 15

# Generate with a specific run ID for reproducibility
video-gen generate --run-id "final-v1"

# Skip validation (if you know structure is correct)
video-gen generate --skip-validation
```

### Project Management
```bash
# Check project health
video-gen validate

# Validate custom audio file
video-gen validate --audio my-audio.mp3

# List all previous runs
video-gen list --detail

# Clean up old runs
video-gen clean --run-id "old-run"
video-gen clean --all
```

## Pipeline Architecture

The tool follows a **linear, four-stage pipeline**:

```text
voiceover.mp3         assets/
      │                  │
      ▼                  ▼
  script-parser      asset-processor
      │                  │
      ▼                  ▼
segments.json       assets.json
      │                  │
      └────┐     ┌───────┘
           ▼     ▼
    segment-mapper
           │
           ▼
    timeline.json
           │
           ▼
  timeline-exporter
           │
           ▼
generated-timeline.fcpxml
```

### Pipeline Stages

1. **Asset Processing** (`asset-processor.js`): Discovers and analyzes visual assets with OpenAI Vision
2. **Script Parsing** (`script-parser.js`): Transcribes voiceover via Whisper and creates timed segments
3. **Segment Mapping** (`segment-mapper.js`): Maps audio segments to visual assets using AI
4. **Timeline Export** (`timeline-exporter.js`): Generates FCPXML timeline for Final Cut Pro

Each stage produces a JSON artifact, making the process modular and debuggable. The architecture is designed for easy extension (e.g., SRT subtitle generation, multi-language support).

## Environment Variables

Set the required environment variable in your shell:

```bash
# Required: OpenAI API key for asset analysis and transcription
export OPENAI_API_KEY=your_api_key_here

# Optional: Enable debug logging
export DEBUG=true
```

You can also create a `.env` file in your project directory if preferred:

```bash
# .env file (optional)
OPENAI_API_KEY=your_api_key_here
DEBUG=true
```

## Working with Multiple Projects

The CLI is designed to work with multiple video projects. Each project should be in its own directory:

```bash
# Project 1
mkdir ~/Videos/documentary-1 && cd ~/Videos/documentary-1
video-gen init
# ... add content and generate

# Project 2
mkdir ~/Videos/documentary-2 && cd ~/Videos/documentary-2
video-gen init
# ... add content and generate
```

Each project maintains its own:
- Asset library
- Whisper transcription cache
- Generated artifacts with run history
- Configuration and environment

## Troubleshooting

### Common Issues

**"No voiceover audio file found"**
- Ensure your audio file is in the project root
- Use a supported format and naming convention
- Run `video-gen validate` to see what was detected

**"Project validation failed"**
- Run `video-gen validate` to see specific issues
- Ensure `assets/` directory exists with media files
- Check that your OpenAI API key is set without printing it: `test -n "$OPENAI_API_KEY" && echo "OpenAI key is set"`

**"Pipeline failed"**
- Check your OpenAI API key and billing status
- Ensure audio file is under 25MB (will auto-compress if needed)
- Use `DEBUG=true video-gen generate` for detailed error logs

### Getting Help

```bash
video-gen --help              # General help
video-gen generate --help     # Command-specific help
video-gen validate            # Check project health
```

## Contributing

This tool uses ES modules and requires Node.js 20+. The codebase is organized into modular pipeline stages for easy maintenance and extension.

```bash
npm test
npm audit
```

## Dependencies

- `openai` – OpenAI API for captions, mapping, and transcription
- `fluent-ffmpeg` + `@ffprobe-installer/ffprobe` – Video processing and metadata
- `dotenv` – Load environment variables
- `commander` – CLI framework
- `xmlbuilder2` – FCPXML generation
- `tmp` – Temporary file management

## License

MIT
