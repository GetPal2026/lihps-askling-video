# lihps-askling-video
A separate static web app for markerless analysis of two side-on videos. It uses MediaPipe Pose Landmarker Full to estimate hip, knee and ankle landmarks and Mediabunny/WebCodecs to decode source frames in presentation order. Each video stays on the device. The web app downloads the decoder, model and runtime on first use.
