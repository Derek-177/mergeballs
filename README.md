# Merge Ball

A physics merge game in a single static page: custom balls and merge equations,
adjustable drop rate and speed, merge sounds (Web Audio) with a different custom
MP3/WAV/OGG sound per ball - the merge that creates a ball plays that ball's sound -
and a built-in YouTube Shorts (9:16) video recorder with sound. No build step, no dependencies.

## Files
- `index.html` - the game and settings panel
- `audio.js` - merge sounds (per-ball and default)
- `recorder.js` - 9:16 video recording
- `assets/container.jpg` - container artwork
- `render.yaml` - Render deployment blueprint

## Run locally
    python3 -m http.server 8000
then open http://localhost:8000 (opening `index.html` directly also works).

## Deploy: GitHub + Render
1. Push this folder to a GitHub repository (see commands below).
2. On https://dashboard.render.com choose **New + > Blueprint**, connect the repo and
   click **Apply**. Render reads `render.yaml` and publishes the site.
   (Manual alternative: **New + > Static Site**, pick the repo, leave Build Command empty,
   set Publish Directory to `.`)
3. Open the `https://merge-ball.onrender.com` URL (or the one Render shows you).

    git init
    git add .
    git commit -m "Merge Ball"
    git branch -M main
    git remote add origin https://github.com/<your-username>/merge-ball.git
    git push -u origin main

Every later `git push` redeploys automatically.

## Notes
- Sound and recording start after the first tap/click (browser autoplay rules).
- Uploaded sounds are not saved between visits; volume/pitch/on-off are.
- Recording needs a Chromium-based browser (Chrome/Edge/Android Chrome work best).
