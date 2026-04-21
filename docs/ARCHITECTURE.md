# Architecture

Video Gen was built around a practical question: if you start with a narration script, an AI-generated voiceover of that script, and a folder of related images and videos, can a pipeline assemble a decent first-pass edit?

The answer here is "kind of, yes." Not a final cut. Not something you would ship without watching it. But a real timeline with narration-driven pacing, visually matched assets, image motion, and video clips placed at plausible moments.

That was the point of the experiment.

## The Core Idea

Most automatic video tools struggle because they do not have a good clock. They can pick images. They can pick clips. But pacing is the edit.

This project uses the voiceover as the clock.

The original transcript matters because it is what produced the voiceover. But the pipeline uses the rendered voiceover audio as the timing source. It transcribes that audio with word-level timestamps, groups the words into segments, and builds the visual timeline around those segment boundaries.

That gives each visual choice a job:

- cover this specific part of the narration
- start at this point in the audio
- last roughly this long
- avoid feeling repetitive next to the surrounding shots

The output is a Final Cut Pro XML file, not a rendered video. Final Cut Pro becomes the final renderer and review surface.

## Inputs

A project directory has three conceptual inputs:

- **Transcript/script**: the source narration text you wrote or generated
- **Voiceover**: an AI text-to-speech render of that transcript
- **Assets**: images and video clips related to the story

The current CLI does not require a separate transcript file at runtime. It reconstructs timed narration segments from the voiceover itself. That is intentional for this prototype: the voiceover is the source of truth because it contains the real pacing, pauses, and delivery.

```text
project/
├── voiceover.mp3
├── assets/
│   ├── archival-photo.jpg
│   ├── interview-shot.png
│   ├── track-footage.mp4
│   └── b-roll.mov
└── artifacts/
```

## Pipeline

The pipeline is deliberately linear. Each stage writes a JSON artifact, so you can stop, inspect what happened, tweak inputs, and rerun only the step you care about.

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

## Stage 1: Analyze The Asset Library

`src/asset-processor.js` walks the `assets/` directory and turns raw media files into structured descriptions.

Images are straightforward. The file is read, encoded, and sent to the vision model with the filename as extra context. The output is a short description of what the image shows and how it might work in a documentary edit.

Videos need an extra step. The pipeline does not send a whole video to the model. Instead, it uses `ffprobe` to measure the video duration and `ffmpeg` to extract still frames at useful timestamps.

The timestamp strategy is intentionally simple:

- very short videos get one representative frame
- short and medium videos get a couple of frames
- longer videos get frames spread across the beginning, middle, and end

Each extracted frame is analyzed like an image, then stored as a selectable video moment:

```json
{
  "path": "assets/race-footage.mp4",
  "type": "video",
  "originalFilename": "race-footage.mp4",
  "totalDurationSeconds": 42.5,
  "frames": [
    {
      "timestamp": "4.25",
      "description": "Race cars entering a fast corner with dense trackside motion."
    },
    {
      "timestamp": "21.30",
      "description": "Close pack of cars battling down the straight."
    }
  ]
}
```

That turns a video file into multiple editorial choices. The mapper can say, "Use this video, starting around this timestamp," instead of only saying, "Use this video somewhere."

The frame cache keeps repeated runs cheaper. Once a video has been sampled and analyzed, its extracted frame metadata can be reused as long as the source file hash has not changed.

## Stage 2: Turn Voiceover Into Timed Segments

`src/script-parser.js` transcribes the voiceover with word-level timestamps.

Those words are grouped into segments around a target duration, defaulting to about ten seconds. Each segment keeps the text plus its start and end time:

```json
{
  "id": 3,
  "start": 28.42,
  "end": 38.11,
  "text": "By the time the race began, the rivalry had become something bigger than engineering."
}
```

This is where the edit gets its pacing. The timeline is not based on arbitrary slide durations. It follows the actual spoken narration.

The segmenter also guards against tiny or invalid durations. Very short segments are extended enough to avoid unusable flash clips later in Final Cut Pro.

## Stage 3: Map Narration To Visuals

`src/segment-mapper.js` gives the model two things:

- the timed narration segments
- the analyzed image and video-frame descriptions

The model returns a structured `timeline.json` mapping each narration segment to one visual choice:

```json
{
  "segmentId": 3,
  "assetPath": "assets/race-footage.mp4",
  "assetType": "video",
  "frameTimestamp": "21.30"
}
```

The prompt pushes for a few editor-like behaviors:

- match the visual to the narration
- avoid using the same asset back-to-back
- use more of the asset library before repeating shots
- alternate energy and mood where possible
- preserve a sense of visual flow

This is not a full nonlinear editor brain. It is more like an assistant editor making a rough selects pass with timing already handled.

## Stage 4: Export A Final Cut Pro Timeline

`src/timeline-exporter.js` converts `segments.json` and `timeline.json` into FCPXML.

For each segment, it creates a clip in the Final Cut Pro timeline:

- image assets become still clips
- image clips can get simple Ken Burns-style crop animation
- video assets start around the selected frame timestamp
- video durations are clamped to the real source duration so clips do not extend past the end of the file

That last point matters. Earlier versions could generate clips that asked Final Cut Pro for more video than the source file actually had. Final Cut would truncate those into tiny flashes. The exporter now checks source duration with `ffprobe` and shortens the clip when needed.

The final artifact is:

```text
artifacts/<run-id>/generated-timeline.fcpxml
```

Import that into Final Cut Pro and you get an editable timeline instead of a baked render. That was the right tradeoff for this project. The AI gets you to a rough cut. A human can still trim, replace shots, adjust timing, and render the final video.

## Why The Artifacts Matter

Each step writes data you can inspect:

- `assets.json`: what the tool thinks your media contains
- `segments.json`: how the voiceover was divided into timed narration chunks
- `timeline.json`: which visual asset was selected for each narration segment
- `generated-timeline.fcpxml`: the editable Final Cut Pro handoff

That makes the pipeline debuggable. If the final edit feels wrong, you can usually tell where it went wrong:

- bad asset descriptions mean the vision pass missed context
- awkward timing means the voiceover segmentation needs tuning
- repetitive visuals mean the mapping prompt or available assets need work
- FCP import issues mean the exporter needs attention

## What This Is Not

This is not a full video editor. It does not understand story structure the way a human editor does. It does not watch full videos end-to-end. It does not render final MP4 output. And it does not replace review.

It is a proof of concept for narration-driven video assembly.

That is still a useful shape. Feed it a voiceover and a media library, and it can build the first timeline. The rest is taste.
