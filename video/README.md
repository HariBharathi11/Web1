# video — HyperFrames project

Video compositions for Web1, built with [HyperFrames](https://github.com/heygen-com/hyperframes)
(docs: https://hyperframes.heygen.com).

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
- Agent skills (`/hyperframes`, `/hyperframes-core`, `/hyperframes-animation`, …) were
  installed by `hyperframes init`; restart the agent session to pick them up.
