# LIHPS Askling Video v0.2.1 · iPhone web app

A separate static web app for markerless analysis of one or two side-on videos. It uses MediaPipe Pose Landmarker Full to estimate hip, knee and ankle landmarks and Mediabunny/WebCodecs to decode source frames in presentation order. Each video stays on the device. The web app downloads the decoder, model and runtime on first use.

## Publish alongside Motion Angle

1. Extract the ZIP. In GitHub, create a **new public repository** named `lihps-askling-video` and initialize it with a README.
2. In the new repository, choose **Add file → Upload files**. Drag in the **contents of the `site` folder**, including `icons`. Commit to `main`. Confirm that `index.html` is at the top level. Upload the application files only. Keep all recordings, previews containing people and patient data off the repository.
3. Open **Settings → Pages**. Select **Deploy from a branch**, then **main** and **/(root)**, and save.
4. When the Pages deployment succeeds, use **Visit site**. The address will be `https://YOUR-USERNAME.github.io/lihps-askling-video/`.
5. Open this address in current iPhone Safari. Choose **Share → Add to Home Screen**, enable **Open as Web App** and tap **Add**.
6. From the installed app, with networking available, open **Recording and measurement notes** and tap **Prepare for offline use**. If the app requests a reload, close and reopen it first. Then test opening and analysing a short clip pair with networking off. The browser may clear cached assets, so use the same preparation step if needed.

[GitHub Pages publishing settings](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

## Update an existing deployment

If you already published the video app, upload the contents of the new `site` folder to the **same video repository** and commit the replacements, including the new `review.js`. Wait for GitHub Pages to finish. Fully close and reopen the installed app while online after the update. If needed, reload it in Safari and repeat **Prepare for offline use**. Version 0.2.1 appears in the header. The IMU app uses a separate deployment.

## Process one or both legs

1. Assign an original camera clip to **Left video** or **Right video**. Either input is sufficient to start. Add both clips when you want a left/right comparison. The clips used for this project are **IMG_1795.mov (left)** and **IMG_1796.mov (right)**.
2. Use the two rotation buttons to orient each preview. For your existing clips, try the original orientation first. Leave **First raise is practice** off for both clips. The setting is per leg.
3. Tap **Process left video**, **Process right video** or **Process both videos**, according to the selected files. Leave the app open while it decodes and analyses the selected clips. With one clip, the other leg and comparison ratios show a dash. If you later add the second clip, the action changes to **Process both videos** and runs both selected files. The progress message shows the current side, frame count and video time. You can cancel analysis.
4. Read the **Set summary**, then expand any raise under **Per repetition** for its individual values and QC. **Show peak frame** brings the peak frame and model overlay into view. Use the slider to move across the clip. **Previous frame** and **Next frame** move exactly one decoded frame. The counter uses one-based frame numbers.
5. Use **Next flagged frame** to jump to the first frame of the next pending stretch. The message shows the reason for the current frame. Step through a stretch to inspect it. After inspection, choose **Mark reviewed** or **Mark stretch reviewed** to remove it from the queue. These actions acknowledge the flags and leave the analysis QC in place.
6. To adjust a landmark, open **Correct landmarks on this frame**, choose hip, knee or ankle, and tap the point on the preview. The app updates the metrics using that frame. Use **Reset frame** to recover the model's landmarks for the displayed frame. Corrections affect the selected frame only. The chosen joint stays active while stepping through that clip. Each edit recalculates flags and measurements.
7. Export the repetition CSV before closing or replacing the videos. No recordings, landmarks or results are retained across reloads.

## Braced knee and review flags

**Braced knee for this leg** can be toggled per clip. It uses the hip-to-ankle line to find repetitions and locate peak preview frames. If knee tracking fails within a raise or has a knee-related review flag, the app withholds thigh, shank and knee measurements for that raise. Hip-to-ankle angle and speed stay available when their own QC passes. When knee measurements are available, knee flexion at peak still refers to the peak of the thigh trace. The CSV records the mode, the basis of the peak-frame timestamp, and any knee-specific QC.

For unbraced clips, the queue uses projected thigh and shank lengths separately. Braced clips also use projected hip-to-ankle length and place knee-only stretches behind hip, ankle and timing issues. The length threshold is the larger of 3 scaled median absolute deviations and 12% of the median length. Missing or low-confidence points, isolated jumps relative to neighbouring frames, and timestamp gaps can also trigger review. Consecutive flags of the same priority are grouped. These are screening heuristics, and genuine out-of-plane motion can change projected length.

## Interpretation

Thigh and shank measurements use hip-to-knee and knee-to-ankle orientations relative to rest. Hip-to-ankle excursion is a separate whole-leg measure. Knee flexion is the angle between the thigh and shank, with a straight line at 0°. The app reports knee flexion at peak thigh elevation and maximum knee flexion during each raise. These 2D measures assume a stationary side-on camera and movement close to the image plane.

The app smooths valid angle runs using a local quadratic fit, with a timestamp window of ±38 ms or about ±3 frame intervals, whichever is larger. Peak velocities are positive central differences around the upward phase. Automatic quality flags identify large landmark jumps, invalid points or timestamps inside a raise, and incomplete returns. They cannot detect every plausible-looking misplaced point or wrong-leg estimate. Flagged raises and practice are excluded from the set means. Where a comparable value exists for both sides, the summary reports Left ÷ Right × 100. Knee flexion is shown in degrees on each side. Speeds from clips below 100 decoded fps are marked preliminary.

## Recorded clip verification

Both supplied H.264 MOVs decoded locally with PyAV. Left yielded 270 frames and right yielded 314, with increasing source timestamps. Replay of the MediaPipe Full keypoints from the completed Mac benchmark through the app's JavaScript measurement code found 3 raises per side. Version 0.2 found 14 review stretches on the left clip and five on the right, without changing the unbraced results. Mean peak thigh ROM was 104.8° left and 115.7° right. Mean peak thigh speed was 251.8°/s left and 293.5°/s right. The web model and browser decoder still need end-to-end iPhone testing. A fresh native MediaPipe run inside the workspace was blocked by unavailable graphics services. No test footage or participant data is included in the download.

Run the automated geometry, segmentation, braced-knee, review-queue and simulated file-selection/processing checks with `npm test`. To replay the recorded benchmark data, run `node tests/recordings.mjs /path/to/benchmark/results-0-0`. That command expects the left and right keypoint CSVs generated separately by the Mac benchmark runner.

[MediaPipe Pose Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) · [Mediabunny frame decoding](https://mediabunny.dev/guide/media-sinks)
