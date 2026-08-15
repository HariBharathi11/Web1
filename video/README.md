# video — HyperFrames project

Video compositions for Web1, built with [HyperFrames](https://github.com/heygen-com/hyperframes)
(docs: https://hyperframes.heygen.com).

**Current composition:** `index.html` — the MinMaxHR 20-second cinematic VSL,
1080x1920 @ 30fps, silent master.

**Brand:** `assets/brand/BRAND.md` holds the MinMaxHR palette, type, voice rules, and the
three logo variants. Every MinMaxHR deliverable must carry the logo — read it before
starting any new MinMaxHR video or image.

Compositions are plain HTML: `index.html` holds the stage plus `class="clip"` elements
with `data-start` / `data-duration` timing, and a single paused GSAP timeline registered
on `window.__timelines`. No build step.

## Requirements

- Node.js 22+
- FFmpeg / FFprobe on PATH (`sudo apt-get install -y ffmpeg`)
- Chrome headless shell: `npx hyperframes browser ensure`

Verify with `npx hyperframes doctor`.

## Commands

```bash
cd video
npm run dev      # live preview in the browser
npm run check    # validate structure, timing, layout, contrast
npm run render   # render to MP4 in renders/
npm run publish  # publish the composition
```

## Notes

- GSAP is vendored at `vendor/gsap.min.js` — the render sandbox has no network access,
  so a CDN `<script>` tag fails at capture time. Vendor any other runtime the same way.
- `renders/` is generated output and is git-ignored.
- The VSL is silent by design this pass. Beat markers are commented in the timeline at
  0.40 / 3.00 / 7.00 / 13.00 / 17.10 so a music bed and voiceover drop onto an
  `<audio data-timeline-role="music">` track with no re-choreography.
- 16:9 and 1:1 cuts are a layout pass on the same scene modules, not a rebuild.
- Agent skills (`/hyperframes`, `/hyperframes-core`, `/hyperframes-animation`, …) were
  installed by `hyperframes init`; restart the agent session to pick them up.
